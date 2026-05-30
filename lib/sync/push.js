/**
 * POST /sync/push — receive rows from a peer and apply them locally.
 *
 * Wire contract (see SYNC.md §Wire protocol):
 *
 *   Body: { "rows": [Row, Row, ...] }   1..1000 rows
 *
 *   Row: {
 *     source, conversation_id, msg_id, uuid, role, sender, text,
 *     ts, edited_at, channel, metadata,
 *     conversation: { title, first_ts, last_ts, parent_conversation_id, project_path }
 *   }
 *
 *   Response: {
 *     accepted:     N,   // newly inserted (we didn't have this msg_id before)
 *     deduplicated: M,   // already had — ON CONFLICT updated text from caller
 *     last_id:      <int>
 *   }
 *
 * Behaviour mirrors lib/ingest-file.js so a synced row ends up identical to
 * a row written by the daemon's own ingest path. UNIQUE(source, conv_id, msg_id)
 * guarantees idempotency — a stuck push can be retried indefinitely without
 * duplicating rows.
 *
 * The "deduplicated" count is computed via a pre-check (single indexed lookup
 * against the UNIQUE index) — cheap, and the only way to distinguish INSERT
 * from ON-CONFLICT-UPDATE since better-sqlite3 reports changes=1 for both.
 */

import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 2 * 1024 * 1024;     // 2 MB
const MAX_ROWS_PER_PUSH = 1000;

/**
 * Build the push handler. Pass a read-write db handle. Returns a (req, res)
 * function suitable for direct mounting under the sync server's router.
 *
 * Prepared statements are created once at handler-build time and reused
 * per request — fast path with no statement compilation overhead.
 */
/**
 * Pure row-applier — the shared core that both the HTTP push handler and the
 * local replicate-pull path use to insert rows. NO body-size cap here: that
 * limit is a NETWORK concern (bounding a single HTTP request), not a reason
 * to refuse applying rows we already hold in memory locally.
 *
 * Returns { apply(rows) → {accepted, deduplicated, lastId, firstError} }.
 * Prepared statements are compiled once at build time.
 */
export function makeRowApplier({ db }) {
  if (!db) throw new Error('makeRowApplier: db is required');

  const insertMessage = db.prepare(`
    INSERT INTO messages (source, conversation_id, msg_id, role, sender, text,
                          ts, metadata, edited_at, uuid, channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, conversation_id, msg_id) DO UPDATE SET
      text = excluded.text,
      uuid = COALESCE(messages.uuid, excluded.uuid)
  `);

  const upsertConversation = db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts,
                               last_ts, message_count,
                               parent_conversation_id, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      title        = COALESCE(excluded.title, title),
      first_ts     = COALESCE(MIN(first_ts, excluded.first_ts), excluded.first_ts, first_ts),
      last_ts      = COALESCE(MAX(last_ts, excluded.last_ts), excluded.last_ts, last_ts),
      project_path = COALESCE(excluded.project_path, project_path),
      message_count = (
        SELECT COUNT(*) FROM messages WHERE messages.conversation_id = conversations.conversation_id
      )
  `);

  const existsCheck = db.prepare(`
    SELECT 1 FROM messages
     WHERE source = ? AND conversation_id = ? AND msg_id = ?
     LIMIT 1
  `);

  const maxIdQuery = db.prepare(`SELECT MAX(id) AS id FROM messages`);

  function apply(rows) {
    let accepted = 0;
    let deduplicated = 0;
    let firstError = null;

    const tx = db.transaction(() => {
      for (const row of rows) {
        applyRow(row, {
          insertMessage, upsertConversation, existsCheck,
          countAccepted: () => accepted++,
          countDedup:    () => deduplicated++,
          recordError:   (err) => { if (!firstError) firstError = err; },
        });
      }
    });
    tx();

    const lastRow = maxIdQuery.get();
    return { accepted, deduplicated, lastId: lastRow?.id ?? 0, firstError };
  }

  return { apply };
}

export function makePushHandler({ db }) {
  if (!db) throw new Error('makePushHandler: db is required');

  const applier = makeRowApplier({ db });

  return function pushHandler(req, res) {
    readBody(req, res, MAX_BODY_BYTES)
      .then((body) => {
        if (body == null) return; // already responded with 413
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (_) {
          return respondJson(res, 400, { error: 'bad_request', detail: 'invalid JSON' });
        }

        if (!payload || !Array.isArray(payload.rows)) {
          return respondJson(res, 400, { error: 'bad_request', detail: 'rows[] required' });
        }
        if (payload.rows.length === 0) {
          return respondJson(res, 200, { accepted: 0, deduplicated: 0, last_id: 0 });
        }
        if (payload.rows.length > MAX_ROWS_PER_PUSH) {
          return respondJson(res, 400, {
            error: 'bad_request',
            detail: `rows[] max ${MAX_ROWS_PER_PUSH}`,
          });
        }

        let result;
        try {
          result = applier.apply(payload.rows);
        } catch (err) {
          return respondJson(res, 500, {
            error: 'internal',
            detail: `transaction failed: ${err.message}`,
          });
        }

        const body200 = {
          accepted: result.accepted,
          deduplicated: result.deduplicated,
          last_id: result.lastId,
        };
        if (result.firstError) body200.warning = result.firstError;
        respondJson(res, 200, body200);
      })
      .catch((err) => {
        respondJson(res, 500, { error: 'internal', detail: err.message });
      });
  };
}

/**
 * Apply one Row inside the transaction. Returns true if the row was processed
 * (regardless of accepted vs deduplicated), false if validation rejected it.
 *
 * Validation is intentionally lenient — we want sync to be forward-compatible
 * with future schema additions, so unknown fields are ignored rather than
 * rejected. Only the bare minimum is enforced.
 */
function applyRow(row, ctx) {
  // Required fields. msg_id may be null per spec, but if it IS null we still
  // try to insert — the UNIQUE constraint will then dedup on (source, conv_id, NULL),
  // which behaves correctly for our purposes (multiple null msg_ids in same
  // conversation are allowed; that mirrors the existing ingest behavior).
  if (!row || typeof row !== 'object') return false;
  if (typeof row.source !== 'string' || !row.source) return false;
  if (typeof row.conversation_id !== 'string' || !row.conversation_id) return false;
  if (typeof row.role !== 'string' || !row.role) return false;
  if (typeof row.text !== 'string') return false;
  // ts may be null in unusual cases (e.g. boundary rows) — accept anything coercible to int or null
  const ts = (row.ts == null) ? null : Number(row.ts);
  if (ts != null && !Number.isFinite(ts)) return false;

  // Conversation upsert — we always do this so messages don't orphan if
  // they arrive before their conversation row exists locally.
  const conv = row.conversation || {};
  try {
    ctx.upsertConversation.run(
      row.conversation_id,
      row.source,
      coalesceString(conv.title),
      coalesceInt(conv.first_ts),
      coalesceInt(conv.last_ts),
      0,
      coalesceString(conv.parent_conversation_id),
      coalesceString(conv.project_path),
    );
  } catch (err) {
    ctx.recordError(`conversation_upsert: ${err.message}`);
    return false;
  }

  // Detect whether we already have this message (so accepted/dedup counts
  // are correct even though ON CONFLICT swallows the case from SQLite's POV).
  const existed = ctx.existsCheck.get(
    row.source,
    row.conversation_id,
    row.msg_id ?? null,
  );

  // Generate-on-insert UUID per SYNC.md §UUID generation policy.
  const uuid = coalesceString(row.uuid) || randomUUID();

  try {
    ctx.insertMessage.run(
      row.source,
      row.conversation_id,
      row.msg_id ?? null,
      row.role,
      coalesceString(row.sender),
      row.text,
      ts,
      coalesceMetadata(row.metadata),
      coalesceInt(row.edited_at),
      uuid,
      coalesceString(row.channel),
    );
  } catch (err) {
    ctx.recordError(`message_insert: ${err.message}`);
    return false;
  }

  if (existed) ctx.countDedup();
  else         ctx.countAccepted();
  return true;
}

/** Read req body up to maxBytes; respond 413 if exceeded. Resolves to body or null. */
function readBody(req, res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        respondJson(res, 413, { error: 'payload_too_large' });
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', reject);
  });
}

function respondJson(res, status, obj) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function coalesceString(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

function coalesceInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Metadata is stored as TEXT in messages.metadata. We accept either a
 * JSON string (passthrough) or an object (stringify). Anything else
 * becomes null.
 */
function coalesceMetadata(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (_) { return null; }
  }
  return null;
}
