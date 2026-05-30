/**
 * Bidirectional replication loop for one remote.
 *
 * `replicateOnce(remoteAlias)`:
 *   1. PULL phase — keep pulling rows id > pulled_to from the remote until
 *      has_more is false; insert each batch locally via the same INSERT OR
 *      UPDATE logic the server uses (we just call lib/sync/push internally).
 *   2. PUSH phase — read local rows with id > pushed_to in id-asc batches
 *      and POST them to the remote until empty.
 *   3. Persist updated cursors + last_sync_at into ~/.memex/config.json.
 *
 * The PULL-then-PUSH ordering is deliberate: if both sides have new rows,
 * we want the local DB to see the remote's new state BEFORE we re-push
 * the union back, so the second cycle stabilises quickly.
 *
 * Idempotent throughout — re-running on the same data is safe (everything
 * deduplicates via UNIQUE(source, conv_id, msg_id)).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createSyncClient } from './client.js';
import { makeRowApplier } from './push.js';
import { getSyncRemote, upsertSyncRemote } from './config.js';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DEFAULT_DB_PATH = join(MEMEX_DIR, 'data', 'memex.db');

const PULL_BATCH = 500;
// Push batching is ADAPTIVE (Phase 1). We start optimistic and halve on a
// 413 payload_too_large, because the server caps the BODY at 2MB and row
// size varies wildly (a telegram line is ~100 bytes; a claude-code turn with
// embedded tool-call artefacts can be multiple KB). Count is just a proxy
// for bytes, so we react to the real signal (413) rather than hardcoding low.
const PUSH_BATCH_START = 250;
const PUSH_BATCH_MIN = 1;
// Server caps the request body at 2MB. We pre-flight the serialized payload
// client-side and shrink BEFORE sending if it would exceed this safe ceiling
// (1.8MB leaves headroom for the tiny framing difference between our estimate
// and the server's measured byte count). This avoids the mid-stream 413+
// connection-reset entirely — much cleaner than uploading 3MB just to be
// rejected with an EPIPE. The 413 catch below remains as a belt-and-suspenders
// backstop in case a peer runs a lower cap than we assume.
const SAFE_PUSH_BYTES = 1.8 * 1024 * 1024;

/**
 * Run one full bidirectional sync against a configured remote.
 *
 * opts.dbPath — local memex.db; defaults to ~/.memex/data/memex.db
 * opts.alias  — remote alias from sync.remotes config; required
 * opts.log    — optional log function (default console.log); pass () => {} for silence
 */
export async function replicateOnce({ alias, dbPath = DEFAULT_DB_PATH, log = console.log } = {}) {
  if (!alias) throw new Error('replicateOnce: alias required');

  const remote = getSyncRemote(alias);
  if (!remote) throw new Error(`replicateOnce: remote "${alias}" not configured`);
  if (!remote.url || !remote.bearer) {
    throw new Error(`replicateOnce: remote "${alias}" missing url or bearer`);
  }

  const client = createSyncClient({
    url:      remote.url,
    bearer:   remote.bearer,
    insecure: remote.insecure === true,   // tracer-bullet flag
    cert_fp:  remote.cert_fp || null,
  });

  // Quick liveness probe — bail early with a clear message if peer is down.
  let peerHealth;
  try {
    peerHealth = await client.health();
  } catch (err) {
    throw new Error(`peer ${alias} unreachable: ${err.message}`);
  }

  // Open local DB read-write. WAL mode is already set by db-init at install time.
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const stats = {
    alias,
    peer_version: peerHealth.version,
    pulled: { batches: 0, rows: 0, accepted: 0, deduplicated: 0 },
    pushed: { batches: 0, rows: 0, accepted: 0, deduplicated: 0 },
    cursors_before: { pulled_to: remote.pulled_to || 0, pushed_to: remote.pushed_to || 0 },
    cursors_after:  { pulled_to: remote.pulled_to || 0, pushed_to: remote.pushed_to || 0 },
    elapsed_ms: 0,
  };

  const t0 = Date.now();

  try {
    // Snapshot our max local id BEFORE pull starts. Rows inserted by the
    // pull phase get ids > localMaxBeforePull, and we exclude them from
    // the push phase so we don't echo back what we just received.
    //
    // Without this guard, after a pull of N rows our push phase would
    // happily ship those same N rows back to the peer, who'd dedup them
    // — correct outcome but 2× bandwidth and noise in the stats.
    const localMaxBeforePull = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM messages`).get().m) | 0;

    // 1. PULL phase
    // Apply pulled rows via the shared row-applier — NOT through the HTTP push
    // handler. The handler enforces a 2MB body cap (a network concern); a pull
    // page of fat rows can exceed that, but locally we're applying in-memory
    // rows directly, so no size limit applies.
    const localApplier = makeRowApplier({ db });
    let pulled_to = remote.pulled_to || 0;
    while (true) {
      const page = await client.pull({ since: pulled_to, limit: PULL_BATCH });
      if (!page.rows || page.rows.length === 0) break;

      const inserted = localApplier.apply(page.rows);
      stats.pulled.batches += 1;
      stats.pulled.rows += page.rows.length;
      stats.pulled.accepted += inserted.accepted;
      stats.pulled.deduplicated += inserted.deduplicated;

      pulled_to = page.next_cursor;
      if (!page.has_more) break;
    }
    stats.cursors_after.pulled_to = pulled_to;

    // 2. PUSH phase — only rows in (pushed_to, localMaxBeforePull].
    // Anything newer than localMaxBeforePull either came from the peer
    // via the pull we just did, or is a concurrent write we'll catch
    // on the next cycle.
    const fetchOurs = db.prepare(`
      SELECT
        m.id, m.source, m.conversation_id, m.msg_id, m.role, m.sender, m.text,
        m.ts, m.edited_at, m.uuid, m.channel, m.metadata,
        c.title                  AS conv_title,
        c.first_ts               AS conv_first_ts,
        c.last_ts                AS conv_last_ts,
        c.parent_conversation_id AS conv_parent,
        c.project_path           AS conv_project_path
      FROM messages m
      LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
      WHERE m.id > ? AND m.id <= ?
      ORDER BY m.id ASC
      LIMIT ?
    `);

    let pushed_to = remote.pushed_to || 0;
    let batchSize = PUSH_BATCH_START;
    while (true) {
      const localRows = fetchOurs.all(pushed_to, localMaxBeforePull, batchSize);
      if (localRows.length === 0) break;

      const wire = localRows.map((r) => ({
        source: r.source,
        conversation_id: r.conversation_id,
        msg_id: r.msg_id,
        uuid: r.uuid,
        role: r.role,
        sender: r.sender,
        text: r.text,
        ts: r.ts,
        edited_at: r.edited_at,
        channel: r.channel,
        metadata: r.metadata,
        conversation: {
          title: r.conv_title,
          first_ts: r.conv_first_ts,
          last_ts: r.conv_last_ts,
          parent_conversation_id: r.conv_parent,
          project_path: r.conv_project_path,
        },
      }));

      // Pre-flight size check — shrink BEFORE sending if this batch would
      // exceed the server's body cap. Avoids the mid-stream 413/EPIPE entirely.
      const payloadBytes = Buffer.byteLength(JSON.stringify({ rows: wire }), 'utf-8');
      if (payloadBytes > SAFE_PUSH_BYTES && localRows.length > PUSH_BATCH_MIN) {
        batchSize = Math.max(PUSH_BATCH_MIN, Math.floor(localRows.length / 2));
        stats.pushed.shrinks = (stats.pushed.shrinks || 0) + 1;
        log(`  push batch ~${(payloadBytes / 1048576).toFixed(2)}MB > cap — shrinking to ${batchSize} rows and re-fetching`);
        continue; // re-fetch the same segment with fewer rows
      }

      let result;
      try {
        result = await client.push({ rows: wire });
      } catch (err) {
        // Backstop: if a peer enforces a lower cap than SAFE_PUSH_BYTES, we
        // might still get a 413 — or a mid-stream connection reset (EPIPE/
        // ECONNRESET) when the server destroys the request before we finish
        // uploading. Treat all three as "too big, halve and retry".
        const tooBig =
          err.status === 413 ||
          err.code === 'EPIPE' ||
          err.code === 'ECONNRESET' ||
          /EPIPE|ECONNRESET|socket hang up/i.test(String(err.message));
        if (tooBig && localRows.length > PUSH_BATCH_MIN) {
          batchSize = Math.max(PUSH_BATCH_MIN, Math.floor(localRows.length / 2));
          stats.pushed.shrinks = (stats.pushed.shrinks || 0) + 1;
          log(`  push rejected (${err.status || err.code || 'reset'}) — halving to ${batchSize} and retrying`);
          continue;
        }
        throw err; // genuine error, or already at min batch — propagate
      }

      stats.pushed.batches += 1;
      stats.pushed.rows += localRows.length;
      stats.pushed.accepted += result.accepted;
      stats.pushed.deduplicated += result.deduplicated;

      pushed_to = localRows[localRows.length - 1].id;

      // Recover throughput: after a successful send, grow the batch back
      // toward the optimistic start size (doubling), so one fat row doesn't
      // pin us at a tiny batch for the rest of the run.
      if (batchSize < PUSH_BATCH_START) {
        batchSize = Math.min(PUSH_BATCH_START, batchSize * 2);
      }
      // Termination is handled by the empty-fetch check at loop top once
      // pushed_to reaches localMaxBeforePull.
    }
    stats.cursors_after.pushed_to = pushed_to;

    // 3. Persist cursors + clear any prior error
    upsertSyncRemote(alias, {
      pulled_to: stats.cursors_after.pulled_to,
      pushed_to: stats.cursors_after.pushed_to,
      last_sync_at: Date.now(),
      last_error: null,
    });
  } catch (err) {
    upsertSyncRemote(alias, { last_error: String(err.message || err) });
    db.close();
    throw err;
  } finally {
    stats.elapsed_ms = Date.now() - t0;
  }

  db.close();
  return stats;
}
