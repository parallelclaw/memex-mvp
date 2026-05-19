/**
 * Single-call ingest of an arbitrary file path.
 *
 * Solves the v0.10.x onboarding gap: users put their Telegram/Claude exports
 * in *natural* places like ~/projects/memex/ or ~/Desktop/ rather than the
 * memex-magic paths (~/.memex/inbox/, ~/Downloads/Telegram Desktop/). The
 * old answer was "drop it where memex watches" — but users don't know those
 * paths and AI agents had to fall back to ~10k tokens of bash file-ops
 * (mv to inbox, poll ingest.log, check DB count, …) just to get one file in.
 *
 * This helper lets the agent (or CLI) pass any path and get a single
 * structured response. Auto-detects format, respects Telegram privacy
 * decisions, returns precise insert/duplicate counts.
 *
 * Returns one of:
 *   { status: 'imported',     ... }   — records landed in DB
 *   { status: 'needs_consent',... }   — new Telegram chat, ask user before forcing
 *   { status: 'skipped',      ... }   — user previously skipped/blocked this chat
 *   { status: 'error',        ... }   — file unreadable / format unknown / parse failed
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

const SUPPORTED_FORMATS = ['telegram-json', 'telegram-html', 'claude-jsonl', 'cowork-jsonl', 'openclaw-jsonl'];

/**
 * Expand ~ and resolve relative paths against cwd. We DON'T realpath here —
 * symlinks in the user's home are valid (e.g. iCloud-synced ~/Downloads).
 */
export function resolvePath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim();
  if (s.startsWith('~/')) s = join(homedir(), s.slice(2));
  else if (s === '~') s = homedir();
  if (!isAbsolute(s)) s = join(process.cwd(), s);
  return s;
}

/**
 * Sniff format from path + content. Returns null when we can't tell.
 *
 * Heuristics:
 *   - directory containing messages.html → telegram-html (Desktop export dir)
 *   - .html / .htm → telegram-html
 *   - .json with Telegram markers in first 8KB → telegram-json
 *   - .jsonl starting with cowork- → cowork-jsonl
 *   - other .jsonl → claude-jsonl
 */
export function detectFormat(absPath) {
  if (!existsSync(absPath)) return null;
  const stat = statSync(absPath);

  if (stat.isDirectory()) {
    // Telegram Desktop HTML export = directory with messages.html at root
    if (existsSync(join(absPath, 'messages.html'))) return 'telegram-html';
    // Some exports nest result.json inside
    if (existsSync(join(absPath, 'result.json'))) return 'telegram-json-in-dir';
    return null;
  }

  const lower = absPath.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'telegram-html';

  if (lower.endsWith('.json')) {
    let head = '';
    try { head = readFileSync(absPath, 'utf-8').slice(0, 8192); }
    catch (_) { return null; }
    if (
      head.includes('"messages"') ||
      head.includes('"chats"') ||
      head.includes('"personal_information"')
    ) return 'telegram-json';
    return null;
  }

  if (lower.endsWith('.jsonl')) {
    const name = basename(lower);
    if (name.startsWith('cowork-')) return 'cowork-jsonl';
    if (name.startsWith('openclaw-')) return 'openclaw-jsonl';
    // On-disk OpenClaw sessions live at ~/.openclaw/agents/main/sessions/<uuid>.jsonl
    // with no filename prefix — detect via path instead.
    if (lower.includes('/.openclaw/')) return 'openclaw-jsonl';
    return 'claude-jsonl';
  }

  return null;
}

/**
 * Main entry. Caller is responsible for opening a writable better-sqlite3 Database
 * handle and passing it in — we don't open/close the DB here.
 *
 * opts:
 *   format:  one of SUPPORTED_FORMATS, or 'auto' (default).
 *   force:   bypass Telegram privacy gate (skip/block decisions). Default false.
 */
export async function ingestFile(db, rawPath, opts = {}) {
  const path = resolvePath(rawPath);
  if (!path) return { status: 'error', error: 'path required' };
  if (!existsSync(path)) return { status: 'error', error: `file not found: ${path}` };

  const format = opts.format && opts.format !== 'auto' ? opts.format : detectFormat(path);
  if (!format) {
    return {
      status: 'error',
      error: `unable to detect format; supported: ${SUPPORTED_FORMATS.join(', ')}. ` +
             `Pass an explicit format= if the file has no extension hint.`,
    };
  }

  if (format === 'telegram-json' || format === 'telegram-json-in-dir' || format === 'telegram-html') {
    return ingestTelegram(db, path, format, opts);
  }
  if (format === 'claude-jsonl' || format === 'cowork-jsonl' || format === 'openclaw-jsonl') {
    return ingestClaudeJsonl(db, path, format, opts);
  }
  return { status: 'error', error: `unsupported format: ${format}` };
}

// ----- Telegram path -----

async function ingestTelegram(db, path, format, opts = {}) {
  // Parse raw → { chats: { list: [...] }, ... }
  let raw;
  try {
    if (format === 'telegram-html') {
      const { parseTelegramHtmlExport } = await import('./parse-telegram-html.js');
      raw = parseTelegramHtmlExport(path);
    } else if (format === 'telegram-json-in-dir') {
      raw = JSON.parse(readFileSync(join(path, 'result.json'), 'utf-8'));
    } else {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch (e) {
    return { status: 'error', error: `parse failed: ${e.message}` };
  }
  if (!raw) return { status: 'error', error: 'parse returned empty' };

  // Find the chat title — for single-chat exports, it's the only chat in the list
  const chats = Array.isArray(raw.chats?.list)
    ? raw.chats.list
    : Array.isArray(raw.list)
    ? raw.list
    : raw.messages
    ? [raw]
    : [];
  if (chats.length === 0) {
    return { status: 'error', error: 'no chats found in file' };
  }

  // Privacy gate — single chat exports route through user's decision state;
  // multi-chat exports (whole-Telegram-archive case, rare) skip the gate and
  // import everything by default (the agent already had to coordinate that).
  const decisionsMod = await import('./telegram-decisions.js');
  const state = decisionsMod.loadDecisions();

  if (chats.length === 1 && !opts.force) {
    const chat = chats[0];
    const title =
      chat.name ||
      (chat.type === 'saved_messages' ? 'Saved Messages' : `Telegram chat ${chat.id}`);

    if (decisionsMod.isBlocked(state, title)) {
      return {
        status: 'skipped',
        format,
        chat_title: title,
        reason: 'matches a block pattern in your decision state',
        message: `Chat "${title}" matches a block pattern. To override, call again with force=true (and consider unblocking via memex telegram unblock <pattern>).`,
      };
    }
    if (decisionsMod.isSkipped(state, title)) {
      return {
        status: 'skipped',
        format,
        chat_title: title,
        reason: 'previously skipped by user',
        message: `Chat "${title}" was previously skipped. To override, call again with force=true.`,
      };
    }
    if (!decisionsMod.isAllowed(state, title)) {
      // New chat — needs consent. Surface preview so the agent can ask the user.
      const msgs = Array.isArray(chat.messages) ? chat.messages : [];
      const realMsgs = msgs.filter((m) => m.type === 'message');
      const senders = new Set();
      let firstTs = Infinity, lastTs = 0;
      for (const m of realMsgs.slice(0, 200)) {
        if (m.from) senders.add(m.from);
        const ts = parseInt(m.date_unixtime || '0', 10);
        if (ts) { firstTs = Math.min(firstTs, ts); lastTs = Math.max(lastTs, ts); }
      }
      return {
        status: 'needs_consent',
        format,
        chat_title: title,
        chat_type: chat.type || 'unknown',
        message_count: realMsgs.length,
        senders_sample: Array.from(senders).slice(0, 5),
        date_first: isFinite(firstTs) ? new Date(firstTs * 1000).toISOString().slice(0, 10) : null,
        date_last: lastTs ? new Date(lastTs * 1000).toISOString().slice(0, 10) : null,
        message:
          `New Telegram chat "${title}" (${realMsgs.length} msgs). ` +
          `Ask the user before importing — privacy gate. ` +
          `To proceed: call memex_import_file again with force=true. ` +
          `To never auto-import this chat: memex telegram skip "${title}".`,
      };
    }
  }

  // Allowed (or forced, or multi-chat archive) → run the upsert.
  const { importTelegramRaw } = await import('./import-telegram.js');
  let result;
  try {
    result = importTelegramRaw(db, raw);
  } catch (e) {
    return { status: 'error', error: `import failed: ${e.message}` };
  }

  // Mark chats as allowed for future re-exports
  for (const c of result.chats) {
    decisionsMod.allowChat(state, c.title);
  }
  decisionsMod.saveDecisions(state);

  return {
    status: 'imported',
    format,
    chats: result.chats.map((c) => ({
      conversation_id: c.conversation_id,
      title: c.title,
      msg_count: c.msg_count,
      date_first: c.first_ts ? new Date(c.first_ts * 1000).toISOString().slice(0, 10) : null,
      date_last: c.last_ts ? new Date(c.last_ts * 1000).toISOString().slice(0, 10) : null,
    })),
    total_imported: result.totalImported,
  };
}

// ----- Claude Code / Cowork JSONL path -----

async function ingestClaudeJsonl(db, path, format, _opts) {
  // v0.11+: OpenClaw gets its own ingest path with channel-aware routing —
  // Telegram messages go to per-sender conversations, Kimi-web messages to
  // per-session conversations, system messages segregated. See
  // ingestOpenclawJsonl below for the full logic.
  if (format === 'openclaw-jsonl') {
    return ingestOpenclawJsonl(db, path, _opts);
  }

  const source = format === 'cowork-jsonl' ? 'claude-cowork' : 'claude-code';
  const fileName = basename(path, '.jsonl');
  const conversationId = `${source}-${fileName}`;

  // We replicate the inner logic of server.js's importClaudeCodeJsonl so this
  // module stays self-contained. (Extracting that function from server.js is
  // a bigger refactor we don't need right now.)
  const { extractMessageFromRecord, extractCompactBoundary, isContinuationBoilerplate } =
    await import('./parse.js');

  const insertMessage = db.prepare(`
    INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts, metadata, edited_at, uuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, conversation_id, msg_id) DO UPDATE SET
      text = excluded.text,
      uuid = COALESCE(messages.uuid, excluded.uuid)
  `);
  const upsertConversation = db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, parent_conversation_id, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      title = COALESCE(excluded.title, title),
      first_ts = MIN(first_ts, excluded.first_ts),
      last_ts = MAX(last_ts, excluded.last_ts),
      project_path = COALESCE(excluded.project_path, project_path),
      message_count = (
        SELECT COUNT(*) FROM messages WHERE messages.conversation_id = conversations.conversation_id
      )
  `);

  let lines;
  try {
    lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  } catch (e) {
    return { status: 'error', error: `read failed: ${e.message}` };
  }

  let aiTitle = null;
  let firstUserText = null;
  let projectPath = null;
  let first_ts = Infinity, last_ts = 0;
  let imported = 0;

  const tx = db.transaction(() => {
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }

      if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
        aiTitle = obj.aiTitle.trim();
        continue;
      }
      if (obj.cwd && !projectPath) projectPath = obj.cwd;

      const boundary = extractCompactBoundary(obj);
      if (boundary) {
        const ts = boundary.timestamp ? Math.floor(new Date(boundary.timestamp).getTime() / 1000) : 0;
        if (ts) { first_ts = Math.min(first_ts, ts); last_ts = Math.max(last_ts, ts); }
        const msgId =
          boundary.id ||
          (boundary.uuid ? `boundary-${boundary.uuid}` : null) ||
          (boundary.timestamp ? `boundary-${boundary.timestamp}` : 'boundary-unknown');
        try {
          insertMessage.run(
            source, conversationId, msgId, 'boundary', 'compact',
            JSON.stringify(boundary.metadata || {}), ts,
            JSON.stringify({ raw_type: 'compact_boundary', parentUuid: boundary.parentUuid || null }),
            null, boundary.uuid || null,
          );
          imported++;
        } catch (_) { /* dupe */ }
        continue;
      }

      const m = extractMessageFromRecord(obj);
      if (!m) continue;
      if (!['user', 'assistant', 'summary'].includes(m.role)) continue;

      const ts = m.timestamp ? Math.floor(new Date(m.timestamp).getTime() / 1000) : 0;
      if (ts) { first_ts = Math.min(first_ts, ts); last_ts = Math.max(last_ts, ts); }

      if (m.role === 'user' && !firstUserText) {
        const text = m.text.trim().replace(/\s+/g, ' ');
        if (text && !isContinuationBoilerplate(text)) firstUserText = text.slice(0, 80);
      }

      const sender =
        m.role === 'user' ? 'me'
        : m.role === 'summary' ? 'compact-summary'
        : source;

      try {
        insertMessage.run(
          source, conversationId,
          obj.id || `${source}-${fileName}-${(m.uuid || ts).toString().slice(0, 16)}`,
          m.role, sender, m.text, ts,
          JSON.stringify({ raw_type: obj.type || null, parentUuid: m.parentUuid || null }),
          null, m.uuid || null,
        );
        imported++;
      } catch (_) { /* dupe */ }
    }

    const baseTitle = aiTitle || firstUserText || fileName;
    upsertConversation.run(
      conversationId, source, baseTitle,
      isFinite(first_ts) ? first_ts : null,
      last_ts || null,
      0, // message_count gets recomputed by the trigger expression above
      null, projectPath,
    );
  });

  try {
    tx();
  } catch (e) {
    return { status: 'error', error: `transaction failed: ${e.message}` };
  }

  return {
    status: 'imported',
    format,
    conversation_id: conversationId,
    total_imported: imported,
    title: aiTitle || firstUserText || fileName,
  };
}

// ----- OpenClaw JSONL — channel-aware per-record routing (v0.11+) -----

/**
 * Ingest an OpenClaw session file with proper channel splitting.
 *
 * Key differences from the claude/cowork path above:
 *   1. Per-record channel detection (kimi-web / telegram / system / null)
 *   2. Telegram "[Queued messages while agent was busy]" records are
 *      UNPACKED into N individual memex messages (each Queued #i block).
 *   3. conversation_id is derived per-channel, not per-file:
 *        telegram   → openclaw-tg-<sender_id>      (per-user thread)
 *        kimi-web   → openclaw-kimi-<file8>        (per-session thread)
 *        system     → openclaw-sys-<file8>
 *        null       → openclaw-<file8>             (fallback)
 *   4. Per-conversation title/first_ts/last_ts/message_count tracked in
 *      a Map and upserted at end. One source file can produce 2-5+ convs.
 *   5. `channel` column populated.
 *   6. Sender metadata (sender_id, username, reply_to_id) for Telegram
 *      stored in `metadata` JSON for future queries.
 */
async function ingestOpenclawJsonl(db, path, _opts) {
  const source = 'openclaw';
  const fileName = basename(path, '.jsonl');

  const { extractMessageFromRecord } = await import('./parse.js');
  const channelMod = await import('./openclaw-channel.js');
  const {
    CHANNELS,
    findChannelDef,
    getOrAutoRegister,
    detectChannel,
    findSessionsJson,
    loadSessionsJsonChannelMap,
    deriveOpenclawConvId,
    titlePrefixFor,
    baseUuid8,
  } = channelMod;

  // Sessions.json fallback channel — keyed by full sessionFile path. For
  // files in the archive (re-parse / backfill) the absolute path won't
  // appear in current sessions.json — that's fine, we just fall through
  // to text-based detection.
  const sessionsJsonPath = findSessionsJson(path);
  const channelMap = sessionsJsonPath ? loadSessionsJsonChannelMap(sessionsJsonPath) : new Map();
  const fileFallbackChannel = channelMap.get(path) || null;

  const fileUuid8 = baseUuid8(fileName);

  let lines;
  try {
    lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  } catch (e) {
    return { status: 'error', error: `read failed: ${e.message}` };
  }

  // Prepared statements with channel column
  const insertMessage = db.prepare(`
    INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts, metadata, edited_at, uuid, channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, conversation_id, msg_id) DO UPDATE SET
      text = excluded.text,
      channel = COALESCE(excluded.channel, messages.channel),
      uuid = COALESCE(messages.uuid, excluded.uuid)
  `);
  const upsertConversation = db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, parent_conversation_id, project_path)
    VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
    ON CONFLICT(conversation_id) DO UPDATE SET
      title = COALESCE(excluded.title, conversations.title),
      first_ts = MIN(conversations.first_ts, excluded.first_ts),
      last_ts = MAX(conversations.last_ts, excluded.last_ts),
      message_count = (
        SELECT COUNT(*) FROM messages WHERE messages.conversation_id = conversations.conversation_id
      )
  `);

  // Per-conversation stats — title / first_ts / last_ts / channel.
  // Computed during ingest, applied once via upsertConversation at the
  // end. Channel is remembered so the title prefix ("[Telegram]" /
  // "[Kimi-web]" / "[<auto-registered>]") can be derived even for
  // self-hosted channels whose conv_id doesn't follow the built-in
  // openclaw-tg-* / openclaw-kimi-* / openclaw-sys-* prefixes.
  const convStats = new Map();
  function bump(convId, ts, candidateTitle, channel) {
    let s = convStats.get(convId);
    if (!s) {
      s = { first_ts: Infinity, last_ts: 0, title: null, channel: null };
      convStats.set(convId, s);
    }
    if (ts && ts > 0) {
      s.first_ts = Math.min(s.first_ts, ts);
      s.last_ts = Math.max(s.last_ts, ts);
    }
    if (!s.title && candidateTitle) {
      s.title = candidateTitle.trim().replace(/\s+/g, ' ').slice(0, 80);
    }
    if (!s.channel && channel) s.channel = channel;
  }

  let imported = 0;

  // === Sticky channel + conv pointer ===
  //
  // Tracks the channel + conv_id of the most recent DETECTED user
  // message. Used to route two kinds of records that have no channel
  // marker of their own:
  //
  //   1. assistant replies         — semantically belong to the thread
  //                                  they answer
  //   2. tool-result records       — role='user' in the OpenClaw schema
  //                                  but actually Bash/Read/etc. output;
  //                                  these are part of the agent's
  //                                  reasoning chain in the same thread
  //
  // The sticky pointer is initialised from the file-level
  // sessions.json fallback (so a pure single-channel file routes even
  // its very first record). It only ADVANCES on detected user
  // messages — never on tool-results or assistants — so those don't
  // shadow the real conversation owner. (v0.11.0 bug: tool-results
  // reset sticky to null and orphaned ~170 messages into a fallback
  // bucket. v0.11.1 fixes this.)
  let lastUserChannel = fileFallbackChannel;
  let lastUserConvId = fileFallbackChannel
    ? deriveOpenclawConvId(fileFallbackChannel, null, fileUuid8)
    : null;

  const tx = db.transaction(() => {
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }

      // OpenClaw uses {type: "message", message: {role, content}, ...} —
      // extractMessageFromRecord handles this shape (it's the same as
      // Claude Code's nested-content form).
      const m = extractMessageFromRecord(obj);
      if (!m) continue;
      if (!['user', 'assistant'].includes(m.role)) continue;

      const baseTs = m.timestamp
        ? Math.floor(new Date(m.timestamp).getTime() / 1000)
        : 0;

      // === Determine routing ===
      // Text-pattern detection only — file-level fallback handled below
      // so we can distinguish "detected" from "inherited".
      const detectedChannel = m.role === 'user'
        ? detectChannel(m.text, null)
        : null;

      let channel, channelDef;
      if (detectedChannel) {
        // Real user message with a channel marker.
        channel = detectedChannel;
        channelDef = findChannelDef(channel);
      } else if (lastUserConvId) {
        // Synthetic user (tool_result) or assistant — inherit from last
        // detected user message.
        channel = lastUserChannel;
        channelDef = channel
          ? (findChannelDef(channel) || getOrAutoRegister(channel))
          : null;
      } else {
        // Early in file, no sticky yet — use file-level fallback (from
        // sessions.json). For known channels this is null since the
        // pointer was initialised from fileFallbackChannel; this branch
        // mainly covers files with no sessions.json sibling.
        channel = fileFallbackChannel;
        channelDef = channel
          ? (findChannelDef(channel) || getOrAutoRegister(channel))
          : null;
      }

      // === Batched record (Telegram today; pluggable for future) ===
      if (
        channelDef?.parseBatch &&
        m.role === 'user' &&
        /^\[Queued messages while agent was busy\]/i.test(m.text)
      ) {
        const batches = channelDef.parseBatch(m.text);
        for (const b of batches) {
          if (!b.sender_id) continue;
          const convId =
            channelDef.convIdFor({ sender_id: b.sender_id }, { fileUuid8 }) ||
            `openclaw-${fileUuid8}`;
          const msgId = b.message_id ? `tg-${b.message_id}` : `tg-${b.sender_id}-${b.ts || baseTs}`;
          const ts = b.ts || baseTs;
          const metadata = JSON.stringify({
            raw_type: 'openclaw-telegram-batched',
            telegram_message_id: b.message_id,
            sender_id: b.sender_id,
            sender: b.sender,
            username: b.username,
            reply_to_id: b.reply_to_id,
            source_file: fileName,
            parentId: obj.parentId || null,
          });
          try {
            const r = insertMessage.run(
              source, convId, msgId, m.role,
              b.sender || (b.username ? `@${b.username}` : channel),
              b.text || '', ts, metadata, null,
              null,
              channel,
            );
            if (r.changes > 0) imported++;
            bump(convId, ts, b.text, channel);
          } catch (_) { /* dupe via UNIQUE */ }
          // Advance sticky to last batched sender
          lastUserChannel = channel;
          lastUserConvId = convId;
        }
        continue;
      }

      // === Single-record metadata extraction (e.g. one TG without batch header) ===
      if (channelDef?.parseSingle && m.role === 'user' && detectedChannel) {
        const parsed = channelDef.parseSingle(m.text);
        if (parsed && parsed.sender_id) {
          const convId =
            channelDef.convIdFor({ sender_id: parsed.sender_id }, { fileUuid8 }) ||
            `openclaw-${fileUuid8}`;
          const msgId = parsed.message_id ? `tg-${parsed.message_id}` : (m.id || `openclaw-${fileName}-${baseTs}`);
          const ts = parsed.ts || baseTs;
          const metadata = JSON.stringify({
            raw_type: 'openclaw-telegram-single',
            telegram_message_id: parsed.message_id,
            sender_id: parsed.sender_id,
            sender: parsed.sender,
            username: parsed.username,
            reply_to_id: parsed.reply_to_id,
            source_file: fileName,
            parentId: obj.parentId || null,
          });
          try {
            const r = insertMessage.run(
              source, convId, msgId, m.role,
              parsed.sender || (parsed.username ? `@${parsed.username}` : channel),
              parsed.text || '', ts, metadata, null,
              m.uuid || null,
              channel,
            );
            if (r.changes > 0) imported++;
            bump(convId, ts, parsed.text, channel);
          } catch (_) { /* dupe */ }
          lastUserChannel = channel;
          lastUserConvId = convId;
          continue;
        }
        // parseSingle failed → fall through to default path
      }

      // === Default path ===
      // - Detected user message on a channel without special parser
      //   (e.g. Kimi-web, system, auto-registered self-hosted channel):
      //   derive a fresh conv_id from the channel def.
      // - Synthetic user (tool_result) or assistant: inherit from
      //   sticky pointer.
      let convId;
      if (detectedChannel && channelDef) {
        convId =
          channelDef.convIdFor({}, { fileUuid8 }) ||
          `openclaw-${fileUuid8}`;
      } else if (lastUserConvId) {
        convId = lastUserConvId;
      } else if (channelDef) {
        convId =
          channelDef.convIdFor({}, { fileUuid8 }) ||
          `openclaw-${fileUuid8}`;
      } else {
        convId = `openclaw-${fileUuid8}`;
      }

      // Channel-specific header strip (Kimi today; pluggable via stripHeader)
      let text = m.text;
      if (channelDef?.stripHeader && m.role === 'user' && detectedChannel) {
        text = channelDef.stripHeader(text);
      }
      if (!text || !text.trim()) continue;

      const sender = m.role === 'user' ? 'me' : source;
      const msgId = m.id || obj.id || `openclaw-${fileName}-${baseTs}`;
      const metadata = JSON.stringify({
        raw_type: obj.type || null,
        parentId: obj.parentId || null,
        parentUuid: m.parentUuid || null,
        source_file: fileName,
        auto_channel: channelDef?.isAutoRegistered || false,
      });
      try {
        const r = insertMessage.run(
          source, convId, msgId, m.role, sender, text, baseTs, metadata, null,
          m.uuid || null,
          channel, // may be null — that's fine
        );
        if (r.changes > 0) imported++;
        bump(convId, baseTs, m.role === 'user' ? text : null, channel);
      } catch (_) { /* dupe */ }

      // Advance sticky ONLY for detected user messages. Tool_results
      // (role='user' without a channel marker) and assistant records
      // do NOT advance — they inherit and pass through.
      if (detectedChannel && m.role === 'user') {
        lastUserChannel = channel;
        lastUserConvId = convId;
      }
    }

    // Upsert all conversations seen in this file. Title prefix comes
    // from the channel def (covers auto-registered self-hosted
    // channels too — e.g. "[discord] What did Mara say?").
    for (const [convId, s] of convStats.entries()) {
      const prefix = s.channel ? (titlePrefixFor(s.channel) || '') : '';
      const titleText = s.title || fileName;
      const title = prefix ? `${prefix} ${titleText}` : titleText;
      upsertConversation.run(
        convId, source, title,
        isFinite(s.first_ts) ? s.first_ts : null,
        s.last_ts || null,
      );
    }
  });

  try {
    tx();
  } catch (e) {
    return { status: 'error', error: `transaction failed: ${e.message}` };
  }

  return {
    status: 'imported',
    format: 'openclaw-jsonl',
    total_imported: imported,
    conversations: Array.from(convStats.keys()),
    file_uuid8: fileUuid8,
  };
}
