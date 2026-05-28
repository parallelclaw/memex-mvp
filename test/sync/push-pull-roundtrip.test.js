/**
 * End-to-end round-trip test for POST /sync/push + GET /sync/pull.
 *
 * Simulates two memex instances ("A" = laptop, "B" = VPS) by spawning two
 * sync servers on ephemeral ports backed by isolated DBs. Exercises:
 *
 *   1. Initial state — both DBs empty; pull from each returns 0 rows.
 *   2. A pushes 3 rows to B → B's row_count goes 0 → 3.
 *   3. B pulls from A starting since=0 → gets 0 rows (A pushed to B, not B to A).
 *   4. B pushes its own rows to A → A's row_count grows.
 *   5. A pulls from B → gets the original 3 rows back? No — only A's pushed
 *      rows now live on B; A pulls them and dedups via UNIQUE.
 *   6. Repeating the same push is idempotent (accepted=0, deduplicated=N).
 *   7. Cursor advancement: pull twice in a row, second call returns empty.
 *   8. Conversation upsert: title from push survives, message_count updates.
 *   9. has_more flag: pull with limit < total returns has_more=true.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import Database from 'better-sqlite3';

// Two isolated MEMEX_DIRs (one per simulated host). Order matters: each
// startSyncServer call below pre-overrides MEMEX_DIR right before importing
// the server (which captures it at module load), then restores. Since we
// reuse the same already-imported module here, we instead pass dbPath/cert
// paths explicitly to startSyncServer to keep instances isolated.

const TMP_A = mkdtempSync(join(tmpdir(), 'memex-sync-A-'));
const TMP_B = mkdtempSync(join(tmpdir(), 'memex-sync-B-'));

// Init both DBs with the real schema (db-init).
const { initializeDb } = await import('../../lib/db-init.js');
const dbPathA = join(TMP_A, 'memex.db');
const dbPathB = join(TMP_B, 'memex.db');
initializeDb(dbPathA).close();
initializeDb(dbPathB).close();

const { startSyncServer } = await import('../../lib/sync/server.js');

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

console.log('Spinning up two ephemeral sync servers...');
const A = await startSyncServer({
  ephemeral: true, port: 0, bind: '127.0.0.1',
  dbPath: dbPathA,
  certPath: join(TMP_A, 'cert.pem'),
  keyPath:  join(TMP_A, 'key.pem'),
});
const B = await startSyncServer({
  ephemeral: true, port: 0, bind: '127.0.0.1',
  dbPath: dbPathB,
  certPath: join(TMP_B, 'cert.pem'),
  keyPath:  join(TMP_B, 'key.pem'),
});
console.log(`  A on :${A.port}, B on :${B.port}`);

// --- helper: HTTPS request returning {status, body} ---
function rpc({ port, bearer, method, path, body }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = httpsRequest({
      host: '127.0.0.1', port, path, method,
      rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// --- seed messages ---
function mkRow({ source, conversation_id, msg_id, role, text, ts }) {
  return {
    source, conversation_id, msg_id, role, text, ts,
    sender: role === 'user' ? 'me' : 'claude-code',
    channel: null,
    metadata: null,
    edited_at: null,
    conversation: {
      title: `conv-for-${conversation_id}`,
      first_ts: ts,
      last_ts: ts,
      parent_conversation_id: null,
      project_path: null,
    },
  };
}

await t('GET /sync/pull on empty DB returns 0 rows, cursor stays at 0', async () => {
  const { status, body } = await rpc({
    port: B.port, bearer: B.bearer,
    method: 'GET', path: '/sync/pull?since=0',
  });
  assert.equal(status, 200);
  assert.equal(body.rows.length, 0);
  assert.equal(body.next_cursor, 0);
  assert.equal(body.has_more, false);
});

await t('POST /sync/push 3 rows: accepted=3, deduplicated=0', async () => {
  const rows = [
    mkRow({ source: 'claude-code', conversation_id: 'cc-conv-1', msg_id: 'm1', role: 'user',      text: 'hello',  ts: 1700000000 }),
    mkRow({ source: 'claude-code', conversation_id: 'cc-conv-1', msg_id: 'm2', role: 'assistant', text: 'hi',     ts: 1700000001 }),
    mkRow({ source: 'claude-code', conversation_id: 'cc-conv-1', msg_id: 'm3', role: 'user',      text: 'thanks', ts: 1700000002 }),
  ];
  const { status, body } = await rpc({
    port: B.port, bearer: B.bearer,
    method: 'POST', path: '/sync/push', body: { rows },
  });
  assert.equal(status, 200);
  assert.equal(body.accepted, 3);
  assert.equal(body.deduplicated, 0);
  assert.equal(body.last_id, 3);
});

await t('GET /sync/pull after push: returns same 3 rows with embedded conversation', async () => {
  const { body } = await rpc({
    port: B.port, bearer: B.bearer,
    method: 'GET', path: '/sync/pull?since=0',
  });
  assert.equal(body.rows.length, 3);
  assert.equal(body.next_cursor, 3);
  assert.equal(body.has_more, false);
  for (const r of body.rows) {
    assert.equal(r.source, 'claude-code');
    assert.equal(r.conversation_id, 'cc-conv-1');
    assert.equal(r.conversation.title, 'conv-for-cc-conv-1');
    assert.ok(r.uuid, 'uuid should be auto-generated');
  }
});

await t('GET /sync/pull?since=last_id returns 0 rows on a fresh follow-up', async () => {
  const { body } = await rpc({
    port: B.port, bearer: B.bearer,
    method: 'GET', path: '/sync/pull?since=3',
  });
  assert.equal(body.rows.length, 0);
  assert.equal(body.next_cursor, 3);
});

await t('POST /sync/push with same rows is idempotent: accepted=0, dedup=3', async () => {
  const rows = [
    mkRow({ source: 'claude-code', conversation_id: 'cc-conv-1', msg_id: 'm1', role: 'user',      text: 'hello',  ts: 1700000000 }),
    mkRow({ source: 'claude-code', conversation_id: 'cc-conv-1', msg_id: 'm2', role: 'assistant', text: 'hi',     ts: 1700000001 }),
    mkRow({ source: 'claude-code', conversation_id: 'cc-conv-1', msg_id: 'm3', role: 'user',      text: 'thanks', ts: 1700000002 }),
  ];
  const { body } = await rpc({
    port: B.port, bearer: B.bearer,
    method: 'POST', path: '/sync/push', body: { rows },
  });
  assert.equal(body.accepted, 0, 'no new accepts');
  assert.equal(body.deduplicated, 3, 'all three dedup');
});

await t('Server A is independent: still empty until rows pushed to it', async () => {
  const { body } = await rpc({
    port: A.port, bearer: A.bearer,
    method: 'GET', path: '/sync/pull?since=0',
  });
  assert.equal(body.rows.length, 0);
});

await t('Bidirectional: pull from B, push to A (full sync simulation)', async () => {
  // 1. A pulls everything from B
  const pull = await rpc({
    port: B.port, bearer: B.bearer,
    method: 'GET', path: '/sync/pull?since=0',
  });
  assert.equal(pull.body.rows.length, 3);
  // 2. A pushes them locally (this is what `memex sync run` does internally)
  const push = await rpc({
    port: A.port, bearer: A.bearer,
    method: 'POST', path: '/sync/push', body: { rows: pull.body.rows },
  });
  assert.equal(push.body.accepted, 3, 'A absorbs all 3 rows from B');
  // 3. A's row_count via health
  const health = await rpc({
    port: A.port, bearer: A.bearer,
    method: 'GET', path: '/sync/health',
  });
  assert.equal(health.body.row_count, 3, 'A now has 3 rows');
});

await t('limit + has_more: pull with limit=2 of 3 rows returns has_more=true', async () => {
  const { body } = await rpc({
    port: A.port, bearer: A.bearer,
    method: 'GET', path: '/sync/pull?since=0&limit=2',
  });
  assert.equal(body.rows.length, 2);
  assert.equal(body.has_more, true);
  assert.equal(body.next_cursor, 2);
  // follow-up pull picks up where we left off
  const { body: body2 } = await rpc({
    port: A.port, bearer: A.bearer,
    method: 'GET', path: '/sync/pull?since=2',
  });
  assert.equal(body2.rows.length, 1);
  assert.equal(body2.has_more, false);
});

await t('Conversation upserted on B has correct message_count', () => {
  const db = new Database(dbPathB, { readonly: true });
  const conv = db.prepare(`SELECT message_count FROM conversations WHERE conversation_id = ?`)
    .get('cc-conv-1');
  db.close();
  assert.equal(conv.message_count, 3);
});

await t('POST /sync/push validates: missing rows[] → 400', async () => {
  const { status, body } = await rpc({
    port: A.port, bearer: A.bearer,
    method: 'POST', path: '/sync/push', body: { not_rows: [] },
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'bad_request');
});

await t('POST /sync/push validates: rows over 1000 → 400', async () => {
  const rows = new Array(1001).fill(0).map((_, i) =>
    mkRow({ source: 'x', conversation_id: 'y', msg_id: `m${i}`, role: 'user', text: 'a', ts: i })
  );
  const { status, body } = await rpc({
    port: A.port, bearer: A.bearer,
    method: 'POST', path: '/sync/push', body: { rows },
  });
  assert.equal(status, 400);
  assert.match(body.detail, /max 1000/);
});

await t('GET /sync/pull validates: since=negative → 400', async () => {
  const { status, body } = await rpc({
    port: A.port, bearer: A.bearer,
    method: 'GET', path: '/sync/pull?since=-1',
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'bad_request');
});

// shutdown
await new Promise((r) => A.server.close(r));
await new Promise((r) => B.server.close(r));
rmSync(TMP_A, { recursive: true, force: true });
rmSync(TMP_B, { recursive: true, force: true });

console.log(failed === 0 ? '\nRound-trip checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
