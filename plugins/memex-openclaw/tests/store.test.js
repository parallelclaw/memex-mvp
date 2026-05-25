/**
 * Integration tests for the SQLite store.
 * Run: `node --test tests/store.test.js`
 *
 * Uses a temp DB per test — no leakage, no shared state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemexStore, resolveDbPath, DEFAULT_DB_PATH } from '../lib/store.js';

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'memex-oc-test-'));
  return {
    path: join(dir, 'memex.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('store: opens fresh DB and reports count=0', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    assert.equal(store.count(), 0);
    store.close();
  } finally { cleanup(); }
});

test('store: insertMessage writes row', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    const ok = store.insertMessage({
      conversationId: 'openclaw-telegram-42',
      msgId: 'openclaw-abc123',
      role: 'user',
      text: 'hello',
      ts: 1700000000,
      channel: 'telegram',
      metadata: { foo: 'bar' },
    });
    assert.equal(ok, true);
    assert.equal(store.count(), 1);
    store.close();
  } finally { cleanup(); }
});

test('store: insertMessage idempotent on UNIQUE constraint', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    const kw = {
      conversationId: 'c1',
      msgId: 'm1',
      role: 'user',
      text: 'hello',
      ts: 1700000000,
    };
    assert.equal(store.insertMessage(kw), true);
    assert.equal(store.insertMessage(kw), false); // dedup
    assert.equal(store.count(), 1);
    store.close();
  } finally { cleanup(); }
});

test('store: empty text is skipped', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    const ok = store.insertMessage({
      conversationId: 'c1',
      msgId: 'm1',
      role: 'user',
      text: '',
      ts: 1700000000,
    });
    assert.equal(ok, false);
    assert.equal(store.count(), 0);
    store.close();
  } finally { cleanup(); }
});

test('store: search finds match', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    store.insertMessage({
      conversationId: 'c1', msgId: 'm1', role: 'user',
      text: 'install ffmpeg please', ts: 1700000000, channel: 'telegram',
    });
    const rows = store.search('ffmpeg');
    assert.equal(rows.length, 1);
    assert.match(rows[0].preview, /ffmpeg/);
    assert.equal(rows[0].channel, 'telegram');
    store.close();
  } finally { cleanup(); }
});

test('store: search respects limit', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    for (let i = 0; i < 20; i++) {
      store.insertMessage({
        conversationId: 'c1', msgId: `m${i}`, role: 'user',
        text: `ffmpeg msg ${i}`, ts: 1700000000 + i,
      });
    }
    assert.equal(store.search('ffmpeg', 5).length, 5);
    assert.equal(store.search('ffmpeg', 100).length, 20);
    store.close();
  } finally { cleanup(); }
});

test('store: search returns empty on malformed FTS query', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    store.insertMessage({
      conversationId: 'c1', msgId: 'm1', role: 'user',
      text: 'hello', ts: 1700000000,
    });
    // Unbalanced quotes — FTS5 syntax error. Should NOT throw.
    const rows = store.search('"foo bar');
    assert.deepEqual(rows, []);
    store.close();
  } finally { cleanup(); }
});

test('store: getById returns full row + parsed metadata', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    store.insertMessage({
      conversationId: 'c1', msgId: 'm1', role: 'assistant',
      text: 'the full text', ts: 1700000000, channel: 'cli',
      metadata: { foo: 'bar', n: 42 },
    });
    const row = store.getById(1);
    assert.equal(row.id, 1);
    assert.equal(row.role, 'assistant');
    assert.equal(row.text, 'the full text');
    assert.deepEqual(row.metadata, { foo: 'bar', n: 42 });
    store.close();
  } finally { cleanup(); }
});

test('store: getById returns null on missing', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    assert.equal(store.getById(999), null);
    store.close();
  } finally { cleanup(); }
});

test('store: upsertConversation creates + updates', () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = new MemexStore(path);
    store.upsertConversation({
      conversationId: 'c1', title: 'first', firstTs: 1700000000, lastTs: 1700000000,
    });
    store.upsertConversation({
      conversationId: 'c1', title: 'should-not-override', lastTs: 1700001000,
    });
    const row = store.db.prepare('SELECT * FROM conversations WHERE conversation_id=?').get('c1');
    assert.equal(row.title, 'first');     // first title wins
    assert.equal(row.last_ts, 1700001000); // last_ts updated
    store.close();
  } finally { cleanup(); }
});

test('store: re-open preserves data', () => {
  const { path, cleanup } = tmpDb();
  try {
    {
      const s1 = new MemexStore(path);
      s1.insertMessage({
        conversationId: 'c1', msgId: 'm1', role: 'user',
        text: 'persistent', ts: 1700000000,
      });
      s1.close();
    }
    const s2 = new MemexStore(path);
    assert.equal(s2.count(), 1);
    assert.equal(s2.search('persistent').length, 1);
    s2.close();
  } finally { cleanup(); }
});

test('resolveDbPath: tilde expansion', () => {
  const p = resolveDbPath('~/test.db');
  assert.ok(!p.includes('~'));
  assert.ok(p.endsWith('test.db'));
});

test('resolveDbPath: default when undefined', () => {
  const p = resolveDbPath();
  assert.ok(p.endsWith('memex.db'));
  assert.ok(!p.includes('~'));
});

test('resolveDbPath: absolute path passes through', () => {
  const p = resolveDbPath('/tmp/explicit-memex.db');
  assert.equal(p, '/tmp/explicit-memex.db');
});

// ============================================================
// v0.2.0 — plugin_state (watermark storage for backfill etc.)
// ============================================================

test('plugin_state: setState + getState round-trips a string value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    store.setState('memex-openclaw', 'agent:main:last_session_id', 'abc-123');
    assert.equal(
      store.getState('memex-openclaw', 'agent:main:last_session_id'),
      'abc-123',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: getState returns null for missing key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    assert.equal(store.getState('memex-openclaw', 'never-set'), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: setState overwrites existing value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    store.setState('memex-openclaw', 'k', 'v1');
    store.setState('memex-openclaw', 'k', 'v2');
    assert.equal(store.getState('memex-openclaw', 'k'), 'v2');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: setState(null) deletes the entry (clear)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    store.setState('memex-openclaw', 'k', 'v');
    store.setState('memex-openclaw', 'k', null);
    assert.equal(store.getState('memex-openclaw', 'k'), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: namespaced by plugin_id — same key in different plugins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    store.setState('memex-openclaw', 'k', 'openclaw-val');
    store.setState('memex-hermes', 'k', 'hermes-val');
    assert.equal(store.getState('memex-openclaw', 'k'), 'openclaw-val');
    assert.equal(store.getState('memex-hermes', 'k'), 'hermes-val');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: listState returns all entries for a plugin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    store.setState('memex-openclaw', 'agent:main:last_id', 'a');
    store.setState('memex-openclaw', 'agent:main:last_mtime', '1700');
    store.setState('memex-openclaw', 'other:flag', 'on');
    const rows = store.listState('memex-openclaw');
    assert.equal(rows.length, 3);
    // Each row has key + value + updated_ts
    rows.forEach((r) => {
      assert.ok(r.key);
      assert.ok(r.value);
      assert.ok(r.updated_ts);
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: listState prefix-filter narrows results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    store.setState('memex-openclaw', 'agent:main:last_id', 'a');
    store.setState('memex-openclaw', 'agent:other:last_id', 'b');
    store.setState('memex-openclaw', 'config:debug', 'on');
    const agents = store.listState('memex-openclaw', 'agent:');
    assert.equal(agents.length, 2);
    assert.ok(agents.every((r) => r.key.startsWith('agent:')));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: clearStateForPlugin wipes a plugin namespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    store.setState('memex-openclaw', 'k1', 'v');
    store.setState('memex-openclaw', 'k2', 'v');
    store.setState('memex-hermes', 'k1', 'v');
    const cleared = store.clearStateForPlugin('memex-openclaw');
    assert.equal(cleared, 2);
    assert.equal(store.listState('memex-openclaw').length, 0);
    // memex-hermes namespace unaffected
    assert.equal(store.listState('memex-hermes').length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: survives store reopen (persisted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const s1 = new MemexStore(path);
  s1.setState('memex-openclaw', 'persist-me', 'xyz');
  s1.close();
  const s2 = new MemexStore(path);
  try {
    assert.equal(s2.getState('memex-openclaw', 'persist-me'), 'xyz');
  } finally {
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin_state: defensive against empty inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memex-state-'));
  const path = join(dir, 'memex.db');
  const store = new MemexStore(path);
  try {
    // Empty plugin_id or key → no-op / null, not crash
    assert.equal(store.getState('', 'k'), null);
    assert.equal(store.getState('p', ''), null);
    store.setState('', 'k', 'v'); // silently no-op
    store.setState('p', '', 'v'); // silently no-op
    assert.deepEqual(store.listState(''), []);
    assert.equal(store.clearStateForPlugin(''), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
