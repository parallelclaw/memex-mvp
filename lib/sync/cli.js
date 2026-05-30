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
    case 'status': {
      const cfg = loadSyncConfig();
      console.log(`enabled in config:  ${cfg.server.enabled ? 'yes' : 'no'}`);
      console.log(`port:               ${cfg.server.port}`);
      console.log(`bind:               ${cfg.server.bind}`);
      console.log(`cert fingerprint:   ${cfg.server.cert_fp || '(not generated yet)'}`);
      console.log(`bearer:             ${cfg.server.bearer ? '(configured)' : '(none)'}`);
      console.log('');
      console.log('Server runs in foreground via `memex-sync sync-server start`.');
      console.log('Background daemonisation lands in v0.12.');
      process.exit(0);
    }
    default:
      console.error('usage:');
      console.error('  memex-sync sync-server start [--port 8765] [--bind 0.0.0.0]');
      console.error('  memex-sync sync-server status');
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
  const alias = process.argv[3];
  if (!alias) {
    console.error('usage: memex-sync sync-run <alias>');
    process.exit(2);
  }
  if (!getSyncRemote(alias)) {
    console.error(`no remote "${alias}". configure with sync-add first.`);
    process.exit(2);
  }

  console.log(`replicating "${alias}"…`);
  try {
    const stats = await replicateOnce({ alias });
    console.log('');
    console.log(`✓ peer ${alias} is alive (memex v${stats.peer_version})`);
    console.log(`  pulled  ${stats.pulled.rows} rows in ${stats.pulled.batches} batch(es)`);
    console.log(`          accepted=${stats.pulled.accepted}  dedup=${stats.pulled.deduplicated}`);
    console.log(`  pushed  ${stats.pushed.rows} rows in ${stats.pushed.batches} batch(es)`);
    console.log(`          accepted=${stats.pushed.accepted}  dedup=${stats.pushed.deduplicated}`);
    console.log(`  cursor  pull ${stats.cursors_before.pulled_to} → ${stats.cursors_after.pulled_to}`);
    console.log(`          push ${stats.cursors_before.pushed_to} → ${stats.cursors_after.pushed_to}`);
    console.log(`  total   ${stats.elapsed_ms}ms`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ replication failed: ${err.message}`);
    process.exit(1);
  }
}

export function cmdSyncStatus() {
  refuseUnlessEnabled();
  const cfg = loadSyncConfig();
  console.log('server side:');
  console.log(`  enabled:     ${cfg.server.enabled ? 'yes' : 'no'}`);
  console.log(`  port:        ${cfg.server.port}`);
  console.log(`  bind:        ${cfg.server.bind}`);
  console.log(`  fingerprint: ${cfg.server.cert_fp || '(not generated)'}`);
  console.log('');
  console.log('remotes:');
  const remotes = listSyncRemotes();
  const keys = Object.keys(remotes);
  if (keys.length === 0) {
    console.log('  (none configured)');
    process.exit(0);
  }
  for (const alias of keys) {
    const r = remotes[alias];
    const last = r.last_sync_at ? new Date(r.last_sync_at).toISOString() : 'never';
    console.log(`  ${alias.padEnd(16)} pull→${(r.pulled_to ?? 0).toString().padStart(7)}  push→${(r.pushed_to ?? 0).toString().padStart(7)}  last:${last}`);
    if (r.last_error) console.log(`  ${' '.repeat(16)} ERROR: ${r.last_error}`);
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
