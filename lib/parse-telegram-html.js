/**
 * Telegram Desktop HTML export → Telegram-JSON-shape converter.
 *
 * Telegram Desktop offers two export formats:
 *   - "Machine-readable JSON"  — what memex's importTelegram expects
 *   - "Human-readable HTML"    — what many users pick by default
 *
 * Users frequently export as HTML by accident (often the default in the
 * Telegram UI), then memex's inbox watcher silently ignores the dropped
 * directory. This module makes HTML work: parse → emit the same shape
 * importTelegram already understands.
 *
 * Telegram's HTML export is reasonably stable:
 *
 *   ChatExport_<chat-title>_<date>/
 *     ├── messages.html     (or messages.htm — chunked: messages2, messages3, …)
 *     ├── photos/
 *     ├── files/
 *     ├── stickers/
 *     └── voice_messages/
 *
 * Each messages*.html has structure:
 *
 *   <div class="message default clearfix" id="message12345">
 *     <div class="body">
 *       <div class="from_name"> ↳ Sender Name </div>      (may be absent on "joined" messages)
 *       <div class="text"> message text </div>
 *       <div class="pull_right date details" title="2024-01-01 14:23:45 UTC+03:00">14:23</div>
 *     </div>
 *   </div>
 *
 *   Joined message = same sender as previous, has class "joined", no from_name.
 *   Service message = class "service" (joined chat, name change, …) — we skip these.
 *   Forwarded = "forwarded body" wrapping the message body.
 *   Reply = "reply_to details" sibling.
 *
 * We use regex-based parsing (no DOM dependency) because Telegram's class
 * names are stable and we control which fields we care about. If Telegram
 * radically changes the schema, parser breaks loudly (returns 0 messages
 * + clear log) rather than silently corrupting.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

/**
 * Detect if a given path is a Telegram HTML export.
 * Accepts both a directory (most common — ChatExport_xxx/) and a bare
 * messages.html file (rare — user dropped just the one file).
 *
 * Returns { type: 'dir' | 'file' | null, htmlFiles: string[] }
 *   null type means "not a Telegram HTML export"
 */
export function detectTelegramHtml(path) {
  if (!existsSync(path)) return { type: null, htmlFiles: [] };
  const stats = statSync(path);

  // Directory case: look for messages*.html inside
  if (stats.isDirectory()) {
    let entries = [];
    try { entries = readdirSync(path); } catch (_) { return { type: null, htmlFiles: [] }; }
    const htmlFiles = entries
      .filter((f) => /^messages\d*\.html?$/i.test(f))
      .map((f) => join(path, f));
    if (htmlFiles.length === 0) return { type: null, htmlFiles: [] };
    // Verify the first one contains Telegram-shaped markers
    const head = safeReadHead(htmlFiles[0]);
    if (!looksLikeTelegram(head)) return { type: null, htmlFiles: [] };
    // Sort chunks: messages.html < messages2.html < messages3.html …
    htmlFiles.sort(numericChunkSort);
    return { type: 'dir', htmlFiles };
  }

  // Single file case: must be messages*.html
  if (stats.isFile() && /\.html?$/i.test(path) && /messages\d*\.html?$/i.test(basename(path))) {
    const head = safeReadHead(path);
    if (!looksLikeTelegram(head)) return { type: null, htmlFiles: [] };
    return { type: 'file', htmlFiles: [path] };
  }

  return { type: null, htmlFiles: [] };
}

function safeReadHead(file, bytes = 8192) {
  try {
    return readFileSync(file, 'utf-8').slice(0, bytes);
  } catch (_) {
    return '';
  }
}

function looksLikeTelegram(head) {
  // Reliable markers in Telegram Desktop HTML exports
  return /class="page_wrap"/.test(head) ||
         /class="page_body chat_page"/.test(head) ||
         (/class="from_name"/.test(head) && /class="text"/.test(head));
}

function numericChunkSort(a, b) {
  const numA = parseInt((basename(a).match(/messages(\d*)\.html?/i) || [, '0'])[1] || '0', 10);
  const numB = parseInt((basename(b).match(/messages(\d*)\.html?/i) || [, '0'])[1] || '0', 10);
  return numA - numB;
}

/**
 * Strip HTML tags and decode common entities → plain text.
 * Conservative: preserves newlines from <br>, paragraph breaks from </div>.
 */
function htmlToText(html) {
  if (!html) return '';
  let out = String(html);
  // Convert breaks to newlines BEFORE stripping tags
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/p>/gi, '\n\n');
  out = out.replace(/<\/div>/gi, '\n');
  // Drop all remaining tags
  out = out.replace(/<[^>]+>/g, '');
  // Decode common entities
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
  // Collapse 3+ blank lines, trim
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/**
 * Parse a Telegram date title into Unix timestamp.
 * Format: "2024-01-01 14:23:45 UTC+03:00" (or "UTC-04:00", etc.)
 * Returns { tsUnix, isoString } or null if unparseable.
 */
function parseTelegramDate(title) {
  if (!title) return null;
  const m = title.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+UTC([+-])(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  // Construct an ISO 8601 string with the explicit offset (or UTC if absent)
  const offset = sign ? `${sign}${oh}:${om}` : 'Z';
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return {
    tsUnix: Math.floor(date.getTime() / 1000),
    isoString: iso.replace(/[+-]\d{2}:\d{2}$/, '').replace('Z', ''),
  };
}

/**
 * Parse a single message div (raw HTML segment).
 * Returns null for service messages (we skip those) or messages with no text.
 */
function parseMessageDiv(messageHtml, lastSender) {
  // Skip service messages outright
  if (/class="message service\b/.test(messageHtml)) return null;

  // Extract message id from outer div: id="message12345"
  const idMatch = messageHtml.match(/id="message(\d+)"/);
  const msgId = idMatch ? idMatch[1] : null;
  if (!msgId) return null;

  const isJoined = /class="message [^"]*joined/.test(messageHtml);

  // Forwarded marker
  const isForwarded = /class="forwarded body"/.test(messageHtml);
  let forwardedFrom = null;
  if (isForwarded) {
    const fwdM = messageHtml.match(/class="forwarded[^"]*"[\s\S]*?<div class="from_name"[^>]*>\s*([\s\S]*?)\s*<\/div>/);
    if (fwdM) {
      forwardedFrom = htmlToText(fwdM[1]).replace(/^Forwarded from:?\s*/i, '').trim();
    }
  }

  // Sender (from_name) — absent on joined messages
  let fromName = null;
  const fromM = messageHtml.match(/<div class="from_name"[^>]*>\s*([\s\S]*?)\s*<\/div>/);
  if (fromM && !isForwarded) {
    fromName = htmlToText(fromM[1]).trim();
  }
  // If joined, inherit lastSender; otherwise use parsed or fallback
  if (!fromName && isJoined && lastSender) fromName = lastSender;
  if (!fromName) fromName = 'Unknown';

  // Date — title attribute on `.date.details`
  let date = null;
  const dateM = messageHtml.match(/class="[^"]*\bdate details[^"]*"\s+title="([^"]+)"/);
  if (dateM) date = parseTelegramDate(dateM[1]);

  // Main text — last `<div class="text">…</div>` inside body (forwards may have one earlier)
  let text = '';
  const textMatches = [...messageHtml.matchAll(/<div class="text"[^>]*>([\s\S]*?)<\/div>(?=\s*(?:<div class="(?!text)|<\/div>|<a class="|$))/g)];
  if (textMatches.length > 0) {
    // Use last one (the actual message body, after any quoted/forwarded preamble)
    text = htmlToText(textMatches[textMatches.length - 1][1]);
  }

  // Reply marker — include as prefix so it's searchable but not lost
  const replyM = messageHtml.match(/class="reply_to details"[^>]*>([\s\S]*?)<\/div>/);
  if (replyM) {
    const replyTxt = htmlToText(replyM[1]).replace(/^In reply to\s+/i, '').trim();
    if (replyTxt) text = `↩ Reply: ${replyTxt}\n\n${text}`;
  }

  // Photo / media — if no text, note the media presence so the row isn't lost.
  // Use word-boundary regexes since class attrs like "photo_wrap clearfix pull_left"
  // wouldn't match a strict `class="photo_wrap"` pattern.
  if (!text) {
    if (/class="[^"]*\bphoto_wrap\b/.test(messageHtml)) text = '[photo]';
    else if (/class="[^"]*\bmedia_voice_message\b/.test(messageHtml)) text = '[voice message]';
    else if (/class="[^"]*\bmedia_video_file\b/.test(messageHtml)) text = '[video]';
    else if (/class="[^"]*\bmedia_audio_file\b/.test(messageHtml)) text = '[audio]';
    else if (/class="[^"]*\bmedia_file\b/.test(messageHtml)) text = '[file]';
    else if (/class="[^"]*\bsticker\b/.test(messageHtml)) text = '[sticker]';
    else return null;  // Truly empty — skip
  }

  // Build the message object in the shape importTelegram expects
  // (date and date_unixtime are required by the importer)
  const isoDate = date ? date.isoString : null;
  const tsUnix = date ? date.tsUnix : 0;

  return {
    id: parseInt(msgId, 10),
    type: 'message',
    date: isoDate || '1970-01-01T00:00:00',
    date_unixtime: tsUnix > 0 ? String(tsUnix) : '0',
    from: fromName,
    from_id: fromName ? `user_html_${slugify(fromName)}` : 'unknown',
    text: text,
    ...(forwardedFrom ? { forwarded_from: forwardedFrom } : {}),
  };
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'anon';
}

/**
 * Extract chat title from messages.html (or first chunk).
 * Falls back to directory name basename, then "Telegram chat".
 */
function extractChatTitle(htmlContent, fallbackPath) {
  // Try the <title>...</title>
  const titleM = htmlContent.match(/<title>\s*([^<]+?)\s*<\/title>/i);
  if (titleM) {
    let t = titleM[1].trim();
    // Telegram titles often look like "Alice — Chat Export"
    t = t.replace(/\s*[—-]\s*(Chat Export|Telegram).*$/i, '').trim();
    if (t && t !== 'Telegram') return t;
  }
  // Try the page_header text
  const headerM = htmlContent.match(/<div class="text bold"[^>]*>\s*([\s\S]*?)\s*<\/div>/);
  if (headerM) {
    const t = htmlToText(headerM[1]).trim();
    if (t) return t;
  }
  // Fallback: dirname of the parent ChatExport_xxx folder
  if (fallbackPath) {
    const parent = basename(dirname(fallbackPath));
    if (parent && parent.startsWith('ChatExport')) {
      return parent.replace(/^ChatExport_?/, '').replace(/_/g, ' ').trim() || 'Telegram chat';
    }
  }
  return 'Telegram chat';
}

/**
 * Main entrypoint. Parse a Telegram HTML export path → return an object
 * shaped like a Telegram JSON export, ready for importTelegram().
 *
 * Returns null if path isn't a valid Telegram HTML export.
 *
 * Object shape:
 *   {
 *     personal_information: { user_id: "" },
 *     chats: {
 *       list: [{
 *         id: <stable hash of chat title>,
 *         name: <chat title>,
 *         type: "personal_chat",
 *         messages: [{ id, type, date, date_unixtime, from, from_id, text, … }, …]
 *       }]
 *     }
 *   }
 */
export function parseTelegramHtmlExport(path, opts = {}) {
  const detection = detectTelegramHtml(path);
  if (!detection.type) return null;
  if (detection.htmlFiles.length === 0) return null;

  let allMessages = [];
  let chatTitle = null;
  let lastSender = null;

  for (const htmlPath of detection.htmlFiles) {
    let content;
    try { content = readFileSync(htmlPath, 'utf-8'); }
    catch (_) { continue; }

    if (!chatTitle) chatTitle = extractChatTitle(content, htmlPath);

    // Split into per-message blocks. The reliable boundary is the
    // opening `<div class="message ` of the next message.
    // Use a tolerant regex that handles the message default / joined variants.
    const messageBlocks = [...content.matchAll(/<div class="message [^"]*"[\s\S]*?(?=<div class="message [^"]*"|<div class="page_footer"|<\/body>)/g)];

    for (const blockMatch of messageBlocks) {
      const msg = parseMessageDiv(blockMatch[0], lastSender);
      if (msg) {
        allMessages.push(msg);
        // Track sender for "joined" continuation messages
        if (msg.from && msg.from !== 'Unknown') lastSender = msg.from;
      }
    }
  }

  if (allMessages.length === 0) return null;

  // Stable chat id: hash of title + first message ts (good enough for dedup)
  // We use a simple numeric hash so the synthetic chat_id is stable across re-imports.
  const chatId = stableChatId(chatTitle || 'Telegram chat', allMessages[0]?.date_unixtime || '0');

  return {
    personal_information: { user_id: '' },
    chats: {
      list: [
        {
          id: chatId,
          name: chatTitle || 'Telegram chat',
          type: 'personal_chat',
          messages: allMessages,
        },
      ],
    },
    _source: {
      format: 'telegram-html',
      original_path: path,
      chunks: detection.htmlFiles.length,
      messages_total: allMessages.length,
    },
  };
}

function stableChatId(title, firstTs) {
  let hash = 0;
  const key = title + ':' + firstTs;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
