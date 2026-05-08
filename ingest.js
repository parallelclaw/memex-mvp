#!/usr/bin/env node
/**
 * memex-sync — long-running daemon that auto-captures Claude Code and
 * Cowork sessions into memex's inbox in near-realtime.
 *
 * CLI usage:
 *   memex-sync             # run in foreground (debug / launchctl ProgramArguments)
 *   memex-sync install     # register macOS LaunchAgent (autostart on login)
 *   memex-sync uninstall   # unload + remove LaunchAgent (data is preserved)
 *   memex-sync status      # show daemon state, watched files, last activity
 *   memex-sync logs        # tail -f the daemon log
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
import { homedir, platform } from 'node:os';
import { join, basename, sep, resolve } from 'node:path';
import {
  existsSync, statSync, readFileSync, writeFileSync, renameSync,
  mkdirSync, openSync, readSync, closeSync, unlinkSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractMessageFromRecord, extractAiTitle } from './lib/parse.js';

// -------------------- Paths & config --------------------
const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const INBOX = join(MEMEX_DIR, 'inbox');
const DATA = join(MEMEX_DIR, 'data');
const STATE_PATH = join(DATA, 'ingest-state.json');
const LOG_PATH = join(DATA, 'ingest.log');

// LaunchAgent metadata (macOS). Linux/systemd-user support to follow.
const LAUNCH_LABEL = 'com.parallelclaw.memex.sync';
const LEGACY_LABEL = 'com.parallelclaw.memex.ingest'; // pre-rename, migrated transparently
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);
const LEGACY_PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);

// -------------------- Subcommand dispatch --------------------
const subcommand = process.argv[2];
if (subcommand && subcommand !== '--help' && subcommand.startsWith('-') === false) {
  // Run as CLI tool, not as daemon
  const handlers = {
    install: cmdInstall,
    uninstall: cmdUninstall,
    status: cmdStatus,
    logs: cmdLogs,
    serve: cmdServe, // explicit foreground; same as no-arg
  };
  const handler = handlers[subcommand];
  if (!handler) {
    console.error(`unknown command: ${subcommand}`);
    console.error(`usage: memex-sync [install|uninstall|status|logs|serve]`);
    process.exit(2);
  }
  handler();
  // CLI handlers either exit themselves or fall through to daemon mode (cmdServe)
} else if (subcommand === '--help' || subcommand === '-h') {
  console.log(`memex-sync — auto-capture daemon for memex memory

usage:
  memex-sync                    run in foreground (default; same as 'serve')
  memex-sync install            register macOS LaunchAgent (autostart on login)
  memex-sync uninstall          unload and remove LaunchAgent (data preserved)
  memex-sync status             show daemon health, watched files, last activity
  memex-sync logs               tail the daemon log

paths:
  state:   ${STATE_PATH}
  log:     ${LOG_PATH}
  plist:   ${PLIST_PATH}`);
  process.exit(0);
}

// -------------------- CLI command handlers --------------------

function cmdInstall() {
  if (platform() !== 'darwin') {
    console.error('install: macOS-only for now (LaunchAgent). Linux systemd-user support pending.');
    console.error('on Linux you can run: nohup memex-sync &');
    process.exit(1);
  }

  // Migrate legacy plist (pre-rename) if present.
  if (existsSync(LEGACY_PLIST_PATH)) {
    console.log('migrating legacy LaunchAgent (com.parallelclaw.memex.ingest → .sync)...');
    try { execSync(`launchctl unload ${JSON.stringify(LEGACY_PLIST_PATH)}`, { stdio: 'ignore' }); }
    catch (_) {}
    try { unlinkSync(LEGACY_PLIST_PATH); } catch (_) {}
  }

  const nodePath = process.execPath;
  const scriptPath = resolve(fileURLToPath(import.meta.url));

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
  <key>StandardOutPath</key><string>${join(DATA, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(DATA, 'launchd.err.log')}</string>
  <key>WorkingDirectory</key><string>${resolve(scriptPath, '..')}</string>
</dict>
</plist>
`;

  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
  // Stop existing instance first (idempotent)
  try { execSync(`launchctl unload ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' }); }
  catch (_) {}
  writeFileSync(PLIST_PATH, plist);
  try {
    execSync(`launchctl load ${JSON.stringify(PLIST_PATH)}`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`launchctl load failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`✓ memex-sync installed and running`);
  console.log(`  plist: ${PLIST_PATH}`);
  console.log(`  log:   ${LOG_PATH}`);
  console.log(`\nIt will autostart on login. To check status: memex-sync status`);
  console.log(`To stop and remove: memex-sync uninstall`);
  process.exit(0);
}

function cmdUninstall() {
  if (platform() !== 'darwin') {
    console.error('uninstall: macOS-only for now.');
    process.exit(1);
  }
  let removed = 0;
  for (const p of [PLIST_PATH, LEGACY_PLIST_PATH]) {
    if (existsSync(p)) {
      try { execSync(`launchctl unload ${JSON.stringify(p)}`, { stdio: 'ignore' }); } catch (_) {}
      try { unlinkSync(p); removed++; } catch (_) {}
    }
  }
  if (removed > 0) {
    console.log(`✓ memex-sync uninstalled (${removed} LaunchAgent file${removed > 1 ? 's' : ''} removed)`);
    console.log(`\nMemory database at ~/.memex/data/memex.db is preserved.`);
    console.log(`To fully purge: rm -rf ~/.memex`);
  } else {
    console.log(`memex-sync was not installed (nothing to remove).`);
  }
  process.exit(0);
}

function cmdStatus() {
  // Discover state + plist + running PID
  const installed = existsSync(PLIST_PATH);
  const legacyInstalled = existsSync(LEGACY_PLIST_PATH);
  let runningPid = null;
  let label = installed ? LAUNCH_LABEL : (legacyInstalled ? LEGACY_LABEL : null);
  if (label) {
    try {
      const out = execSync(`launchctl list | grep ${label}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const m = out.match(/^(\d+|-)\s+(\d+|-)\s+\S+/m);
      if (m && m[1] !== '-') runningPid = parseInt(m[1], 10);
    } catch (_) {}
  }

  let state = {};
  let stateFresh = null;
  if (existsSync(STATE_PATH)) {
    try { state = JSON.parse(readFileSync(STATE_PATH, 'utf-8')); }
    catch (_) {}
    try {
      const ageMs = Date.now() - statSync(STATE_PATH).mtimeMs;
      stateFresh = ageMs;
    } catch (_) {}
  }
  const watchedCount = Object.keys(state).length;
  let codeCount = 0, coworkCount = 0;
  for (const p of Object.keys(state)) {
    // Cowork paths embed `.claude/projects/` too (inside Application Support);
    // check the cowork-specific marker first.
    if (p.includes('local-agent-mode-sessions')) coworkCount++;
    else if (p.includes('/.claude/projects/')) codeCount++;
  }

  // Output
  console.log('memex-sync status\n');
  if (installed) {
    console.log(`  daemon:    installed (${PLIST_PATH})`);
  } else if (legacyInstalled) {
    console.log(`  daemon:    installed under legacy label (run 'memex-sync install' to migrate)`);
  } else {
    console.log(`  daemon:    NOT installed`);
    console.log(`             enable autostart with: memex-sync install`);
  }
  if (runningPid) {
    console.log(`  process:   running (PID ${runningPid})`);
  } else {
    console.log(`  process:   not running`);
  }
  if (watchedCount > 0) {
    console.log(`  watching:  ${codeCount} Claude Code · ${coworkCount} Cowork session(s) (${watchedCount} files total)`);
  } else {
    console.log(`  watching:  no sessions seen yet`);
  }
  if (stateFresh !== null) {
    const min = Math.floor(stateFresh / 60000);
    const human = min < 1 ? 'just now' : (min < 60 ? `${min} min ago` : `${Math.floor(min / 60)}h ${min % 60}m ago`);
    console.log(`  last activity: ${human}`);
  }
  console.log('');
  console.log(`  log:       ${LOG_PATH}`);
  console.log(`  state:     ${STATE_PATH}`);

  process.exit(0);
}

function cmdLogs() {
  if (!existsSync(LOG_PATH)) {
    console.error(`no log file at ${LOG_PATH} — daemon never started?`);
    process.exit(1);
  }
  // tail -f via spawn
  const tail = spawn('tail', ['-n', '50', '-f', LOG_PATH], { stdio: 'inherit' });
  process.on('SIGINT', () => { tail.kill('SIGINT'); process.exit(0); });
  tail.on('exit', (code) => process.exit(code || 0));
}

function cmdServe() {
  // Fall through to the daemon body below
}

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
  return true;
}

/**
 * Decide what inbox filename to use for a given source file.
 *
 * Cowork main session:
 *   .../local_<MAIN>/.claude/projects/<encoded>/<INNER>.jsonl
 *   → inbox/cowork-<INNER first 8>.jsonl
 *
 * Cowork subagent (parented to a main session):
 *   .../local_<MAIN>/.claude/projects/<encoded>/<INNER>/subagents/agent-<AGENT>.jsonl
 *   → inbox/cowork-<INNER first 8>-sub-<AGENT first 8>.jsonl
 *
 * Plain Claude Code session:
 *   ~/.claude/projects/<encoded>/<UUID>.jsonl
 *   → inbox/code-<UUID first 8>.jsonl
 */
function inboxNameFor(srcPath, source) {
  const parts = srcPath.split(sep);
  const subIdx = parts.indexOf('subagents');
  if (subIdx > 0) {
    // Subagent transcript. Parent inner UUID is the dir containing subagents/.
    const innerUUID = parts[subIdx - 1];
    const innerShort = innerUUID.slice(0, 8);
    const agentName = basename(srcPath, '.jsonl'); // 'agent-<...>'
    const m = agentName.match(/^agent-(.+)$/);
    if (!m) return null;
    // Strip non-alphanumerics (handles names like 'agent-acompact-d7a9...').
    const agentShort = m[1].replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    return `${source.prefix}-${innerShort}-sub-${agentShort}.jsonl`;
  }
  // Main session — use file stem.
  const stem = basename(srcPath, '.jsonl');
  const shortId = stem.slice(0, 8);
  return `${source.prefix}-${shortId}.jsonl`;
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

  const inboxName = inboxNameFor(srcPath, source);
  if (!inboxName) return { error: 'cannot-name' };
  const targetPath = join(INBOX, inboxName);
  const tmpPath = targetPath + '.tmp';
  // Reuse first 8 chars of the inbox stem for record-id seeding.
  const shortId = inboxName.replace(new RegExp(`^${source.prefix}-`), '').replace(/\.jsonl$/, '');

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
      const inboxName = inboxNameFor(srcPath, source) || basename(srcPath);
      const isSubagent = inboxName.includes('-sub-');
      log(`+ ${inboxName} ← ${r.msgCount} msgs from ${source.name}` +
          (isSubagent ? ' [subagent]' : '') +
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
