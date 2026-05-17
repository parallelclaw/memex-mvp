/**
 * GET /settings — read-only configuration & status.
 *
 * Shows where the daemon is, what's running, what's installed.
 * No write actions — those happen via CLI (`memex hook install`, etc.)
 * to keep the web UI safe from accidental clicks.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { renderPage, html, raw, esc, fmtBytes, fmtDateTime } from '../templates.js';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DB_PATH = join(MEMEX_DIR, 'data', 'memex.db');
const INBOX_DIR = join(MEMEX_DIR, 'inbox');
const PLIST_PATH = join(HOME, 'Library/LaunchAgents/com.parallelclaw.memex.sync.plist');
const SETTINGS_PATH = join(HOME, '.claude/settings.json');

function tryStat(p) {
  try {
    return statSync(p);
  } catch (_) {
    return null;
  }
}

function safeRead(p) {
  try {
    const { readFileSync } = require('node:fs');
    return readFileSync(p, 'utf-8');
  } catch (_) {
    return null;
  }
}

function sessionStartHookInstalled() {
  // Soft check — look for "memex hook" inside ~/.claude/settings.json
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs');
    const txt = readFileSync(SETTINGS_PATH, 'utf-8');
    return /memex\s+hook/.test(txt) || /memex-mvp/.test(txt);
  } catch (_) {
    return false;
  }
}

export async function renderSettings(db, status) {
  // ----- Daemon -----
  const plistStat = tryStat(PLIST_PATH);
  const dbStat = tryStat(DB_PATH);
  const ingestLogStat = tryStat(join(MEMEX_DIR, 'data', 'ingest.log'));

  // ----- Sources (count of conversations per source) -----
  const sourceRows = db
    .prepare(
      `
      SELECT source,
             COUNT(*) AS conv_count,
             SUM(message_count) AS msg_count
      FROM conversations
      WHERE archived_at IS NULL
      GROUP BY source
      ORDER BY msg_count DESC
    `
    )
    .all();

  // ----- Pending count -----
  let pendingCount = 0;
  try {
    const { listPending } = await import('../../telegram-pending.js');
    pendingCount = listPending().length;
  } catch (_) {
    /* optional */
  }

  // ----- Decisions count -----
  let decisionStats = null;
  try {
    const { loadDecisions } = await import('../../telegram-decisions.js');
    const d = loadDecisions();
    decisionStats = {
      mode: d.mode || 'pick',
      allowed: d.allowed ? Object.keys(d.allowed).length : 0,
      skipped: d.skipped ? Object.keys(d.skipped).length : 0,
      blocked: d.blocked ? Object.keys(d.blocked).length : 0,
    };
  } catch (_) {
    /* optional */
  }

  const daemonState = status?.running
    ? html`<span class="status-pill ok">🟢 running</span>`
    : status?.installed
    ? html`<span class="status-pill stale">🔴 installed but stopped</span>`
    : html`<span class="status-pill">⚪ not installed</span>`;

  const daemonCard = html`
    <section class="card">
      <div class="card-label">daemon</div>
      <ul class="sources-list">
        <li>
          <span class="src-name">Status</span>
          <span class="src-meta">${daemonState}</span>
        </li>
        <li>
          <span class="src-name">LaunchAgent</span>
          <span class="src-meta">${plistStat ? raw('<code>' + esc(PLIST_PATH) + '</code>') : 'not installed'}</span>
        </li>
        <li>
          <span class="src-name">Last capture</span>
          <span class="src-meta">${ingestLogStat ? fmtDateTime(Math.floor(ingestLogStat.mtimeMs / 1000)) : '—'}</span>
        </li>
      </ul>
      <p class="conv-meta" style="margin-top:14px;">
        Manage via CLI: <code>memex-sync install</code> · <code>memex-sync uninstall</code> · <code>launchctl unload …</code>
      </p>
    </section>
  `;

  const dbCard = html`
    <section class="card">
      <div class="card-label">database</div>
      <ul class="sources-list">
        <li>
          <span class="src-name">Path</span>
          <span class="src-meta"><code>${esc(DB_PATH)}</code></span>
        </li>
        <li>
          <span class="src-name">Size</span>
          <span class="src-meta">${dbStat ? fmtBytes(dbStat.size) : '—'}</span>
        </li>
        <li>
          <span class="src-name">Inbox</span>
          <span class="src-meta"><code>${esc(INBOX_DIR)}</code> ${pendingCount > 0 ? raw(' · <strong>' + pendingCount + ' pending</strong>') : ''}</span>
        </li>
      </ul>
    </section>
  `;

  const sourcesCard = html`
    <section class="card">
      <div class="card-label">sources captured</div>
      <ul class="sources-list">
        ${sourceRows.length === 0
          ? html`<li><span class="src-meta">No sources captured yet.</span></li>`
          : sourceRows.map(
              (s) => html`
                <li>
                  <span class="src-name">${s.source}</span>
                  <span class="src-meta">${s.conv_count} chats · ${s.msg_count} msgs</span>
                </li>
              `
            )}
      </ul>
    </section>
  `;

  const hookCard = html`
    <section class="card">
      <div class="card-label">hooks</div>
      <ul class="sources-list">
        <li>
          <span class="src-name">SessionStart (Claude Code)</span>
          <span class="src-meta">${sessionStartHookInstalled()
            ? raw('<span class="status-pill ok">✓ installed</span>')
            : raw('<span class="status-pill">— not installed</span>')}</span>
        </li>
      </ul>
      <p class="conv-meta" style="margin-top:14px;">
        Install: <code>memex hook install</code> · Uninstall: <code>memex hook uninstall</code>
      </p>
    </section>
  `;

  const decisionsCard = decisionStats
    ? html`
        <section class="card">
          <div class="card-label">telegram decisions</div>
          <ul class="sources-list">
            <li>
              <span class="src-name">Mode</span>
              <span class="src-meta">${decisionStats.mode}</span>
            </li>
            <li>
              <span class="src-name">Allowed</span>
              <span class="src-meta">${decisionStats.allowed}</span>
            </li>
            <li>
              <span class="src-name">Skipped</span>
              <span class="src-meta">${decisionStats.skipped}</span>
            </li>
            <li>
              <span class="src-name">Blocked patterns</span>
              <span class="src-meta">${decisionStats.blocked}</span>
            </li>
          </ul>
          <p class="conv-meta" style="margin-top:14px;">
            Manage via CLI: <code>memex telegram allow|skip|block|unblock|mode</code>
          </p>
        </section>
      `
    : null;

  const body = html`
    <div class="callout">
      Read-only view. Destructive operations (uninstall, remove data) live in the CLI to prevent accidental clicks.
    </div>
    ${daemonCard}
    ${dbCard}
    ${sourcesCard}
    ${hookCard}
    ${decisionsCard}
  `;

  return renderPage({
    title: 'Settings',
    active: 'settings',
    body,
    status,
  });
}
