/**
 * Cursor IDE history parser.
 *
 * Reads Cursor's local SQLite store (state.vscdb) and extracts
 * Composer / Chat conversations as ingest-ready dialogue messages.
 *
 * Schema (verified 2026-05 on Cursor _v: 13 / bubble _v: 3):
 *
 *   cursorDiskKV table:
 *     composerData:<composerId>          session metadata + ordered headers
 *     bubbleId:<composerId>:<bubbleId>   individual message bubble
 *     agentKv:* / checkpointId:*         ignored (not dialogue)
 *     inlineDiff:* / composer.content.*  ignored
 *
 * Key insight from real-data probe: Cursor splits ONE logical assistant
 * turn across MULTIPLE bubbles —
 *   bubble.type=1 + bubble.text   = user prompt          (KEEP)
 *   bubble.type=2 + bubble.thinking only = reasoning      (SKIP)
 *   bubble.type=2 + bubble.text  = user-visible answer    (KEEP)
 *   bubble.type=2 + bubble.toolFormerData = tool call    (SKIP)
 *
 * We keep only bubbles with a non-empty .text field. Same dialogue-only
 * filter philosophy as our Claude Code/Cowork parser.
 */

import Database from 'better-sqlite3';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const CURSOR_DB_PATHS = {
  darwin: join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  linux: join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  win32: join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
};

export function defaultCursorDbPath() {
  return CURSOR_DB_PATHS[platform()] || null;
}

/**
 * Open Cursor's SQLite read-only with retry on SQLITE_BUSY.
 * Cursor writes live; we use exponential backoff (100/300/900 ms).
 * Returns null if the DB doesn't exist (Cursor not installed).
 */
export function openCursorDB(path) {
  if (!path || !existsSync(path)) return null;
  const delays = [100, 300, 900];
  for (let attempt = 0; ; attempt++) {
    try {
      return new Database(path, { readonly: true, fileMustExist: true });
    } catch (err) {
      const busy = err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED');
      if (busy && attempt < delays.length) {
        const start = Date.now();
        // Synchronous busy-wait so this stays a sync function. Total worst-
        // case ~1.3s, which is acceptable for a once-per-tick scan.
        while (Date.now() - start < delays[attempt]) {}
        continue;
      }
      throw err;
    }
  }
}

function parseValue(buf) {
  if (!buf) return null;
  try {
    return JSON.parse(typeof buf === 'string' ? buf : buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Iterate all Composer sessions in the DB.
 * Yields { composerId, name, createdAt, lastUpdatedAt, headers, isAgentic }.
 */
export function* iterComposers(db) {
  const stmt = db.prepare(`SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`);
  for (const row of stmt.iterate()) {
    const cd = parseValue(row.value);
    if (!cd || !cd.composerId) continue;
    yield {
      composerId: cd.composerId,
      name: cd.name || null,
      createdAt: cd.createdAt || null,
      lastUpdatedAt: cd.lastUpdatedAt || cd.createdAt || null,
      isAgentic: !!cd.isAgentic,
      headers: Array.isArray(cd.fullConversationHeadersOnly) ? cd.fullConversationHeadersOnly : [],
    };
  }
}

/**
 * Extract dialogue messages from one composer.
 * Skips thinking-only and tool-only bubbles (no .text content).
 *
 * Returns [{ role, text, bubbleId, ts }] in conversation order.
 */
export function extractDialogue(db, composer) {
  const { composerId, createdAt, lastUpdatedAt, headers } = composer;
  if (!headers.length) return [];

  const bubbleStmt = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`);
  const messages = [];

  // Synthetic per-bubble timestamps. Real bubble timing is not reliably
  // present, but createdAt → lastUpdatedAt range gives us a valid window.
  const start = createdAt;
  const span = Math.max(1, (lastUpdatedAt || createdAt) - start);
  // We'll assign each KEPT message a ts that lives between start and end.
  // To preserve order even when we skip bubbles, we use the header index
  // for spacing.
  const totalHeaders = headers.length;

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h || !h.bubbleId) continue;

    const row = bubbleStmt.get(`bubbleId:${composerId}:${h.bubbleId}`);
    if (!row) continue; // truncated — skip silently

    const b = parseValue(row.value);
    if (!b) continue;

    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) continue; // thinking-only / tool-only bubble — skip

    const role = h.type === 1 ? 'user' : (h.type === 2 ? 'assistant' : null);
    if (!role) continue;

    const ts = start
      ? Math.floor(start + (i / Math.max(1, totalHeaders - 1)) * span)
      : null;

    messages.push({
      role,
      text,
      bubbleId: h.bubbleId,
      ts, // unix ms
    });
  }

  return messages;
}

/**
 * Render dialogue + ai-title metadata as inbox-ready JSONL records.
 * Records match the flat shape that memex's importClaudeCodeJsonl expects,
 * so the inbox flow stays unified across sources.
 *
 * Returns: [recordObj, ...] — each is one JSONL line (caller serializes).
 */
export function composerToInboxRecords(composer, dialogue, prefix, shortId, hashFn) {
  const records = [];
  if (composer.name) {
    records.push({ type: 'ai-title', aiTitle: composer.name });
  }
  for (const m of dialogue) {
    const tsIso = m.ts ? new Date(m.ts).toISOString() : null;
    const seed = `${m.role}|${tsIso}|${m.text.slice(0, 200)}`;
    const msgId = hashFn(seed);
    records.push({
      role: m.role,
      content: m.text,
      timestamp: tsIso,
      id: `${prefix}-${shortId}-${msgId}`,
    });
  }
  return records;
}
