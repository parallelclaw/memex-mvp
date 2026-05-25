// Tests for `memex-sync wire-openclaw` — the one-shot OpenClaw wiring
// CLI we added in v0.11.7 to power the lazy-install lending flow off
// memex.parallelclaw.ai/openclaw. Subprocess-driven: we spawn the
// real ingest.js via node and assert stdout JSON + on-disk
// openclaw.json mutation. This is closer to integration than unit,
// but it's exactly what the install skill / LLM agent invokes — so
// catching regressions here matches the actual contract.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m = '') {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const INGEST = join(__dirname, '..', 'ingest.js');

function runCli(args, expectedExit = 0) {
  // execFileSync throws on non-zero exit. Catch + assert separately
  // so we can test failure paths.
  try {
    const out = execFileSync('node', [INGEST, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (expectedExit !== 0) throw new Error(`expected exit ${expectedExit}, got 0`);
    return { stdout: out, exit: 0 };
  } catch (err) {
    if (err.status === expectedExit) return { stdout: err.stdout || '', exit: err.status };
    throw new Error(`exit ${err.status} (expected ${expectedExit}); stderr: ${err.stderr}`);
  }
}

function setupTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'wire-openclaw-test-'));
  const configPath = join(dir, 'openclaw.json');
  return { dir, configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

console.log('wire-openclaw CLI:\n');

try {
  test('wires memex into a fresh openclaw.json (cfg.mcp.servers.memex)', () => {
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, '{}');
      const r = runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/fake/memex',
      ]);
      const report = JSON.parse(r.stdout);
      assertEq(report.mcp.action, 'wired');
      assertEq(report.mcp.memex_bin, '/fake/memex');
      assertEq(report.status, 'ready');
      // Config on disk has the right shape
      const cfg = JSON.parse(readFileSync(t.configPath, 'utf8'));
      assertEq(cfg.mcp.servers.memex.command, '/fake/memex');
      assertEq(cfg.mcp.servers.memex.args, []);
    } finally { t.cleanup(); }
  });

  test('idempotent — re-run on same config is a no-op (already_correct)', () => {
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, '{}');
      runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/fake/memex',
      ]);
      const r2 = runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/fake/memex',
      ]);
      const report = JSON.parse(r2.stdout);
      assertEq(report.mcp.action, 'already_correct');
      assertEq(report.status, 'already_in_sync');
      assertEq(report.next_action, 'none');
    } finally { t.cleanup(); }
  });

  test('cleans up stale top-level mcpServers.memex (from pre-v3 skills)', () => {
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, JSON.stringify({
        mcpServers: {
          memex: { command: '/old/path', args: [], env: {} },
          other: { command: '/somewhere-else', args: [] },
        },
      }));
      const r = runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/new/path',
      ]);
      const report = JSON.parse(r.stdout);
      assertEq(report.mcp.cleaned_stale, true);
      const cfg = JSON.parse(readFileSync(t.configPath, 'utf8'));
      // Stale memex gone, other preserved
      assert(!cfg.mcpServers?.memex, 'stale mcpServers.memex should be deleted');
      assertEq(cfg.mcpServers.other.command, '/somewhere-else');
      // New entry at correct key
      assertEq(cfg.mcp.servers.memex.command, '/new/path');
    } finally { t.cleanup(); }
  });

  test('refuses to overwrite a different memex command without --force', () => {
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, JSON.stringify({
        mcp: { servers: { memex: { command: '/user/custom/memex', args: [], env: {} } } },
      }));
      const r = runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/different/memex',
      ], 1);
      const report = JSON.parse(r.stdout);
      assertEq(report.mcp.action, 'conflict');
      assertEq(report.status, 'partial');
      assertEq(report.next_action, 'use_force_or_resolve_conflict');
      // File unchanged
      const cfg = JSON.parse(readFileSync(t.configPath, 'utf8'));
      assertEq(cfg.mcp.servers.memex.command, '/user/custom/memex');
    } finally { t.cleanup(); }
  });

  test('--force overwrites a conflicting memex command', () => {
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, JSON.stringify({
        mcp: { servers: { memex: { command: '/user/custom/memex', args: [], env: {} } } },
      }));
      const r = runCli([
        'wire-openclaw', '--json', '--no-auto-restart', '--force',
        '--config', t.configPath, '--memex-bin', '/different/memex',
      ]);
      const report = JSON.parse(r.stdout);
      assertEq(report.mcp.action, 'wired');
      const cfg = JSON.parse(readFileSync(t.configPath, 'utf8'));
      assertEq(cfg.mcp.servers.memex.command, '/different/memex');
    } finally { t.cleanup(); }
  });

  test('missing openclaw.json surfaces config_missing + failed status', () => {
    const t = setupTmp();
    try {
      // Intentionally do NOT write configPath
      const r = runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/fake/memex',
      ], 2);
      const report = JSON.parse(r.stdout);
      assertEq(report.mcp.action, 'config_missing');
      assertEq(report.status, 'failed');
      assertEq(report.next_action, 'manual_intervention');
    } finally { t.cleanup(); }
  });

  test('corrupt openclaw.json surfaces parse_failed', () => {
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, '{not valid json');
      const r = runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/fake/memex',
      ], 2);
      const report = JSON.parse(r.stdout);
      assertEq(report.mcp.action, 'parse_failed');
      assertEq(report.status, 'failed');
    } finally { t.cleanup(); }
  });

  test('preserves unrelated config keys (merge, not overwrite)', () => {
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, JSON.stringify({
        plugins: { entries: { 'some-other-plugin': { enabled: true } } },
        unrelated_top_level: { keep_me: true },
      }));
      runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/fake/memex',
      ]);
      const cfg = JSON.parse(readFileSync(t.configPath, 'utf8'));
      assertEq(cfg.plugins.entries['some-other-plugin'].enabled, true);
      assertEq(cfg.unrelated_top_level.keep_me, true);
      assertEq(cfg.mcp.servers.memex.command, '/fake/memex');
    } finally { t.cleanup(); }
  });

  test('agent_instructions never tells terminal-less users to "open a terminal"', () => {
    // Critical for Telegram-only users — agent_instructions is what the
    // LLM relays to the human. It must propose chat-driven recovery,
    // not assume shell access.
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, '{}');
      const r = runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/fake/memex',
      ]);
      const report = JSON.parse(r.stdout);
      const text = report.agent_instructions || '';
      assert(!/open\s+(a\s+)?terminal/i.test(text),
        `agent_instructions should not assume terminal access: "${text}"`);
    } finally { t.cleanup(); }
  });

  test('JSON output shape — has expected top-level keys for agents', () => {
    const t = setupTmp();
    try {
      writeFileSync(t.configPath, '{}');
      const r = runCli([
        'wire-openclaw', '--json', '--no-auto-restart',
        '--config', t.configPath, '--memex-bin', '/fake/memex',
      ]);
      const report = JSON.parse(r.stdout);
      for (const key of ['config_path', 'mcp', 'restart', 'status', 'next_action', 'agent_instructions']) {
        assert(key in report, `expected key "${key}" in JSON output`);
      }
    } finally { t.cleanup(); }
  });
} catch (e) {
  console.error('top-level error:', e.message);
  failed++;
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
