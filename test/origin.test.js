/**
 * v0.14 provenance — per-row `origin` (which node captured the row).
 *
 * Born from two live confusions on a 3-node mesh (2026-06-12): synced rows
 * from a peer blend into the same source label the local capture uses, and
 * two OpenClaw instances bridging the same Telegram account interleave into
 * ONE conversation. `origin` is the per-node identity that disambiguates.
 *
 * Invariants locked here:
 *   1. schema migration adds messages.origin (idempotent)
 *   2. getOrigin(): env override → config → hostname; sanitised [a-z0-9-];
 *      derived value PERSISTS to config (identity survives hostname changes)
 *   3. wire applier: row.origin stored verbatim; absent → NULL; conflict
 *      backfills NULL but NEVER overwrites an existing origin
 *   4. plugin resolveOrigin(): env → config.json next to the db → hostname
 *   5. the search filter SQL (m.origin = ?) selects exactly the node's rows
 *
 * Run: node test/origin.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'memex-origin-'));
process.env.MEMEX_DIR = TMP;
delete process.env.MEMEX_ORIGIN;

const { initializeDb } = await import('../lib/db-init.js');
const { getOrigin, sanitizeOrigin, loadConfig } = await import('../lib/config.js');
const { makeRowApplier } = await import('../lib/sync/push.js');
const { resolveOrigin } = await import('../plugins/memex-openclaw/lib/store.js');
const Database = (await import('better-sqlite3')).default;

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

mkdirSync(join(TMP, 'data'), { recursive: true });
const dbPath = join(TMP, 'data', 'memex.db');
initializeDb(dbPath).close();

console.log('schema migration:');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

t('messages.origin column exists after initializeDb', () => {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  assert.ok(cols.includes('origin'), `columns: ${cols.join(',')}`);
});

t('partial index on origin exists', () => {
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_origin'`).get();
  assert.ok(idx, 'idx_messages_origin missing');
});

console.log('getOrigin():');

t('sanitises to [a-z0-9-], short-hostname, max 24', () => {
  assert.equal(sanitizeOrigin('MacBook-Pro-MacBook.local'), 'macbook-pro-macbook');
  assert.equal(sanitizeOrigin('it_vmv2 mini!'), 'it-vmv2-mini');
  assert.equal(sanitizeOrigin('---'), null);
  assert.equal(sanitizeOrigin('x'.repeat(40)).length, 24);
});

t('MEMEX_ORIGIN env wins (and is sanitised)', () => {
  process.env.MEMEX_ORIGIN = 'My VPS.example.com';
  assert.equal(getOrigin(), 'my-vps');
  delete process.env.MEMEX_ORIGIN;
});

t('derived from hostname and PERSISTED into config.json', () => {
  const got = getOrigin();
  const expected = sanitizeOrigin(hostname()) || 'node';
  assert.equal(got, expected);
  assert.equal(loadConfig().origin, expected, 'must persist so a hostname change later does not fork identity');
});

t('config origin wins over hostname afterwards', () => {
  // simulate the user renaming their node in config.json
  const cfgPath = join(TMP, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  cfg.origin = 'renamed-node';
  writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.equal(getOrigin(), 'renamed-node');
});

console.log('wire applier pass-through:');
const applier = makeRowApplier({ db });
const mkRow = (i, origin) => ({
  source: 'openclaw', conversation_id: 'shared-conv', msg_id: `m${i}`,
  role: 'user', sender: 'me', text: `msg ${i}`, ts: 1700000000 + i,
  ...(origin !== undefined ? { origin } : {}),
  conversation: { title: 'shared', first_ts: 1700000000, last_ts: 1700000100 },
});

t('row.origin from the wire is stored verbatim (never re-stamped locally)', () => {
  applier.apply([mkRow(1, 'vps1'), mkRow(2, 'kimi')]);
  const got = db.prepare(`SELECT msg_id, origin FROM messages WHERE conversation_id='shared-conv' ORDER BY msg_id`).all();
  assert.deepEqual(got, [{ msg_id: 'm1', origin: 'vps1' }, { msg_id: 'm2', origin: 'kimi' }]);
});

t('a wire row WITHOUT origin stays NULL (pre-provenance era)', () => {
  applier.apply([mkRow(3)]);
  assert.equal(db.prepare(`SELECT origin FROM messages WHERE msg_id='m3'`).get().origin, null);
});

t('conflict backfills NULL origin but never overwrites an existing one', () => {
  // m3 currently NULL → re-push with origin → backfilled
  applier.apply([mkRow(3, 'vps1')]);
  assert.equal(db.prepare(`SELECT origin FROM messages WHERE msg_id='m3'`).get().origin, 'vps1');
  // m1 is 'vps1' → re-push claiming 'kimi' → must KEEP 'vps1'
  applier.apply([mkRow(1, 'kimi')]);
  assert.equal(db.prepare(`SELECT origin FROM messages WHERE msg_id='m1'`).get().origin, 'vps1');
});

t('one conversation can interleave multiple origins (the merged-chat case)', () => {
  const origins = db.prepare(
    `SELECT DISTINCT origin FROM messages WHERE conversation_id='shared-conv' AND origin IS NOT NULL ORDER BY origin`
  ).all().map((r) => r.origin);
  assert.deepEqual(origins, ['kimi', 'vps1']);
});

console.log('plugin resolveOrigin():');

t('env → config.json next to db → hostname (in that order)', () => {
  process.env.MEMEX_ORIGIN = 'plug-env';
  assert.equal(resolveOrigin(dbPath), 'plug-env');
  delete process.env.MEMEX_ORIGIN;
  // config.json lives at dirname(dirname(dbPath)) — TMP/config.json, already has 'renamed-node'
  assert.equal(resolveOrigin(dbPath), 'renamed-node');
});

console.log('search filter SQL (mirrors server.js memex_search):');

t('m.origin = ? selects exactly that node\'s rows', () => {
  const rows = db.prepare(`SELECT msg_id FROM messages WHERE origin = ? ORDER BY msg_id`).all('vps1');
  assert.deepEqual(rows.map((r) => r.msg_id), ['m1', 'm3']);
});

db.close();
rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? '\nOrigin/provenance checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
