/**
 * Durable service registration for the sync-server (Phase 2).
 *
 * Turns `memex-sync sync-server start` (a foreground process) into a managed
 * service that survives reboot and auto-restarts on crash:
 *   • macOS  → LaunchAgent  com.parallelclaw.memex.syncserver
 *   • Linux  → systemd-user memex-sync-server.service
 *
 * Deliberately SEPARATE from the capture daemon (com.parallelclaw.memex.sync
 * / memex-sync.service). A host can run both: the capture daemon ingests local
 * sources, the sync-server answers remote pull/push. Different jobs, different
 * lifecycles.
 *
 * The bearer token and TLS cert persist on disk (~/.memex/config.json +
 * sync-cert.pem), so a restart reuses the SAME credentials — paired peers
 * keep working without re-pairing. That's the whole point of Phase 2.
 *
 * The unit/plist MUST inject MEMEX_SYNC_EXPERIMENTAL=1, otherwise the
 * sync-server start command refuses to run (experimental gate).
 */

import { platform, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DATA = join(MEMEX_DIR, 'data');

// Service identity — distinct from the capture daemon.
const MAC_LABEL = 'com.parallelclaw.memex.syncserver';
const MAC_PLIST = join(HOME, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
const LINUX_UNIT = 'memex-sync-server.service';
const LINUX_DIR  = join(HOME, '.config', 'systemd', 'user');
const LINUX_PATH = join(LINUX_DIR, LINUX_UNIT);

const OUT_LOG = join(DATA, 'sync-server.out.log');
const ERR_LOG = join(DATA, 'sync-server.err.log');

// Scheduler identity (Phase 3) — distinct again from both the capture daemon
// AND the sync-server. This is the client-side timer that runs `sync-run --all`
// every N minutes. On a hub (VPS) you typically run sync-server; on a spoke
// (laptop) you run the schedule. A machine can run both.
const SCHED_MAC_LABEL = 'com.parallelclaw.memex.syncschedule';
const SCHED_MAC_PLIST = join(HOME, 'Library', 'LaunchAgents', `${SCHED_MAC_LABEL}.plist`);
const SCHED_LINUX_SERVICE = 'memex-sync-schedule.service';
const SCHED_LINUX_TIMER   = 'memex-sync-schedule.timer';
const SCHED_SERVICE_PATH  = join(LINUX_DIR, SCHED_LINUX_SERVICE);
const SCHED_TIMER_PATH    = join(LINUX_DIR, SCHED_LINUX_TIMER);
const SCHED_OUT_LOG = join(DATA, 'sync-schedule.out.log');
const SCHED_ERR_LOG = join(DATA, 'sync-schedule.err.log');

export const SERVICE_PATHS = {
  MAC_LABEL, MAC_PLIST, LINUX_UNIT, LINUX_DIR, LINUX_PATH, OUT_LOG, ERR_LOG,
  SCHED_MAC_LABEL, SCHED_MAC_PLIST, SCHED_LINUX_SERVICE, SCHED_LINUX_TIMER,
  SCHED_SERVICE_PATH, SCHED_TIMER_PATH,
};

/**
 * Install + start the sync-server as a managed service.
 *
 * opts:
 *   scriptPath — absolute path to ingest.js (defaults to process.argv[1])
 *   port, bind — listen config baked into the unit's ExecStart
 *   nodePath   — node binary (defaults to process.execPath)
 *
 * Returns { platform, unitPath } on success; throws on failure.
 */
export function installSyncServerService({ scriptPath, port, bind, nodePath = process.execPath } = {}) {
  const script = resolve(scriptPath || process.argv[1]);
  if (!existsSync(script)) {
    throw new Error(`installSyncServerService: script not found at ${script}`);
  }
  mkdirSync(DATA, { recursive: true });

  if (platform() === 'darwin') return installLaunchAgent({ script, port, bind, nodePath });
  if (platform() === 'linux')  return installSystemd({ script, port, bind, nodePath });
  throw new Error(`installSyncServerService: unsupported platform ${platform()}`);
}

export function uninstallSyncServerService() {
  if (platform() === 'darwin') return uninstallLaunchAgent();
  if (platform() === 'linux')  return uninstallSystemd();
  throw new Error(`uninstallSyncServerService: unsupported platform ${platform()}`);
}

/**
 * Report service state: { installed, running, manager, unitPath, detail }.
 * Best-effort — never throws.
 */
export function syncServerServiceStatus() {
  if (platform() === 'darwin') {
    const installed = existsSync(MAC_PLIST);
    let running = false, detail = '';
    if (installed) {
      try {
        const out = execSync(`launchctl list 2>/dev/null | grep ${MAC_LABEL} || true`, { encoding: 'utf-8' });
        running = out.trim().length > 0 && !out.trim().startsWith('-');
        detail = out.trim();
      } catch (_) {}
    }
    return { installed, running, manager: 'launchd', unitPath: MAC_PLIST, detail };
  }
  if (platform() === 'linux') {
    const installed = existsSync(LINUX_PATH);
    let running = false, detail = '';
    if (installed) {
      try {
        detail = execSync(`systemctl --user is-active ${LINUX_UNIT} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
        running = detail === 'active';
      } catch (_) {}
    }
    return { installed, running, manager: 'systemd-user', unitPath: LINUX_PATH, detail };
  }
  return { installed: false, running: false, manager: 'none', unitPath: null, detail: 'unsupported platform' };
}

// ── macOS LaunchAgent ────────────────────────────────────────────────────────

/**
 * Pure builder — returns the LaunchAgent plist XML. Exported for testing so
 * we can assert the env var / args / paths without touching launchctl.
 */
export function buildLaunchAgentPlist({ script, port, bind, nodePath }) {
  const args = ['sync-server', 'start'];
  if (port) args.push('--port', String(port));
  if (bind) args.push('--bind', String(bind));
  const argXml = [nodePath, script, ...args].map((a) => `    <string>${a}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMEX_SYNC_EXPERIMENTAL</key><string>1</string>
    <key>HOME</key><string>${HOME}</string>
    <key>MEMEX_DIR</key><string>${MEMEX_DIR}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${OUT_LOG}</string>
  <key>StandardErrorPath</key><string>${ERR_LOG}</string>
  <key>WorkingDirectory</key><string>${resolve(script, '..')}</string>
</dict>
</plist>
`;
}

function installLaunchAgent({ script, port, bind, nodePath }) {
  const plist = buildLaunchAgentPlist({ script, port, bind, nodePath });
  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
  try { execSync(`launchctl unload ${JSON.stringify(MAC_PLIST)}`, { stdio: 'ignore' }); } catch (_) {}
  writeFileSync(MAC_PLIST, plist);
  execSync(`launchctl load ${JSON.stringify(MAC_PLIST)}`, { stdio: 'inherit' });
  return { platform: 'darwin', unitPath: MAC_PLIST };
}

function uninstallLaunchAgent() {
  try { execSync(`launchctl unload ${JSON.stringify(MAC_PLIST)}`, { stdio: 'ignore' }); } catch (_) {}
  if (existsSync(MAC_PLIST)) unlinkSync(MAC_PLIST);
  return { platform: 'darwin', unitPath: MAC_PLIST };
}

// ── Linux systemd-user ───────────────────────────────────────────────────────

/**
 * Pure builder — returns the systemd-user unit file content. Exported for
 * testing so we can assert env var / ExecStart / restart policy without
 * touching systemctl.
 */
export function buildSystemdUnit({ script, port, bind, nodePath }) {
  const args = ['sync-server', 'start'];
  if (port) args.push('--port', String(port));
  if (bind) args.push('--bind', String(bind));
  const execStart = [nodePath, script, ...args].join(' ');

  return `[Unit]
Description=memex sync server (experimental multi-device replication)
Documentation=https://github.com/parallelclaw/memex-mvp/blob/main/SYNC.md
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${resolve(script, '..')}
Restart=on-failure
RestartSec=10s
StartLimitIntervalSec=60
StartLimitBurst=5
Environment=MEMEX_SYNC_EXPERIMENTAL=1
Environment=HOME=${HOME}
Environment=MEMEX_DIR=${MEMEX_DIR}
StandardOutput=append:${OUT_LOG}
StandardError=append:${ERR_LOG}

[Install]
WantedBy=default.target
`;
}

function installSystemd({ script, port, bind, nodePath }) {
  try { execSync('systemctl --user --version', { stdio: 'ignore' }); }
  catch (_) {
    throw new Error(
      'systemctl --user not available. Run the server under nohup instead, ' +
      'or enable lingering: `loginctl enable-linger $USER`.'
    );
  }

  const unit = buildSystemdUnit({ script, port, bind, nodePath });
  mkdirSync(LINUX_DIR, { recursive: true });
  try { execSync(`systemctl --user stop ${LINUX_UNIT}`, { stdio: 'ignore' }); } catch (_) {}
  writeFileSync(LINUX_PATH, unit);
  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync(`systemctl --user enable ${LINUX_UNIT}`, { stdio: 'inherit' });
  execSync(`systemctl --user start ${LINUX_UNIT}`, { stdio: 'inherit' });
  return { platform: 'linux', unitPath: LINUX_PATH };
}

function uninstallSystemd() {
  try { execSync(`systemctl --user stop ${LINUX_UNIT}`, { stdio: 'ignore' }); } catch (_) {}
  try { execSync(`systemctl --user disable ${LINUX_UNIT}`, { stdio: 'ignore' }); } catch (_) {}
  if (existsSync(LINUX_PATH)) unlinkSync(LINUX_PATH);
  try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch (_) {}
  return { platform: 'linux', unitPath: LINUX_PATH };
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 3 · scheduled auto-sync (client side)
// Runs `sync-run --all` every N minutes via the platform scheduler.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Install the recurring auto-sync schedule.
 *   opts.everyMinutes — interval (default 15)
 *   opts.scriptPath   — ingest.js (defaults to process.argv[1])
 *   opts.nodePath     — node binary (defaults to process.execPath)
 */
export function installSyncSchedule({ scriptPath, everyMinutes = 15, nodePath = process.execPath } = {}) {
  const script = resolve(scriptPath || process.argv[1]);
  if (!existsSync(script)) throw new Error(`installSyncSchedule: script not found at ${script}`);
  const mins = Math.max(1, Math.floor(Number(everyMinutes) || 15));
  mkdirSync(DATA, { recursive: true });

  if (platform() === 'darwin') return installScheduleLaunchAgent({ script, mins, nodePath });
  if (platform() === 'linux')  return installScheduleSystemd({ script, mins, nodePath });
  throw new Error(`installSyncSchedule: unsupported platform ${platform()}`);
}

export function uninstallSyncSchedule() {
  if (platform() === 'darwin') {
    try { execSync(`launchctl unload ${JSON.stringify(SCHED_MAC_PLIST)}`, { stdio: 'ignore' }); } catch (_) {}
    if (existsSync(SCHED_MAC_PLIST)) unlinkSync(SCHED_MAC_PLIST);
    return { platform: 'darwin', unitPath: SCHED_MAC_PLIST };
  }
  if (platform() === 'linux') {
    try { execSync(`systemctl --user stop ${SCHED_LINUX_TIMER}`, { stdio: 'ignore' }); } catch (_) {}
    try { execSync(`systemctl --user disable ${SCHED_LINUX_TIMER}`, { stdio: 'ignore' }); } catch (_) {}
    if (existsSync(SCHED_TIMER_PATH)) unlinkSync(SCHED_TIMER_PATH);
    if (existsSync(SCHED_SERVICE_PATH)) unlinkSync(SCHED_SERVICE_PATH);
    try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch (_) {}
    return { platform: 'linux', unitPath: SCHED_TIMER_PATH };
  }
  throw new Error(`uninstallSyncSchedule: unsupported platform ${platform()}`);
}

/** { installed, running, manager, everyMinutes?, unitPath, detail } — best-effort. */
export function syncScheduleStatus() {
  if (platform() === 'darwin') {
    const installed = existsSync(SCHED_MAC_PLIST);
    let running = false, detail = '';
    if (installed) {
      try {
        const out = execSync(`launchctl list 2>/dev/null | grep ${SCHED_MAC_LABEL} || true`, { encoding: 'utf-8' });
        running = out.trim().length > 0;
        detail = out.trim();
      } catch (_) {}
    }
    return { installed, running, manager: 'launchd', unitPath: SCHED_MAC_PLIST, detail };
  }
  if (platform() === 'linux') {
    const installed = existsSync(SCHED_TIMER_PATH);
    let running = false, detail = '';
    if (installed) {
      try {
        detail = execSync(`systemctl --user is-active ${SCHED_LINUX_TIMER} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
        running = detail === 'active';
      } catch (_) {}
    }
    return { installed, running, manager: 'systemd-user', unitPath: SCHED_TIMER_PATH, detail };
  }
  return { installed: false, running: false, manager: 'none', unitPath: null, detail: 'unsupported' };
}

// ── macOS: LaunchAgent with StartInterval (re-runs the one-shot every N sec) ──

export function buildScheduleLaunchAgentPlist({ script, mins, nodePath }) {
  const interval = mins * 60;
  const argXml = [nodePath, script, 'sync-run', '--all']
    .map((a) => `    <string>${a}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHED_MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMEX_SYNC_EXPERIMENTAL</key><string>1</string>
    <key>HOME</key><string>${HOME}</string>
    <key>MEMEX_DIR</key><string>${MEMEX_DIR}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${SCHED_OUT_LOG}</string>
  <key>StandardErrorPath</key><string>${SCHED_ERR_LOG}</string>
  <key>WorkingDirectory</key><string>${resolve(script, '..')}</string>
</dict>
</plist>
`;
}

function installScheduleLaunchAgent({ script, mins, nodePath }) {
  const plist = buildScheduleLaunchAgentPlist({ script, mins, nodePath });
  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
  try { execSync(`launchctl unload ${JSON.stringify(SCHED_MAC_PLIST)}`, { stdio: 'ignore' }); } catch (_) {}
  writeFileSync(SCHED_MAC_PLIST, plist);
  execSync(`launchctl load ${JSON.stringify(SCHED_MAC_PLIST)}`, { stdio: 'inherit' });
  return { platform: 'darwin', unitPath: SCHED_MAC_PLIST, everyMinutes: mins };
}

// ── Linux: systemd .timer + oneshot .service ─────────────────────────────────

export function buildScheduleSystemdService({ script, nodePath }) {
  return `[Unit]
Description=memex sync — one auto-sync pass (all remotes)
Documentation=https://github.com/parallelclaw/memex-mvp/blob/main/SYNC.md

[Service]
Type=oneshot
ExecStart=${nodePath} ${script} sync-run --all
WorkingDirectory=${resolve(script, '..')}
Environment=MEMEX_SYNC_EXPERIMENTAL=1
Environment=HOME=${HOME}
Environment=MEMEX_DIR=${MEMEX_DIR}
StandardOutput=append:${SCHED_OUT_LOG}
StandardError=append:${SCHED_ERR_LOG}
`;
}

export function buildScheduleSystemdTimer({ mins }) {
  return `[Unit]
Description=memex sync — run auto-sync every ${mins}m
Documentation=https://github.com/parallelclaw/memex-mvp/blob/main/SYNC.md

[Timer]
OnBootSec=2min
OnUnitActiveSec=${mins}min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function installScheduleSystemd({ script, mins, nodePath }) {
  try { execSync('systemctl --user --version', { stdio: 'ignore' }); }
  catch (_) {
    throw new Error('systemctl --user not available. Enable lingering (loginctl enable-linger $USER) or run sync manually.');
  }
  mkdirSync(LINUX_DIR, { recursive: true });
  writeFileSync(SCHED_SERVICE_PATH, buildScheduleSystemdService({ script, nodePath }));
  writeFileSync(SCHED_TIMER_PATH, buildScheduleSystemdTimer({ mins }));
  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync(`systemctl --user enable ${SCHED_LINUX_TIMER}`, { stdio: 'inherit' });
  execSync(`systemctl --user start ${SCHED_LINUX_TIMER}`, { stdio: 'inherit' });
  return { platform: 'linux', unitPath: SCHED_TIMER_PATH, everyMinutes: mins };
}
