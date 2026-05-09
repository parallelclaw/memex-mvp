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
import { join, basename, sep, resolve, relative } from 'node:path';
import {
  existsSync, statSync, readFileSync, writeFileSync, renameSync,
  mkdirSync, openSync, readSync, closeSync, unlinkSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractMessageFromRecord, extractAiTitle } from './lib/parse.js';
import {
  defaultCursorDbPath,
  openCursorDB,
  iterComposers,
  extractDialogue,
  composerToInboxRecords,
} from './lib/parse-cursor.js';
import { renderConversationMarkdown, suggestFilename } from './lib/render-markdown.js';
import {
  autodetectObsidianVaults,
  walkVault,
  parseNote,
  noteShortId,
  vaultSlug,
  shouldSkipPath,
} from './lib/parse-obsidian.js';
import {
  CONFIG_PATH,
  KNOWN_SOURCES,
  loadConfig,
  saveConfig,
  isSourceEnabled,
  setSourceEnabled,
  obsidianVaultsFromConfig,
  addObsidianVault,
  removeObsidianVault,
  normalizeSourceName,
} from './lib/config.js';

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
    restart: cmdRestart,
    sources: cmdSources,
    vault: cmdVault,
    serve: cmdServe, // explicit foreground; same as no-arg
    // All scan / export modes fall through to module-level logic at EOF.
    // cmdServe is a no-op marker so the dispatch doesn't error.
    scan: cmdServe,
    'scan-claude': cmdServe,
    'scan-cursor': cmdServe,
    'scan-obsidian': cmdServe,
    'export-markdown': cmdServe,
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

daemon mode:
  memex-sync                    run in foreground (default; same as 'serve')
  memex-sync install            register macOS LaunchAgent (autostart on login)
  memex-sync uninstall          unload and remove LaunchAgent (data preserved)
  memex-sync restart            restart the LaunchAgent (after config changes)
  memex-sync status             show daemon health, watched files, last activity
  memex-sync logs               tail the daemon log

source control:
  memex-sync sources            list which sources are enabled / disabled
  memex-sync sources <name> enable
  memex-sync sources <name> disable
                                turn on/off a source (claude_code, claude_cowork,
                                cursor, obsidian). 'code' / 'cowork' aliases work.
  memex-sync vault              list configured Obsidian vaults
  memex-sync vault add <path>   add an Obsidian vault to the watched list
  memex-sync vault remove <p>   remove a vault

one-shot scans (no daemon needed — handy for cron / manual import):
  memex-sync scan               import everything once
  memex-sync scan-claude        Claude Code + Cowork only
  memex-sync scan-cursor        Cursor IDE history only
  memex-sync scan-obsidian      Obsidian vaults only

export to Obsidian / file system:
  memex-sync export-markdown --output <dir> [--source <s>] [--since <date>]
                                bulk-render conversations as Markdown files

paths:
  state:   ${STATE_PATH}
  log:     ${LOG_PATH}
  config:  ${CONFIG_PATH}
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
  console.log('');

  // Show what daemon will actually capture, based on current config.
  const cfg = loadConfig();
  console.log('memex-sync will capture from these sources:');
  for (const name of KNOWN_SOURCES) {
    const enabled = isSourceEnabled(name, cfg);
    const mark = enabled ? '✓' : '✗';
    let detail = '';
    if (name === 'claude_code') {
      const dir = join(HOME, '.claude', 'projects');
      detail = existsSync(dir) ? `(${dir})` : '(not found — won\'t capture)';
    } else if (name === 'claude_cowork') {
      const dir = join(HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
      detail = existsSync(dir) ? '(Cowork sessions found)' : '(not found — won\'t capture)';
    } else if (name === 'cursor') {
      const dbPath = defaultCursorDbPath();
      detail = dbPath && existsSync(dbPath) ? '(Cursor detected)' : '(not found — won\'t capture)';
    } else if (name === 'obsidian') {
      const vaults = obsidianVaultsFromConfig(cfg);
      const auto = vaults.length === 0 ? autodetectObsidianVaults() : vaults;
      detail = auto.length > 0 ? `(${auto.length} vault${auto.length > 1 ? 's' : ''}: ${auto.map((v) => v.replace(HOME, '~')).join(', ')})` : '(no vaults detected)';
    }
    console.log(`  ${mark} ${name.padEnd(15)} ${detail}`);
  }
  console.log('');
  console.log(`To opt out of any source:`);
  console.log(`  npx memex-sync sources <name> disable`);
  console.log(`  npx memex-sync vault remove <path>     (for Obsidian)`);
  console.log(`Then: npx memex-sync restart`);
  console.log('');
  console.log(`config: ${CONFIG_PATH} (auto-created on first edit)`);
  console.log(`status: npx memex-sync status`);
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
  let codeCount = 0, coworkCount = 0, cursorCount = 0, obsidianCount = 0, subagentCount = 0;
  for (const [p, v] of Object.entries(state)) {
    if (p.startsWith('cursor::')) { cursorCount++; continue; }
    if (v && v.isObsidian) { obsidianCount++; continue; }
    if (p.endsWith('.md')) { obsidianCount++; continue; }
    // Subagent transcripts under .../subagents/ are tool-spawned helpers,
    // not standalone main sessions — count separately for honest reporting.
    if (p.includes('/subagents/')) { subagentCount++; continue; }
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
    const parts = [];
    if (codeCount > 0) parts.push(`${codeCount} Claude Code`);
    if (coworkCount > 0) parts.push(`${coworkCount} Cowork`);
    if (cursorCount > 0) parts.push(`${cursorCount} Cursor`);
    if (obsidianCount > 0) parts.push(`${obsidianCount} Obsidian`);
    const subagentSuffix = subagentCount > 0
      ? ` (+ ${subagentCount} subagent transcript${subagentCount === 1 ? '' : 's'})`
      : '';
    console.log(`  watching:  ${parts.join(' · ')} main session(s)${subagentSuffix} · ${watchedCount} entries total`);
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

function cmdRestart() {
  if (platform() !== 'darwin') {
    console.error('restart: macOS-only for now.');
    process.exit(1);
  }
  if (!existsSync(PLIST_PATH)) {
    console.error('memex-sync is not installed (no LaunchAgent plist found).');
    console.error('Run: npx memex-sync install');
    process.exit(1);
  }
  try { execSync(`launchctl unload ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' }); } catch (_) {}
  try {
    execSync(`launchctl load ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' });
  } catch (e) {
    console.error('launchctl load failed:', e.message);
    process.exit(1);
  }
  console.log(`✓ memex-sync restarted`);
  process.exit(0);
}

function cmdSources() {
  const action = process.argv[3];
  const target = process.argv[4];
  const cfg = loadConfig();

  if (!action || action === 'list' || action === '--list') {
    // Pretty status table
    console.log(`memex-sync sources (config: ${CONFIG_PATH})\n`);
    for (const name of KNOWN_SOURCES) {
      const enabled = isSourceEnabled(name, cfg);
      const mark = enabled ? '✓' : '✗';
      const label = name.padEnd(15);
      let extra = '';
      if (name === 'obsidian') {
        const vaults = obsidianVaultsFromConfig(cfg);
        if (vaults.length > 0) extra = `· vaults: ${vaults.join(', ')}`;
        else if (enabled) extra = '· vaults: (autodetect)';
      }
      console.log(`  ${mark} ${label} ${enabled ? 'enabled' : 'disabled'}  ${extra}`);
    }
    console.log(`\n  · telegram      manual-import only (drop result.json into ~/.memex/inbox/)`);
    console.log('\nuse: memex-sync sources <name> <enable|disable>');
    process.exit(0);
  }

  // memex-sync sources <name> <enable|disable>
  const sourceName = normalizeSourceName(action);
  const verb = target;
  if (!sourceName) {
    console.error(`unknown source: "${action}". Known: ${KNOWN_SOURCES.join(', ')} (or aliases code/cowork).`);
    process.exit(2);
  }
  if (verb !== 'enable' && verb !== 'disable') {
    console.error(`expected 'enable' or 'disable' as third arg.`);
    console.error(`usage: memex-sync sources ${sourceName} <enable|disable>`);
    process.exit(2);
  }
  setSourceEnabled(sourceName, verb === 'enable', cfg);
  saveConfig(cfg);
  console.log(`✓ ${sourceName} ${verb}d (saved to ${CONFIG_PATH})`);
  // Hint for restart if daemon installed
  if (existsSync(PLIST_PATH)) {
    console.log(`\nrestart the daemon to apply: npx memex-sync restart`);
  }
  process.exit(0);
}

function cmdVault() {
  const action = process.argv[3];
  const target = process.argv[4];
  const cfg = loadConfig();

  if (!action || action === 'list' || action === '--list') {
    const vaults = obsidianVaultsFromConfig(cfg);
    if (vaults.length === 0) {
      console.log('no Obsidian vaults configured.');
      console.log('Without explicit configuration, autodetect runs against standard');
      console.log('locations (~/Documents, ~/Obsidian, ~/Library/Mobile Documents/');
      console.log('iCloud~md~obsidian/Documents) when the daemon starts.');
      console.log('\nadd one with: memex-sync vault add <path>');
    } else {
      console.log('configured Obsidian vaults:');
      for (const v of vaults) console.log(`  · ${v}`);
    }
    process.exit(0);
  }

  if (action === 'add') {
    if (!target) {
      console.error('expected a path: memex-sync vault add /path/to/vault');
      process.exit(2);
    }
    const abs = addObsidianVault(target, cfg);
    if (!existsSync(abs)) {
      console.error(`warning: ${abs} doesn't exist yet — config saved anyway.`);
    } else if (!existsSync(join(abs, '.obsidian'))) {
      console.error(`warning: ${abs} doesn't look like an Obsidian vault (no .obsidian/ subfolder).`);
    }
    saveConfig(cfg);
    console.log(`✓ added ${abs}`);
    if (existsSync(PLIST_PATH)) {
      console.log(`\nrestart the daemon to apply: npx memex-sync restart`);
    }
    process.exit(0);
  }

  if (action === 'remove' || action === 'rm') {
    if (!target) {
      console.error('expected a path: memex-sync vault remove /path/to/vault');
      process.exit(2);
    }
    const removed = removeObsidianVault(target, cfg);
    if (!removed) {
      console.log(`no vault matching "${target}" was configured.`);
      process.exit(1);
    }
    saveConfig(cfg);
    console.log(`✓ removed ${target}`);
    if (existsSync(PLIST_PATH)) {
      console.log(`\nrestart the daemon to apply: npx memex-sync restart`);
    }
    process.exit(0);
  }

  console.error(`unknown action: "${action}". Use list / add / remove.`);
  process.exit(2);
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

// -------------------- Config --------------------
// Loaded once at module init; CLI subcommands that mutate config exit immediately
// before the daemon body runs, so the daemon always uses the latest on-disk state.
const CONFIG = loadConfig();

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
// In any one-shot scan mode the watchers and timers are skipped; the scan
// runs at the end of the file and exits. See the conditional block at EOF.
const SCAN_CURSOR_MODE   = subcommand === 'scan-cursor';
const SCAN_CLAUDE_MODE   = subcommand === 'scan-claude';
const SCAN_OBSIDIAN_MODE = subcommand === 'scan-obsidian';
const SCAN_ALL_MODE      = subcommand === 'scan';
const EXPORT_MD_MODE     = subcommand === 'export-markdown';
const ANY_SCAN_MODE = SCAN_CURSOR_MODE || SCAN_CLAUDE_MODE || SCAN_OBSIDIAN_MODE || SCAN_ALL_MODE;
const ANY_ONESHOT_MODE = ANY_SCAN_MODE || EXPORT_MD_MODE;

const watchers = [];
// Per-source enablement check. SOURCES is the FSEvents-watched JSONL set
// (Claude Code + Cowork); each maps to a config key.
const SOURCE_TO_CONFIG_KEY = {
  'claude-code': 'claude_code',
  'claude-cowork': 'claude_cowork',
};
function isJsonlSourceEnabled(source) {
  const key = SOURCE_TO_CONFIG_KEY[source.name] || source.name;
  return isSourceEnabled(key, CONFIG);
}
if (!ANY_ONESHOT_MODE) for (const source of SOURCES) {
  if (!isJsonlSourceEnabled(source)) { log(`- ${source.name} disabled by config — skipping`); continue; }
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
if (!ANY_ONESHOT_MODE) setInterval(safetyRescan, RESCAN_INTERVAL_MS);

// -------------------- Cursor scanner --------------------
// Cursor stores history in SQLite (state.vscdb), not flat files. We can't
// usefully chokidar-watch it because the WAL journal flips on every keystroke
// and the main file mtime is unreliable. So instead: poll the DB every few
// minutes, compare each composer's lastUpdatedAt against state, and re-emit
// inbox JSONL only for composers that actually changed.
//
// Initial scan runs ~2s after startup (lets the inbox watchers settle first).

const CURSOR_DB_PATH = defaultCursorDbPath();
const CURSOR_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function cursorStateKey(composerId) {
  return `cursor::${composerId}`;
}

function emitCursorComposer(db, composer) {
  const dialogue = extractDialogue(db, composer);
  const stateKey = cursorStateKey(composer.composerId);

  if (dialogue.length === 0) {
    // Empty / thinking-only / tool-only session — record state so we don't
    // re-process every tick, but don't write to inbox.
    state[stateKey] = {
      lastUpdatedAt: composer.lastUpdatedAt,
      bubbleCount: 0,
      composerName: composer.name,
    };
    saveState();
    return { changed: false };
  }

  const shortId = composer.composerId.slice(0, 8);
  const targetPath = join(INBOX, `cursor-${shortId}.jsonl`);
  const tmpPath = targetPath + '.tmp';

  const records = composerToInboxRecords(
    composer,
    dialogue,
    'cursor',
    shortId,
    (seed) => createHash('sha1').update(seed).digest('hex').slice(0, 16)
  );

  try {
    writeFileSync(tmpPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch (_) {}
    return { error: 'write: ' + e.message };
  }

  state[stateKey] = {
    lastUpdatedAt: composer.lastUpdatedAt,
    bubbleCount: dialogue.length,
    composerName: composer.name,
  };
  saveState();

  return { changed: true, msgCount: dialogue.length, name: composer.name };
}

function scanCursor() {
  if (!CURSOR_DB_PATH) return; // unsupported platform
  if (!existsSync(CURSOR_DB_PATH)) return; // Cursor not installed

  let db;
  try {
    db = openCursorDB(CURSOR_DB_PATH);
  } catch (e) {
    log(`! cursor db open failed: ${e.message}`);
    return;
  }
  if (!db) return;

  let scanned = 0;
  let emitted = 0;
  try {
    for (const composer of iterComposers(db)) {
      scanned++;
      const prev = state[cursorStateKey(composer.composerId)];
      if (prev && prev.lastUpdatedAt === composer.lastUpdatedAt) continue;

      const r = emitCursorComposer(db, composer);
      if (r.error) {
        log(`! cursor ${composer.composerId.slice(0, 8)}: ${r.error}`);
      } else if (r.changed) {
        emitted++;
        const tag = r.name ? ` "${r.name.slice(0, 50)}"` : '';
        log(`+ cursor-${composer.composerId.slice(0, 8)}.jsonl ← ${r.msgCount} msgs${tag}`);
      }
    }
  } finally {
    db.close();
  }

  if (emitted > 0) {
    log(`cursor scan · ${scanned} composers, ${emitted} updated`);
  }
}

// Initial scan ~2s after start, then poll every 5 minutes.
const CURSOR_ENABLED = isSourceEnabled('cursor', CONFIG);
if (!ANY_ONESHOT_MODE && CURSOR_ENABLED) {
  setTimeout(scanCursor, 2000);
  setInterval(scanCursor, CURSOR_POLL_INTERVAL_MS);
}

// -------------------- Obsidian watcher --------------------
// Vault paths: explicit env var first (comma-separated), then auto-detect
// of standard macOS locations. User opt-in via path discovery — we don't
// recurse into ~/Documents wholesale, only confirmed vaults (folders
// with a .obsidian/ subdir, found at depths 0-3).
const OBSIDIAN_ENABLED = isSourceEnabled('obsidian', CONFIG);
const OBSIDIAN_VAULTS = (() => {
  if (!OBSIDIAN_ENABLED) return [];
  // Priority: config.sources.obsidian.vaults + MEMEX_OBSIDIAN_VAULTS env.
  // If both are empty, fall back to autodetect (preserves zero-config UX).
  const explicit = obsidianVaultsFromConfig(CONFIG);
  if (explicit.length > 0) return explicit.filter((v) => existsSync(v));
  return autodetectObsidianVaults();
})();

function emitObsidianNote(notePath, vaultRoot) {
  // Defensive — chokidar's ignored may not catch every case
  const rel = relative(vaultRoot, notePath);
  if (shouldSkipPath(rel)) return { changed: false };

  const note = parseNote(notePath, vaultRoot);
  if (!note) return { changed: false };

  // Hash-based dedupe — body content, not file mtime, decides
  const prev = state[notePath];
  if (prev && prev.hash === note.hash) return { changed: false };

  const slug = vaultSlug(vaultRoot);
  const short = noteShortId(vaultRoot, note.relativePath);
  const inboxName = `obsidian-${slug}-${short}.jsonl`;
  const targetPath = join(INBOX, inboxName);
  const tmpPath = targetPath + '.tmp';

  const updatedIso = new Date(note.updated).toISOString();
  const seedText = slicePy(note.body, 200);
  const msgId = createHash('sha1').update(`user|${updatedIso}|${seedText}`).digest('hex').slice(0, 16);

  const records = [
    { type: 'ai-title', aiTitle: note.title },
    {
      role: 'user',
      content: note.body,
      timestamp: updatedIso,
      id: `obsidian-${slug}-${short}-${msgId}`,
    },
  ];

  try {
    writeFileSync(tmpPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch (_) {}
    return { error: 'write: ' + e.message };
  }

  state[notePath] = {
    hash: note.hash,
    updated: note.updated,
    title: note.title,
    vault: vaultRoot,
    isObsidian: true,
  };
  saveState();

  return { changed: true, title: note.title, bodyChars: note.body.length };
}

const obsidianPending = new Map();
function scheduleObsidian(notePath, vaultRoot) {
  if (obsidianPending.has(notePath)) clearTimeout(obsidianPending.get(notePath));
  obsidianPending.set(notePath, setTimeout(() => {
    obsidianPending.delete(notePath);
    const r = emitObsidianNote(notePath, vaultRoot);
    if (r.error) {
      log(`! obsidian ${basename(notePath)}: ${r.error}`);
    } else if (r.changed) {
      log(`+ obsidian "${r.title}" (${r.bodyChars} chars)`);
    }
  }, DEBOUNCE_MS));
}

if (!ANY_ONESHOT_MODE && OBSIDIAN_ENABLED) {
  for (const vault of OBSIDIAN_VAULTS) {
    log(`watching obsidian: ${vault}`);
    const w = chokidar
      .watch(vault, {
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
        ignored: [
          '**/.obsidian/**',
          '**/.trash/**',
          '**/.git/**',
          '**/.DS_Store',
          '**/*.sync-conflict-*',
        ],
        depth: 12,
      })
      .on('add', (p) => p.endsWith('.md') && scheduleObsidian(p, vault))
      .on('change', (p) => p.endsWith('.md') && scheduleObsidian(p, vault))
      .on('error', (e) => log(`watcher error (obsidian): ${e.message}`));
    watchers.push(w);
  }
}

// Synchronous one-shot walk for scan-obsidian / scan modes.
function scanObsidian() {
  if (OBSIDIAN_VAULTS.length === 0) {
    console.log('no Obsidian vaults configured/detected — skipping');
    return;
  }
  let scanned = 0;
  let emitted = 0;
  for (const vault of OBSIDIAN_VAULTS) {
    if (!existsSync(vault)) continue;
    console.log(`scanning obsidian: ${vault}`);
    for (const f of walkVault(vault)) {
      scanned++;
      const r = emitObsidianNote(f.absolute, vault);
      if (r.error) {
        console.error(`  ! ${f.relative}: ${r.error}`);
      } else if (r.changed) {
        emitted++;
        console.log(`  + "${r.title}" (${r.bodyChars} chars)`);
      }
    }
  }
  console.log(`scanned ${scanned} notes · ${emitted} updated`);
}

// -------------------- One-shot scan modes --------------------
// Synchronous walk-and-emit for Claude Code / Cowork directories. Bypasses
// the debounce queue (we want eager processing in one-shot mode).
function scanClaudeSync() {
  let scanned = 0;
  let emitted = 0;
  for (const source of SOURCES) {
    if (!existsSync(source.dir)) {
      console.log(`- skipping ${source.name}: directory not found at ${source.dir}`);
      continue;
    }
    console.log(`scanning ${source.name}: ${source.dir}`);
    walkDir(source.dir, (p) => {
      if (!shouldIngest(p)) return;
      scanned++;
      const r = emitToInbox(p, source);
      if (r.error) {
        console.error(`! ${basename(p)} (${source.name}): ${r.error}`);
      } else if (r.changed) {
        emitted++;
        const inboxName = inboxNameFor(p, source) || basename(p);
        const isSubagent = inboxName.includes('-sub-');
        console.log(`+ ${inboxName} ← ${r.msgCount} msgs from ${source.name}` +
                    (isSubagent ? ' [subagent]' : '') +
                    (r.hadTitle ? ' (with ai-title)' : ''));
      }
    });
  }
  console.log(`scanned ${scanned} files · ${emitted} updated`);
}

if (SCAN_CLAUDE_MODE || SCAN_ALL_MODE) {
  console.log(`=== Claude Code + Cowork ===`);
  scanClaudeSync();
}

if (SCAN_OBSIDIAN_MODE || SCAN_ALL_MODE) {
  console.log(`=== Obsidian ===`);
  scanObsidian();
}

if (SCAN_CURSOR_MODE || SCAN_ALL_MODE) {
  if (SCAN_ALL_MODE || SCAN_CURSOR_MODE) console.log(`=== Cursor ===`);
  if (!CURSOR_DB_PATH) {
    if (SCAN_CURSOR_MODE) {
      console.error('Cursor not supported on this platform.');
      process.exit(2);
    } else {
      console.log('Cursor not supported on this platform — skipping.');
    }
  } else if (!existsSync(CURSOR_DB_PATH)) {
    if (SCAN_CURSOR_MODE) {
      console.error(`Cursor not detected — no state.vscdb at:\n  ${CURSOR_DB_PATH}`);
      console.error(`Install Cursor and use it at least once before running this.`);
      process.exit(2);
    } else {
      console.log('Cursor not detected — skipping.');
    }
  } else {
    console.log(`scanning Cursor at ${CURSOR_DB_PATH} ...`);
    try {
      scanCursor();
    } catch (e) {
      console.error('cursor scan failed:', e.message);
      if (SCAN_CURSOR_MODE) process.exit(1);
    }
  }
}

if (ANY_SCAN_MODE) {
  console.log(`done. New inbox files (if any) are in: ${INBOX}`);
  console.log(`memex MCP server will pick them up next time it starts (or now, if running).`);
  process.exit(0);
}

// -------------------- One-shot export-markdown mode --------------------
// `memex-sync export-markdown --output <dir> [--source S] [--since DATE]
//                              [--include-subagents]`
async function runExportMarkdown() {
  // Parse argv
  const argv = process.argv.slice(3);
  const opts = { output: null, source: null, since: null, includeSubagents: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output' || a === '-o') opts.output = argv[++i];
    else if (a === '--source' || a === '-s') opts.source = argv[++i];
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--include-subagents') opts.includeSubagents = true;
  }
  if (!opts.output) {
    console.error('error: --output <dir> is required');
    console.error('example: memex-sync export-markdown --output ~/Obsidian/memex/');
    process.exit(2);
  }
  // Tilde expansion + ensure dir exists
  let outDir = opts.output;
  if (outDir === '~') outDir = HOME;
  else if (outDir.startsWith('~/')) outDir = join(HOME, outDir.slice(2));
  mkdirSync(outDir, { recursive: true });

  // Open memex.db readonly
  const dbPath = join(MEMEX_DIR, 'data', 'memex.db');
  if (!existsSync(dbPath)) {
    console.error(`error: memex.db not found at ${dbPath}`);
    console.error('Has memex ever ingested anything? Run a scan first.');
    process.exit(2);
  }
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  // Build conversation query
  const where = ['(archived_at IS NULL OR archived_at = 0)', 'parent_conversation_id IS NULL'];
  const params = [];
  if (opts.source) { where.push('source = ?'); params.push(opts.source); }
  if (opts.since) {
    const ts = Math.floor(new Date(opts.since).getTime() / 1000);
    if (Number.isFinite(ts) && ts > 0) {
      where.push('last_ts >= ?');
      params.push(ts);
    } else {
      console.error(`warning: --since "${opts.since}" not parseable, ignoring`);
    }
  }
  const convs = db
    .prepare(
      `SELECT conversation_id, source, title, first_ts, last_ts, message_count
         FROM conversations
        WHERE ${where.join(' AND ')}
     ORDER BY last_ts DESC`
    )
    .all(...params);

  if (convs.length === 0) {
    console.log('no conversations match the filter.');
    db.close();
    process.exit(0);
  }
  console.log(`exporting ${convs.length} conversation(s) to ${outDir}`);
  console.log('');

  let written = 0;
  for (const conv of convs) {
    // Fetch messages (with subagents if requested)
    const ids = [conv.conversation_id];
    if (opts.includeSubagents) {
      const subs = db
        .prepare(`SELECT conversation_id FROM conversations WHERE parent_conversation_id = ?`)
        .all(conv.conversation_id);
      for (const s of subs) ids.push(s.conversation_id);
    }
    const placeholders = ids.map(() => '?').join(',');
    const messages = db
      .prepare(
        `SELECT conversation_id, role, sender, text, ts
           FROM messages
          WHERE conversation_id IN (${placeholders})
       ORDER BY ts ASC`
      )
      .all(...ids);
    if (messages.length === 0) continue;
    for (const m of messages) {
      if (m.conversation_id !== conv.conversation_id) m.from_subagent = m.conversation_id;
    }

    const md = renderConversationMarkdown(conv, messages, {
      includeFrontmatter: true,
      includeSubagentTag: opts.includeSubagents,
    });
    const filename = suggestFilename(conv);
    const target = join(outDir, filename);
    const tmp = target + '.tmp';
    try {
      writeFileSync(tmp, md);
      renameSync(tmp, target);
      written++;
      console.log(`  ✓ ${filename} (${messages.length} msgs)`);
    } catch (e) {
      console.error(`  ✗ ${filename}: ${e.message}`);
    }
  }
  db.close();

  console.log('');
  console.log(`done. ${written} file(s) written to ${outDir}`);
  console.log(`tip: drop the directory into your Obsidian vault to get full Dataview support.`);
}

if (EXPORT_MD_MODE) {
  // Need writeFileSync — already imported above.
  runExportMarkdown().catch((e) => {
    console.error('export failed:', e.message);
    process.exit(1);
  });
}

// -------------------- Lifecycle --------------------
if (!ANY_ONESHOT_MODE) {
  log(`memex-ingest started`);
  log(`  inbox:        ${INBOX}`);
  log(`  state:        ${STATE_PATH}`);
  log(`  log:          ${LOG_PATH}`);
  log(`  debounce:     ${DEBOUNCE_MS}ms`);
  log(`  rescan every: ${RESCAN_INTERVAL_MS / 60000} min`);
  if (CURSOR_DB_PATH && existsSync(CURSOR_DB_PATH)) {
    log(`  cursor poll:  ${CURSOR_POLL_INTERVAL_MS / 60000} min · ${CURSOR_DB_PATH}`);
  } else {
    log(`  cursor poll:  skipped (Cursor not detected on this machine)`);
  }
  if (OBSIDIAN_VAULTS.length > 0) {
    log(`  obsidian:     ${OBSIDIAN_VAULTS.length} vault(s) — ${OBSIDIAN_VAULTS.join(', ')}`);
  } else {
    log(`  obsidian:     skipped (no vaults detected, set MEMEX_OBSIDIAN_VAULTS to override)`);
  }
}

function shutdown(sig) {
  log(`received ${sig}, shutting down`);
  for (const w of watchers) try { w.close(); } catch (_) {}
  // flush any pending state write
  try { saveState(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
