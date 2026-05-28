/**
 * GET /sync/pull?since=<int>&limit=<int> — return rows the caller hasn't seen.
 *
 * Wire contract (see SYNC.md §Wire protocol):
 *
 *   Query:
 *     since   — caller's last-seen local id from this server (0 = first pull)
 *     limit   — max rows; default 500, hard cap 1000
 *
 *   Response: {
 *     rows:        [Row, ...],    // ordered by id ASC, id > since
 *     next_cursor: <int>,         // id of the last row in this batch
 *                                  // (caller passes this as since= next time)
 *     has_more:    bool,          // true → more rows wait; caller should
 *                                  // re-pull immediately with the new cursor
 *     server_now:  <ms_epoch>     // informational
 *   }
 *
 * Each Row matches the shape POST /sync/push expects, including the embedded
 * conversation metadata (so the receiver can upsert without a separate
 * join-and-fetch round trip).
 *
 * Conversation embedding is denormalised on read: we LEFT JOIN conversations
 * and inline the columns. For a typical 500-row pull this is one query.
 */

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

export function makePullHandler({ db }) {
  if (!db) throw new Error('makePullHandler: db is required');

  // One query, LEFT JOIN — every message also surfaces its conversation row
  // for the receiver's upsert. Order is critical: ASC by id ensures the
  // cursor (max id returned) is monotonic across pulls.
  const fetchSince = db.prepare(`
    SELECT
      m.id                              AS id,
      m.source                          AS source,
      m.conversation_id                 AS conversation_id,
      m.msg_id                          AS msg_id,
      m.role                            AS role,
      m.sender                          AS sender,
      m.text                            AS text,
      m.ts                              AS ts,
      m.edited_at                       AS edited_at,
      m.uuid                            AS uuid,
      m.channel                         AS channel,
      m.metadata                        AS metadata,
      c.title                           AS conv_title,
      c.first_ts                        AS conv_first_ts,
      c.last_ts                         AS conv_last_ts,
      c.parent_conversation_id          AS conv_parent,
      c.project_path                    AS conv_project_path
    FROM messages m
    LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
    WHERE m.id > ?
    ORDER BY m.id ASC
    LIMIT ?
  `);

  return function pullHandler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'https://placeholder.local');
    } catch (_) {
      return respondJson(res, 400, { error: 'bad_request', detail: 'malformed URL' });
    }

    const sinceRaw = url.searchParams.get('since') ?? '0';
    const limitRaw = url.searchParams.get('limit') ?? String(DEFAULT_LIMIT);

    const since = parseNonNegInt(sinceRaw);
    if (since == null) {
      return respondJson(res, 400, { error: 'bad_request', detail: 'since must be a non-negative integer' });
    }
    const limit = clampLimit(limitRaw);

    let rows;
    try {
      rows = fetchSince.all(since, limit + 1);
    } catch (err) {
      return respondJson(res, 500, { error: 'internal', detail: err.message });
    }

    // If we fetched limit+1, the extra row indicates there's more after this batch.
    const has_more = rows.length > limit;
    if (has_more) rows = rows.slice(0, limit);

    const wireRows = rows.map(rowToWire);
    const next_cursor = wireRows.length
      ? wireRows[wireRows.length - 1].id_serverside
      : since;

    // Strip the bookkeeping field — id_serverside was only for next_cursor.
    for (const r of wireRows) delete r.id_serverside;

    respondJson(res, 200, {
      rows: wireRows,
      next_cursor,
      has_more,
      server_now: Date.now(),
    });
  };
}

/**
 * Map a SQLite-row into the wire Row shape per SYNC.md. We tuck the
 * server-side id into a temporary `id_serverside` field so the caller of
 * makePullHandler can compute next_cursor without re-iterating. Field is
 * removed before serialization.
 */
function rowToWire(r) {
  return {
    source:          r.source,
    conversation_id: r.conversation_id,
    msg_id:          r.msg_id,
    uuid:            r.uuid,
    role:            r.role,
    sender:          r.sender,
    text:            r.text,
    ts:              r.ts,
    edited_at:       r.edited_at,
    channel:         r.channel,
    metadata:        r.metadata,
    conversation: {
      title:                   r.conv_title,
      first_ts:                r.conv_first_ts,
      last_ts:                 r.conv_last_ts,
      parent_conversation_id:  r.conv_parent,
      project_path:            r.conv_project_path,
    },
    id_serverside: r.id, // stripped before response
  };
}

function parseNonNegInt(s) {
  if (s == null) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return Math.trunc(n);
}

function clampLimit(s) {
  const n = parseNonNegInt(s);
  if (n == null || n === 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function respondJson(res, status, obj) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
