/**
 * Read-only search against memex.db for the bot's /search and /recent
 * slash-commands. Uses better-sqlite3 directly — server.js uses WAL mode
 * so concurrent readers are safe.
 *
 * Lazy DB open: don't error at startup if memex.db doesn't exist yet
 * (first-time install where the bot fires before the MCP server has run).
 * Open on first call instead and surface a friendly message.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

let db = null;
let openError = null;

function ensureDb(dbPath) {
  if (db) return db;
  if (openError) return null;
  if (!existsSync(dbPath)) {
    openError = `memex.db not found at ${dbPath}. Run the memex MCP server at least once first.`;
    return null;
  }
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
  } catch (e) {
    openError = `failed to open memex.db: ${e.message}`;
    return null;
  }
  return db;
}

function shortDate(unixTs) {
  if (!unixTs) return '?';
  const d = new Date(unixTs * 1000);
  // YYYY-MM-DD HH:MM
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function sourceLabel(source) {
  switch (source) {
    case 'claude-code': return 'Claude Code';
    case 'claude-cowork': return 'Cowork';
    case 'cursor': return 'Cursor';
    case 'obsidian': return 'Obsidian';
    case 'telegram': return 'Telegram';
    default: return source || '?';
  }
}

function escapeMarkdown(s) {
  // Telegram MarkdownV1 is forgiving — only escape backticks and underscores
  // we actually emit as raw text; we wrap snippets in code blocks so this is
  // mostly defensive.
  return String(s || '').replace(/`/g, "'");
}

/**
 * FTS5 search. Returns up to `limit` rows, one row per match (not grouped).
 * Each row: { snippet, title, source, conversation_id, ts }
 */
export function searchMemex({ dbPath, query, limit = 3 }) {
  const conn = ensureDb(dbPath);
  if (!conn) return { error: openError };
  const q = String(query || '').trim();
  if (!q) return { error: 'empty query' };

  let rows;
  try {
    rows = conn
      .prepare(
        `SELECT m.text AS text,
                m.ts AS ts,
                m.source AS source,
                m.conversation_id AS conversation_id,
                c.title AS title,
                snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet
           FROM messages_fts
           JOIN messages m ON messages_fts.rowid = m.id
      LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
          WHERE messages_fts MATCH ?
            AND (c.archived_at IS NULL OR c.archived_at = 0)
       ORDER BY rank
          LIMIT ?`
      )
      .all(q, limit);
  } catch (e) {
    return { error: `search failed: ${e.message}` };
  }
  return { rows };
}

/** Most recent N user-facing messages, time-sorted. */
export function recentMemex({ dbPath, limit = 5 }) {
  const conn = ensureDb(dbPath);
  if (!conn) return { error: openError };
  let rows;
  try {
    rows = conn
      .prepare(
        `SELECT m.text AS text,
                m.ts AS ts,
                m.source AS source,
                m.conversation_id AS conversation_id,
                c.title AS title
           FROM messages m
      LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
          WHERE (c.archived_at IS NULL OR c.archived_at = 0)
            AND m.text IS NOT NULL
            AND length(m.text) > 0
       ORDER BY m.ts DESC
          LIMIT ?`
      )
      .all(limit);
  } catch (e) {
    return { error: `recent failed: ${e.message}` };
  }
  return { rows };
}

/** Render search results as a single Telegram message body. */
export function renderSearchResults(query, rows) {
  if (!rows || rows.length === 0) {
    return `🔍 No matches for *${escapeMarkdown(query)}*`;
  }
  const parts = [`🔍 Top ${rows.length} for *${escapeMarkdown(query)}*\n`];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const title = r.title ? r.title.slice(0, 80) : r.conversation_id;
    const snippet = (r.snippet || r.text || '').replace(/\s+/g, ' ').slice(0, 240);
    parts.push(
      `*${i + 1}.* [${sourceLabel(r.source)}] ${escapeMarkdown(title)}` +
      `\n_${shortDate(r.ts)}_` +
      `\n\`\`\`\n${escapeMarkdown(snippet)}\n\`\`\``
    );
  }
  return parts.join('\n\n');
}

export function renderRecent(rows) {
  if (!rows || rows.length === 0) return '📭 Nothing in memex yet.';
  const parts = ['🕒 Most recent:\n'];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const title = r.title ? r.title.slice(0, 80) : r.conversation_id;
    const snippet = (r.text || '').replace(/\s+/g, ' ').slice(0, 200);
    parts.push(
      `*${i + 1}.* [${sourceLabel(r.source)}] ${escapeMarkdown(title)}` +
      `\n_${shortDate(r.ts)}_` +
      `\n${escapeMarkdown(snippet)}`
    );
  }
  return parts.join('\n\n');
}
