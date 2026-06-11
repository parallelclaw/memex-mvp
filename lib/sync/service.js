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
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
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

// Tunnel keeper (sync-join, v0.13) — a durable forward SSH tunnel from a
// spoke (laptop) to the hub's loopback sync-server. The OS supervisor
// (KeepAlive / Restart=always) respawns ssh whenever it exits — sleep/wake,
// network change, drop — which is what makes the tunnel self-healing.
const TUNNEL_MAC_LABEL = 'com.parallelclaw.memex.synctunnel';
const TUNNEL_MAC_PLIST = join(HOME, 'Library', 'LaunchAgents', `${TUNNEL_MAC_LABEL}.plist`);
const TUNNEL_LINUX_UNIT = 'memex-sync-tunnel.service';
const TUNNEL_LINUX_PATH = join(LINUX_DIR, TUNNEL_LINUX_UNIT);
const TUNNEL_SCRIPT = join(MEMEX_DIR, 'sync-tunnel.sh');
const TUNNEL_OUT_LOG = join(DATA, 'sync-tunnel.out.log');
const TUNNEL_ERR_LOG = join(DATA, 'sync-tunnel.err.log');

// Watchdog (sync-join, v0.13) — hourly `sync-watchdog` pass that checks every
// remote's last_sync_at + the tunnel unit and surfaces silent failures
// (notification + alert file). The 2026-06 incident — a dead tunnel silently
// stranding 6 days of data — is exactly what this catches on day one.
const WD_MAC_LABEL = 'com.parallelclaw.memex.syncwatchdog';
const WD_MAC_PLIST = join(HOME, 'Library', 'LaunchAgents', `${WD_MAC_LABEL}.plist`);
const WD_LINUX_SERVICE = 'memex-sync-watchdog.service';
const WD_LINUX_TIMER   = 'memex-sync-watchdog.timer';
const WD_SERVICE_PATH  = join(LINUX_DIR, WD_LINUX_SERVICE);
const WD_TIMER_PATH    = join(LINUX_DIR, WD_LINUX_TIMER);
const WD_OUT_LOG = join(DATA, 'sync-watchdog.out.log');
const WD_ERR_LOG = join(DATA, 'sync-watchdog.err.log');

export const SERVICE_PATHS = {
  MAC_LABEL, MAC_PLIST, LINUX_UNIT, LINUX_DIR, LINUX_PATH, OUT_LOG, ERR_LOG,
  SCHED_MAC_LABEL, SCHED_MAC_PLIST, SCHED_LINUX_SERVICE, SCHED_LINUX_TIMER,
  SCHED_SERVICE_PATH, SCHED_TIMER_PATH,
  TUNNEL_MAC_LABEL, TUNNEL_MAC_PLIST, TUNNEL_LINUX_UNIT, TUNNEL_LINUX_PATH, TUNNEL_SCRIPT,
  WD_MAC_LABEL, WD_MAC_PLIST, WD_LINUX_SERVICE, WD_LINUX_TIMER, WD_SERVICE_PATH, WD_TIMER_PATH,
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

// ════════════════════════════════════════════════════════════════════════════
// sync-join (v0.13) · durable forward tunnel — spoke → hub loopback
// ════════════════════════════════════════════════════════════════════════════

/**
 * Pure builder — the tunnel keeper script. Runs ssh in the FOREGROUND
 * (`-N`, no `-f`): the OS supervisor owns the lifecycle and respawns on any
 * exit. ServerAlive* makes ssh notice a dead peer within ~90s and exit so
 * the supervisor can heal it. ExitOnForwardFailure turns a failed -L bind
 * into an exit (→ respawn with backoff) instead of a silent no-op tunnel.
 * Explicit IPv4 loopback on both sides — a bare port once bound ::1-only
 * and produced a tunnel nobody dialed.
 */
export function buildTunnelScript({ sshTarget, localPort, remotePort, identity = null }) {
  if (!sshTarget) throw new Error('buildTunnelScript: sshTarget required');
  const lp = Number(localPort) || 8766;
  const rp = Number(remotePort) || 8766;
  // Either '' or a full continuation line — the template line before it always
  // ends in `\\`, so this must NEVER inject a bare ` \\` (a backslash-escaped
  // space becomes a literal space argument to ssh and breaks the tunnel).
  const idFlags = identity ? `\n  -i "${identity}" -o IdentitiesOnly=yes \\` : '';
  return `#!/bin/bash
# memex sync tunnel keeper — generated by \`memex-sync sync-join\`. Do not edit;
# re-run sync-join to regenerate. Managed by the OS service alongside it.
exec ssh -N \\
  -o BatchMode=yes \\
  -o StrictHostKeyChecking=accept-new \\
  -o ExitOnForwardFailure=yes \\
  -o ServerAliveInterval=30 \\
  -o ServerAliveCountMax=3 \\${idFlags}
  -L 127.0.0.1:${lp}:127.0.0.1:${rp} \\
  "${sshTarget}"
`;
}

/** Pure builder — launchd plist for the tunnel keeper (KeepAlive = self-heal). */
export function buildTunnelLaunchAgentPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${TUNNEL_MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${TUNNEL_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${TUNNEL_OUT_LOG}</string>
  <key>StandardErrorPath</key><string>${TUNNEL_ERR_LOG}</string>
</dict>
</plist>
`;
}

/** Pure builder — systemd-user unit for the tunnel keeper. */
export function buildTunnelSystemdUnit() {
  return `[Unit]
Description=memex sync tunnel keeper (self-healing forward SSH tunnel to hub)
Documentation=https://github.com/parallelclaw/memex-mvp/blob/main/SYNC.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${TUNNEL_SCRIPT}
Restart=always
RestartSec=15
StandardOutput=append:${TUNNEL_OUT_LOG}
StandardError=append:${TUNNEL_ERR_LOG}

[Install]
WantedBy=default.target
`;
}

/**
 * Install (or replace) the durable tunnel. Writes the keeper script, then
 * registers the supervisor unit. Idempotent: an existing tunnel is stopped
 * and replaced — which also frees its local port before the new bind.
 */
export function installSyncTunnel({ sshTarget, localPort, remotePort, identity } = {}) {
  if (!sshTarget) throw new Error('installSyncTunnel: sshTarget required');
  mkdirSync(DATA, { recursive: true });
  writeFileSync(TUNNEL_SCRIPT, buildTunnelScript({ sshTarget, localPort, remotePort, identity }), { mode: 0o755 });

  if (platform() === 'darwin') {
    try { execSync(`launchctl unload ${JSON.stringify(TUNNEL_MAC_PLIST)}`, { stdio: 'ignore' }); } catch (_) {}
    mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(TUNNEL_MAC_PLIST, buildTunnelLaunchAgentPlist());
    execSync(`launchctl load ${JSON.stringify(TUNNEL_MAC_PLIST)}`, { stdio: 'inherit' });
    return { platform: 'darwin', unitPath: TUNNEL_MAC_PLIST, scriptPath: TUNNEL_SCRIPT };
  }
  if (platform() === 'linux') {
    try { execSync('systemctl --user --version', { stdio: 'ignore' }); }
    catch (_) { throw new Error('systemctl --user not available — enable lingering: loginctl enable-linger $USER'); }
    mkdirSync(LINUX_DIR, { recursive: true });
    try { execSync(`systemctl --user stop ${TUNNEL_LINUX_UNIT}`, { stdio: 'ignore' }); } catch (_) {}
    writeFileSync(TUNNEL_LINUX_PATH, buildTunnelSystemdUnit());
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    execSync(`systemctl --user enable ${TUNNEL_LINUX_UNIT}`, { stdio: 'inherit' });
    execSync(`systemctl --user start ${TUNNEL_LINUX_UNIT}`, { stdio: 'inherit' });
    return { platform: 'linux', unitPath: TUNNEL_LINUX_PATH, scriptPath: TUNNEL_SCRIPT };
  }
  throw new Error(`installSyncTunnel: unsupported platform ${platform()}`);
}

export function uninstallSyncTunnel() {
  if (platform() === 'darwin') {
    try { execSync(`launchctl unload ${JSON.stringify(TUNNEL_MAC_PLIST)}`, { stdio: 'ignore' }); } catch (_) {}
    if (existsSync(TUNNEL_MAC_PLIST)) unlinkSync(TUNNEL_MAC_PLIST);
    if (existsSync(TUNNEL_SCRIPT)) unlinkSync(TUNNEL_SCRIPT);
    return { platform: 'darwin', unitPath: TUNNEL_MAC_PLIST };
  }
  if (platform() === 'linux') {
    try { execSync(`systemctl --user stop ${TUNNEL_LINUX_UNIT}`, { stdio: 'ignore' }); } catch (_) {}
    try { execSync(`systemctl --user disable ${TUNNEL_LINUX_UNIT}`, { stdio: 'ignore' }); } catch (_) {}
    if (existsSync(TUNNEL_LINUX_PATH)) unlinkSync(TUNNEL_LINUX_PATH);
    if (existsSync(TUNNEL_SCRIPT)) unlinkSync(TUNNEL_SCRIPT);
    try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch (_) {}
    return { platform: 'linux', unitPath: TUNNEL_LINUX_PATH };
  }
  throw new Error(`uninstallSyncTunnel: unsupported platform ${platform()}`);
}

/**
 * { installed, running, manager, unitPath, scriptPath, spec } — best-effort.
 * `spec` is parsed back out of the generated script ({sshTarget, localPort,
 * remotePort}) so status can describe the tunnel without extra state files.
 */
export function syncTunnelStatus() {
  let spec = null;
  if (existsSync(TUNNEL_SCRIPT)) {
    try {
      const body = readFileSync(TUNNEL_SCRIPT, 'utf-8');
      const m = body.match(/-L 127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)[\s\S]*?"([^"]+)"/);
      if (m) spec = { localPort: Number(m[1]), remotePort: Number(m[2]), sshTarget: m[3] };
    } catch (_) {}
  }
  if (platform() === 'darwin') {
    const installed = existsSync(TUNNEL_MAC_PLIST);
    let running = false, detail = '';
    if (installed) {
      try {
        const out = execSync(`launchctl list 2>/dev/null | grep ${TUNNEL_MAC_LABEL} || true`, { encoding: 'utf-8' });
        running = out.trim().length > 0 && !out.trim().startsWith('-');
        detail = out.trim();
      } catch (_) {}
    }
    return { installed, running, manager: 'launchd', unitPath: TUNNEL_MAC_PLIST, scriptPath: TUNNEL_SCRIPT, spec, detail };
  }
  if (platform() === 'linux') {
    const installed = existsSync(TUNNEL_LINUX_PATH);
    let running = false, detail = '';
    if (installed) {
      try {
        detail = execSync(`systemctl --user is-active ${TUNNEL_LINUX_UNIT} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
        running = detail === 'active';
      } catch (_) {}
    }
    return { installed, running, manager: 'systemd-user', unitPath: TUNNEL_LINUX_PATH, scriptPath: TUNNEL_SCRIPT, spec, detail };
  }
  return { installed: false, running: false, manager: 'none', unitPath: null, scriptPath: TUNNEL_SCRIPT, spec, detail: 'unsupported' };
}

// ════════════════════════════════════════════════════════════════════════════
// sync-join (v0.13) · watchdog timer — hourly silent-failure detector
// ════════════════════════════════════════════════════════════════════════════

/** Pure builder — launchd plist running `sync-watchdog` every N minutes. */
export function buildWatchdogLaunchAgentPlist({ script, mins = 60, nodePath }) {
  const argXml = [nodePath, script, 'sync-watchdog']
    .map((a) => `    <string>${a}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WD_MAC_LABEL}</string>
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
  <key>StartInterval</key><integer>${Math.max(60, Math.floor(mins * 60))}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${WD_OUT_LOG}</string>
  <key>StandardErrorPath</key><string>${WD_ERR_LOG}</string>
  <key>WorkingDirectory</key><string>${resolve(script, '..')}</string>
</dict>
</plist>
`;
}

/** Pure builders — systemd oneshot + timer for the watchdog. */
export function buildWatchdogSystemdService({ script, nodePath }) {
  return `[Unit]
Description=memex sync — one watchdog pass (detect silent sync failure)

[Service]
Type=oneshot
ExecStart=${nodePath} ${script} sync-watchdog
WorkingDirectory=${resolve(script, '..')}
Environment=MEMEX_SYNC_EXPERIMENTAL=1
Environment=HOME=${HOME}
Environment=MEMEX_DIR=${MEMEX_DIR}
StandardOutput=append:${WD_OUT_LOG}
StandardError=append:${WD_ERR_LOG}
`;
}

export function buildWatchdogSystemdTimer({ mins = 60 }) {
  return `[Unit]
Description=memex sync — watchdog every ${mins}m

[Timer]
OnBootSec=5min
OnUnitActiveSec=${mins}min
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
`;
}

export function installSyncWatchdog({ scriptPath, everyMinutes = 60, nodePath = process.execPath } = {}) {
  const script = resolve(scriptPath || process.argv[1]);
  if (!existsSync(script)) throw new Error(`installSyncWatchdog: script not found at ${script}`);
  const mins = Math.max(5, Math.floor(Number(everyMinutes) || 60));
  mkdirSync(DATA, { recursive: true });

  if (platform() === 'darwin') {
    try { execSync(`launchctl unload ${JSON.stringify(WD_MAC_PLIST)}`, { stdio: 'ignore' }); } catch (_) {}
    mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(WD_MAC_PLIST, buildWatchdogLaunchAgentPlist({ script, mins, nodePath }));
    execSync(`launchctl load ${JSON.stringify(WD_MAC_PLIST)}`, { stdio: 'inherit' });
    return { platform: 'darwin', unitPath: WD_MAC_PLIST, everyMinutes: mins };
  }
  if (platform() === 'linux') {
    try { execSync('systemctl --user --version', { stdio: 'ignore' }); }
    catch (_) { throw new Error('systemctl --user not available — enable lingering: loginctl enable-linger $USER'); }
    mkdirSync(LINUX_DIR, { recursive: true });
    writeFileSync(WD_SERVICE_PATH, buildWatchdogSystemdService({ script, nodePath }));
    writeFileSync(WD_TIMER_PATH, buildWatchdogSystemdTimer({ mins }));
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    execSync(`systemctl --user enable ${WD_LINUX_TIMER}`, { stdio: 'inherit' });
    execSync(`systemctl --user start ${WD_LINUX_TIMER}`, { stdio: 'inherit' });
    return { platform: 'linux', unitPath: WD_TIMER_PATH, everyMinutes: mins };
  }
  throw new Error(`installSyncWatchdog: unsupported platform ${platform()}`);
}

export function uninstallSyncWatchdog() {
  if (platform() === 'darwin') {
    try { execSync(`launchctl unload ${JSON.stringify(WD_MAC_PLIST)}`, { stdio: 'ignore' }); } catch (_) {}
    if (existsSync(WD_MAC_PLIST)) unlinkSync(WD_MAC_PLIST);
    return { platform: 'darwin', unitPath: WD_MAC_PLIST };
  }
  if (platform() === 'linux') {
    try { execSync(`systemctl --user stop ${WD_LINUX_TIMER}`, { stdio: 'ignore' }); } catch (_) {}
    try { execSync(`systemctl --user disable ${WD_LINUX_TIMER}`, { stdio: 'ignore' }); } catch (_) {}
    if (existsSync(WD_TIMER_PATH)) unlinkSync(WD_TIMER_PATH);
    if (existsSync(WD_SERVICE_PATH)) unlinkSync(WD_SERVICE_PATH);
    try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch (_) {}
    return { platform: 'linux', unitPath: WD_TIMER_PATH };
  }
  throw new Error(`uninstallSyncWatchdog: unsupported platform ${platform()}`);
}

export function syncWatchdogStatus() {
  if (platform() === 'darwin') {
    const installed = existsSync(WD_MAC_PLIST);
    let running = false, detail = '';
    if (installed) {
      try {
        const out = execSync(`launchctl list 2>/dev/null | grep ${WD_MAC_LABEL} || true`, { encoding: 'utf-8' });
        running = out.trim().length > 0;
        detail = out.trim();
      } catch (_) {}
    }
    return { installed, running, manager: 'launchd', unitPath: WD_MAC_PLIST, detail };
  }
  if (platform() === 'linux') {
    const installed = existsSync(WD_TIMER_PATH);
    let running = false, detail = '';
    if (installed) {
      try {
        detail = execSync(`systemctl --user is-active ${WD_LINUX_TIMER} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
        running = detail === 'active';
      } catch (_) {}
    }
    return { installed, running, manager: 'systemd-user', unitPath: WD_TIMER_PATH, detail };
  }
  return { installed: false, running: false, manager: 'none', unitPath: null, detail: 'unsupported' };
}
