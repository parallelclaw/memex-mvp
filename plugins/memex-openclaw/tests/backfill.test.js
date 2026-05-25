/**
 * Tests for OpenClaw session backfill.
 *
 * We synthesize the on-disk OpenClaw layout in a tmpdir:
 *
 *   <tmp>/agents/
 *     main/
 *       sessions/
 *         <uuid>.jsonl                ← primary, included
 *         <uuid>.checkpoint.X.jsonl   ← excluded
 *         <uuid>.trajectory.jsonl     ← excluded
 *
 * Then run runBackfill() against that root and a fresh MemexStore in
 * the same tmpdir, asserting counts, watermark behavior, idempotency,
 * and edge cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemexStore } from '../lib/store.js';
import {
  runBackfill,
  discoverAgents,
  listAgentSessions,
  defaultAgentsDir,
} from '../lib/backfill.js';

// ------- fixture builders -------

function makeUuid(seed) {
  // Reproducible-ish UUID-shaped string for test files. Real UUIDs
  // would also work; this just makes tests deterministic.
  const h = String(seed).padStart(32, '0').slice(0, 32);
  return [
    h.slice(0, 8), h.slice(8, 12), h.slice(12, 16),
    h.slice(16, 20), h.slice(20, 32),
  ].join('-');
}

function buildScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'memex-oc-backfill-'));
  const agentsDir = join(dir, 'agents');
  const dbPath = join(dir, 'memex.db');
  return {
    dir,
    agentsDir,
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeSessionFile(agentsDir, agent, fileName, lines) {
  const sessDir = join(agentsDir, agent, 'sessions');
  mkdirSync(sessDir, { recursive: true });
  const path = join(sessDir, fileName);
  writeFileSync(
    path,
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
  );
  return path;
}

function ev(role, text, extra = {}) {
  return {
    role,
    content: text,
    ts: extra.ts || 1700000000,
    messageProvider: extra.platform,
    channelId: extra.channelId,
    ...extra,
  };
}

// ------- defaults / discovery -------

test('defaultAgentsDir: ~/.openclaw/agents resolved', () => {
  const p = defaultAgentsDir();
  assert.ok(p.endsWith(join('.openclaw', 'agents')), `got: ${p}`);
});

test('discoverAgents: returns empty when dir absent', () => {
  const s = buildScratch();
  try {
    assert.deepEqual(discoverAgents(s.agentsDir), []);
  } finally { s.cleanup(); }
});

test('discoverAgents: lists agent directories sorted', () => {
  const s = buildScratch();
  try {
    mkdirSync(join(s.agentsDir, 'main', 'sessions'), { recursive: true });
    mkdirSync(join(s.agentsDir, 'aux', 'sessions'), { recursive: true });
    assert.deepEqual(discoverAgents(s.agentsDir), ['aux', 'main']);
  } finally { s.cleanup(); }
});

test('listAgentSessions: only includes primary .jsonl files', () => {
  const s = buildScratch();
  const u1 = makeUuid(1);
  const u2 = makeUuid(2);
  try {
    writeSessionFile(s.agentsDir, 'main', `${u1}.jsonl`, [ev('user', 'hi')]);
    writeSessionFile(s.agentsDir, 'main', `${u1}.checkpoint.${u2}.jsonl`, [ev('user', 'noise')]);
    writeSessionFile(s.agentsDir, 'main', `${u2}.trajectory.jsonl`, [ev('user', 'noise')]);
    writeSessionFile(s.agentsDir, 'main', `${u2}.jsonl`, [ev('user', 'hi2')]);
    const sessions = listAgentSessions(s.agentsDir, 'main');
    assert.equal(sessions.length, 2, 'only 2 primary sessions');
    sessions.forEach((row) => {
      assert.ok(/^[0-9a-f-]{36}$/.test(row.sessionId), `pure UUID: ${row.sessionId}`);
    });
  } finally { s.cleanup(); }
});

// ------- runBackfill: empty / no-history paths -------

test('runBackfill: no agents dir → status=no_history', () => {
  const s = buildScratch();
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(r.status, 'no_history');
    assert.equal(r.agents_scanned, 0);
    assert.equal(r.next_action, 'none');
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill: agents dir exists but empty → status=no_new_data', () => {
  const s = buildScratch();
  mkdirSync(join(s.agentsDir, 'main', 'sessions'), { recursive: true });
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(r.agents_scanned, 1);
    assert.equal(r.sessions_seen, 0);
    assert.equal(r.status, 'no_new_data');
  } finally { store.close(); s.cleanup(); }
});

// ------- runBackfill: happy path -------

test('runBackfill: imports user+assistant pairs from a single session', () => {
  const s = buildScratch();
  const u = makeUuid(42);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    ev('user', 'install memex', { platform: 'telegram', channelId: '97592799', ts: 1700000010 }),
    ev('assistant', 'on it', { platform: 'telegram', channelId: '97592799', ts: 1700000011 }),
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(r.status, 'imported');
    assert.equal(r.messages_imported, 2);
    assert.equal(r.messages_skipped_dup, 0);
    assert.equal(r.per_agent.length, 1);
    assert.equal(r.per_agent[0].agent, 'main');
    assert.equal(r.next_action, 'restart_gateway');
    // Watermark advanced
    assert.equal(r.watermark_advanced, true);
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill: idempotent — re-run on populated DB does nothing', () => {
  const s = buildScratch();
  const u = makeUuid(7);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    ev('user', 'hi', { ts: 1700000010 }),
    ev('assistant', 'hello', { ts: 1700000011 }),
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    const first = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(first.messages_imported, 2);
    const second = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(second.messages_imported, 0,
      're-run should import nothing — watermark skips already-seen sessions');
    assert.equal(second.status, 'no_new_data');
    assert.equal(second.next_action, 'none');
    assert.equal(second.sessions_skipped_watermark, 1);
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill: --ignoreWatermark re-processes all sessions but dedup catches them', () => {
  const s = buildScratch();
  const u = makeUuid(8);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    ev('user', 'hi', { ts: 1700000010 }),
    ev('assistant', 'hello', { ts: 1700000011 }),
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    runBackfill(store, { agentsDir: s.agentsDir });
    const r = runBackfill(store, {
      agentsDir: s.agentsDir,
      ignoreWatermark: true,
    });
    // Sessions processed (watermark bypass), but UNIQUE dedup means 0 inserted
    assert.equal(r.messages_imported, 0);
    assert.equal(r.messages_skipped_dup, 2);
    assert.equal(r.status, 'already_in_sync');
  } finally { store.close(); s.cleanup(); }
});

// ------- runBackfill: dry-run -------

test('runBackfill: dry-run does not write to DB', () => {
  const s = buildScratch();
  const u = makeUuid(9);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    ev('user', 'hi', { ts: 1700000010 }),
    ev('assistant', 'hello', { ts: 1700000011 }),
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, { agentsDir: s.agentsDir, dryRun: true });
    assert.equal(r.dry_run, true);
    assert.equal(r.next_action, 'review_then_real_run');
    // DB still empty
    assert.equal(store.count(), 0);
    // Watermark NOT advanced (dry-run)
    assert.equal(r.watermark_advanced, false);
  } finally { store.close(); s.cleanup(); }
});

// ------- runBackfill: filtering -------

test('runBackfill: --since filters by event ts', () => {
  const s = buildScratch();
  const u = makeUuid(10);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    ev('user', 'old',   { ts: 1700000010 }),   // before cutoff
    ev('user', 'recent', { ts: 1700001000 }),  // after
    ev('assistant', 'reply', { ts: 1700001001 }),
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, {
      agentsDir: s.agentsDir,
      since: 1700000500,
    });
    assert.equal(r.messages_imported, 2);
    assert.equal(r.messages_skipped_dup, 1, 'one event before cutoff was skipped');
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill: corrupt JSONL line is reported but does not abort session', () => {
  const s = buildScratch();
  const u = makeUuid(11);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    JSON.stringify(ev('user', 'good', { ts: 1700000010 })),
    'this is not json',
    JSON.stringify(ev('assistant', 'reply', { ts: 1700000011 })),
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(r.messages_imported, 2);
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].includes('parse error'));
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill: sticky routing — provider in session_start applies to later messages', () => {
  const s = buildScratch();
  const u = makeUuid(12);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    // session_start carries routing but isn't a user/assistant message
    { type: 'session_start', messageProvider: 'discord', channelId: 'guild-7' },
    ev('user', 'first message — no routing on event itself', { ts: 1700000010 }),
    ev('assistant', 'reply', { ts: 1700000011 }),
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    runBackfill(store, { agentsDir: s.agentsDir });
    // Should have routed to openclaw-discord-guild-7
    const search = store.search('first message');
    assert.equal(search.length, 1);
    assert.equal(search[0].conversation_id, 'openclaw-discord-guild-7');
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill: multiple agents — counts and watermarks tracked per agent', () => {
  const s = buildScratch();
  const u1 = makeUuid(13);
  const u2 = makeUuid(14);
  writeSessionFile(s.agentsDir, 'main', `${u1}.jsonl`, [
    ev('user', 'main agent', { ts: 1700000010 }),
  ]);
  writeSessionFile(s.agentsDir, 'aux', `${u2}.jsonl`, [
    ev('user', 'aux agent', { ts: 1700000020 }),
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(r.agents_scanned, 2);
    assert.equal(r.per_agent.length, 2);
    const main = r.per_agent.find((a) => a.agent === 'main');
    const aux = r.per_agent.find((a) => a.agent === 'aux');
    assert.equal(main.messages_imported, 1);
    assert.equal(aux.messages_imported, 1);
    // Re-run — watermark advanced for both agents
    const second = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(second.messages_imported, 0);
    assert.equal(second.sessions_skipped_watermark, 2);
  } finally { store.close(); s.cleanup(); }
});

// ============================================================
// v0.2.1 — real OpenClaw 2026.5+ JSONL event shapes
// (fixtures based on agent's dump from /home/openclaw/.openclaw/
// agents/main/sessions/*.jsonl on the VPS)
// ============================================================

test('runBackfill v0.2.1: parses real OpenClaw 2026.5 message shape (nested message.role/content)', () => {
  const s = buildScratch();
  const u = makeUuid(101);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    // OpenClaw runtime-context — sticky routing
    {
      type: 'custom_message',
      customType: 'openclaw.runtime-context',
      chat_id: 'telegram:97592799',
      message_id: '5611',
      sender_id: '97592799',
    },
    // Real OpenClaw message — nested shape
    {
      type: 'message',
      id: 'b9727eda',
      timestamp: '2026-05-25T17:12:28.864Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'найди в апреле' }],
        timestamp: 1779729148864,
      },
    },
    {
      type: 'message',
      id: 'c9a3-de01',
      timestamp: '2026-05-25T17:12:35.421Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'нашёл следующее...' }],
        timestamp: 1779729155421,
      },
    },
    // Tool calls / model_change / etc — should be skipped
    { type: 'model_change', provider: 'anthropic', modelId: 'claude-opus' },
    { type: 'thinking_level_change', thinkingLevel: 'high' },
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(r.status, 'imported');
    assert.equal(r.messages_imported, 2, 'both nested-shape messages imported, model_change skipped');
    // Routing applied from custom_message sticky
    const rows = store.search('найди');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].conversation_id, 'openclaw-telegram-97592799',
      'chat_id "telegram:97592799" should split into platform=telegram, channelId=97592799');
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill v0.2.1: skips type=session, type=custom (non-message events)', () => {
  const s = buildScratch();
  const u = makeUuid(102);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    { type: 'session', id: 'session-uuid', timestamp: '2026-05-25T17:00:00Z', cwd: '/home/openclaw' },
    { type: 'model_change', provider: 'anthropic' },
    { type: 'custom', customType: 'model-snapshot', payload: '...' },
    {
      type: 'message',
      timestamp: '2026-05-25T17:12:28.864Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    const r = runBackfill(store, { agentsDir: s.agentsDir });
    assert.equal(r.messages_imported, 1,
      'only the one type:message event imports; session/model_change/custom are skipped');
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill v0.2.1: webchat session (no telegram chat_id) routes via session8 fallback', () => {
  const s = buildScratch();
  const u = '0503a630-1234-1234-1234-123456789abc';
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    {
      type: 'message',
      timestamp: '2026-05-25T17:12:28.864Z',
      message: { role: 'user', content: [{ type: 'text', text: 'web prompt' }] },
    },
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    runBackfill(store, { agentsDir: s.agentsDir });
    const rows = store.search('web prompt');
    assert.equal(rows.length, 1);
    // No platform routing → falls back to openclaw-<session8>
    assert.equal(rows[0].conversation_id, 'openclaw-0503a630',
      `expected session-short fallback, got ${rows[0].conversation_id}`);
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill v0.2.1: chat_id without colon is treated as channelId only (no platform split)', () => {
  const s = buildScratch();
  const u = makeUuid(103);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    {
      type: 'custom_message',
      customType: 'openclaw.runtime-context',
      chat_id: 'just-channel-no-prefix',
    },
    {
      type: 'message',
      timestamp: '2026-05-25T17:12:28.864Z',
      message: { role: 'user', content: [{ type: 'text', text: 'msg' }] },
    },
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    runBackfill(store, { agentsDir: s.agentsDir });
    const rows = store.search('msg');
    assert.equal(rows.length, 1);
    // No provider prefix → falls back to openclaw-<session8> with no platform
    // (deriveConvId with platform=null returns openclaw-<session8>)
    assert.ok(rows[0].conversation_id.startsWith('openclaw-'),
      `got: ${rows[0].conversation_id}`);
  } finally { store.close(); s.cleanup(); }
});

test('runBackfill v0.2.1: ts parses ISO string from top-level event.timestamp', () => {
  const s = buildScratch();
  const u = makeUuid(104);
  writeSessionFile(s.agentsDir, 'main', `${u}.jsonl`, [
    {
      type: 'message',
      timestamp: '2026-04-19T18:57:28.000Z',  // ISO string, NO unix-ms inside
      message: { role: 'user', content: [{ type: 'text', text: 'april message' }] },
    },
  ]);
  const store = new MemexStore(s.dbPath);
  try {
    runBackfill(store, { agentsDir: s.agentsDir });
    const rows = store.search('april message');
    assert.equal(rows.length, 1);
    // Verify ts parsed from the ISO string, not the file mtime fallback.
    // 2026-04-19T18:57:28Z = floor(Date.parse('2026-04-19T18:57:28Z') / 1000)
    const fullRow = store.getById(rows[0].id);
    const expectedTs = Math.floor(Date.parse('2026-04-19T18:57:28.000Z') / 1000);
    assert.equal(fullRow.ts, expectedTs,
      `expected ts=${expectedTs} from ISO, got ${fullRow.ts}`);
  } finally { store.close(); s.cleanup(); }
});
