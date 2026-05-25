/**
 * Tests for setup orchestrator.
 *
 * Strategy: synthesize a fake ~/.openclaw with openclaw.json + agents/
 * dir in a tmpdir, run runSetup() with --no-auto-restart (so we never
 * fire a real restart in tests), assert the JSON shape + the on-disk
 * state of openclaw.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemexStore } from '../lib/store.js';
import { runSetup } from '../lib/setup.js';

function buildEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'memex-oc-setup-'));
  const configPath = join(dir, 'openclaw.json');
  const agentsDir = join(dir, 'agents');
  const dbPath = join(dir, 'memex.db');
  return {
    dir, configPath, agentsDir, dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeConfig(p, cfg) {
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}

function readConfig(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function makeUuid(seed) {
  const h = String(seed).padStart(32, '0').slice(0, 32);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

function seedSession(agentsDir, agent, uuid, msgs) {
  const sessDir = join(agentsDir, agent, 'sessions');
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, `${uuid}.jsonl`),
    msgs.map((m) => JSON.stringify(m)).join('\n'),
  );
}

// ---------------- happy paths ----------------

test('runSetup: wires plugin entry + MCP server from a minimal config', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {});
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath,
      agentsDir: e.agentsDir,
      noAutoRestart: true,
      memexBin: '/fake/path/memex',
    });
    assert.equal(r.status, 'ready');
    assert.equal(r.plugin_config.action, 'wired');
    assert.equal(r.plugin_config.enabled, true);
    assert.equal(r.plugin_config.allowConversationAccess, true);
    assert.equal(r.mcp.action, 'wired');
    assert.equal(r.mcp.memex_bin, '/fake/path/memex');
    // On-disk verification
    const written = readConfig(e.configPath);
    assert.equal(written.plugins.entries['memex-openclaw'].enabled, true);
    assert.equal(written.plugins.entries['memex-openclaw'].hooks.allowConversationAccess, true);
    assert.equal(written.mcp.servers.memex.command, '/fake/path/memex');
  } finally { store.close(); e.cleanup(); }
});

test('runSetup: idempotent — second run is no-op', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {});
  const store = new MemexStore(e.dbPath);
  try {
    runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/fake/memex',
    });
    const r2 = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/fake/memex',
    });
    assert.equal(r2.plugin_config.action, 'already_correct');
    assert.equal(r2.mcp.action, 'already_correct');
    assert.equal(r2.status, 'already_in_sync');
    assert.equal(r2.next_action, 'none');
  } finally { store.close(); e.cleanup(); }
});

test('runSetup: cleans up stale mcpServers.memex from pre-2.0.2 skill', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {
    mcpServers: {
      memex: { command: '/old/path/memex', args: [], env: {} },
      other: { command: '/somewhere/else', args: [] },
    },
  });
  const store = new MemexStore(e.dbPath);
  try {
    runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/new/path/memex',
    });
    const written = readConfig(e.configPath);
    // Stale memex entry removed
    assert.ok(!written.mcpServers?.memex,
      'stale mcpServers.memex must be deleted');
    // Other unrelated server preserved
    assert.equal(written.mcpServers.other.command, '/somewhere/else');
    // New entry at correct location
    assert.equal(written.mcp.servers.memex.command, '/new/path/memex');
  } finally { store.close(); e.cleanup(); }
});

test('runSetup: refuses to overwrite conflicting mcp.servers.memex without --force', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {
    mcp: { servers: { memex: { command: '/user/customized/memex', args: [], env: {} } } },
  });
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/different/path/memex',
    });
    assert.equal(r.mcp.action, 'conflict');
    assert.equal(r.status, 'partial');
    assert.equal(r.next_action, 'use_force_or_resolve_conflict');
    // On-disk: customized path preserved (we refused to write)
    const written = readConfig(e.configPath);
    assert.equal(written.mcp.servers.memex.command, '/user/customized/memex');
  } finally { store.close(); e.cleanup(); }
});

test('runSetup: --force overwrites conflicting mcp.servers.memex', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {
    mcp: { servers: { memex: { command: '/user/customized/memex', args: [], env: {} } } },
  });
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/different/path/memex',
      force: true,
    });
    assert.equal(r.mcp.action, 'wired');
    const written = readConfig(e.configPath);
    assert.equal(written.mcp.servers.memex.command, '/different/path/memex');
  } finally { store.close(); e.cleanup(); }
});

// ---------------- error paths ----------------

test('runSetup: missing memex binary surfaces in result without crashing', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {});
  const store = new MemexStore(e.dbPath);
  try {
    // memexBin null → simulate missing binary
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: null,
    });
    // Plugin config wires fine — that's independent of memex binary
    assert.equal(r.plugin_config.action, 'wired');
    // Result depends on whether memex is actually on PATH of test host.
    // If it IS, mcp wires fine; if NOT, we get memex_missing. Either is acceptable.
    assert.ok(['wired', 'memex_missing', 'already_correct'].includes(r.mcp.action));
  } finally { store.close(); e.cleanup(); }
});

test('runSetup: missing openclaw.json surfaces failed status with hint', () => {
  const e = buildEnv();
  // No config file written.
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/fake/memex',
    });
    assert.equal(r.status, 'failed');
    assert.equal(r.next_action, 'manual_intervention');
    assert.ok(r.agent_instructions.includes(e.configPath));
  } finally { store.close(); e.cleanup(); }
});

test('runSetup: corrupt openclaw.json surfaces parse error', () => {
  const e = buildEnv();
  writeFileSync(e.configPath, '{not valid json');
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/fake/memex',
    });
    assert.equal(r.status, 'failed');
    assert.ok(r.plugin_config.error.toLowerCase().includes('parse'));
  } finally { store.close(); e.cleanup(); }
});

// ---------------- backfill integration ----------------

test('runSetup: with seeded sessions, imports them as part of setup', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {});
  seedSession(e.agentsDir, 'main', makeUuid(1), [
    { role: 'user', content: 'install memex', ts: 1700000010, messageProvider: 'telegram', channelId: '97592799' },
    { role: 'assistant', content: 'on it', ts: 1700000011, messageProvider: 'telegram', channelId: '97592799' },
  ]);
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/fake/memex',
    });
    assert.equal(r.backfill.status, 'imported');
    assert.equal(r.backfill.messages_imported, 2);
    assert.equal(store.count(), 2);
  } finally { store.close(); e.cleanup(); }
});

test('runSetup: --no-backfill skips history import', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {});
  seedSession(e.agentsDir, 'main', makeUuid(1), [
    { role: 'user', content: 'install', ts: 1700000010 },
  ]);
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noBackfill: true, noAutoRestart: true, memexBin: '/fake/memex',
    });
    assert.equal(r.backfill.status, 'skipped');
    assert.equal(store.count(), 0);
  } finally { store.close(); e.cleanup(); }
});

// ---------------- agent_instructions ----------------

test('runSetup: agent_instructions mentions imported count when present', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {});
  seedSession(e.agentsDir, 'main', makeUuid(1), [
    { role: 'user', content: 'hi', ts: 1700000010 },
    { role: 'assistant', content: 'hello', ts: 1700000011 },
  ]);
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/fake/memex',
    });
    assert.ok(r.agent_instructions.includes('2'));
    assert.ok(/searchable|memex/.test(r.agent_instructions));
  } finally { store.close(); e.cleanup(); }
});

test('runSetup: agent_instructions does NOT tell terminal-less users to "open a terminal"', () => {
  const e = buildEnv();
  writeConfig(e.configPath, {});
  const store = new MemexStore(e.dbPath);
  try {
    const r = runSetup(store, {
      configPath: e.configPath, agentsDir: e.agentsDir,
      noAutoRestart: true, memexBin: '/fake/memex',
    });
    // Critical for Telegram-only users: instructions must not include "terminal".
    assert.ok(!/open\s+(a\s+)?terminal/i.test(r.agent_instructions),
      `agent_instructions should not assume terminal access: "${r.agent_instructions}"`);
  } finally { store.close(); e.cleanup(); }
});
