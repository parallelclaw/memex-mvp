/**
 * GET /conversations — list with optional FTS5 search.
 * GET /conversations/search — htmx partial (just the list).
 *
 * Query params:
 *   q       — search query (FTS5 MATCH)
 *   source  — filter by source ("telegram", "claude-code", etc.)
 *   limit   — page size (default 50, max 200)
 */

import { renderPage, html, raw, esc, fmtDate, fmtNum } from '../templates.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const SOURCES = ['telegram', 'claude-code', 'claude-cowork', 'cursor', 'obsidian', 'document'];

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Build the conv-list HTML for either full page or htmx partial.
 * Branches on whether `q` is present:
 *   - With q: FTS5 over messages_fts, group by conversation, rank by recency-boosted BM25
 *   - Without q: list conversations directly by last_ts DESC
 */
function fetchConversations(db, { q, source, limit }) {
  if (q && q.trim()) {
    // Sanitise query for FTS5: strip control chars but keep words/quotes/spaces.
    const safe = q.trim().replace(/[^\p{L}\p{N}\s"'._-]/gu, ' ');
    const sourceFilter = source ? 'AND c.source = @source' : '';
    // snippet() can't survive an outer GROUP BY — we just count hits per chat.
    // The snippet itself is rendered inside /c/:id?q=... via the highlight() helper.
    const stmt = db.prepare(`
      SELECT
        c.conversation_id,
        c.source,
        c.title,
        c.last_ts,
        c.message_count,
        COUNT(m.id) AS hit_count,
        NULL AS snippet
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN conversations c ON c.conversation_id = m.conversation_id
      WHERE messages_fts MATCH @q
        AND c.archived_at IS NULL
        ${sourceFilter}
      GROUP BY c.conversation_id
      ORDER BY c.last_ts DESC
      LIMIT @limit
    `);
    return stmt.all({ q: safe, source, limit });
  }

  const sourceFilter = source ? 'AND source = @source' : '';
  return db
    .prepare(
      `
      SELECT conversation_id, source, title, last_ts, message_count,
             0 AS hit_count, NULL AS snippet
      FROM conversations
      WHERE archived_at IS NULL
        AND message_count > 0
        ${sourceFilter}
      ORDER BY last_ts DESC
      LIMIT @limit
    `
    )
    .all({ source, limit });
}

function renderList(rows, { q }) {
  if (rows.length === 0) {
    return html`
      <div class="empty">
        <h3>${q ? 'No matches' : 'No conversations'}</h3>
        <p>${q ? 'Try a different query or remove filters.' : 'Wait for memex-sync to capture, or import Telegram exports.'}</p>
      </div>
    `;
  }

  return html`
    <div class="conv-list">
      ${rows.map(
        (c) => html`
          <a class="conv-item" href="/c/${encodeURIComponent(c.conversation_id)}${q ? '?q=' + encodeURIComponent(q) : ''}">
            <div class="conv-item-top">
              <span class="conv-title">${c.title || '(untitled)'}</span>
              <span class="conv-count">
                ${c.hit_count > 0 ? `${fmtNum(c.hit_count)} hits · ` : ''}${fmtNum(c.message_count)} msgs
              </span>
            </div>
            <div class="conv-meta">
              <span class="conv-source-tag">${c.source}</span>
              ${fmtDate(c.last_ts)}
              ${c.snippet ? raw(` · <span class="search-meta">${c.snippet}</span>`) : null}
            </div>
          </a>
        `
      )}
    </div>
  `;
}

export async function renderConversations(db, query, status) {
  const q = query.q || '';
  const source = query.source && SOURCES.includes(query.source) ? query.source : '';
  const limit = clampLimit(query.limit);

  let rows;
  let error = null;
  try {
    rows = fetchConversations(db, { q, source, limit });
  } catch (e) {
    rows = [];
    error = e.message;
  }

  const sourceChips = html`
    <div class="search-bar" style="gap:6px;">
      <a class="btn ${source ? '' : 'btn-primary'}" href="/conversations${q ? '?q=' + encodeURIComponent(q) : ''}">all</a>
      ${SOURCES.map(
        (s) => html`
          <a class="btn ${source === s ? 'btn-primary' : ''}" href="/conversations?source=${s}${q ? '&q=' + encodeURIComponent(q) : ''}">${s}</a>
        `
      )}
    </div>
  `;

  const searchBar = html`
    <form class="search-bar" hx-get="/conversations/search" hx-target="#conv-list-target" hx-trigger="input changed delay:200ms, search" hx-include="[name=source]">
      <input
        class="search-input"
        type="search"
        name="q"
        placeholder="🔍  Search conversations (FTS5)…"
        value="${esc(q)}"
        autocomplete="off"
      />
      <input type="hidden" name="source" value="${esc(source)}" />
      <span class="search-meta">${fmtNum(rows.length)} result${rows.length === 1 ? '' : 's'}${source ? ' · ' + source : ''}</span>
    </form>
  `;

  const body = html`
    ${searchBar}
    ${sourceChips}
    ${error
      ? html`<div class="callout" style="border-left-color:var(--red-soft);"><strong>Search error:</strong> ${esc(error)}</div>`
      : null}
    <div id="conv-list-target">${renderList(rows, { q })}</div>
  `;

  return renderPage({
    title: 'Conversations',
    active: 'conversations',
    body,
    status,
  });
}

export async function renderConversationsPartial(db, query) {
  const q = query.q || '';
  const source = query.source && SOURCES.includes(query.source) ? query.source : '';
  const limit = clampLimit(query.limit);

  let rows;
  try {
    rows = fetchConversations(db, { q, source, limit });
  } catch (e) {
    return `<div class="callout" style="border-left-color:var(--red-soft);"><strong>Search error:</strong> ${esc(e.message)}</div>`;
  }

  const out = renderList(rows, { q });
  return out && typeof out === 'object' && out.value ? out.value : String(out);
}
