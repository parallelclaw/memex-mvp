/**
 * Day 7 (tracer-bullet) end-to-end CLI test.
 *
 * Spawns two real memex-sync subprocesses — one acting as "VPS" running
 * `sync-server start`, the other as "Mac" running `sync-add` + `sync-run` —
 * each with its own MEMEX_DIR. Verifies that messages move across the wire
 * exactly like they would in production:
 *
 *   1. Mac seeded with 5 messages locally.
 *   2. VPS seeded with 3 different messages.
 *   3. Start VPS sync-server in background; capture bearer + port from stdout.
 *   4. Mac registers VPS via sync-add (insecure mode).
 *   5. Mac runs sync-run.
 *   6. Mac DB should now hold 8 rows (5 original + 3 pulled); VPS DB
 *      should hold 8 rows too (3 original + 5 pushed).
 *   7. Re-running sync-run is a no-op (everything dedup).
 *
 * This is the real proof that the tracer-bullet command chain works end-to-end.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const INGEST_JS = join(REPO_ROOT, 'ingest.js');

function setupHost(name) {
  const dir = mkdtempSync(join(tmpdir(), `memex-cli-${name}-`));
  const dbDir = join(dir, 'data');
  mkdirSync(dbDir, { recursive: true });
  return { dir, dbPath: join(dbDir, 'memex.db') };
}

function seedDb(dbPath, rows) {
  // Lazily import db-init so the schema matches production exactly.
  return import('../../lib/db-init.js').then(({ initializeDb }) => {
    const db = initializeDb(dbPath);
    const ins = db.prepare(`INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const upsertConv = db.prepare(`INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count)
                                   VALUES (?, ?, ?, ?, ?, ?)
                                   ON CONFLICT(conversation_id) DO NOTHING`);
    for (const r of rows) {
      upsertConv.run(r.conversation_id, r.source, `seed-${r.conversation_id}`, r.ts, r.ts, 0);
      ins.run(r.source, r.conversation_id, r.msg_id, r.role, r.sender || null, r.text, r.ts);
    }
    db.close();
  });
}

function runCli({ env, args, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [INGEST_JS, ...args], {
      env: { ...process.env, ...env, MEMEX_SYNC_EXPERIMENTAL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${timeoutMs}ms: ${args.join(' ')}\nSTDOUT:\n${out}\nSTDERR:\n${err}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/**
 * Start `sync-server start` in the background, return a kill handle plus the
 * parsed port + bearer from its banner output.
 */
function spawnServer({ env, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [INGEST_JS, 'sync-server', 'start', ...args], {
      env: { ...process.env, ...env, MEMEX_SYNC_EXPERIMENTAL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(new Error(`server didn't print banner within 10s\nSTDOUT:\n${out}\nSTDERR:\n${err}`));
      }
    }, 10_000);

    child.stdout.on('data', (d) => {
      out += d;
      // Banner shape (matches lib/sync/cli.js):
      //   ✓ Listening on 0.0.0.0:51234
      //   Bearer (256-bit):  abc123...
      const portMatch = out.match(/Listening on [^\s:]+:(\d+)/);
      const bearerMatch = out.match(/Bearer \(256-bit\):\s+([0-9a-f]+)/);
      if (portMatch && bearerMatch && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          child,
          port: parseInt(portMatch[1], 10),
          bearer: bearerMatch[1],
          out, err,
        });
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
  });
}

function countRows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
  db.close();
  return n;
}

// ─── test driver ───────────────────────────────────────────────────────────

const VPS = setupHost('vps');
const MAC = setupHost('mac');

let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('CLI end-to-end (tracer-bullet):');

await seedDb(VPS.dbPath, [
  { source: 'openclaw', conversation_id: 'openclaw-vps-conv-1', msg_id: 'v1', role: 'user',      sender: 'me',       text: 'install ffmpeg',        ts: 1700000100 },
  { source: 'openclaw', conversation_id: 'openclaw-vps-conv-1', msg_id: 'v2', role: 'assistant', sender: 'openclaw', text: 'installed v6.1',        ts: 1700000101 },
  { source: 'openclaw', conversation_id: 'openclaw-vps-conv-1', msg_id: 'v3', role: 'user',      sender: 'me',       text: 'now whisper',           ts: 1700000102 },
]);

await seedDb(MAC.dbPath, [
  { source: 'claude-code', conversation_id: 'cc-mac-conv-1', msg_id: 'a1', role: 'user',      sender: 'me',          text: 'help with React',       ts: 1700000200 },
  { source: 'claude-code', conversation_id: 'cc-mac-conv-1', msg_id: 'a2', role: 'assistant', sender: 'claude-code', text: 'sure, what stack?',     ts: 1700000201 },
  { source: 'claude-code', conversation_id: 'cc-mac-conv-1', msg_id: 'a3', role: 'user',      sender: 'me',          text: 'vite + ts',             ts: 1700000202 },
  { source: 'claude-code', conversation_id: 'cc-mac-conv-1', msg_id: 'a4', role: 'assistant', sender: 'claude-code', text: 'npm create vite@latest', ts: 1700000203 },
  { source: 'claude-code', conversation_id: 'cc-mac-conv-1', msg_id: 'a5', role: 'user',      sender: 'me',          text: 'thanks',                ts: 1700000204 },
]);

let server = null;

await t('VPS pre-seed: 3 rows', () => assert.equal(countRows(VPS.dbPath), 3));
await t('Mac pre-seed: 5 rows', () => assert.equal(countRows(MAC.dbPath), 5));

await t('spawn `sync-server start` on VPS — banner appears with port + bearer', async () => {
  server = await spawnServer({
    env: { MEMEX_DIR: VPS.dir },
    args: ['--port', '0', '--bind', '127.0.0.1'],
  });
  assert.ok(server.port > 0, 'port parsed from banner');
  assert.ok(/^[0-9a-f]+$/.test(server.bearer), 'bearer parsed from banner');
});

await t('Mac registers VPS via sync-add (insecure)', async () => {
  const r = await runCli({
    env: { MEMEX_DIR: MAC.dir },
    args: ['sync-add', 'vps', `https://127.0.0.1:${server.port}`, server.bearer, '--insecure'],
  });
  assert.equal(r.code, 0, `sync-add failed: ${r.err}`);
  assert.match(r.out, /remote "vps" added/);
});

await t('Mac sync-list shows the new remote', async () => {
  const r = await runCli({
    env: { MEMEX_DIR: MAC.dir },
    args: ['sync-list'],
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /vps/);
  assert.match(r.out, /127\.0\.0\.1/);
});

await t('Mac sync-run pulls 3 from VPS + pushes 5 to VPS', async () => {
  const r = await runCli({
    env: { MEMEX_DIR: MAC.dir },
    args: ['sync-run', 'vps'],
    timeoutMs: 30_000,
  });
  assert.equal(r.code, 0, `sync-run failed:\nSTDOUT:\n${r.out}\nSTDERR:\n${r.err}`);
  assert.match(r.out, /pulled  3 rows/);
  assert.match(r.out, /pushed  5 rows/);
});

await t('after sync — Mac has 8 rows total (5 local + 3 pulled)', () => {
  assert.equal(countRows(MAC.dbPath), 8);
});

await t('after sync — VPS has 8 rows total (3 local + 5 pushed)', () => {
  assert.equal(countRows(VPS.dbPath), 8);
});

await t('Re-running sync-run accepts 0 new rows (echo round still dedups)', async () => {
  // Cursor-only design has one extra "echo" round: VPS's id sequence now
  // includes the rows Mac pushed, so Mac will pull them and dedup. Conversely
  // Mac's id sequence includes the rows it pulled from VPS, so it'll push
  // them and VPS will dedup. Net data movement = 0; bandwidth ≠ 0. Third
  // run is the true no-op (see below).
  const r = await runCli({
    env: { MEMEX_DIR: MAC.dir },
    args: ['sync-run', 'vps'],
    timeoutMs: 30_000,
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /accepted=0/, 'no new data accepted');
});

await t('Third sync-run is a true no-op (echo absorbed, nothing to send)', async () => {
  const r = await runCli({
    env: { MEMEX_DIR: MAC.dir },
    args: ['sync-run', 'vps'],
    timeoutMs: 30_000,
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /pulled\s+0 rows/);
  assert.match(r.out, /pushed\s+0 rows/);
});

await t('sync-status shows non-zero cursors after first sync', async () => {
  const r = await runCli({
    env: { MEMEX_DIR: MAC.dir },
    args: ['sync-status'],
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /vps\s+pull→/);
  // pull→ should be > 0 since we pulled 3 rows
  assert.match(r.out, /pull→\s+[1-9]/);
  assert.match(r.out, /push→\s+[1-9]/);
});

await t('MEMEX_SYNC_EXPERIMENTAL=0 refuses to operate', async () => {
  const child = spawn('node', [INGEST_JS, 'sync-list'], {
    env: { ...process.env, MEMEX_DIR: MAC.dir, MEMEX_SYNC_EXPERIMENTAL: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
  assert.match(err, /MEMEX_SYNC_EXPERIMENTAL/);
});

// teardown — wait for the server child to fully exit before removing
// its data dir, otherwise WAL/SHM files keep ENOTEMPTY-ing rmSync.
if (server?.child) {
  await new Promise((resolve) => {
    server.child.on('exit', resolve);
    server.child.kill();
    setTimeout(resolve, 2000); // hard cap
  });
}
rmSync(VPS.dir, { recursive: true, force: true });
rmSync(MAC.dir, { recursive: true, force: true });

console.log(failed === 0 ? '\nCLI end-to-end checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
