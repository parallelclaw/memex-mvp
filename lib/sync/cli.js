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
      const { encodePairBlob, DEFAULT_PAIR_TTL_SEC } = await import('./pair.js');
      const { homedir } = await import('node:os');
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
