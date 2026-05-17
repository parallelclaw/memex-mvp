/**
 * GET / — dashboard overview.
 *
 * Read-only snapshot of the memex corpus: stats, sources breakdown,
 * pending Telegram exports, and recent conversations.
 */

import { renderPage, html, raw, esc, fmtDate, fmtNum } from '../templates.js';

const SOURCE_ICONS = {
  telegram: '📱',
  'claude-code': '💬',
  'claude-cowork': '🤝',
  cursor: '✏️',
  obsidian: '📓',
  document: '📄',
};

export async function renderDashboard(db, status) {
  // ----- Core stats -----
  const totalMessages = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE role NOT IN ('boundary', 'summary')")
    .get().n;
  const totalConversations = db
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE archived_at IS NULL')
    .get().n;
  const totalImports = db.prepare('SELECT COUNT(*) AS n FROM imports').get().n;
  const dateRange = db
    .prepare(
      "SELECT MIN(ts) AS first, MAX(ts) AS last FROM messages WHERE ts IS NOT NULL AND ts > 0 AND role NOT IN ('boundary', 'summary')"
    )
    .get();

  // ----- Sources breakdown -----
  const sources = db
    .prepare(
      `
      SELECT
        source,
        COUNT(*) AS msg_count,
        COUNT(DISTINCT conversation_id) AS conv_count,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts
      FROM messages
      WHERE role NOT IN ('boundary', 'summary')
      GROUP BY source
      ORDER BY msg_count DESC
    `
    )
    .all();

  // ----- Pending Telegram exports -----
  let pendingList = [];
  try {
    const { listPending } = await import('../../telegram-pending.js');
    pendingList = listPending();
  } catch (_) {
    /* pending module may be unavailable in stripped builds */
  }

  // ----- Recent conversations -----
  const recent = db
    .prepare(
      `
      SELECT conversation_id, source, title, last_ts, message_count
      FROM conversations
      WHERE archived_at IS NULL
        AND message_count > 0
      ORDER BY last_ts DESC
      LIMIT 10
    `
    )
    .all();

  // ----- Build HTML -----
  const statGrid = html`
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-value">${fmtNum(totalMessages)}</div>
        <div class="stat-label">messages</div>
      </div>
      <div class="stat">
        <div class="stat-value">${fmtNum(totalConversations)}</div>
        <div class="stat-label">conversations</div>
      </div>
      <div class="stat">
        <div class="stat-value">${fmtNum(sources.length)}</div>
        <div class="stat-label">sources</div>
      </div>
      <div class="stat">
        <div class="stat-value">${fmtNum(totalImports)}</div>
        <div class="stat-label">imports</div>
      </div>
    </div>
  `;

  const sourcesCard = html`
    <section class="card">
      <div class="card-label">sources</div>
      <ul class="sources-list">
        ${sources.map(
          (s) => html`
            <li>
              <span class="src-name">${raw(SOURCE_ICONS[s.source] || '•')} ${s.source}</span>
              <span class="src-meta">${fmtNum(s.msg_count)} msgs · ${fmtNum(s.conv_count)} chats</span>
              <span class="src-spacer"></span>
              <span class="src-meta">${fmtDate(s.first_ts)} → ${fmtDate(s.last_ts)}</span>
            </li>
          `
        )}
      </ul>
    </section>
  `;

  const pendingCallout = pendingList.length
    ? html`
        <div class="callout">
          <strong>📬 ${pendingList.length} Telegram export${pendingList.length === 1 ? '' : 's'} awaiting review</strong>
          —
          ${pendingList
            .slice(0, 3)
            .map((p) => esc(p.chat_title || p.basename || '?'))
            .join(', ')}${pendingList.length > 3 ? `, + ${pendingList.length - 3} more` : ''}
          · <a href="/pending">Review →</a>
        </div>
      `
    : null;

  const recentCard = html`
    <section class="card">
      <div class="card-label">recent conversations</div>
      <div class="conv-list">
        ${recent.map(
          (c) => html`
            <a class="conv-item" href="/c/${encodeURIComponent(c.conversation_id)}">
              <div class="conv-item-top">
                <span class="conv-title">${c.title || '(untitled)'}</span>
                <span class="conv-count">${fmtNum(c.message_count)} msgs</span>
              </div>
              <div class="conv-meta">
                <span class="conv-source-tag">${c.source}</span>
                ${fmtDate(c.last_ts)}
              </div>
            </a>
          `
        )}
        ${recent.length === 0
          ? html`<div class="empty"><h3>No conversations yet</h3><p>Wait for memex-sync to capture, or import Telegram exports.</p></div>`
          : null}
      </div>
      ${recent.length > 0
        ? html`<p style="margin-top:14px;text-align:right;"><a href="/conversations">All conversations →</a></p>`
        : null}
    </section>
  `;

  const corpusSpan = dateRange.first
    ? html`<p class="conv-meta" style="margin-top:6px;">Corpus span: ${fmtDate(dateRange.first)} → ${fmtDate(dateRange.last)}</p>`
    : null;

  const body = html`
    ${statGrid}
    ${corpusSpan}
    ${pendingCallout}
    ${sourcesCard}
    ${recentCard}
  `;

  return renderPage({
    title: 'Dashboard',
    active: 'dashboard',
    body,
    status,
  });
}
