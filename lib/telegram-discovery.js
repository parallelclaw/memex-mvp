/**
 * Telegram-Desktop discovery & preview.
 *
 * Three responsibilities:
 *   1. detectTelegramDesktop()   — is the app installed, where, what kind
 *   2. detectFirstLogin()        — when did the user log in (anti-abuse 24h window)
 *   3. discoverExports(dirs)     — scan likely Downloads paths for ChatExport_*
 *   4. previewExport(path)       — extract chat name, msg count, date range
 *      without doing a full ingest. Used by `memex telegram pending`.
 *
 * Everything here is fast and read-only — safe to call from CLI, MCP, or daemon.
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { detectTelegramHtml, parseTelegramHtmlExport } from './parse-telegram-html.js';

// ------------------------- Desktop detection -------------------------

/**
 * Detect Telegram Desktop installation.
 *
 * Returns {
 *   installed: bool,
 *   path: string|null,           // absolute path to .app / executable / install dir
 *   variant: 'direct'|'app_store'|'snap'|'apt'|'exe'|null,
 *   platform: 'darwin'|'linux'|'win32'|'other',
 *   notes: string[]              // user-facing hints, e.g. App Store sandbox warning
 * }
 *
 * On macOS we check /Applications/Telegram.app and /Applications/Telegram Desktop.app.
 * The Mac App Store version is sandboxed and can have issues with the export
 * folder — we flag that.
 */
export function detectTelegramDesktop() {
  const plat = platform();
  const out = { installed: false, path: null, variant: null, platform: plat, notes: [] };

  if (plat === 'darwin') {
    const candidates = [
      '/Applications/Telegram.app',
      '/Applications/Telegram Desktop.app',
      join(homedir(), 'Applications/Telegram.app'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        out.installed = true;
        out.path = c;
        // Try to tell App Store apart from direct download by bundle receipt path
        const receiptPath = join(c, 'Contents/_MASReceipt/receipt');
        out.variant = existsSync(receiptPath) ? 'app_store' : 'direct';
        if (out.variant === 'app_store') {
          out.notes.push(
            "App Store Telegram has sandboxed file access. Chat exports usually work but may go to a Containers/ path instead of ~/Downloads/Telegram Desktop/. If memex can't see your exports, install the direct version from telegram.org/dl/macos."
          );
        }
        break;
      }
    }
  } else if (plat === 'linux') {
    // Common Linux install paths
    const candidates = [
      '/usr/bin/telegram-desktop',
      '/usr/local/bin/telegram-desktop',
      '/snap/bin/telegram-desktop',
      join(homedir(), '.local/share/TelegramDesktop'),
      '/var/lib/flatpak/exports/bin/org.telegram.desktop',
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        out.installed = true;
        out.path = c;
        out.variant = c.includes('/snap/') ? 'snap' : c.includes('flatpak') ? 'flatpak' : 'apt';
        break;
      }
    }
  } else if (plat === 'win32') {
    const candidates = [
      join(homedir(), 'AppData/Roaming/Telegram Desktop/Telegram.exe'),
      'C:/Program Files/Telegram Desktop/Telegram.exe',
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        out.installed = true;
        out.path = c;
        out.variant = 'exe';
        break;
      }
    }
  }

  return out;
}

// ------------------------- Login age (24h delay) -------------------------

/**
 * Detect when the user logged in to Telegram Desktop, by looking at the
 * tdata directory mtime. Telegram refuses to export chats for the first
 * ~24 hours after a fresh login (anti-abuse window).
 *
 * Returns {
 *   logged_in: bool,
 *   first_login_at: ISO string | null,
 *   hours_since_login: number | null,
 *   export_allowed: bool          // true iff > 24h elapsed
 * }
 */
export function detectFirstLogin() {
  const out = { logged_in: false, first_login_at: null, hours_since_login: null, export_allowed: false };
  const plat = platform();
  let tdataDir = null;

  if (plat === 'darwin') {
    tdataDir = join(homedir(), 'Library/Application Support/Telegram Desktop/tdata');
  } else if (plat === 'linux') {
    tdataDir = join(homedir(), '.local/share/TelegramDesktop/tdata');
  } else if (plat === 'win32') {
    tdataDir = join(homedir(), 'AppData/Roaming/Telegram Desktop/tdata');
  }

  if (!tdataDir || !existsSync(tdataDir)) return out;

  try {
    // Look for 'key_datas' or 'shortcuts-default.json' or just the dir itself.
    // The dir creation time on Telegram-init is our login proxy.
    const candidates = ['key_datas', 'shortcuts-default.json', ''];
    let oldestMs = null;
    for (const c of candidates) {
      const p = c ? join(tdataDir, c) : tdataDir;
      if (existsSync(p)) {
        const s = statSync(p);
        // Prefer birthtime if it's sensible; otherwise mtime
        const t = s.birthtimeMs && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
        if (oldestMs === null || t < oldestMs) oldestMs = t;
      }
    }
    if (oldestMs !== null) {
      const ageMs = Date.now() - oldestMs;
      out.logged_in = true;
      out.first_login_at = new Date(oldestMs).toISOString();
      out.hours_since_login = Math.floor(ageMs / 3600000);
      out.export_allowed = ageMs > 24 * 3600000;
    }
  } catch (_) {
    /* swallow */
  }

  return out;
}

// ------------------------- Export discovery -------------------------

/**
 * Default paths to scan for ChatExport_* folders / result.json files.
 * Returns absolute paths that exist on disk (caller filters).
 */
export function defaultDownloadsPaths() {
  const paths = [];
  if (platform() === 'darwin') {
    paths.push(join(homedir(), 'Downloads/Telegram Desktop'));
    paths.push(join(homedir(), 'Downloads'));
    paths.push(join(homedir(), 'Desktop'));
  } else if (platform() === 'linux') {
    paths.push(join(homedir(), 'Downloads/Telegram Desktop'));
    paths.push(join(homedir(), 'Downloads'));
  } else if (platform() === 'win32') {
    paths.push(join(homedir(), 'Downloads/Telegram Desktop'));
    paths.push(join(homedir(), 'Downloads'));
  }
  return paths.filter((p) => existsSync(p));
}

/**
 * Walk the given directories looking for Telegram chat exports.
 * A "candidate" is either a `ChatExport_*` directory (HTML or JSON export)
 * or a bare `result.json` file (legacy single-file JSON dump).
 *
 * Returns an array of { path, kind: 'html-dir'|'json-file', modified_ts, size_bytes }.
 * The caller decides whether to preview each, import, or skip.
 */
export function discoverExports(rootDirs) {
  const out = [];
  for (const root of rootDirs) {
    if (!existsSync(root)) continue;
    let entries = [];
    try { entries = readdirSync(root); } catch (_) { continue; }
    for (const name of entries) {
      const full = join(root, name);
      let s;
      try { s = statSync(full); } catch (_) { continue; }
      if (s.isDirectory()) {
        // ChatExport_2026-05-15 style
        if (name.startsWith('ChatExport_') || name.toLowerCase().startsWith('chatexport_')) {
          const det = detectTelegramHtml(full);
          if (det.type === 'dir') {
            out.push({ path: full, kind: 'html-dir', modified_ts: Math.floor(s.mtimeMs / 1000), size_bytes: dirSizeShallow(full) });
            continue;
          }
          // Maybe it's a JSON export inside the same folder name
          const resultJson = join(full, 'result.json');
          if (existsSync(resultJson)) {
            out.push({ path: resultJson, kind: 'json-file', modified_ts: Math.floor(statSync(resultJson).mtimeMs / 1000), size_bytes: statSync(resultJson).size });
          }
        }
      } else if (s.isFile() && name === 'result.json') {
        // Bare result.json at the root of one of the scanned dirs
        out.push({ path: full, kind: 'json-file', modified_ts: Math.floor(s.mtimeMs / 1000), size_bytes: s.size });
      }
    }
  }
  // Newest first
  out.sort((a, b) => b.modified_ts - a.modified_ts);
  return out;
}

function dirSizeShallow(dir) {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        const s = statSync(join(dir, name));
        if (s.isFile()) total += s.size;
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* skip */ }
  return total;
}

// ------------------------- Preview -------------------------

/**
 * Read enough of an export to produce a UI-facing preview, WITHOUT a full
 * ingest. Returns:
 *   {
 *     path,
 *     kind: 'html-dir'|'json-file',
 *     chat_title: string,
 *     chat_type: 'personal_chat'|'private_group'|null,
 *     message_count: number,
 *     date_first: ISO string | null,
 *     date_last: ISO string | null,
 *     senders_sample: string[],   // up to 6 distinct senders
 *     size_bytes: number
 *   }
 *
 * The preview is fast — for HTML we run the same parser but cap at the first
 * `messages.html` file; for JSON we do a streaming-ish read of the first chat
 * in the list and tally.
 */
export function previewExport(path) {
  const out = {
    path,
    kind: null,
    chat_title: null,
    chat_type: null,
    message_count: 0,
    date_first: null,
    date_last: null,
    senders_sample: [],
    size_bytes: 0,
  };

  if (!existsSync(path)) return out;
  const s = statSync(path);
  out.size_bytes = s.isDirectory() ? dirSizeShallow(path) : s.size;

  if (s.isDirectory()) {
    // Telegram Desktop directories can contain EITHER messages.html (HTML
    // export) OR a top-level *.json (JSON export — usually `result.json`
    // but custom names like `kimi.json` also occur when user renamed).
    // Try HTML first; fall back to the first JSON file we find inside.
    out.kind = 'html-dir';
    let parsedOk = false;
    try {
      const parsed = parseTelegramHtmlExport(path);
      if (parsed && parsed.chats.list[0] && parsed.chats.list[0].messages.length > 0) {
        const chat = parsed.chats.list[0];
        out.chat_title = chat.name;
        out.chat_type = chat.type;
        out.message_count = chat.messages.length;
        out.date_first = chat.messages[0].date || null;
        out.date_last = chat.messages[chat.messages.length - 1].date || null;
        const seen = new Set();
        for (const m of chat.messages) {
          if (m.from && m.from !== 'Unknown' && !seen.has(m.from)) {
            seen.add(m.from);
            out.senders_sample.push(m.from);
            if (out.senders_sample.length >= 6) break;
          }
        }
        parsedOk = true;
      }
    } catch (_) { /* swallow — try JSON next */ }

    // JSON fallback — look for any *.json directly in the dir
    if (!parsedOk) {
      try {
        const entries = readdirSync(path);
        // Prefer result.json; otherwise first *.json
        const jsonName = entries.find((n) => n === 'result.json')
          || entries.find((n) => n.endsWith('.json'));
        if (jsonName) {
          const jsonPath = join(path, jsonName);
          out.kind = 'json-in-dir';
          out.inner_json_path = jsonPath;
          const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
          let chat = null;
          if (data && data.chats && Array.isArray(data.chats.list) && data.chats.list[0]) {
            chat = data.chats.list[0];
          } else if (data && Array.isArray(data.messages)) {
            chat = data;
          }
          if (chat) {
            out.chat_title = chat.name || 'Telegram chat';
            out.chat_type = chat.type || null;
            const msgs = Array.isArray(chat.messages) ? chat.messages : [];
            out.message_count = msgs.length;
            if (msgs.length > 0) {
              out.date_first = msgs[0].date || null;
              out.date_last = msgs[msgs.length - 1].date || null;
            }
            const seen = new Set();
            for (const m of msgs) {
              const from = m.from || m.actor;
              if (from && !seen.has(from)) {
                seen.add(from);
                out.senders_sample.push(from);
                if (out.senders_sample.length >= 6) break;
              }
            }
          }
        }
      } catch (_) { /* swallow */ }
    }
  } else if (s.isFile() && path.endsWith('.json')) {
    out.kind = 'json-file';
    try {
      // Streaming-ish: just JSON.parse the whole file; result.json size is typically
      // a few MB, fine for preview. Telegram puts the chat list as the first key.
      const text = readFileSync(path, 'utf-8');
      const data = JSON.parse(text);
      // result.json has two shapes: { chats: { list: [...] }, ... } or { name, type, messages: [...] }
      let chat = null;
      if (data && data.chats && Array.isArray(data.chats.list) && data.chats.list[0]) {
        chat = data.chats.list[0];
      } else if (data && Array.isArray(data.messages)) {
        chat = data;
      }
      if (chat) {
        out.chat_title = chat.name || 'Telegram chat';
        out.chat_type = chat.type || null;
        const msgs = Array.isArray(chat.messages) ? chat.messages : [];
        out.message_count = msgs.length;
        if (msgs.length > 0) {
          out.date_first = msgs[0].date || null;
          out.date_last = msgs[msgs.length - 1].date || null;
        }
        const seen = new Set();
        for (const m of msgs) {
          const from = m.from || m.actor;
          if (from && !seen.has(from)) {
            seen.add(from);
            out.senders_sample.push(from);
            if (out.senders_sample.length >= 6) break;
          }
        }
      }
    } catch (_) { /* swallow */ }
  }
  return out;
}
