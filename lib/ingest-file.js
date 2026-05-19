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
  const source =
    format === 'cowork-jsonl' ? 'claude-cowork'
    : format === 'openclaw-jsonl' ? 'openclaw'
    : 'claude-code';
  const fileName = basename(path, '.jsonl');
  // v0.10.18 (reverted from v0.10.17): for OpenClaw checkpoint files the
  // previous fix merged them into the BASE session's conversation_id —
  // which was wrong. A Telegram message sent while the agent was busy
  // on a Kimi-web session is conceptually a SEPARATE conversation (own
  // channel, own context), not part of the Kimi thread it happened to
  // overlap with. Each checkpoint inbox file now gets its own conv_id
  // (so the `openclaw-<base8>-ckpt-<chkpt8>` form stays as-is in the DB).
  // Proper channel-aware routing (Telegram messages → openclaw-tg-<chat_id>,
  // Kimi web → openclaw-<base8>, etc.) is a v0.11 feature pending a survey
  // of OpenClaw's actual record schema.
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
