#!/usr/bin/env node
/**
 * memex-ingest — long-running daemon that auto-ingests Claude Code and
 * Cowork sessions into memex's inbox in near-realtime.
 *
 * Architecture (variant C — hybrid):
 *   - chokidar (FSEvents on macOS, inotify on Linux) watches the source
 *     directories for add/change events.
 *   - Per-file state in ~/.memex/data/ingest-state.json:
 *       fingerprint (sha1 of first 256 bytes — robust to inode reuse)
 *       size, mtime, last dialogue count
 *   - On change: re-parse the full source JSONL, write a dialogue-only
 *     snapshot to ~/.memex/inbox/<prefix>-<short_id>.jsonl atomically
 *     (temp + rename). Memex's MCP server picks it up via its existing
 *     chokidar inbox watcher and imports → memex.db. UNIQUE(msg_id)
 *     dedupes, so re-emits are idempotent.
 *   - Backstop: every 30 minutes, walk both source dirs and re-trigger
 *     processing for any file whose (size, mtime) differs from state.
 *     Catches FSEvents coalescing during sleep / lid-close.
 *
 * Compatible with claude-backup's feed-memex format (same record shape,
 * same msg_id hash seed: sha1(role|timestamp|text[:200])).
 */

import chokidar from 'chokidar';
import { homedir } from 'node:os';
import { join, basename, sep } from 'node:path';
import {
  existsSync, statSync, readFileSync, writeFileSync, renameSync,
  mkdirSync, openSync, readSync, closeSync, unlinkSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { extractMessageFromRecord, extractAiTitle } from './lib/parse.js';

// -------------------- Paths & config --------------------
const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const INBOX = join(MEMEX_DIR, 'inbox');
const DATA = join(MEMEX_DIR, 'data');
const STATE_PATH = join(DATA, 'ingest-state.json');
const LOG_PATH = join(DATA, 'ingest.log');

const RESCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEBOUNCE_MS = 1500;

const SOURCES = [
  {
    name: 'claude-code',
    prefix: 'code',
    dir: join(HOME, '.claude', 'projects'),
  },
  {
    name: 'claude-cowork',
    prefix: 'cowork',
    dir: join(HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
  },
];

[INBOX, DATA].forEach((d) => mkdirSync(d, { recursive: true }));

// -------------------- State --------------------
let state = {};
if (existsSync(STATE_PATH)) {
  try { state = JSON.parse(readFileSync(STATE_PATH, 'utf-8')); }
  catch (_) { state = {}; }
}

function saveState() {
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

// -------------------- Logging --------------------
import { appendFileSync } from 'node:fs';
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  process.stderr.write(line);
  try { appendFileSync(LOG_PATH, line); } catch (_) {}
}

// -------------------- Fingerprint --------------------
function fingerprint(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    return createHash('sha1').update(buf.subarray(0, n)).digest('hex').slice(0, 16);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch (_) {}
  }
}

// -------------------- File filter --------------------
function shouldIngest(filePath) {
  if (!filePath.endsWith('.jsonl')) return false;
  const name = basename(filePath);
  if (name === 'audit.jsonl') return false; // tool-call audit log, not dialogue
  // Skip subagent transcripts — they're tool spawns, not standalone chats
  if (filePath.split(sep).includes('subagents')) return false;
  return true;
}

// -------------------- Codepoint-aware slice --------------------
// Match Python's text[:n] codepoint indexing so msg_id hashes line up
// with claude-backup's feed-memex output.
function slicePy(text, n) {
  return [...text].slice(0, n).join('');
}

// -------------------- Parse + emit --------------------
function parseFileForDialogue(filePath) {
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  let aiTitle = null;
  const dialogue = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    const t = extractAiTitle(obj);
    if (t) { aiTitle = t; continue; }
    const msg = extractMessageFromRecord(obj);
    if (!msg) continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    dialogue.push(msg);
  }
  return { aiTitle, dialogue };
}

function emitToInbox(srcPath, source) {
  let stat;
  try { stat = statSync(srcPath); }
  catch (_) { return { changed: false }; }
  if (!stat.isFile() || stat.size === 0) return { changed: false };

  let fp;
  try { fp = fingerprint(srcPath); }
  catch (e) { return { error: 'fingerprint: ' + e.message }; }

  // Cache hit: same content as last time → skip.
  const prev = state[srcPath];
  if (
    prev &&
    prev.fingerprint === fp &&
    prev.size === stat.size &&
    prev.mtime === stat.mtimeMs
  ) {
    return { changed: false };
  }

  const stem = basename(srcPath, '.jsonl');
  const shortId = stem.slice(0, 8);
  const targetPath = join(INBOX, `${source.prefix}-${shortId}.jsonl`);
  const tmpPath = targetPath + '.tmp';

  let parsed;
  try { parsed = parseFileForDialogue(srcPath); }
  catch (e) { return { error: 'parse: ' + e.message }; }

  const records = [];
  if (parsed.aiTitle) {
    records.push({ type: 'ai-title', aiTitle: parsed.aiTitle });
  }
  for (const m of parsed.dialogue) {
    const seed = `${m.role}|${m.timestamp}|${slicePy(m.text, 200)}`;
    const msgId = createHash('sha1').update(seed).digest('hex').slice(0, 16);
    records.push({
      role: m.role,
      content: m.text,
      timestamp: m.timestamp,
      id: `${source.prefix}-${shortId}-${msgId}`,
    });
  }

  // Update state regardless — so we don't keep retrying empty files.
  state[srcPath] = {
    fingerprint: fp,
    size: stat.size,
    mtime: stat.mtimeMs,
    dialogueCount: parsed.dialogue.length,
  };

  if (records.length === 0) {
    saveState();
    return { changed: false };
  }

  try {
    writeFileSync(tmpPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch (_) {}
    return { error: 'write: ' + e.message };
  }

  saveState();
  return { changed: true, msgCount: parsed.dialogue.length, hadTitle: !!parsed.aiTitle };
}

// -------------------- Debounce --------------------
const pending = new Map();
function schedule(srcPath, source) {
  if (!shouldIngest(srcPath)) return;
  if (pending.has(srcPath)) clearTimeout(pending.get(srcPath));
  pending.set(srcPath, setTimeout(() => {
    pending.delete(srcPath);
    const r = emitToInbox(srcPath, source);
    if (r.error) {
      log(`! ${basename(srcPath)} (${source.name}): ${r.error}`);
    } else if (r.changed) {
      const stem = basename(srcPath, '.jsonl').slice(0, 8);
      log(`+ ${source.prefix}-${stem}.jsonl ← ${r.msgCount} msgs from ${source.name}` +
          (r.hadTitle ? ' (with ai-title)' : ''));
    }
  }, DEBOUNCE_MS));
}

// -------------------- Watchers --------------------
const watchers = [];
for (const source of SOURCES) {
  if (!existsSync(source.dir)) {
    log(`- skipping ${source.name}: directory not found at ${source.dir}`);
    continue;
  }
  log(`watching ${source.name}: ${source.dir}`);
  const w = chokidar
    .watch(source.dir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
      depth: 12,
    })
    .on('add', (p) => schedule(p, source))
    .on('change', (p) => schedule(p, source))
    .on('error', (e) => log(`watcher error (${source.name}): ${e.message}`));
  watchers.push(w);
}

// -------------------- Backstop rescan --------------------
function walkDir(dir, visit) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDir(p, visit);
    else if (e.isFile()) visit(p);
  }
}

function safetyRescan() {
  log('safety rescan starting');
  let triggered = 0;
  for (const source of SOURCES) {
    if (!existsSync(source.dir)) continue;
    walkDir(source.dir, (p) => {
      if (!shouldIngest(p)) return;
      let stat;
      try { stat = statSync(p); } catch (_) { return; }
      const prev = state[p];
      if (!prev || prev.size !== stat.size || prev.mtime !== stat.mtimeMs) {
        schedule(p, source);
        triggered++;
      }
    });
  }
  log(`safety rescan done · ${triggered} file(s) re-scheduled`);
}
setInterval(safetyRescan, RESCAN_INTERVAL_MS);

// -------------------- Lifecycle --------------------
log(`memex-ingest started`);
log(`  inbox:        ${INBOX}`);
log(`  state:        ${STATE_PATH}`);
log(`  log:          ${LOG_PATH}`);
log(`  debounce:     ${DEBOUNCE_MS}ms`);
log(`  rescan every: ${RESCAN_INTERVAL_MS / 60000} min`);

function shutdown(sig) {
  log(`received ${sig}, shutting down`);
  for (const w of watchers) try { w.close(); } catch (_) {}
  // flush any pending state write
  try { saveState(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
