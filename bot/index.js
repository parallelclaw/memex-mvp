#!/usr/bin/env node
/**
 * memex-bot — Telegram capture bot for memex.
 *
 * The bot is a separate process. It writes Telegram-Desktop-export-format
 * JSON snippets into ~/.memex/inbox/, where memex's existing inbox watcher
 * picks them up. Zero new ingest code path.
 *
 * CLI usage:
 *   memex-bot                  # run in foreground (debug / launchctl ProgramArguments)
 *   memex-bot serve            # explicit foreground (alias)
 *   memex-bot install          # register macOS LaunchAgent (autostart on login)
 *   memex-bot uninstall        # unload + remove LaunchAgent (config preserved)
 *   memex-bot status           # show daemon state, last activity, offset
 *   memex-bot logs             # tail -f the daemon log
 *   memex-bot restart          # reload LaunchAgent after config edit
 *
 * Config:
 *   ~/.memex/bot.config.json — token, allowlist, optional Nexara key
 *
 * Offline behavior:
 *   When the laptop is off, Telegram buffers updates ~24h server-side and
 *   the bot catches up on next poll. Beyond that, export the bot chat from
 *   Telegram Desktop and drop result.json into ~/.memex/inbox/ — UNIQUE
 *   constraint dedupes safely.
 */

import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync,
  appendFileSync, statSync,
} from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBotConfig, BOT_CONFIG_PATH } from './config.js';
import { BotRunner } from './poll.js';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DATA = join(MEMEX_DIR, 'data');
const LOG_PATH = join(DATA, 'bot.log');

const LAUNCH_LABEL = 'com.parallelclaw.memex.bot';
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);

mkdirSync(DATA, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  process.stderr.write(line);
  try { appendFileSync(LOG_PATH, line); } catch (_) {}
}

const subcommand = process.argv[2];

if (subcommand === '--help' || subcommand === '-h') {
  console.log(`memex-bot — Telegram capture bot for memex memory

run modes:
  memex-bot                  run in foreground (default; same as 'serve')
  memex-bot serve            explicit foreground
  memex-bot install          register macOS LaunchAgent (autostart on login)
  memex-bot uninstall        unload and remove LaunchAgent (config preserved)
  memex-bot restart          restart the LaunchAgent (after config changes)
  memex-bot status           show daemon health, offset, last activity
  memex-bot logs             tail the daemon log

config:
  ${BOT_CONFIG_PATH}

paths:
  log:   ${LOG_PATH}
  plist: ${PLIST_PATH}`);
  process.exit(0);
}

const handlers = {
  install: cmdInstall,
  uninstall: cmdUninstall,
  status: cmdStatus,
  logs: cmdLogs,
  restart: cmdRestart,
  serve: cmdServe,
};

if (subcommand && !subcommand.startsWith('-')) {
  const handler = handlers[subcommand];
  if (!handler) {
    console.error(`unknown command: ${subcommand}`);
    console.error(`usage: memex-bot [serve|install|uninstall|restart|status|logs]`);
    process.exit(2);
  }
  handler();
} else {
  cmdServe();
}

// -------------------- CLI handlers --------------------

function cmdServe() {
  let config;
  try { config = loadBotConfig(); }
  catch (e) {
    console.error(e.message);
    process.exit(e.code === 'NO_CONFIG' ? 2 : 1);
  }
  const runner = new BotRunner({ config, log });

  let shuttingDown = false;
  function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${sig}, shutting down`);
    runner.stop();
    setTimeout(() => process.exit(0), 1500);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log('memex-bot starting');
  runner.start().catch((e) => {
    log(`fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}

function cmdInstall() {
  if (platform() !== 'darwin') {
    console.error('install: macOS-only for now (LaunchAgent). Linux: nohup memex-bot &');
    process.exit(1);
  }

  // Validate config exists before installing — otherwise the daemon would
  // crashloop the moment launchd starts it.
  try { loadBotConfig(); }
  catch (e) {
    console.error(`Cannot install — config not ready:\n\n${e.message}`);
    process.exit(2);
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
  <key>StandardOutPath</key><string>${join(DATA, 'bot.launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(DATA, 'bot.launchd.err.log')}</string>
  <key>WorkingDirectory</key><string>${resolve(scriptPath, '..', '..')}</string>
</dict>
</plist>
`;

  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
  try { execSync(`launchctl unload ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' }); } catch (_) {}
  writeFileSync(PLIST_PATH, plist);
  try {
    execSync(`launchctl load ${JSON.stringify(PLIST_PATH)}`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`launchctl load failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`✓ memex-bot installed and running`);
  console.log(`  plist:   ${PLIST_PATH}`);
  console.log(`  log:     ${LOG_PATH}`);
  console.log(`  config:  ${BOT_CONFIG_PATH}`);
  console.log('');
  console.log(`Send a test message to your bot — it should appear in ~/.memex/inbox/`);
  console.log(`within ~5s, then in memex.db within another ~2s.`);
  console.log('');
  console.log(`status: npx memex-bot status`);
  console.log(`logs:   npx memex-bot logs`);
  process.exit(0);
}

function cmdUninstall() {
  if (platform() !== 'darwin') {
    console.error('uninstall: macOS-only for now.');
    process.exit(1);
  }
  if (!existsSync(PLIST_PATH)) {
    console.log(`memex-bot was not installed (nothing to remove).`);
    process.exit(0);
  }
  try { execSync(`launchctl unload ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' }); } catch (_) {}
  try { unlinkSync(PLIST_PATH); } catch (_) {}
  console.log(`✓ memex-bot uninstalled`);
  console.log(`\nConfig preserved at ${BOT_CONFIG_PATH}.`);
  console.log(`To reinstall: npx memex-bot install`);
  process.exit(0);
}

function cmdRestart() {
  if (platform() !== 'darwin') {
    console.error('restart: macOS-only for now.');
    process.exit(1);
  }
  if (!existsSync(PLIST_PATH)) {
    console.error('memex-bot is not installed (no LaunchAgent plist found).');
    console.error('Run: npx memex-bot install');
    process.exit(1);
  }
  try { execSync(`launchctl unload ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' }); } catch (_) {}
  try {
    execSync(`launchctl load ${JSON.stringify(PLIST_PATH)}`, { stdio: 'ignore' });
  } catch (e) {
    console.error('launchctl load failed:', e.message);
    process.exit(1);
  }
  console.log(`✓ memex-bot restarted`);
  process.exit(0);
}

function cmdStatus() {
  const installed = existsSync(PLIST_PATH);
  let runningPid = null;
  if (installed) {
    try {
      const out = execSync(`launchctl list | grep ${LAUNCH_LABEL}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const m = out.match(/^(\d+|-)\s+(\d+|-)\s+\S+/m);
      if (m && m[1] !== '-') runningPid = parseInt(m[1], 10);
    } catch (_) {}
  }

  console.log('memex-bot status\n');

  if (installed) {
    console.log(`  daemon:   installed (${PLIST_PATH})`);
  } else {
    console.log(`  daemon:   NOT installed`);
    console.log(`            enable autostart with: memex-bot install`);
  }
  console.log(`  process:  ${runningPid ? `running (PID ${runningPid})` : 'not running'}`);

  // Config probe
  if (existsSync(BOT_CONFIG_PATH)) {
    try {
      const cfg = loadBotConfig();
      console.log(`  config:   ✓ ${BOT_CONFIG_PATH}`);
      console.log(`            allowlist: ${cfg.allowlist_user_ids.join(', ')}`);
      console.log(`            voice:     ${cfg.voice_enabled ? 'enabled' : 'disabled'}`);
      console.log(`            inbox:     ${cfg.inbox_path}`);
    } catch (e) {
      console.log(`  config:   ✗ ${BOT_CONFIG_PATH} — ${e.message.split('\n')[0]}`);
    }
  } else {
    console.log(`  config:   ✗ missing at ${BOT_CONFIG_PATH}`);
  }

  // Offset state
  let offsetInfo = '(none)';
  let lastSeen = null;
  try {
    const cfg = existsSync(BOT_CONFIG_PATH) ? loadBotConfig() : null;
    if (cfg && existsSync(cfg.state_path)) {
      const s = JSON.parse(readFileSync(cfg.state_path, 'utf-8'));
      offsetInfo = `last update_id: ${s.lastUpdateId}`;
      const ageMs = Date.now() - statSync(cfg.state_path).mtimeMs;
      const min = Math.floor(ageMs / 60000);
      lastSeen = min < 1 ? 'just now' : (min < 60 ? `${min} min ago` : `${Math.floor(min / 60)}h ${min % 60}m ago`);
    }
  } catch (_) {}
  console.log(`  state:    ${offsetInfo}`);
  if (lastSeen) console.log(`  last activity: ${lastSeen}`);

  console.log('');
  console.log(`  log:      ${LOG_PATH}`);
  process.exit(0);
}

function cmdLogs() {
  if (!existsSync(LOG_PATH)) {
    console.error(`no log file at ${LOG_PATH} — bot never started?`);
    process.exit(1);
  }
  const tail = spawn('tail', ['-n', '50', '-f', LOG_PATH], { stdio: 'inherit' });
  process.on('SIGINT', () => { tail.kill('SIGINT'); process.exit(0); });
  tail.on('exit', (code) => process.exit(code || 0));
}
