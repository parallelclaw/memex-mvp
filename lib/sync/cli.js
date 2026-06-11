/**
 * CLI subcommands for memex sync (v0.11.11 experimental tracer-bullet).
 *
 * Wired into ingest.js's subcommand dispatcher under:
 *   memex-sync sync-server   — start the server side (replaces config),
 *                              prints bearer + cert fingerprint to copy
 *   memex-sync sync-add      — register a remote on the client side
 *   memex-sync sync-list     — list configured remotes + their cursors
 *   memex-sync sync-run      — execute one bidirectional sync round
 *   memex-sync sync-status   — show cursor state across remotes
 *
 * All commands refuse to operate unless MEMEX_SYNC_EXPERIMENTAL=1 (or 'true').
 *
 * v0.12+ will replace these with a polished `memex sync ...` namespace
 * (under server.js entry, not ingest.js), with adaptive setup wizard.
 */

import {
  syncExperimentEnabled,
  loadSyncConfig,
  upsertSyncRemote,
  getSyncRemote,
  removeSyncRemote,
  listSyncRemotes,
} from './config.js';
import { startSyncServer, DEFAULT_SYNC_PORT } from './server.js';
import { replicateOnce } from './replicate.js';

/** Print the "you forgot to enable the env var" banner and exit. */
function refuseUnlessEnabled() {
  if (syncExperimentEnabled()) return;
  console.error('memex sync is experimental in v0.11.11.');
  console.error('Enable with:');
  console.error('  export MEMEX_SYNC_EXPERIMENTAL=1');
  console.error('');
  console.error('Wire protocol may change before v0.12 — pin your memex');
  console.error('version on both peers if you use this in production.');
  process.exit(2);
}

// ── sync-server ─────────────────────────────────────────────────────────────

/**
 * `memex-sync sync-server start [--port N] [--bind ADDR]`
 *
 * Foreground HTTPS server. Prints bearer + cert fingerprint to stdout — the
 * operator copies these to the peer's `sync-add` command.
 *
 * For tracer-bullet: foreground only. Backgrounding via LaunchAgent/systemd
 * lands when we wire memex-sync install to know about sync.
 */
export async function cmdSyncServer() {
  refuseUnlessEnabled();
  const sub = process.argv[3];
  const args = parseFlags(process.argv.slice(4));

  switch (sub) {
    case 'start': {
      const port = parseInt(args['--port'] || '', 10) || undefined;
      const bind = args['--bind'] || undefined;

      console.log('Starting memex sync server (foreground)…');
      const result = await startSyncServer({ port, bind });
      console.log(`✓ Listening on ${bind || result.server.address().address}:${result.port}`);
      console.log('');
      console.log('Pair credentials — paste into the other host:');
      console.log(`  memex-sync sync-add <alias> https://<host>:${result.port} ${result.bearer} --insecure`);
      console.log('');
      console.log(`Cert fingerprint:  ${result.fingerprint}`);
      console.log(`Bearer (256-bit):  ${result.bearer}`);
      if (result.bearerMinted) {
        console.log('');
        console.log('(bearer minted on first start — stored in ~/.memex/config.json)');
      }
      console.log('');
      console.log('Server running. Press Ctrl+C to stop.');

      // Keep alive on Ctrl+C / kill.
      process.on('SIGINT',  () => { console.log('\nshutting down…'); result.server.close(() => process.exit(0)); });
      process.on('SIGTERM', () => { result.server.close(() => process.exit(0)); });

      // CRITICAL: return a promise that never resolves. The ingest.js
      // dispatcher does `await handler(); process.exit(0)` for non-fallthrough
      // commands — if we returned normally here, that process.exit(0) would
      // kill the freshly-started server. A never-resolving promise keeps the
      // dispatcher awaiting forever; the process stays alive on the HTTPS
      // server's event loop until SIGINT/SIGTERM fires the handlers above.
      return new Promise(() => { /* never resolves — foreground server */ });
    }
    case 'install': {
      // Register the server as a managed service (systemd-user / LaunchAgent)
      // so it survives reboot and auto-restarts on crash. Port/bind are baked
      // in from flags or existing config.
      const { installSyncServerService, syncServerServiceStatus } =
        await import('./service.js');
      const cfg = loadSyncConfig();
      const port = parseInt(args['--port'] || '', 10) || cfg.server.port || undefined;
      const bind = args['--bind'] || cfg.server.bind || undefined;

      console.log(`Installing sync-server as a managed service (port ${port}, bind ${bind})…`);
      try {
        const r = installSyncServerService({ port, bind });
        const st = syncServerServiceStatus();
        console.log(`✓ installed via ${r.platform === 'darwin' ? 'LaunchAgent' : 'systemd-user'}`);
        console.log(`  unit:    ${r.unitPath}`);
        console.log(`  running: ${st.running ? 'yes' : '(check status)'}`);
        console.log('');
        console.log('Server now survives reboot + auto-restarts on crash.');
        console.log('Bearer + cert persist on disk, so paired peers keep working.');
        console.log('Logs: ~/.memex/data/sync-server.{out,err}.log');
      } catch (e) {
        console.error(`✗ install failed: ${e.message}`);
        process.exit(1);
      }
      process.exit(0);
    }
    case 'uninstall': {
      const { uninstallSyncServerService } = await import('./service.js');
      console.log('Removing sync-server service…');
      try {
        const r = uninstallSyncServerService();
        console.log(`✓ uninstalled (${r.unitPath})`);
        console.log('Data, bearer, and cert are preserved — only the service is gone.');
      } catch (e) {
        console.error(`✗ uninstall failed: ${e.message}`);
        process.exit(1);
      }
      process.exit(0);
    }
    case 'invite': {
      // Ensure cert + bearer exist (without starting the server), then print
      // a single pair blob that bundles host/port/cert_fp/token. The operator
      // pastes it into `sync pair` on the other machine.
      const { ensureCert } = await import('./cert.js');
      const { generateBearerToken } = await import('./auth.js');
      const { updateSyncServer } = await import('./config.js');
      const { encodePairBlob, encodeJoinBlob, DEFAULT_PAIR_TTL_SEC, DEFAULT_JOIN_TTL_SEC } = await import('./pair.js');
      const { homedir, userInfo } = await import('node:os');
      const { join } = await import('node:path');

      const cfg = loadSyncConfig();
      const MEMEX_DIR = process.env.MEMEX_DIR || join(homedir(), '.memex');
      const certPath = cfg.server.cert_path || join(MEMEX_DIR, 'sync-cert.pem');
      const keyPath  = cfg.server.key_path  || join(MEMEX_DIR, 'sync-key.pem');

      const certInfo = await ensureCert({ certPath, keyPath });
      let bearer = cfg.server.bearer;
      if (!bearer) { bearer = generateBearerToken(); }

      const port = parseInt(args['--port'] || '', 10) || cfg.server.port || DEFAULT_SYNC_PORT;
      // Persist so a later `sync-server start/install` reuses the same creds.
      updateSyncServer({ bearer, cert_path: certPath, key_path: keyPath, cert_fp: certInfo.fingerprint, port });

      let host = args['--host'];
      let hostNote = '';
      if (!host) {
        host = await detectPublicIp();
        if (host) hostNote = `(auto-detected public IP — override with --host if you use an SSH tunnel [localhost] or Tailscale [magicdns name])`;
      }
      if (!host) {
        console.error('Could not auto-detect a public host. Pass --host explicitly:');
        console.error('  • public IP:    memex-sync sync-server invite --host 203.0.113.5');
        console.error('  • SSH tunnel:   memex-sync sync-server invite --host localhost');
        console.error('  • Tailscale:    memex-sync sync-server invite --host my-vps.tail-xxxx.ts.net');
        process.exit(1);
      }

      // --join: emit a JOIN token (v0.13 lazy flow). Carries ssh_target so the
      // other machine builds a forward tunnel to THIS host's loopback server —
      // no public port ever needed. Default target: <this-user>@<public-ip>.
      if ('--join' in args) {
        const ttlSec = parseInt(args['--ttl'] || '', 10) || DEFAULT_JOIN_TTL_SEC;
        let sshTarget = args['--ssh-target'];
        if (!sshTarget) {
          const user = process.env.USER || userInfo().username;
          sshTarget = `${user}@${host}`;
        }
        const blob = encodeJoinBlob({ ssh_target: sshTarget, port, cert_fp: certInfo.fingerprint, token: bearer, ttlSec });
        console.log('Join token (valid ' + Math.round(ttlSec / 60) + ' min) — paste on the other machine:');
        console.log('');
        console.log('  memex-sync sync-join ' + blob);
        console.log('');
        console.log(`ssh target: ${sshTarget}   server: 127.0.0.1:${port} (loopback — reached via tunnel)`);
        console.log(`fingerprint: ${certInfo.fingerprint}`);
        if ((cfg.server.bind || '0.0.0.0') !== '127.0.0.1') {
          console.log('');
          console.log('Note: for the canonical loopback-hub setup, install the server with');
          console.log('  memex-sync sync-server install --bind 127.0.0.1');
        }
        process.exit(0);
      }

      const ttlSec = parseInt(args['--ttl'] || '', 10) || DEFAULT_PAIR_TTL_SEC;
      const blob = encodePairBlob({ host, port, cert_fp: certInfo.fingerprint, token: bearer, ttlSec });

      console.log('Pair blob (valid ' + Math.round(ttlSec / 60) + ' min) — paste on the other machine:');
      console.log('');
      console.log('  memex-sync sync-pair ' + blob);
      console.log('');
      console.log(`host: ${host}:${port}  ${hostNote}`);
      console.log(`fingerprint: ${certInfo.fingerprint}`);
      console.log('');
      console.log('Make sure the server is actually running/reachable on that host:port');
      console.log('  (memex-sync sync-server start   or   sync-server install)');
      process.exit(0);
    }
    case 'status': {
      const cfg = loadSyncConfig();
      const { syncServerServiceStatus } = await import('./service.js');
      const svc = syncServerServiceStatus();
      console.log('config:');
      console.log(`  enabled:          ${cfg.server.enabled ? 'yes' : 'no'}`);
      console.log(`  port:             ${cfg.server.port}`);
      console.log(`  bind:             ${cfg.server.bind}`);
      console.log(`  cert fingerprint: ${cfg.server.cert_fp || '(not generated yet)'}`);
      console.log(`  bearer:           ${cfg.server.bearer ? '(configured)' : '(none)'}`);
      console.log('');
      console.log('service:');
      console.log(`  manager:   ${svc.manager}`);
      console.log(`  installed: ${svc.installed ? 'yes' : 'no'}`);
      console.log(`  running:   ${svc.running ? 'yes' : 'no'}${svc.detail ? ' (' + svc.detail + ')' : ''}`);
      console.log(`  unit:      ${svc.unitPath || '(n/a)'}`);
      if (!svc.installed) {
        console.log('');
        console.log('Not installed as a service. Either:');
        console.log('  • foreground:  memex-sync sync-server start');
        console.log('  • durable:     memex-sync sync-server install');
      }
      process.exit(0);
    }
    default:
      console.error('usage:');
      console.error('  memex-sync sync-server start    [--port 8766] [--bind 0.0.0.0]   foreground');
      console.error('  memex-sync sync-server install  [--port 8766] [--bind 0.0.0.0]   durable service');
      console.error('  memex-sync sync-server invite   [--host H] [--port N] [--ttl 600] print pair blob');
      console.error('  memex-sync sync-server invite --join [--ssh-target u@h]           print JOIN token (lazy flow)');
      console.error('  memex-sync sync-server uninstall                                 remove service');
      console.error('  memex-sync sync-server status                                    config + service state');
      process.exit(2);
  }
}

// ── sync-add / sync-list / sync-remove ──────────────────────────────────────

/**
 * `memex-sync sync-add <alias> <url> <bearer> [--insecure] [--cert-fp <fp>]`
 *
 * Registers a remote in ~/.memex/config.json sync.remotes.<alias>.
 *
 * `--insecure` is the tracer-bullet escape hatch — skips TLS cert validation
 * entirely. Use only over SSH tunnel or Tailscale, where transport is
 * already encrypted. v0.12 will require either --cert-fp or pair blob.
 */
export function cmdSyncAdd() {
  refuseUnlessEnabled();
  const alias  = process.argv[3];
  const url    = process.argv[4];
  const bearer = process.argv[5];
  const args   = parseFlags(process.argv.slice(6));

  if (!alias || !url || !bearer) {
    console.error('usage: memex-sync sync-add <alias> <url> <bearer> [--insecure] [--cert-fp <fp>]');
    process.exit(2);
  }
  if (!/^[a-z0-9_-]+$/i.test(alias)) {
    console.error('alias must match [a-zA-Z0-9_-]+');
    process.exit(2);
  }
  if (!/^https?:\/\//.test(url)) {
    console.error('url must start with http:// or https://');
    process.exit(2);
  }
  if (!/^[0-9a-fA-F]{32,}$/.test(bearer)) {
    console.error('bearer must be a hex string (32+ chars)');
    process.exit(2);
  }

  const insecure = '--insecure' in args;
  const cert_fp = args['--cert-fp'] || null;
  if (!insecure && !cert_fp) {
    console.error('refusing to add a remote without --insecure or --cert-fp.');
    console.error('use --insecure if you trust the transport (SSH tunnel / Tailscale)');
    console.error('or pass --cert-fp <sha256:AA:BB:...> to pin the server cert.');
    process.exit(2);
  }

  upsertSyncRemote(alias, {
    url, bearer: bearer.toLowerCase(),
    insecure, cert_fp,
    pulled_to: 0, pushed_to: 0,
    last_sync_at: 0, last_error: null,
  });
  console.log(`✓ remote "${alias}" added (${url}, ${insecure ? 'insecure' : 'pinned'})`);
  process.exit(0);
}

/**
 * `memex-sync sync-pair <memex-pair:...> [--alias vps]`
 *
 * The one-paste counterpart to sync-add: decodes a pair blob (host, port,
 * cert_fp, token) and registers the remote. Validates version + expiry.
 */
export async function cmdSyncPair() {
  refuseUnlessEnabled();
  const blob = process.argv[3];
  const args = parseFlags(process.argv.slice(4));
  if (!blob) {
    console.error('usage: memex-sync sync-pair <memex-pair:...> [--alias <name>]');
    process.exit(2);
  }
  const { parsePairBlob } = await import('./pair.js');
  let parsed;
  try {
    parsed = parsePairBlob(blob);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  const alias = args['--alias'] || 'vps';
  upsertSyncRemote(alias, {
    url: parsed.url,
    bearer: parsed.token.toLowerCase(),
    cert_fp: parsed.cert_fp,
    insecure: !parsed.cert_fp,   // no fingerprint in blob → transport-trusted
    pulled_to: 0, pushed_to: 0,
    last_sync_at: 0, last_error: null,
  });
  console.log(`✓ paired remote "${alias}" → ${parsed.url}`);
  console.log(`  transport: ${parsed.cert_fp ? 'TLS pinned (' + parsed.cert_fp.slice(0, 23) + '…)' : 'insecure (no fingerprint in blob)'}`);
  console.log('');
  console.log('Test it now:   memex-sync sync-run ' + alias);
  console.log('Automate it:   memex-sync sync-schedule install --every 15m');
  process.exit(0);
}

export function cmdSyncList() {
  refuseUnlessEnabled();
  const remotes = listSyncRemotes();
  const keys = Object.keys(remotes);
  if (keys.length === 0) {
    console.log('No remotes configured.');
    console.log('Add one with: memex-sync sync-add <alias> <url> <bearer> --insecure');
    process.exit(0);
  }
  for (const alias of keys) {
    const r = remotes[alias];
    console.log(`${alias}`);
    console.log(`  url:           ${r.url}`);
    console.log(`  pulled_to:     ${r.pulled_to ?? 0}`);
    console.log(`  pushed_to:     ${r.pushed_to ?? 0}`);
    console.log(`  last_sync_at:  ${r.last_sync_at ? new Date(r.last_sync_at).toISOString() : 'never'}`);
    if (r.last_error) console.log(`  last_error:    ${r.last_error}`);
    console.log(`  transport:     ${r.insecure ? 'insecure (skip TLS check)' : 'pinned ' + (r.cert_fp || '?')}`);
    console.log('');
  }
  process.exit(0);
}

export function cmdSyncRemove() {
  refuseUnlessEnabled();
  const alias = process.argv[3];
  if (!alias) {
    console.error('usage: memex-sync sync-remove <alias>');
    process.exit(2);
  }
  const ok = removeSyncRemote(alias);
  console.log(ok ? `✓ removed "${alias}"` : `no remote "${alias}"`);
  process.exit(0);
}

// ── sync-run / sync-status ──────────────────────────────────────────────────

export async function cmdSyncRun() {
  refuseUnlessEnabled();
  const arg = process.argv[3];

  // `--all` syncs every configured remote in sequence. This is what the
  // scheduled timer (sync-schedule) invokes — one tick covers all peers.
  if (arg === '--all') {
    const remotes = Object.keys(listSyncRemotes());
    if (remotes.length === 0) {
      console.log('No remotes configured — nothing to sync.');
      process.exit(0);
    }
    let anyFailed = false;
    for (const alias of remotes) {
      const ok = await runOneRemote(alias);
      if (!ok) anyFailed = true;
    }
    process.exit(anyFailed ? 1 : 0);
  }

  const alias = arg;
  if (!alias) {
    console.error('usage: memex-sync sync-run <alias>   (or --all for every remote)');
    process.exit(2);
  }
  if (!getSyncRemote(alias)) {
    console.error(`no remote "${alias}". configure with sync-add first.`);
    process.exit(2);
  }
  const ok = await runOneRemote(alias);
  process.exit(ok ? 0 : 1);
}

/**
 * Replicate one remote, print a compact report. Returns true on success,
 * false on failure (caller decides exit code — used by both single and --all).
 * Never throws — failures are logged so --all can continue to the next peer.
 */
async function runOneRemote(alias) {
  console.log(`replicating "${alias}"…`);
  try {
    const stats = await replicateOnce({ alias });
    console.log(`✓ peer ${alias} is alive (memex v${stats.peer_version})`);
    console.log(`  pulled  ${stats.pulled.rows} rows · accepted=${stats.pulled.accepted} dedup=${stats.pulled.deduplicated}${stats.pulled.skipped ? ' skipped=' + stats.pulled.skipped : ''}`);
    console.log(`  pushed  ${stats.pushed.rows} rows · accepted=${stats.pushed.accepted} dedup=${stats.pushed.deduplicated}`);
    console.log(`  cursor  pull ${stats.cursors_before.pulled_to}→${stats.cursors_after.pulled_to}  push ${stats.cursors_before.pushed_to}→${stats.cursors_after.pushed_to}  (${stats.elapsed_ms}ms)`);
    return true;
  } catch (err) {
    console.error(`✗ ${alias}: ${err.message}`);
    return false;
  }
}

/**
 * `memex-sync sync-schedule install [--every 15m] | uninstall | status`
 *
 * Registers a recurring timer (LaunchAgent StartInterval on macOS, systemd
 * .timer on Linux) that runs `sync-run --all` every N minutes. This is the
 * Phase 3 deliverable — turns manual sync into hands-off auto-sync.
 */
export async function cmdSyncSchedule() {
  refuseUnlessEnabled();
  const sub = process.argv[3];
  const args = parseFlags(process.argv.slice(4));
  const {
    installSyncSchedule, uninstallSyncSchedule, syncScheduleStatus,
  } = await import('./service.js');

  switch (sub) {
    case 'install': {
      if (Object.keys(listSyncRemotes()).length === 0) {
        console.error('No remotes configured yet — add one before scheduling:');
        console.error('  memex-sync sync-add <alias> <url> <bearer> --cert-fp <fp>');
        process.exit(2);
      }
      const everyMinutes = parseInterval(args['--every']) || 15;
      console.log(`Installing auto-sync schedule (every ${everyMinutes}m)…`);
      try {
        const r = installSyncSchedule({ everyMinutes });
        console.log(`✓ scheduled via ${r.platform === 'darwin' ? 'LaunchAgent' : 'systemd timer'} (every ${r.everyMinutes}m)`);
        console.log(`  unit: ${r.unitPath}`);
        console.log(`  runs: sync-run --all`);
        console.log(`  logs: ~/.memex/data/sync-schedule.{out,err}.log`);
        console.log('');
        console.log('Auto-sync is now hands-off. New conversations propagate within the interval.');
      } catch (e) {
        console.error(`✗ schedule install failed: ${e.message}`);
        process.exit(1);
      }
      process.exit(0);
    }
    case 'uninstall': {
      try {
        const r = uninstallSyncSchedule();
        console.log(`✓ auto-sync schedule removed (${r.unitPath})`);
      } catch (e) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
      }
      process.exit(0);
    }
    case 'status': {
      const st = syncScheduleStatus();
      console.log(`manager:   ${st.manager}`);
      console.log(`installed: ${st.installed ? 'yes' : 'no'}`);
      console.log(`running:   ${st.running ? 'yes' : 'no'}${st.detail ? ' (' + st.detail + ')' : ''}`);
      console.log(`unit:      ${st.unitPath || '(n/a)'}`);
      process.exit(0);
    }
    default:
      console.error('usage:');
      console.error('  memex-sync sync-schedule install [--every 15m]   start hands-off auto-sync');
      console.error('  memex-sync sync-schedule uninstall               stop auto-sync');
      console.error('  memex-sync sync-schedule status                  timer state');
      process.exit(2);
  }
}

export async function cmdSyncStatus() {
  refuseUnlessEnabled();
  const cfg = loadSyncConfig();
  const { syncScheduleStatus } = await import('./service.js');
  console.log('server side:');
  console.log(`  enabled:     ${cfg.server.enabled ? 'yes' : 'no'}`);
  console.log(`  port:        ${cfg.server.port}`);
  console.log(`  bind:        ${cfg.server.bind}`);
  console.log(`  fingerprint: ${cfg.server.cert_fp || '(not generated)'}`);
  console.log('');
  console.log('auto-sync schedule:');
  const sched = syncScheduleStatus();
  console.log(`  installed:   ${sched.installed ? 'yes' : 'no'}`);
  console.log(`  running:     ${sched.running ? 'yes' : 'no'}`);
  console.log('');
  const { syncTunnelStatus, syncWatchdogStatus } = await import('./service.js');
  const tun = syncTunnelStatus();
  console.log('tunnel keeper:');
  if (!tun.installed) {
    console.log('  installed:   no (direct connection or hub side)');
  } else {
    console.log(`  installed:   yes`);
    console.log(`  running:     ${tun.running ? 'yes (self-healing)' : 'NO — check ~/.memex/data/sync-tunnel.err.log'}`);
    if (tun.spec) console.log(`  route:       127.0.0.1:${tun.spec.localPort} → ${tun.spec.sshTarget} → 127.0.0.1:${tun.spec.remotePort}`);
  }
  console.log('');
  const wd = syncWatchdogStatus();
  console.log('watchdog:');
  console.log(`  installed:   ${wd.installed ? 'yes (hourly)' : 'no'}`);
  console.log('');
  console.log('remotes:');
  const remotes = listSyncRemotes();
  const keys = Object.keys(remotes);
  if (keys.length === 0) {
    console.log('  (none configured)');
    process.exit(0);
  }
  const now = Date.now();
  for (const alias of keys) {
    const r = remotes[alias];
    const last = r.last_sync_at
      ? `${new Date(r.last_sync_at).toISOString()} (${Math.round((now - r.last_sync_at) / 60000)}m ago)`
      : 'never';
    console.log(`  ${alias.padEnd(16)} pull→${(r.pulled_to ?? 0).toString().padStart(8)}  push→${(r.pushed_to ?? 0).toString().padStart(8)}`);
    console.log(`  ${' '.repeat(16)} last: ${last}`);
    if (r.last_error) console.log(`  ${' '.repeat(16)} ⚠ ERROR: ${r.last_error}`);
  }
  process.exit(0);
}

// ── sync-join (v0.13) — the lazy-user orchestrator ──────────────────────────

/**
 * `memex-sync sync-join <memex-join:...|memex-pair:...> [--alias vps]
 *     [--local-port N] [--every 15m] [--no-watchdog] [--no-selftest]`
 *
 * One command on the spoke that glues the whole canonical setup together:
 * parse token → SSH probe → durable -L tunnel → verify pinned cert → register
 * remote → first sync → schedule → watchdog → marker self-test → done.
 * Every step is idempotent; re-running replaces the tunnel and re-verifies.
 *
 * Join is the STABLE lazy path: it self-enables the experimental gate for
 * this process and persists sync.enabled=true on success, so the user never
 * has to know MEMEX_SYNC_EXPERIMENTAL exists.
 */
export async function cmdSyncJoin() {
  process.env.MEMEX_SYNC_EXPERIMENTAL = '1';
  const blob = process.argv[3];
  const args = parseFlags(process.argv.slice(4));
  if (!blob) {
    console.error('usage: memex-sync sync-join <memex-join:...> [--alias vps] [--local-port N] [--every 15m] [--no-watchdog] [--no-selftest]');
    console.error('');
    console.error('Get a token from the hub machine (or its agent):');
    console.error('  memex-sync sync-server invite --join');
    process.exit(2);
  }

  const { parsePairBlob } = await import('./pair.js');
  let t;
  try { t = parsePairBlob(blob); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

  const alias = args['--alias'] || 'vps';
  const everyMinutes = parseInterval(args['--every']) || 15;
  const expMin = t.exp ? Math.max(0, Math.round((t.exp * 1000 - Date.now()) / 60000)) : null;
  console.log(`✓ token valid (${t.kind === 'join' ? t.ssh_target : t.host + ':' + t.port}${expMin != null ? `, expires in ${expMin}m` : ''})`);

  let url;
  if (t.kind === 'join') {
    // 1. SSH reachability — the only credential the user might lack.
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new', t.ssh_target, 'true',
    ], { encoding: 'utf-8' });
    if (probe.status !== 0) {
      console.error(`✗ SSH to ${t.ssh_target} failed (${(probe.stderr || '').trim().split('\n')[0] || 'no access'})`);
      console.error('');
      const pub = await ensureSshPubkey();
      if (pub) {
        console.error('Give this public key to the hub machine (its agent can add it');
        console.error('to ~/.ssh/authorized_keys), then re-run the same sync-join command:');
        console.error('');
        console.error(`  ${pub.trim()}`);
      } else {
        console.error('Could not find or generate an SSH key (~/.ssh/id_ed25519).');
      }
      process.exit(2);
    }
    console.log(`✓ SSH access to ${t.ssh_target} — OK`);

    // 2. Durable tunnel. Replace any previous keeper first (frees its port),
    //    then pick a free local port starting from the requested one.
    const { installSyncTunnel, uninstallSyncTunnel, syncTunnelStatus } = await import('./service.js');
    if (syncTunnelStatus().installed) {
      try { uninstallSyncTunnel(); } catch (_) {}
    }
    const wantPort = parseInt(args['--local-port'] || '', 10) || t.port;
    const localPort = await findFreeLocalPort(wantPort);
    if (localPort !== wantPort) console.log(`  (local port ${wantPort} busy — using ${localPort})`);
    installSyncTunnel({ sshTarget: t.ssh_target, localPort, remotePort: t.port });

    // 3. Wait for the keeper's listener to come up.
    const up = await waitForPort(localPort, 15000);
    if (!up) {
      console.error(`✗ tunnel did not come up on 127.0.0.1:${localPort} within 15s.`);
      console.error(`  Check logs: ~/.memex/data/sync-tunnel.err.log`);
      process.exit(1);
    }
    console.log(`✓ self-healing tunnel up (127.0.0.1:${localPort} → ${t.ssh_target} → 127.0.0.1:${t.port})`);
    url = `https://127.0.0.1:${localPort}`;
  } else {
    url = t.url; // plain pair token — direct dial, no tunnel
  }

  // 4. Health + cert-pin verification (the client enforces the fingerprint).
  const { createSyncClient } = await import('./client.js');
  const client = createSyncClient({ url, bearer: t.token, cert_fp: t.cert_fp, insecure: !t.cert_fp });
  let health;
  try { health = await client.health(); }
  catch (e) {
    if (/fingerprint mismatch/i.test(e.message)) {
      console.error(`✗ ${e.message}`);
      console.error('  The token is stale or points at a different server — re-emit it on the hub.');
    } else {
      console.error(`✗ tunnel is up but the sync server didn't answer: ${e.message}`);
      console.error('  On the hub, check:  memex-sync sync-server status');
    }
    process.exit(1);
  }
  console.log(`✓ hub sync-server alive (memex v${health.version}${t.cert_fp ? ', cert pinned' : ''})`);

  // 5. Register remote + first sync.
  upsertSyncRemote(alias, {
    url, bearer: t.token.toLowerCase(), cert_fp: t.cert_fp, insecure: !t.cert_fp,
    pulled_to: 0, pushed_to: 0, last_sync_at: 0, last_error: null,
  });
  const { replicateOnce } = await import('./replicate.js');
  let first;
  try { first = await replicateOnce({ alias, log: () => {} }); }
  catch (e) { console.error(`✗ first sync failed: ${e.message}`); process.exit(1); }
  console.log(`✓ first sync: pulled ${first.pulled.rows} · pushed ${first.pushed.rows} (${(first.elapsed_ms / 1000).toFixed(1)}s)`);

  // 6. Automation + observability.
  const { installSyncSchedule, installSyncWatchdog } = await import('./service.js');
  installSyncSchedule({ everyMinutes });
  console.log(`✓ auto-sync every ${everyMinutes}m installed (survives reboot)`);
  if (!('--no-watchdog' in args)) {
    installSyncWatchdog({});
    console.log('✓ health watchdog installed (hourly; alerts if sync goes silent)');
  }

  // 7. Marker self-test — prove the loop, don't promise it.
  if (!('--no-selftest' in args)) {
    try {
      const st = await joinSelfTest({ alias, client });
      if (st.ok) console.log(`✓ end-to-end verified: a test note round-tripped in ${(st.ms / 1000).toFixed(1)}s`);
      else console.log('⚠ setup complete, but the round-trip was not confirmed within this pass — data may sync on the next cycle. Check: memex-sync sync-status');
    } catch (e) {
      console.log(`⚠ self-test skipped (${e.message}) — sync itself succeeded.`);
    }
  }

  const { markSyncEnabled } = await import('./config.js');
  markSyncEnabled();
  console.log('');
  console.log(`Done. Memory now syncs with "${alias}" automatically.`);
  console.log('Check anytime:  memex-sync sync-status');
  process.exit(0);
}

/**
 * Self-test: write a marker locally, sync, then pull from the hub PAST the
 * pre-push cursor and confirm the hub serves the marker back. Wire-level
 * proof that data round-trips — the same check we ran by hand on the live
 * mesh, now built in. The marker conversation is archived locally so it
 * never pollutes listings.
 */
async function joinSelfTest({ alias, client }) {
  const Database = (await import('better-sqlite3')).default;
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const dbPath = join(process.env.MEMEX_DIR || join(homedir(), '.memex'), 'data', 'memex.db');

  const ts = Math.floor(Date.now() / 1000);
  const text = `MEMEX-SYNC-SELFTEST-${Date.now()}-${process.pid}`;
  const CONV = 'memex-sync-selftest';

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  db.prepare(`INSERT OR IGNORE INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, archived_at)
              VALUES (?,?,?,?,?,0,?)`)
    .run(CONV, 'sync-selftest', 'memex sync self-test', ts, ts, ts);
  db.prepare(`INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts)
              VALUES (?,?,?,?,?,?,?)`)
    .run('sync-selftest', CONV, `st-${Date.now()}-${process.pid}`, 'user', 'sync-selftest', text, ts);
  db.close();

  const t0 = Date.now();
  const { replicateOnce } = await import('./replicate.js');
  const stats = await replicateOnce({ alias, log: () => {} });
  // Pull happens before push inside replicateOnce, so pulled_to is the hub's
  // max id BEFORE our marker landed — pulling past it must return the marker.
  const page = await client.pull({ since: stats.cursors_after.pulled_to, limit: 500 });
  const found = Array.isArray(page.rows) && page.rows.some((r) => r.text === text);
  return { ok: found && stats.pushed.accepted >= 1, ms: Date.now() - t0 };
}

/** Ensure ~/.ssh/id_ed25519 exists (generate passphrase-less if absent); return the pubkey line. */
async function ensureSshPubkey() {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { existsSync, readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const priv = join(homedir(), '.ssh', 'id_ed25519');
  const pub = priv + '.pub';
  if (!existsSync(pub)) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', priv, '-q'], { encoding: 'utf-8' });
    if (r.status !== 0) return null;
  }
  try { return readFileSync(pub, 'utf-8'); } catch (_) { return null; }
}

/** First free local port at or after `start` (bind-test on 127.0.0.1). */
async function findFreeLocalPort(start) {
  const net = await import('node:net');
  const tryPort = (p) => new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
  });
  for (let p = start; p < start + 34; p++) {
    if (await tryPort(p)) return p;
  }
  throw new Error(`no free local port in ${start}–${start + 33}`);
}

/** Poll until something accepts TCP on 127.0.0.1:port, or timeout. */
async function waitForPort(port, timeoutMs) {
  const net = await import('node:net');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise((res) => {
      const c = net.connect({ host: '127.0.0.1', port, timeout: 1000 });
      c.once('connect', () => { c.destroy(); res(true); });
      c.once('error', () => res(false));
      c.once('timeout', () => { c.destroy(); res(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── sync-watchdog (v0.13) — detect silent sync failure ──────────────────────

/**
 * `memex-sync sync-watchdog [--threshold-min 60]`
 *
 * One read-only health pass: every remote's last_sync_at must be fresher than
 * the threshold, and the tunnel keeper (if installed) must be running.
 * Problems → ~/.memex/sync-alert.txt + a desktop notification + exit 1.
 * Healthy → alert file removed, line appended to the log, exit 0.
 *
 * Deliberately NOT gated behind the experimental flag: it's read-only, and it
 * must keep working from the hourly timer no matter what shell env the user has.
 */
export async function cmdSyncWatchdog() {
  const args = parseFlags(process.argv.slice(3));
  const thresholdMin = parseInt(args['--threshold-min'] || '', 10) || 60;
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const MEMEX_DIR = process.env.MEMEX_DIR || join(homedir(), '.memex');
  const alertPath = join(MEMEX_DIR, 'sync-alert.txt');
  const logPath = join(MEMEX_DIR, 'data', 'sync-watchdog.log');
  mkdirSync(join(MEMEX_DIR, 'data'), { recursive: true });
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const problems = [];
  const remotes = listSyncRemotes();
  const aliases = Object.keys(remotes);
  if (aliases.length === 0) {
    appendFileSync(logPath, `${stamp} OK — no remotes configured, nothing to watch\n`);
    console.log('no remotes configured — nothing to watch.');
    process.exit(0);
  }
  const now = Date.now();
  for (const alias of aliases) {
    const r = remotes[alias];
    if (!r.last_sync_at) { problems.push(`${alias}: never synced`); continue; }
    const ageMin = Math.round((now - r.last_sync_at) / 60000);
    if (ageMin > thresholdMin) {
      problems.push(`${alias}: sync silent for ${ageMin}m (threshold ${thresholdMin}m)` +
        (r.last_error ? ` — last error: ${r.last_error}` : ''));
    }
  }
  const { syncTunnelStatus } = await import('./service.js');
  const tun = syncTunnelStatus();
  if (tun.installed && !tun.running) problems.push('tunnel keeper installed but not running');

  if (problems.length === 0) {
    if (existsSync(alertPath)) { try { unlinkSync(alertPath); } catch (_) {} }
    appendFileSync(logPath, `${stamp} OK — all sync legs fresh\n`);
    console.log('✓ all sync legs fresh');
    process.exit(0);
  }

  const summary = problems.join('; ');
  appendFileSync(logPath, `${stamp} ALARM — ${summary}\n`);
  writeFileSync(alertPath, `memex sync watchdog — PROBLEM (${stamp}):\n` +
    problems.map((p) => `  - ${p}`).join('\n') +
    `\n\nDiagnose:  memex-sync sync-status\nLog:       ${logPath}\n`);
  // Best-effort desktop notification — never fail the pass over it.
  try {
    if (process.platform === 'darwin') {
      spawnSync('osascript', ['-e',
        `display notification ${JSON.stringify(summary.slice(0, 120))} with title "memex sync: problem" sound name "Basso"`]);
    } else if (process.platform === 'linux') {
      spawnSync('notify-send', ['memex sync: problem', summary.slice(0, 200)]);
    }
  } catch (_) {}
  console.error(`✗ ${summary}`);
  console.error(`  details: ${alertPath}`);
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Crude flag parser — collects --flag and --flag value pairs. */
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) { out[a] = next; i++; }
    else { out[a] = true; }
  }
  return out;
}

/**
 * Best-effort public-IP detection for `sync-server invite`. Returns the IP
 * string or null. Uses a 4s-timeout fetch to a couple of echo services.
 * Node 20+ has global fetch.
 */
async function detectPublicIp() {
  const endpoints = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  for (const url of endpoints) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^[0-9.]+$/.test(ip) || /^[0-9a-f:]+$/i.test(ip)) return ip;
    } catch (_) { /* try next */ }
  }
  return null;
}

/**
 * Parse an interval like "15m", "30m", "1h", "900s", or bare "15" (minutes)
 * into a whole number of MINUTES. Returns null if unparseable.
 */
function parseInterval(v) {
  if (v == null || v === true) return null;
  const s = String(v).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|hour)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] || 'm';
  let minutes;
  if (unit.startsWith('s')) minutes = n / 60;
  else if (unit.startsWith('h')) minutes = n * 60;
  else minutes = n; // m / min / bare
  const rounded = Math.max(1, Math.round(minutes));
  return rounded;
}
