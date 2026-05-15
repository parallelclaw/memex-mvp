/**
 * Manage ~/.memex/pending/ — the staging area where the daemon parks
 * Telegram exports it found in ~/Downloads/Telegram Desktop/ before the
 * user explicitly approves them.
 *
 * Layout:
 *   ~/.memex/pending/
 *     ChatExport_2026-05-15/                   ← exact original name
 *       messages.html
 *       photos/ ...
 *     result-2026-05-12.json
 *     .meta.json                                ← per-entry metadata cache (preview)
 *
 * The .meta.json is recomputed lazily — we cache preview output so listing
 * 50 pending exports doesn't re-parse 50 HTML trees on every CLI invocation.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { previewExport } from './telegram-discovery.js';

// Compute lazily so process.env.HOME overrides (used by tests) actually work.
export function getPendingDir() {
  return join(homedir(), '.memex', 'pending');
}
export function getMetaFile() {
  return join(getPendingDir(), '.meta.json');
}
// Back-compat exports — still used by some callers
export const PENDING_DIR = getPendingDir();
export const META_FILE = getMetaFile();

export function ensurePendingDir() {
  const dir = getPendingDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Move a freshly-detected export from its source location into pending/.
 * If destination exists (re-export of same name), uses a numeric suffix.
 *
 * Returns the absolute destination path that now holds the export.
 *
 * `moveOrCopy` — 'move' uses fs.rename (atomic, same FS only); 'copy' uses
 * cpSync. Default 'move'. If the rename fails (cross-device), automatically
 * falls back to copy + rmSync.
 */
export function stageExport(sourcePath, opts = {}) {
  ensurePendingDir();
  const moveOrCopy = opts.moveOrCopy || 'move';
  const name = basename(sourcePath);
  const baseDir = getPendingDir();
  let dest = join(baseDir, name);
  // Suffix preserves extension so file-type sniffing (e.g. `endsWith('.json')`)
  // still works on the staged copy: result.json → result__1.json
  let suffix = 0;
  while (existsSync(dest)) {
    suffix += 1;
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) {
      const stem = name.slice(0, dot);
      const ext = name.slice(dot);
      dest = join(baseDir, `${stem}__${suffix}${ext}`);
    } else {
      dest = join(baseDir, `${name}__${suffix}`);
    }
  }

  try {
    if (moveOrCopy === 'move') {
      renameSync(sourcePath, dest);
    } else {
      cpSync(sourcePath, dest, { recursive: true });
    }
  } catch (e) {
    // EXDEV — cross-device link. Fall back to copy + delete.
    if (e.code === 'EXDEV') {
      cpSync(sourcePath, dest, { recursive: true });
      try { rmSync(sourcePath, { recursive: true, force: true }); } catch (_) { /* ok */ }
    } else {
      throw e;
    }
  }

  // Invalidate cache — next listPending() will recompute
  invalidateMeta();
  return dest;
}

/**
 * List everything in pending/, with cached previews.
 *
 * Returns an array of objects shaped like:
 *   {
 *     index: 1,
 *     path: '/Users/.../pending/ChatExport_2026-05-15',
 *     basename: 'ChatExport_2026-05-15',
 *     kind: 'html-dir'|'json-file',
 *     chat_title: '...',
 *     chat_type: 'private_group'|'personal_chat',
 *     message_count: 492,
 *     date_first: '2026-03-20T14:08:43',
 *     date_last:  '2026-05-12T00:40:08',
 *     senders_sample: ['Oleg', 'Andrey', ...],
 *     size_bytes: 468468,
 *     modified_ts: 1773820800
 *   }
 *
 * Indices are 1-based and stable within one process — used by CLI commands
 * like `memex telegram import 1 3 5`. Order: newest modified first.
 */
export function listPending(opts = {}) {
  const baseDir = getPendingDir();
  if (!existsSync(baseDir)) return [];

  const cache = loadMeta();
  const entries = [];

  let names;
  try { names = readdirSync(baseDir); } catch (_) { return []; }
  for (const name of names) {
    if (name.startsWith('.')) continue; // skip .meta.json and other hidden
    const full = join(baseDir, name);
    let st;
    try { st = statSync(full); } catch (_) { continue; }
    const mtime = Math.floor(st.mtimeMs / 1000);

    let preview = cache[name];
    if (!preview || preview.modified_ts !== mtime) {
      preview = previewExport(full);
      preview.modified_ts = mtime;
      cache[name] = preview;
    }
    entries.push({
      basename: name,
      path: full,
      modified_ts: mtime,
      ...preview,
    });
  }

  saveMeta(cache);

  entries.sort((a, b) => b.modified_ts - a.modified_ts);
  entries.forEach((e, i) => { e.index = i + 1; });
  return entries;
}

/**
 * Remove an entry from pending/ — used after successful import or after
 * `memex telegram skip`. Deletes from disk and from the meta cache.
 */
export function removePending(absPath) {
  try { rmSync(absPath, { recursive: true, force: true }); } catch (_) { /* ok */ }
  const cache = loadMeta();
  const name = basename(absPath);
  if (name in cache) {
    delete cache[name];
    saveMeta(cache);
  }
}

// -------------------- meta cache helpers --------------------

function loadMeta() {
  const meta = getMetaFile();
  if (!existsSync(meta)) return {};
  try { return JSON.parse(readFileSync(meta, 'utf-8')); }
  catch (_) { return {}; }
}

function saveMeta(cache) {
  ensurePendingDir();
  const meta = getMetaFile();
  try {
    const tmp = meta + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    renameSync(tmp, meta);
  } catch (_) { /* non-fatal */ }
}

function invalidateMeta() {
  const meta = getMetaFile();
  if (existsSync(meta)) {
    try { rmSync(meta, { force: true }); } catch (_) { /* ok */ }
  }
}
