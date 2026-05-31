/**
 * Phase 5 test: the memex_sync_invite MCP tool.
 *
 * Spawns the real MCP server (server.js) over stdio, does the JSON-RPC
 * handshake, and verifies:
 *   1. With MEMEX_SYNC_EXPERIMENTAL=1, tools/list includes memex_sync_invite.
 *   2. tools/call memex_sync_invite {host:"localhost"} returns a pair_blob
 *      that parsePairBlob() accepts, carrying the right host/port/fingerprint.
 *   3. WITHOUT the env flag, the tool is NOT listed (clean stable surface).
 *
 * This is the wow-flow's load-bearing piece: the VPS agent calls this tool
 * to emit a pairing blob from a natural-language request.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const SERVER_JS = join(REPO_ROOT, 'server.js');

const { initializeDb } = await import('../../lib/db-init.js');
const { parsePairBlob } = await import('../../lib/sync/pair.js');

function makeMemexDir() {
  const dir = mkdtempSync(join(tmpdir(), 'memex-mcp-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  initializeDb(join(dir, 'data', 'memex.db')).close();
  return dir;
}

/**
 * Minimal MCP stdio client: spawn server.js, do initialize handshake, then
 * run a sequence of requests. Returns a map of id → result. Newline-delimited
 * JSON-RPC (what StdioServerTransport speaks).
 */
function mcpSession({ memexDir, env = {}, requests }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_JS], {
      env: { ...process.env, MEMEX_DIR: memexDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const results = {};
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP session timeout. stderr:\n${stderr}\nresults so far: ${JSON.stringify(results)}`));
    }, 20000);

    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id != null) {
          results[msg.id] = msg;
          if (msg.id === 'DONE_SENTINEL') return; // unused
        }
        // After initialize (id=1) reply, send initialized + the rest.
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          for (const r of requests) send(r);
        }
        // Once we've collected all request ids, finish.
        const want = requests.map((r) => r.id);
        if (want.every((id) => results[id] != null)) {
          clearTimeout(timer);
          child.kill();
          resolve(results);
        }
      }
    });
    child.on('error', reject);

    function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
    // Kick off the handshake.
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
  });
}

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('memex_sync_invite MCP tool:');

// ── with the experimental flag ───────────────────────────────────────────────
const dirOn = makeMemexDir();
let onResults;
await t('handshake + tools/list + tools/call complete', async () => {
  onResults = await mcpSession({
    memexDir: dirOn,
    env: { MEMEX_SYNC_EXPERIMENTAL: '1' },
    requests: [
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memex_sync_invite', arguments: { host: 'localhost', port: 8766, ttl_minutes: 30 } } },
    ],
  });
  assert.ok(onResults[2] && onResults[3], 'got both responses');
});

await t('tools/list includes memex_sync_invite when flag set', () => {
  const tools = onResults[2].result.tools.map((t) => t.name);
  assert.ok(tools.includes('memex_sync_invite'), `tool list: ${tools.join(', ')}`);
});

await t('tools/call returns a valid, parseable pair_blob', () => {
  const text = onResults[3].result.content[0].text;
  const payload = JSON.parse(text);
  assert.ok(payload.pair_blob, 'pair_blob present');
  const parsed = parsePairBlob(payload.pair_blob);
  assert.equal(parsed.host, 'localhost');
  assert.equal(parsed.port, 8766);
  assert.equal(parsed.url, 'https://localhost:8766');
  assert.ok(parsed.cert_fp && parsed.cert_fp.startsWith('sha256:'), 'fingerprint pinned in blob');
  assert.ok(parsed.token && parsed.token.length === 64, 'bearer in blob');
  assert.equal(payload.expires_in_minutes, 30);
});

await t('response warns when sync-server is not running', () => {
  const payload = JSON.parse(onResults[3].result.content[0].text);
  // In the test env no sync-server is installed, so we expect the warning.
  assert.ok(payload.server_warning, 'should warn that server is not running');
  assert.match(payload.server_warning, /sync-server/i);
});

// ── without the experimental flag ────────────────────────────────────────────
const dirOff = makeMemexDir();
let offResults;
await t('tool is HIDDEN without the experimental flag', async () => {
  offResults = await mcpSession({
    memexDir: dirOff,
    env: { MEMEX_SYNC_EXPERIMENTAL: '' },
    requests: [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }],
  });
  const tools = offResults[2].result.tools.map((t) => t.name);
  assert.ok(!tools.includes('memex_sync_invite'), 'tool must be hidden on the stable surface');
});

rmSync(dirOn, { recursive: true, force: true });
rmSync(dirOff, { recursive: true, force: true });
console.log(failed === 0 ? '\nMCP invite checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
