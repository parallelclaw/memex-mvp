/**
 * Phase 1 test: adaptive push batching.
 *
 * Verifies that when a push batch exceeds the server's 2MB body cap, the
 * replication loop catches the 413, halves the batch, and retries the same
 * segment — converging to a full transfer without operator intervention.
 *
 * Setup:
 *   - In-process server B (empty DB) on an ephemeral port.
 *   - Local client DB seeded with ~280 "fat" rows (~12KB text each). At the
 *     optimistic PUSH_BATCH_START=250, that's ~3MB/batch → guaranteed 413.
 *     After halving to 125 (~1.5MB) it fits.
 *   - replicateOnce() against the configured remote.
 *
 * Asserts:
 *   - replication completes (no throw)
 *   - stats.pushed.shrinks > 0 (the 413 path actually fired)
 *   - all 280 rows landed on server B (accepted), none lost
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const TMP = mkdtempSync(join(tmpdir(), 'memex-adaptive-'));
process.env.MEMEX_DIR = TMP;

// Local (client) DB lives at MEMEX_DIR/data/memex.db — that's what
// replicateOnce reads by default, and where sync config persists.
const { initializeDb } = await import('../../lib/db-init.js');
const localDir = join(TMP, 'data');
mkdirSync(localDir, { recursive: true });
const localDbPath = join(localDir, 'memex.db');

// Server B gets its own isolated DB (empty to start).
const serverDbPath = join(TMP, 'server-memex.db');
initializeDb(serverDbPath).close();

const FAT_ROWS = 280;
const FAT_TEXT_BYTES = 12 * 1024; // 12KB per row → 250×12KB ≈ 3MB > 2MB cap

{
  const db = initializeDb(localDbPath);
  const ins = db.prepare(`INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.prepare(`INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count)
              VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING`)
    .run('fat-conv', 'claude-code', 'fat conversation', 1700000000, 1700000000 + FAT_ROWS, 0);
  const blob = 'x'.repeat(FAT_TEXT_BYTES);
  const tx = db.transaction(() => {
    for (let i = 0; i < FAT_ROWS; i++) {
      ins.run('claude-code', 'fat-conv', `fat-${i}`, i % 2 ? 'assistant' : 'user', 'me',
              `${blob}#${i}`, 1700000000 + i);
    }
  });
  tx();
  db.close();
}

const { startSyncServer } = await import('../../lib/sync/server.js');
const { upsertSyncRemote } = await import('../../lib/sync/config.js');
const { replicateOnce } = await import('../../lib/sync/replicate.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('adaptive push batching:');

const server = await startSyncServer({
  ephemeral: true, port: 0, bind: '127.0.0.1',
  dbPath: serverDbPath,
  certPath: join(TMP, 'cert.pem'),
  keyPath: join(TMP, 'key.pem'),
});

// Configure the remote in MEMEX_DIR/config.json so replicateOnce finds it.
upsertSyncRemote('vps', {
  url: `https://127.0.0.1:${server.port}`,
  bearer: server.bearer,
  insecure: true,          // self-signed test cert; skip chain check
  cert_fp: null,
  pulled_to: 0, pushed_to: 0, last_sync_at: 0, last_error: null,
});

let stats;
await t('replicateOnce completes despite oversized batches', async () => {
  stats = await replicateOnce({ alias: 'vps', dbPath: localDbPath, log: () => {} });
  assert.ok(stats, 'stats returned');
});

await t('413 path fired: pushed.shrinks > 0', () => {
  assert.ok(stats.pushed.shrinks > 0,
    `expected at least one batch shrink, got ${stats.pushed.shrinks || 0}`);
});

await t('all 280 fat rows accepted on server (none lost)', () => {
  assert.equal(stats.pushed.accepted, FAT_ROWS,
    `expected ${FAT_ROWS} accepted, got ${stats.pushed.accepted}`);
  const db = new Database(serverDbPath, { readonly: true });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE source='claude-code'`).get().n;
  db.close();
  assert.equal(n, FAT_ROWS, `server should hold ${FAT_ROWS} rows, has ${n}`);
});

await t('re-run is idempotent — 0 new accepted', async () => {
  const s2 = await replicateOnce({ alias: 'vps', dbPath: localDbPath, log: () => {} });
  assert.equal(s2.pushed.accepted, 0, 'second run accepts nothing new');
});

await new Promise((r) => server.server.close(r));
rmSync(TMP, { recursive: true, force: true });

console.log(failed === 0 ? '\nAdaptive batch checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
