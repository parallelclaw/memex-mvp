/**
 * Foreman tracer — agent-to-agent task ledger (lib/tasks.js).
 *
 * Tasks are messages with source='agent-task', status event-sourced as
 * append-only rows; current status = latest-ts event. Verifies the ledger
 * primitives + the inbox/mine filters that the executor prompt and the
 * requester rely on. Cross-node behaviour (origin of each event) is simulated
 * by flipping MEMEX_ORIGIN between writes.
 *
 * Run: node test/tasks.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'memex-tasks-'));
process.env.MEMEX_DIR = TMP;
process.env.MEMEX_ORIGIN = 'mac';

const { initializeDb } = await import('../lib/db-init.js');
const { createTask, updateTask, listTasks } = await import('../lib/tasks.js');
const Database = (await import('better-sqlite3')).default;

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

mkdirSync(join(TMP, 'data'), { recursive: true });
initializeDb(join(TMP, 'data', 'memex.db')).close();
const db = new Database(join(TMP, 'data', 'memex.db'));
db.pragma('journal_mode = WAL');

const asOrigin = (o, fn) => { const p = process.env.MEMEX_ORIGIN; process.env.MEMEX_ORIGIN = o; try { return fn(); } finally { process.env.MEMEX_ORIGIN = p; } };

console.log('task ledger:');

let A, B;
let clock = 1_700_000_000_000;
const tick = () => (clock += 1000);

t('createTask writes a submitted task addressed to a peer', () => {
  A = createTask({ prompt: 'summarize ECC research', to: 'kimi', db, now: tick() }).id;
  const got = listTasks({ db });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, A);
  assert.equal(got[0].status, 'submitted');
  assert.equal(got[0].from, 'mac');
  assert.equal(got[0].to, 'kimi');
  assert.match(got[0].prompt, /ECC/);
});

t('a task is stored as agent-task messages rows (rides sync)', () => {
  const n = db.prepare(`SELECT COUNT(*) c FROM messages WHERE source='agent-task' AND conversation_id=?`).get(`task-${A}`).c;
  assert.ok(n >= 1, 'at least the submitted event row exists');
  const src = db.prepare(`SELECT DISTINCT source FROM messages WHERE conversation_id=?`).get(`task-${A}`).source;
  assert.equal(src, 'agent-task');
});

t('executor (kimi) sees it in --inbox; requester (mac) does not', () => {
  const kimiInbox = asOrigin('kimi', () => listTasks({ inbox: true, db }));
  assert.deepEqual(kimiInbox.map((x) => x.id), [A], 'kimi inbox = the submitted task to kimi');
  const macInbox = asOrigin('mac', () => listTasks({ inbox: true, db }));
  assert.equal(macInbox.length, 0, 'mac is the sender, not the addressee');
});

t('event-sourced status: working then done is the latest', () => {
  asOrigin('kimi', () => {
    updateTask(A, 'working', { db, now: tick() });
    updateTask(A, 'done', { result: '5 bullets: ...', db, now: tick() });
  });
  const got = listTasks({ db }).find((x) => x.id === A);
  assert.equal(got.status, 'done');
  assert.equal(got.result, '5 bullets: ...');
  // it left the inbox (no longer submitted)
  assert.equal(asOrigin('kimi', () => listTasks({ inbox: true, db })).length, 0);
});

t('every transition is an append-only row (nothing rewritten)', () => {
  const events = db.prepare(`SELECT msg_id FROM messages WHERE conversation_id=? ORDER BY ts`).all(`task-${A}`);
  assert.equal(events.length, 3, 'submitted + working + done = 3 immutable rows');
});

t('--mine shows what I delegated; --status filters', () => {
  assert.deepEqual(asOrigin('mac', () => listTasks({ mine: true, db })).map((x) => x.id), [A]);
  assert.deepEqual(listTasks({ status: 'done', db }).map((x) => x.id), [A]);
  assert.equal(listTasks({ status: 'submitted', db }).length, 0);
});

t('reverse direction: kimi delegates to mac, mac sees inbox', () => {
  B = asOrigin('kimi', () => createTask({ prompt: 'refactor auth', to: 'mac', db, now: tick() }).id);
  const macInbox = asOrigin('mac', () => listTasks({ inbox: true, db }));
  assert.deepEqual(macInbox.map((x) => x.id), [B], 'delegation works both ways — any↔any');
});

t('updateTask on unknown id throws (no silent no-op)', () => {
  assert.throws(() => updateTask('t-nope', 'done', { db }), /no task/);
});

t('invalid status rejected', () => {
  assert.throws(() => updateTask(A, 'banana', { db }), /status must be/);
});

t('failed carries a reason', () => {
  asOrigin('mac', () => updateTask(B, 'failed', { result: 'tests red', db, now: tick() }));
  const got = listTasks({ db }).find((x) => x.id === B);
  assert.equal(got.status, 'failed');
  assert.equal(got.result, 'tests red');
});

db.close();
rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? '\nTask ledger checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
