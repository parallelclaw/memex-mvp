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
import { makePushHandler } from './push.js';
import { getSyncRemote, upsertSyncRemote } from './config.js';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DEFAULT_DB_PATH = join(MEMEX_DIR, 'data', 'memex.db');

const PULL_BATCH = 500;
// PUSH_BATCH is conservative: large claude-code rows (with embedded tool-call
// artefacts in metadata + text) can exceed the server's 2MB body cap at 500
// rows/batch. 100 fits 99%-tile traffic. Adaptive batching with auto-halve
// on 413 is Day 11 work — see replicateOnce() retry logic.
const PUSH_BATCH = 100;

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
    const localPushHandler = makePushHandler({ db });
    let pulled_to = remote.pulled_to || 0;
    while (true) {
      const page = await client.pull({ since: pulled_to, limit: PULL_BATCH });
      if (!page.rows || page.rows.length === 0) break;

      // Apply rows into local DB via the same INSERT-OR-UPDATE handler the
      // server uses, but bypass HTTP — invoke it directly through a fake
      // req/res pair to avoid duplicating the validation/transaction code.
      const inserted = await applyRowsLocally(localPushHandler, page.rows);
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
    while (true) {
      const localRows = fetchOurs.all(pushed_to, localMaxBeforePull, PUSH_BATCH);
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

      const result = await client.push({ rows: wire });
      stats.pushed.batches += 1;
      stats.pushed.rows += localRows.length;
      stats.pushed.accepted += result.accepted;
      stats.pushed.deduplicated += result.deduplicated;

      pushed_to = localRows[localRows.length - 1].id;
      if (localRows.length < PUSH_BATCH) break;
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

/**
 * Invoke the push handler with a synthetic req/res pair, capture its
 * response body. Used to share the validation + transaction logic between
 * the HTTP server path and the local-replicate path.
 */
async function applyRowsLocally(pushHandler, rows) {
  // Build a tiny faux req — emits 'data' then 'end' with the JSON body.
  const body = JSON.stringify({ rows });
  const req = makeReadableReq(body);
  const { promise, capture } = makeWriteableRes();
  pushHandler(req, capture);
  const responseBody = await promise;
  if (responseBody.error) {
    throw new Error(`local apply: ${responseBody.error} — ${responseBody.detail || ''}`);
  }
  return {
    accepted: responseBody.accepted ?? 0,
    deduplicated: responseBody.deduplicated ?? 0,
  };
}

function makeReadableReq(body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    url: '/sync/push',
    on(evt, cb) { (listeners[evt] || []).push(cb); return req; },
    destroy() { /* no-op */ },
  };
  // Emit asynchronously so handler has a chance to attach listeners.
  setImmediate(() => {
    for (const cb of listeners.data) cb(Buffer.from(body, 'utf-8'));
    for (const cb of listeners.end)  cb();
  });
  return req;
}

function makeWriteableRes() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  let body = '';
  const capture = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader() { /* no-op */ },
    end(chunk) {
      if (chunk) body += chunk;
      this.writableEnded = true;
      try { resolve(JSON.parse(body || '{}')); }
      catch (_) { resolve({ _raw: body }); }
    },
  };
  return { promise, capture };
}
