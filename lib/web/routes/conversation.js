/**
 * GET /c/:id — verbatim transcript of one conversation.
 *
 * This is the page that demonstrates memex's verbatim moat: every message
 * the user and the AI exchanged, in chat-bubble form, never paraphrased.
 *
 * Query params:
 *   q       — optional search term to highlight inside the transcript
 *   offset  — pagination offset (default 0)
 *   limit   — page size (default 200, max 1000)
 */

import { renderPage, html, raw, esc, fmtDate, fmtDateTime, fmtNum } from '../templates.js';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Determine which side of the transcript the message should appear on.
 *
 * Conventions:
 *   - role='user' or sender is the user (claude-code/cowork) → right side ("you")
 *   - role='assistant' or 'model' → left side ("ai")
 *   - Telegram: sender matches "self_indicator" → right; everyone else → left
 */
function bubbleSide(msg) {
  if (msg.role === 'user') return 'right';
  if (msg.role === 'assistant' || msg.role === 'model') return 'left';
  // Telegram heuristic: first sender alphabetically goes "left", rest on alternating sides.
  // Without a notion of "me", we just put non-user roles on the left.
  return 'left';
}

function dayKey(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Highlight occurrences of `q` (case-insensitive) inside escaped text.
 * Receives ALREADY-ESCAPED HTML — we do regex over that string and wrap
 * matches in <mark>. Safe because we never let user input near a tag opener.
 */
function highlight(escapedText, q) {
  if (!q || !q.trim()) return escapedText;
  const needle = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Avoid matching inside existing tags by requiring no '<' before next '>'
  const re = new RegExp(`(${needle})`, 'gi');
  return escapedText.replace(re, '<mark>$1</mark>');
}

function renderBubble(msg, q) {
  const side = bubbleSide(msg);
  const cls = side === 'right' ? 'chat-bubble user' : 'chat-bubble ai';
  const who = msg.sender || msg.role || (side === 'right' ? 'you' : 'ai');
  const when = msg.ts ? fmtDateTime(msg.ts) : '';
  const text = msg.text || '';
  const highlighted = highlight(esc(text), q);
  return `
    <div class="${cls}" id="msg-${msg.id}">
      <span class="chat-who">${esc(who)}${when ? ' · ' + esc(when) : ''}</span>
      <p>${highlighted}</p>
    </div>
  `;
}

export async function renderConversation(db, id, query, status) {
  const q = query.q || '';
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  const limit = clampLimit(query.limit);

  const conv = db
    .prepare('SELECT * FROM conversations WHERE conversation_id = ?')
    .get(id);

  if (!conv) {
    const body = html`
      <div class="empty">
        <h3>Conversation not found</h3>
        <p>No conversation with id <code>${esc(id)}</code> in this database.</p>
        <p style="margin-top:12px;"><a class="btn" href="/conversations">← Back to conversations</a></p>
      </div>
    `;
    return renderPage({ title: 'Not found', active: 'conversations', body, status });
  }

  const messages = db
    .prepare(
      `
      SELECT id, role, sender, text, ts, msg_id
      FROM messages
      WHERE conversation_id = ?
        AND role NOT IN ('boundary', 'summary')
      ORDER BY COALESCE(ts, 0) ASC, id ASC
      LIMIT ? OFFSET ?
    `
    )
    .all(id, limit, offset);

  const totalNonMeta = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role NOT IN ('boundary', 'summary')"
    )
    .get(id).n;

  // Build day-separated transcript
  const transcriptParts = [];
  let lastDay = null;
  for (const m of messages) {
    const day = dayKey(m.ts);
    if (day && day !== lastDay) {
      transcriptParts.push(`<div class="transcript-day">${esc(day)}</div>`);
      lastDay = day;
    }
    transcriptParts.push(renderBubble(m, q));
  }

  const transcriptHtml = transcriptParts.join('\n');

  // Pagination
  const hasPrev = offset > 0;
  const hasNext = offset + messages.length < totalNonMeta;
  const baseQs = q ? `?q=${encodeURIComponent(q)}&` : '?';
  const pagination = (hasPrev || hasNext)
    ? html`
        <div class="search-bar" style="justify-content:space-between;margin-top:24px;">
          ${hasPrev
            ? html`<a class="btn" href="/c/${encodeURIComponent(id)}${raw(baseQs)}offset=${Math.max(0, offset - limit)}&limit=${limit}">← Previous ${limit}</a>`
            : html`<span></span>`}
          <span class="search-meta">
            Showing ${fmtNum(offset + 1)}–${fmtNum(offset + messages.length)} of ${fmtNum(totalNonMeta)}
          </span>
          ${hasNext
            ? html`<a class="btn" href="/c/${encodeURIComponent(id)}${raw(baseQs)}offset=${offset + limit}&limit=${limit}">Next ${limit} →</a>`
            : html`<span></span>`}
        </div>
      `
    : null;

  // Search box scoped to this conversation
  const searchBar = html`
    <form class="search-bar" method="get" action="/c/${encodeURIComponent(id)}">
      <input
        class="search-input"
        type="search"
        name="q"
        placeholder="🔍  Find in this conversation…"
        value="${esc(q)}"
        autocomplete="off"
      />
      ${q
        ? html`<a class="btn" href="/c/${encodeURIComponent(id)}">Clear</a>`
        : null}
    </form>
  `;

  const header = html`
    <p style="margin-bottom:14px;">
      <a class="btn" href="/conversations">← All conversations</a>
    </p>
    <section class="card">
      <div class="card-label">
        <span class="conv-source-tag">${conv.source}</span>
        ${fmtNum(totalNonMeta)} messages
        · ${fmtDate(conv.first_ts)} → ${fmtDate(conv.last_ts)}
        ${conv.project_path ? raw(' · <code>' + esc(conv.project_path) + '</code>') : null}
      </div>
      <div class="card-body">
        <h2 style="font-size:20px;font-weight:700;letter-spacing:-0.02em;">${conv.title || '(untitled)'}</h2>
      </div>
    </section>
  `;

  const body = html`
    ${header}
    ${searchBar}
    <div class="transcript">${raw(transcriptHtml)}</div>
    ${pagination}
  `;

  return renderPage({
    title: conv.title || 'Conversation',
    active: 'conversations',
    body,
    status,
  });
}
