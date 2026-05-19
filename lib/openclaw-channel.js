/**
 * OpenClaw channel detection + Telegram batch unpacking.
 *
 * Background (from a fresh disk-survey by an OpenClaw agent on a live VPS,
 * 2026-05-19):
 *
 * OpenClaw stores every channel (Kimi-web, Telegram, future Slack/WA/etc.)
 * in the SAME directory `~/.openclaw/agents/main/sessions/`. There is NO
 * `channel` field at the JSON-record level. The transport is identifiable
 * only by two means:
 *
 *   1. `sessions.json` — authoritative routing registry. Maps each
 *      sessionFile path to its `deliveryContext.channel` value (e.g.
 *      "kimi-claw", "telegram"). Useful as the default channel for a
 *      whole file, but doesn't help with CHECKPOINT files which contain
 *      messages from multiple channels interleaved.
 *
 *   2. Text patterns inside `content[0].text` — embedded Markdown
 *      preambles + JSON metadata blocks. The reliable signals are:
 *
 *        "User Message From Kimi:\n[Time: …]\n…"        → kimi-web
 *        "[Queued messages while agent was busy]\n…"    → telegram (batched)
 *        "Conversation info (untrusted metadata):"      → telegram (single)
 *        "System: …"                                    → system
 *
 * Telegram messages in checkpoint files are BATCHED — one OpenClaw record
 * may pack 1..N Telegram messages as `Queued #1` / `Queued #2` / … blocks
 * with embedded JSON metadata + the actual user text. This module unpacks
 * those batches into separate logical messages.
 *
 * Public API:
 *   • detectChannel(text, fallback?) → 'telegram' | 'kimi-web' | 'system' | null
 *   • parseBatchedTelegram(text)      → array of { text, message_id, sender_id,
 *                                                    sender, username, reply_to_id, ts }
 *   • parseSingleTelegram(text)       → same shape (when one TG without Queued header)
 *   • stripKimiHeader(text)           → text with "User Message From Kimi:\n[Time: …]\n"
 *                                       removed (for cleaner storage)
 *   • loadSessionsJsonChannelMap(path)→ { sessionFile_absolute → channel } for fallback
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// ----- Channel detection -----

export function detectChannel(text, fallback = null) {
  if (typeof text !== 'string' || !text) return fallback;
  // Inspect the first 512 chars only — channel markers always appear at
  // the top of the message text.
  const head = text.slice(0, 512);

  // Kimi-web has a canonical preamble. Both legacy and current forms.
  if (/^User Message From Kimi:/i.test(head)) return 'kimi-web';

  // Telegram batched: starts with the "Queued messages while busy" marker.
  if (/^\[Queued messages while agent was busy\]/i.test(head)) return 'telegram';

  // Telegram single (e.g. when agent was free — message lands in main file
  // with embedded TG metadata but no Queued header).
  if (/Conversation info \(untrusted metadata\):/i.test(head) && /"sender_id"/.test(head)) {
    return 'telegram';
  }

  // System output (Exec, diagnostic). OpenClaw sometimes writes these as
  // role=user records too; treat as separate channel so they don't pollute
  // dialogue conversations.
  if (/^System: /i.test(head)) return 'system';

  return fallback;
}

// ----- Telegram batch + metadata parsing -----

/**
 * Parse a "[Queued messages while agent was busy]" batched-TG record into
 * an array of individual messages. Each item:
 *   { text, message_id, sender_id, sender, username, reply_to_id, ts }
 *
 * `ts` is unix-seconds (parsed from the Telegram-formatted "Fri 2026-05-01
 * 20:03 GMT+8" string in the metadata block).
 *
 * Robust against:
 *   • A single batch (one `Queued #1` block) or many
 *   • Missing Sender metadata block (rare, falls back to Conversation info)
 *   • User text containing arbitrary Markdown including its own ```fenced
 *     blocks — we anchor on the EXACTLY-formatted "Conversation info" /
 *     "Sender (untrusted metadata)" labels rather than ``` itself.
 */
export function parseBatchedTelegram(text) {
  if (typeof text !== 'string' || !text) return [];

  // Split on "\n---\nQueued #<N>\n" — this is the daemon-emitted separator.
  // The first chunk before the first separator is the "[Queued messages …]"
  // header, which we discard.
  const parts = text.split(/\n---\nQueued #\d+\n/);
  if (parts.length < 2) {
    // No batch separator found — maybe just one TG message wrapped without
    // the "Queued #1" header? Try single-message parsing.
    const single = parseSingleTelegram(text);
    return single ? [single] : [];
  }
  // Drop the [Queued messages while agent was busy] header (parts[0]).
  return parts.slice(1).map(parseSingleTelegram).filter(Boolean);
}

/**
 * Parse a single Telegram-formatted message block (with or without
 * `Queued #N` header already stripped).
 *
 * Looks for two ```json blocks in this order:
 *   Conversation info (untrusted metadata) — message_id, sender_id,
 *                                              sender, reply_to_id, timestamp
 *   Sender (untrusted metadata)            — id, name, username, label
 *
 * Returns the actual user text (everything after the last metadata block)
 * along with the extracted fields. Returns null if no Telegram metadata
 * found.
 */
export function parseSingleTelegram(block) {
  if (typeof block !== 'string' || !block) return null;

  const convInfo = extractJsonBlock(block, 'Conversation info');
  const senderInfo = extractJsonBlock(block, 'Sender');

  if (!convInfo && !senderInfo) return null;

  // The user's actual text starts AFTER the closing ``` of the LAST metadata
  // block. For each label we must skip past the OPENING ```json fence before
  // looking for the closing ``` — otherwise indexOf('\n```', labelIdx) lands
  // on the opening fence itself.
  let textStart = 0;
  for (const label of ['Conversation info', 'Sender']) {
    const labelIdx = block.indexOf(`${label} (untrusted metadata)`);
    if (labelIdx < 0) continue;
    const openFence = block.indexOf('```json', labelIdx);
    if (openFence < 0) continue;
    const closingIdx = block.indexOf('\n```', openFence + '```json'.length);
    if (closingIdx < 0) continue;
    const blockEnd = closingIdx + 4; // past '\n```'
    if (blockEnd > textStart) textStart = blockEnd;
  }
  const userText = block.slice(textStart).replace(/^[\s\n]+/, '').trimEnd();

  return {
    text: userText || '',
    message_id: convInfo?.message_id ?? null,
    sender_id: convInfo?.sender_id ?? senderInfo?.id ?? null,
    sender: convInfo?.sender ?? senderInfo?.name ?? null,
    username: senderInfo?.username ?? null,
    reply_to_id: convInfo?.reply_to_id ?? null,
    ts: parseTelegramTimestamp(convInfo?.timestamp),
    raw_timestamp: convInfo?.timestamp ?? null,
  };
}

/**
 * Extract the JSON object from a Markdown "<label> (untrusted metadata):"
 * + ```json … ``` block. Returns the parsed object or null.
 */
function extractJsonBlock(text, label) {
  const labelIdx = text.indexOf(`${label} (untrusted metadata)`);
  if (labelIdx < 0) return null;
  const openFence = text.indexOf('```json', labelIdx);
  if (openFence < 0) return null;
  const jsonStart = openFence + '```json'.length;
  // Skip whitespace/newline after ```json
  let cursor = jsonStart;
  while (cursor < text.length && /[\s\n]/.test(text[cursor])) cursor++;
  const closeFence = text.indexOf('\n```', cursor);
  if (closeFence < 0) return null;
  const jsonStr = text.slice(cursor, closeFence).trim();
  try { return JSON.parse(jsonStr); }
  catch (_) { return null; }
}

/**
 * Convert Telegram's text-format timestamp to unix-seconds.
 *
 *   Input examples:  "Fri 2026-05-01 20:03 GMT+8"
 *                    "Wed 2026-05-20 02:24 GMT+8"
 *   Output:          unix epoch seconds (UTC)
 *
 * Returns 0 if unparseable.
 */
export function parseTelegramTimestamp(s) {
  if (typeof s !== 'string' || !s) return 0;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+GMT([+-]\d+)/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, tz] = m;
  // GMT+8 → -8 hours from local to get UTC
  const offsetHours = parseInt(tz, 10);
  const localDate = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  return Math.floor((localDate - offsetHours * 3600_000) / 1000);
}

// ----- Kimi-web utilities -----

/**
 * Strip the canonical Kimi preamble from text. Used at ingest time so the
 * stored text is the clean user content, not the daemon's framing.
 *
 *   "User Message From Kimi:\n[Time: [...]]\nMain text here"  →
 *   "Main text here"
 */
export function stripKimiHeader(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(/^User Message From Kimi:\s*\n\[Time:[^\]]*\]\]?\s*\n?/i, '').trim();
}

// ----- sessions.json reader -----

/**
 * Read OpenClaw's sessions.json registry and return a Map keyed by
 * sessionFile absolute path → channel name (e.g. "telegram", "kimi-claw").
 *
 * The schema (per OpenClaw maintainer):
 *   {
 *     "agent:main:main": {
 *       "deliveryContext": { "channel": "kimi-claw", ... },
 *       "sessionFile": "/root/.openclaw/agents/main/sessions/<uuid>.jsonl",
 *       ...
 *     },
 *     "agent:main:subagent:<uuid>": {
 *       "deliveryContext": { "channel": "telegram", ... },
 *       "sessionFile": "...",
 *       ...
 *     }
 *   }
 *
 * `sessionsJsonPath` may be passed explicitly OR auto-discovered from a
 * sessionFile path (we walk up to find a sibling `sessions.json`).
 * Returns an empty Map if not found / unreadable.
 */
export function loadSessionsJsonChannelMap(sessionsJsonPath) {
  const map = new Map();
  if (!sessionsJsonPath || !existsSync(sessionsJsonPath)) return map;
  let raw;
  try { raw = JSON.parse(readFileSync(sessionsJsonPath, 'utf-8')); }
  catch (_) { return map; }
  for (const key of Object.keys(raw || {})) {
    const entry = raw[key];
    const ch = entry?.deliveryContext?.channel || entry?.lastChannel || entry?.channel;
    const file = entry?.sessionFile;
    if (ch && file) {
      // Normalise OpenClaw's channel names to our enum
      const normalized =
        ch === 'kimi-claw' ? 'kimi-web'
        : ch; // 'telegram' stays, others pass through
      map.set(file, normalized);
    }
  }
  return map;
}

/**
 * Discover sessions.json given the path of a JSONL session file. Walks up
 * to the first ancestor that contains a sessions.json sibling. Returns the
 * absolute path or null.
 */
export function findSessionsJson(sessionFilePath) {
  if (!sessionFilePath) return null;
  let dir = dirname(sessionFilePath);
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'sessions.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ----- conversation_id derivation -----

/**
 * Pick the right conversation_id for an OpenClaw message given its
 * detected channel and any extracted sender ID.
 *
 *   telegram + sender_id  → "openclaw-tg-<sender_id>"
 *     (all Telegram messages from one user share one conv — across multiple
 *      OpenClaw sessions / checkpoints)
 *   kimi-web              → "openclaw-kimi-<fileUuid8>"
 *     (each Kimi-web session is its own conv)
 *   system                → "openclaw-sys-<fileUuid8>"
 *   anything else / null  → "openclaw-<fileUuid8>"   (default, fileUuid-based)
 *
 * `fileUuid8` is the first 8 hex chars of the SOURCE FILE uuid (NOT the
 * inbox-staged name) — this stays stable across checkpoints since they
 * derive from the same base.
 */
export function deriveOpenclawConvId(channel, senderId, fileUuid8) {
  if (channel === 'telegram' && senderId) {
    return `openclaw-tg-${senderId}`;
  }
  if (channel === 'kimi-web') {
    return `openclaw-kimi-${fileUuid8}`;
  }
  if (channel === 'system') {
    return `openclaw-sys-${fileUuid8}`;
  }
  return `openclaw-${fileUuid8}`;
}

/**
 * Extract the base session uuid8 from an OpenClaw inbox/source filename:
 *   "openclaw-3824f87a.jsonl"               → "3824f87a"
 *   "openclaw-3824f87a-ckpt-e6c37ac7.jsonl" → "3824f87a"
 *   "3824f87a-ea6e-4e08-…-c596288bcfe3.jsonl" → "3824f87a"
 *   "3824f87a.checkpoint.e6c37ac7.jsonl"    → "3824f87a"
 */
export function baseUuid8(fileName) {
  const stem = fileName.replace(/\.jsonl$/, '');
  // OpenClaw inbox-staged: "openclaw-<base8>" or "openclaw-<base8>-ckpt-<chkpt8>"
  let m = stem.match(/^openclaw-([0-9a-f]{8})(?:-ckpt-[0-9a-f]{8})?$/i);
  if (m) return m[1];
  // Source-file form: "<uuid>" or "<base-uuid>.checkpoint.<chkpt-uuid>"
  m = stem.match(/^([0-9a-f]{8})/i);
  if (m) return m[1];
  // Fallback: first 8 chars (alphanumeric).
  return stem.replace(/[^0-9a-z]/gi, '').slice(0, 8);
}
