/**
 * OpenClaw channel detection + Telegram batch unpacking.
 *
 * Background (from disk-surveys by OpenClaw agents on live VPSes,
 * 2026-05-19 → 2026-05-20):
 *
 * OpenClaw stores every channel (Kimi-web, Telegram, future Slack/WA/
 * self-hosted Discord/etc.) in the SAME directory
 * `~/.openclaw/agents/main/sessions/`. There is NO `channel` field at
 * the JSON-record level. The transport is identifiable by two means:
 *
 *   1. `sessions.json` — authoritative routing registry. Maps each
 *      sessionFile path to its `deliveryContext.channel` value (e.g.
 *      "kimi-claw", "telegram", or any self-hosted name like "discord",
 *      "matrix", "custom-web-ui"). USEFUL as the default channel for a
 *      whole file — but DOES NOT help with CHECKPOINT files which mix
 *      messages from multiple channels interleaved.
 *
 *   2. Text patterns inside `content[0].text` — embedded Markdown
 *      preambles + JSON metadata blocks. Reliable signals:
 *
 *        "User Message From Kimi:\n[Time: …]?\n…"       → kimi-web
 *          (Time block is OPTIONAL — short messages skip it)
 *        "[Queued messages while agent was busy]\n…"    → telegram (batched)
 *        "Conversation info (untrusted metadata):"      → telegram (single)
 *        "System: …"                                    → system
 *
 * v0.11.1: channels live in a `CHANNELS` array (not hardcoded if/else).
 * Adding a new known channel = one entry. Unknown channels from
 * sessions.json get auto-registered with sensible defaults
 * (per-account routing if accountId available, else per-file) — so
 * self-hosted OpenClaw with custom channel names "just works".
 *
 * Telegram messages in checkpoint files are BATCHED — one OpenClaw record
 * may pack 1..N Telegram messages as `Queued #1` / `Queued #2` / … blocks
 * with embedded JSON metadata + the actual user text. This module unpacks
 * those batches into separate logical messages.
 *
 * Public API:
 *   • CHANNELS                         — array of known-channel definitions
 *   • findChannelDef(name)             — look up by canonical or alias name
 *   • getOrAutoRegister(rawChannel)    — return def or synthesize generic
 *   • detectChannel(text, fallback?)   — text-pattern detection
 *   • deriveOpenclawConvId(channel, senderInfo, fileUuid8)
 *                                      — conv_id (uses CHANNELS + auto-disc)
 *   • titlePrefixFor(channel)          — "[Telegram]" / "[Kimi-web]" / etc.
 *   • parseBatchedTelegram / parseSingleTelegram / parseTelegramTimestamp
 *   • stripKimiHeader(text)            — drop "User Message From Kimi:\n…"
 *   • loadSessionsJsonChannelMap(path) — file → channel from sessions.json
 *   • findSessionsJson(sessionFilePath)— walk up to discover sessions.json
 *   • baseUuid8(fileName)              — extract 8-char base UUID
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// ----- Channel registry -----
//
// Each entry describes one known channel. Adding a new well-known
// channel (e.g. "slack" with its own batched format) = one block here +
// optional spec-parser. Unknown channels surfaced via sessions.json get
// auto-registered at runtime in `getOrAutoRegister` (see below) — no
// changes needed for self-hosted custom channel names.
//
// Fields:
//   name              — canonical identifier stored in `messages.channel`
//   sessionsJsonAlias — strings that sessions.json may use for the same
//                       channel (e.g. OpenClaw writes "kimi-claw" while
//                       we store "kimi-web" for readability)
//   detect(head)      — text-pattern detector; returns true if the first
//                       512 chars of a message look like this channel.
//                       Used PER-MESSAGE because checkpoint files mix
//                       channels even when sessions.json reports a
//                       single channel.
//   parseBatch(text)  — optional batched-message parser (Telegram only
//                       today). Used when the channel can pack multiple
//                       user messages into one OpenClaw record.
//   parseSingle(text) — optional single-message metadata extractor
//   stripHeader(text) — optional preamble-removal for cleaner storage
//                       (e.g. drop "User Message From Kimi:\n[Time:…]\n")
//   convIdFor(info, ctx)
//                     — function returning the conv_id for a record on
//                       this channel. `info` may contain sender_id /
//                       accountId / etc. `ctx.fileUuid8` is the 8-char
//                       base session UUID. Returns null if not routable;
//                       caller then falls back to "openclaw-<file8>".
//   titlePrefix       — "[Telegram]" / "[Kimi-web]" — prepended to conv
//                       titles so the UI shows channel at a glance.
export const CHANNELS = [
  {
    name: 'telegram',
    sessionsJsonAlias: ['telegram'],
    detect: (head) =>
      /^\[Queued messages while agent was busy\]/i.test(head) ||
      (/Conversation info \(untrusted metadata\):/i.test(head) && /"sender_id"/.test(head)),
    parseBatch: parseBatchedTelegram,
    parseSingle: parseSingleTelegram,
    convIdFor: (info, _ctx) =>
      info?.sender_id ? `openclaw-tg-${info.sender_id}` : null,
    titlePrefix: '[Telegram]',
  },
  {
    name: 'kimi-web',
    sessionsJsonAlias: ['kimi-claw', 'kimi-web'],
    detect: (head) => /^User Message From Kimi:/i.test(head),
    stripHeader: (text) => stripKimiHeader(text),
    convIdFor: (_info, ctx) => `openclaw-kimi-${ctx.fileUuid8}`,
    titlePrefix: '[Kimi-web]',
  },
  {
    name: 'system',
    sessionsJsonAlias: ['system'],
    detect: (head) => /^System: /i.test(head),
    convIdFor: (_info, ctx) => `openclaw-sys-${ctx.fileUuid8}`,
    titlePrefix: '[System]',
  },
];

/**
 * Look up a channel definition by canonical name OR sessions.json alias.
 * Returns null if not found.
 */
export function findChannelDef(name) {
  if (!name) return null;
  return CHANNELS.find(
    (c) => c.name === name || (c.sessionsJsonAlias || []).includes(name),
  ) || null;
}

/**
 * Auto-discovery for self-hosted OpenClaw setups.
 *
 * If sessions.json reports `deliveryContext.channel: "discord"` (or
 * any other name we don't know), build a generic channel def on the
 * fly: per-account routing if `accountId` is available, else per-file.
 * Title prefix is just `[<name>]`. This means custom self-hosted
 * channels work out of the box — no memex code changes required.
 *
 * Returns null if `rawChannelName` is empty or invalid.
 */
export function getOrAutoRegister(rawChannelName) {
  const known = findChannelDef(rawChannelName);
  if (known) return known;
  if (!rawChannelName || typeof rawChannelName !== 'string') return null;
  // Sanitise: only [a-z0-9_-] in the channel name (no spaces, no slashes —
  // these become part of conv_id and table values).
  const safe = rawChannelName.replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  if (!safe) return null;
  return {
    name: safe,
    detect: () => false, // no text-pattern detector — relies on sessions.json
    convIdFor: (info, ctx) =>
      info?.accountId
        ? `openclaw-${safe}-${info.accountId}`
        : info?.sender_id
        ? `openclaw-${safe}-${info.sender_id}`
        : `openclaw-${safe}-${ctx.fileUuid8}`,
    titlePrefix: `[${safe}]`,
    isAutoRegistered: true,
  };
}

// ----- Channel detection -----

/**
 * Text-pattern channel detection. Iterates CHANNELS in order and
 * returns the first match. Returns `fallback` if nothing matches.
 *
 * `fallback` is typically the file-level channel from sessions.json
 * (so a single-channel session whose user messages don't carry a
 * preamble — e.g. Kimi short replies "тут?" — still routes correctly).
 */
export function detectChannel(text, fallback = null) {
  if (typeof text !== 'string' || !text) return fallback;
  const head = text.slice(0, 512);
  for (const ch of CHANNELS) {
    if (ch.detect && ch.detect(head)) return ch.name;
  }
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
 *   "User Message From Kimi:\n[Time: [...]]\nMain text here"  →  "Main text here"
 *   "User Message From Kimi:\nMain text here"                 →  "Main text here"
 *                                                                ↑ Time block
 *                                                                  is OPTIONAL
 *
 * v0.11.1 fix: production OpenClaw omits the `[Time: …]` block for
 * short messages. The v0.11.0 regex required it and silently failed
 * for everything else. The new regex makes the Time line optional.
 */
export function stripKimiHeader(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/^User Message From Kimi:\s*\n(?:\[Time:[^\n]*\]\s*\n)?/i, '')
    .trim();
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
 * detected channel and any extracted sender info.
 *
 * v0.11.1: routes through the CHANNELS registry and falls back to
 * `getOrAutoRegister` for unknown self-hosted channels. Backward-
 * compatible with v0.11.0 calling convention — the second arg may be
 * either a string `sender_id` or an object `{sender_id, accountId, …}`.
 *
 * Examples (built-in channels):
 *   telegram + sender_id  → "openclaw-tg-<sender_id>"
 *   kimi-web              → "openclaw-kimi-<fileUuid8>"
 *   system                → "openclaw-sys-<fileUuid8>"
 *
 * Auto-discovered (self-hosted; e.g. channel="discord"):
 *   discord + accountId   → "openclaw-discord-<accountId>"
 *   discord (no info)     → "openclaw-discord-<fileUuid8>"
 *
 * Fallback:
 *   anything else / null  → "openclaw-<fileUuid8>"
 *
 * `fileUuid8` is the first 8 hex chars of the SOURCE FILE uuid (NOT the
 * inbox-staged name) — this stays stable across checkpoints since they
 * derive from the same base.
 */
export function deriveOpenclawConvId(channel, senderInfoOrId, fileUuid8) {
  if (!channel) return `openclaw-${fileUuid8}`;
  const def = findChannelDef(channel) || getOrAutoRegister(channel);
  if (!def) return `openclaw-${fileUuid8}`;
  const info =
    senderInfoOrId == null
      ? {}
      : typeof senderInfoOrId === 'string'
      ? { sender_id: senderInfoOrId }
      : senderInfoOrId;
  return def.convIdFor(info, { fileUuid8 }) || `openclaw-${fileUuid8}`;
}

/**
 * Title prefix for a channel — "[Telegram]" / "[Kimi-web]" / "[discord]".
 * Returns "" when channel is null or has no known/auto-registered def.
 */
export function titlePrefixFor(channel) {
  if (!channel) return '';
  const def = findChannelDef(channel) || getOrAutoRegister(channel);
  return def?.titlePrefix || '';
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
