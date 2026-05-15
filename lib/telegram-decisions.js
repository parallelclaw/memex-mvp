/**
 * Privacy-first per-chat decisions for Telegram imports.
 *
 * Stored at ~/.memex/telegram-decisions.json:
 *   {
 *     version: 1,
 *     mode: "pick" | "auto" | "manual",
 *     allowed_chats: [{ title, first_imported }],
 *     skipped_chats: [{ title, skipped_at }],
 *     blocked_patterns: [{ pattern, added_at, note }]   // glob-ish on title
 *   }
 *
 * Reads are cheap; writes are atomic (tmp + rename).
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const DECISIONS_PATH = join(homedir(), '.memex', 'telegram-decisions.json');
export const VALID_MODES = ['pick', 'auto', 'manual'];

const DEFAULT_STATE = () => ({
  version: 1,
  mode: 'pick',
  allowed_chats: [],
  skipped_chats: [],
  blocked_patterns: [],
});

export function loadDecisions(path = DECISIONS_PATH) {
  if (!existsSync(path)) return DEFAULT_STATE();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    // Normalize old / partial files
    return {
      ...DEFAULT_STATE(),
      ...parsed,
      allowed_chats: Array.isArray(parsed.allowed_chats) ? parsed.allowed_chats : [],
      skipped_chats: Array.isArray(parsed.skipped_chats) ? parsed.skipped_chats : [],
      blocked_patterns: Array.isArray(parsed.blocked_patterns) ? parsed.blocked_patterns : [],
    };
  } catch (_) {
    return DEFAULT_STATE();
  }
}

export function saveDecisions(state, path = DECISIONS_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// -------------------- Predicates --------------------

function norm(s) { return String(s || '').trim().toLowerCase(); }

export function isAllowed(state, chatTitle) {
  const n = norm(chatTitle);
  return state.allowed_chats.some((c) => norm(c.title) === n);
}

export function isSkipped(state, chatTitle) {
  const n = norm(chatTitle);
  return state.skipped_chats.some((c) => norm(c.title) === n);
}

export function isBlocked(state, chatTitle) {
  const n = norm(chatTitle);
  for (const b of state.blocked_patterns) {
    const p = norm(b.pattern);
    if (!p) continue;
    // glob: "*" → match anywhere; otherwise substring on lowercased title
    if (p.includes('*')) {
      // Convert glob → regex: split on '*', escape each part, rejoin with '.*'
      const escaped = p
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const rx = new RegExp('^' + escaped + '$');
      if (rx.test(n)) return true;
    } else if (n.includes(p)) {
      return true;
    }
  }
  return false;
}

/**
 * Decide what to do with a freshly-detected chat.
 *
 * Returns one of:
 *   'import'  — go ahead and add to memex.db
 *   'skip'    — user explicitly said no before
 *   'block'   — matches a block pattern, never import
 *   'pending' — first time we've seen this chat, wait for user decision
 *
 * Mode controls default for unknown chats:
 *   pick   → 'pending'
 *   auto   → 'pending'   (auto only auto-imports KNOWN allowed; new chats still wait)
 *   manual → 'pending'   (manual disables the watcher entirely; this fn unused)
 */
export function decideForChat(state, chatTitle) {
  if (isBlocked(state, chatTitle)) return 'block';
  if (isSkipped(state, chatTitle)) return 'skip';
  if (isAllowed(state, chatTitle)) return 'import';
  return 'pending';
}

// -------------------- Mutations --------------------

export function allowChat(state, title, now = new Date()) {
  if (isAllowed(state, title)) return state;
  // Move it out of skipped if it was there
  state.skipped_chats = state.skipped_chats.filter((c) => norm(c.title) !== norm(title));
  state.allowed_chats.push({ title, first_imported: now.toISOString() });
  return state;
}

export function skipChat(state, title, now = new Date()) {
  if (isSkipped(state, title)) return state;
  state.allowed_chats = state.allowed_chats.filter((c) => norm(c.title) !== norm(title));
  state.skipped_chats.push({ title, skipped_at: now.toISOString() });
  return state;
}

export function unskipChat(state, title) {
  state.skipped_chats = state.skipped_chats.filter((c) => norm(c.title) !== norm(title));
  return state;
}

export function blockPattern(state, pattern, note = '', now = new Date()) {
  const p = String(pattern || '').trim();
  if (!p) return state;
  if (state.blocked_patterns.some((b) => norm(b.pattern) === norm(p))) return state;
  state.blocked_patterns.push({ pattern: p, added_at: now.toISOString(), note });
  return state;
}

export function unblockPattern(state, pattern) {
  state.blocked_patterns = state.blocked_patterns.filter((b) => norm(b.pattern) !== norm(pattern));
  return state;
}

export function setMode(state, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid mode '${mode}'. Valid: ${VALID_MODES.join(', ')}`);
  }
  state.mode = mode;
  return state;
}
