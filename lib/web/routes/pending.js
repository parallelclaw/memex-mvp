/**
 * GET /pending — Telegram exports awaiting decision.
 * POST /pending/import — import selected entries (form data, name="index").
 * POST /pending/skip   — skip selected entries (same form).
 *
 * Reuses lib/telegram-pending.js (listPending/removePending) and
 * lib/telegram-decisions.js (allowChat/skipChat/loadDecisions/saveDecisions).
 * Imports require a writable DB handle, opened locally and closed on completion.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

import { renderPage, html, raw, esc, fmtDate, fmtNum, fmtBytes } from '../templates.js';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DB_PATH = join(MEMEX_DIR, 'data', 'memex.db');

function openWritableDb() {
  return new Database(DB_PATH, { fileMustExist: true });
}

function renderPendingList(pendingList) {
  if (pendingList.length === 0) {
    return html`
      <div class="empty">
        <h3>Inbox empty</h3>
        <p>Export a chat from Telegram Desktop (Settings → Advanced → Export) — memex-sync will stage it here for review.</p>
      </div>
    `;
  }

  return html`
    <form id="pending-form" method="post" hx-target="#pending-target" hx-swap="innerHTML">
      <div class="pending-list">
        ${pendingList.map(
          (p) => html`
            <div class="pending-item">
              <div class="pending-item-top">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;flex:1;">
                  <input type="checkbox" name="index" value="${p.index}" />
                  <span class="pending-title">📱 ${p.chat_title || p.basename || '(unknown)'}</span>
                </label>
                <span class="pending-count">${fmtNum(p.message_count || 0)} msgs</span>
              </div>
              <div class="pending-meta">
                ${p.date_first ? esc(p.date_first.slice(0, 10)) : '?'} → ${p.date_last ? esc(p.date_last.slice(0, 10)) : '?'}
                · <code>${esc(p.basename)}</code>
                ${p.size_bytes ? ' · ' + fmtBytes(p.size_bytes) : ''}
                ${p.senders_sample && p.senders_sample.length
                  ? raw(' · senders: ' + esc(p.senders_sample.slice(0, 3).join(', ')) + (p.senders_sample.length > 3 ? ', …' : ''))
                  : null}
              </div>
            </div>
          `
        )}
      </div>
      <div class="pending-actions" style="margin-top:16px;">
        <button type="submit" class="btn btn-primary" hx-post="/pending/import">Import selected</button>
        <button type="submit" class="btn btn-danger" hx-post="/pending/skip">Skip selected</button>
        <span class="search-meta" style="margin-left:auto;align-self:center;">
          ${fmtNum(pendingList.length)} pending
        </span>
      </div>
    </form>
  `;
}

function renderDecisionsSection() {
  let state;
  try {
    // Lazy import — avoids loading at server boot when decisions don't exist yet
    // (re-require'd via dynamic import below since decisions is ESM).
    return null;
  } catch (_) {
    return null;
  }
}

async function loadDecisionsState() {
  try {
    const { loadDecisions } = await import('../../telegram-decisions.js');
    return loadDecisions();
  } catch (_) {
    return null;
  }
}

export async function renderPending(status) {
  const { listPending } = await import('../../telegram-pending.js');
  const pendingList = listPending();
  const decisions = await loadDecisionsState();

  const allowed = decisions?.allowed ? Object.keys(decisions.allowed) : [];
  const skipped = decisions?.skipped ? Object.keys(decisions.skipped) : [];
  const blocked = decisions?.blocked ? Object.keys(decisions.blocked) : [];

  const decisionsCard =
    allowed.length || skipped.length || blocked.length
      ? html`
          <section class="card" style="margin-top:24px;">
            <div class="card-label">your decisions (history)</div>
            <ul class="sources-list">
              <li>
                <span class="src-name">✅ Allowed</span>
                <span class="src-meta">${fmtNum(allowed.length)}${allowed.length ? ': ' + esc(allowed.slice(0, 6).join(', ')) + (allowed.length > 6 ? ', …' : '') : ''}</span>
              </li>
              <li>
                <span class="src-name">⏭️ Skipped</span>
                <span class="src-meta">${fmtNum(skipped.length)}${skipped.length ? ': ' + esc(skipped.slice(0, 6).join(', ')) + (skipped.length > 6 ? ', …' : '') : ''}</span>
              </li>
              <li>
                <span class="src-name">🚫 Blocked patterns</span>
                <span class="src-meta">${fmtNum(blocked.length)}${blocked.length ? ': ' + esc(blocked.slice(0, 6).join(', ')) + (blocked.length > 6 ? ', …' : '') : ''}</span>
              </li>
            </ul>
          </section>
        `
      : null;

  const body = html`
    <div class="callout">
      <strong>Privacy-first.</strong> Telegram exports stay on disk until you import them.
      Importing is a one-way decision — once in memex.db they can be searched and removed via
      <code>memex telegram remove "&lt;title&gt;"</code>.
    </div>
    <div id="pending-target">${renderPendingList(pendingList)}</div>
    ${decisionsCard}
  `;

  return renderPage({
    title: 'Pending',
    active: 'pending',
    body,
    status,
  });
}

// ----- POST handlers -----

function parseIndices(body) {
  const raw = body.index;
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function resolveTargets(pendingList, indices) {
  const byIdx = new Map(pendingList.map((p) => [p.index, p]));
  const out = [];
  for (const i of indices) {
    const p = byIdx.get(i);
    if (p) out.push(p);
  }
  return out;
}

export async function handleImport(body) {
  const { listPending, removePending } = await import('../../telegram-pending.js');
  const decisionsMod = await import('../../telegram-decisions.js');
  const pendingList = listPending();
  const indices = parseIndices(body);

  if (indices.length === 0) {
    return wrapFragment(html`
      <div class="callout" style="border-left-color:var(--amber);">
        <strong>Select at least one entry</strong> — tick the checkboxes you want to import.
      </div>
      ${renderPendingList(pendingList)}
    `);
  }

  const targets = resolveTargets(pendingList, indices);
  if (targets.length === 0) {
    return wrapFragment(html`
      <div class="callout" style="border-left-color:var(--red-soft);">
        <strong>Stale selection</strong> — the entries you selected are no longer in pending.
      </div>
      ${renderPendingList(pendingList)}
    `);
  }

  const { importTelegramRaw } = await import('../../import-telegram.js');
  const { parseTelegramHtmlExport } = await import('../../parse-telegram-html.js');
  const state = decisionsMod.loadDecisions();

  const results = [];
  const db = openWritableDb();
  try {
    for (const t of targets) {
      try {
        let raw;
        if (t.kind === 'html-dir') {
          raw = parseTelegramHtmlExport(t.path);
        } else if (t.kind === 'json-file') {
          raw = JSON.parse(readFileSync(t.path, 'utf-8'));
        } else if (t.kind === 'json-in-dir' && t.inner_json_path) {
          raw = JSON.parse(readFileSync(t.inner_json_path, 'utf-8'));
        } else {
          results.push({ title: t.chat_title, error: `unknown kind: ${t.kind}` });
          continue;
        }
        if (!raw) {
          results.push({ title: t.chat_title, error: 'parse-failed' });
          continue;
        }
        const r = importTelegramRaw(db, raw);
        const title = raw.chats?.list?.[0]?.name || t.chat_title || 'Telegram chat';
        decisionsMod.allowChat(state, title);
        removePending(t.path);
        results.push({ title, imported: r.totalImported });
      } catch (e) {
        results.push({ title: t.chat_title, error: e.message });
      }
    }
    decisionsMod.saveDecisions(state);
  } finally {
    db.close();
  }

  const updated = listPending();
  const okCount = results.filter((r) => !r.error).length;
  const errCount = results.filter((r) => r.error).length;
  const totalMsgs = results.reduce((s, r) => s + (r.imported || 0), 0);

  return wrapFragment(html`
    <div class="callout">
      <strong>✓ Imported ${fmtNum(okCount)} chat${okCount === 1 ? '' : 's'}</strong>
      — ${fmtNum(totalMsgs)} message${totalMsgs === 1 ? '' : 's'} now in memex.db.
      ${errCount > 0 ? raw(`<br/><span style="color:var(--red-soft);">⚠ ${errCount} failed: ${results.filter(r => r.error).map(r => esc(r.title || '?') + ' (' + esc(r.error) + ')').join(', ')}</span>`) : null}
    </div>
    ${renderPendingList(updated)}
  `);
}

export async function handleSkip(body) {
  const { listPending, removePending } = await import('../../telegram-pending.js');
  const decisionsMod = await import('../../telegram-decisions.js');
  const pendingList = listPending();
  const indices = parseIndices(body);

  if (indices.length === 0) {
    return wrapFragment(html`
      <div class="callout" style="border-left-color:var(--amber);">
        <strong>Select at least one entry</strong> — tick the checkboxes you want to skip.
      </div>
      ${renderPendingList(pendingList)}
    `);
  }

  const targets = resolveTargets(pendingList, indices);
  const state = decisionsMod.loadDecisions();
  for (const t of targets) {
    if (t.chat_title) decisionsMod.skipChat(state, t.chat_title);
    removePending(t.path);
  }
  decisionsMod.saveDecisions(state);

  const updated = listPending();
  return wrapFragment(html`
    <div class="callout">
      <strong>⏭️ Skipped ${fmtNum(targets.length)} entr${targets.length === 1 ? 'y' : 'ies'}.</strong>
      Future re-exports of these chats will be auto-skipped.
    </div>
    ${renderPendingList(updated)}
  `);
}

// htmx hx-target="#pending-target" → we return the inner HTML for that div.
function wrapFragment(node) {
  return node && typeof node === 'object' && node.value ? node.value : String(node);
}
