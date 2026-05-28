/**
 * HTTPS server for memex sync (v0.11.11 experimental).
 *
 * Spawned in-process by `memex sync server enable` (long-lived) or by
 * integration tests (one-shot, bound to ephemeral port). NOT part of the
 * MCP server — sync runs on its own port so MCP stdio clients aren't
 * affected and the sync surface can be deployed independently.
 *
 * Routes implemented in Day 2 (Day 3+ adds /sync/push, /sync/pull):
 *   GET  /sync/health   — version + schema_version + row counts (auth required)
 *   *    /              — 404
 *
 * Why no Express/Fastify: zero new deps; Node's built-in https is sufficient
 * for our 3-endpoint surface. We add a tiny route table inline.
 *
 * Cert handling: ensureCert() is idempotent — first launch generates a
 * self-signed cert; subsequent launches reuse it so paired clients don't
 * silently break. Use `memex sync rotate-cert` for an explicit rotation.
 */

import { createServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { ensureCert } from './cert.js';
import { requireBearer, generateBearerToken } from './auth.js';
import { updateSyncServer, loadSyncConfig } from './config.js';
import { makePushHandler } from './push.js';
import { makePullHandler } from './pull.js';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DEFAULT_DB_PATH = join(MEMEX_DIR, 'data', 'memex.db');
const DEFAULT_CERT_PATH = join(MEMEX_DIR, 'sync-cert.pem');
const DEFAULT_KEY_PATH  = join(MEMEX_DIR, 'sync-key.pem');

/** Wire-protocol schema version. Must match SYNC.md. */
export const SYNC_SCHEMA_VERSION = 12;

/** Default port, overridable via opts.port or sync.server.port config. */
export const DEFAULT_SYNC_PORT = 8765;

/**
 * Start an HTTPS sync server. Returns a Promise<{server, port, fingerprint, bearer}>.
 *
 * opts:
 *   port      — int; defaults to config.sync.server.port or DEFAULT_SYNC_PORT
 *   bind      — string; defaults to config.sync.server.bind or '0.0.0.0'
 *   dbPath    — string; defaults to ~/.memex/data/memex.db
 *   certPath  — string; defaults to ~/.memex/sync-cert.pem
 *   keyPath   — string; defaults to ~/.memex/sync-key.pem
 *   bearer    — string; if omitted, reuses config.sync.server.bearer
 *                or generates a new one (persisted)
 *   ephemeral — bool; if true, port=0 (OS-assigned), nothing persisted
 *                to config. Used by tests.
 *   onListen  — optional callback fired once listening, args: {port, fingerprint}
 *
 * Idempotency: calling twice with the same opts is fine — cert is reused
 * (ensureCert), bearer reused (if already in config), server just rebinds.
 *
 * Shutdown: call .close() on the returned server.
 */
export async function startSyncServer(opts = {}) {
  const cfg = loadSyncConfig();
  const port = opts.port ?? (opts.ephemeral ? 0 : (cfg.server.port || DEFAULT_SYNC_PORT));
  const bind = opts.bind ?? (cfg.server.bind || '0.0.0.0');
  const dbPath   = opts.dbPath   ?? DEFAULT_DB_PATH;
  const certPath = opts.certPath ?? (cfg.server.cert_path || DEFAULT_CERT_PATH);
  const keyPath  = opts.keyPath  ?? (cfg.server.key_path  || DEFAULT_KEY_PATH);

  // 1. Cert — generate if missing, otherwise reuse.
  const certInfo = await ensureCert({ certPath, keyPath });

  // 2. Bearer — caller can override; otherwise reuse persisted or mint new.
  let bearer = opts.bearer ?? cfg.server.bearer;
  let bearerMinted = false;
  if (!bearer) {
    bearer = generateBearerToken();
    bearerMinted = true;
  }

  // 3. DB handle — read-write since Day 3 (push writes). WAL mode (set by
  //    the install path) lets the daemon's writer and this server coexist
  //    without locking each other.
  if (!existsSync(dbPath)) {
    throw new Error(`Sync server: DB not found at ${dbPath}. Run \`memex-sync install\` first.`);
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // 4. Persist config (unless ephemeral test mode).
  if (!opts.ephemeral) {
    updateSyncServer({
      enabled:   true,
      port,
      bind,
      bearer,                // store back what we have, including freshly minted
      cert_path: certPath,
      key_path:  keyPath,
      cert_fp:   certInfo.fingerprint,
    });
  }

  // 5. Construct HTTPS server. Cert + key passed as PEM strings via TLS opts.
  const tlsOpts = {
    cert: readFileSync(certPath),
    key:  readFileSync(keyPath),
  };

  // Build handlers once at server-start — they each pre-compile their
  // prepared statements and reuse them per request.
  const pushHandler = makePushHandler({ db });
  const pullHandler = makePullHandler({ db });

  const server = createServer(tlsOpts, (req, res) => {
    handleRequest(req, res, { db, bearer, pushHandler, pullHandler });
  });

  // 6. Bind + return when listening.
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      const actualPort = server.address().port;
      const result = {
        server,
        port: actualPort,
        fingerprint: certInfo.fingerprint,
        bearer,
        bearerMinted,
      };
      if (typeof opts.onListen === 'function') {
        try { opts.onListen({ port: actualPort, fingerprint: certInfo.fingerprint }); }
        catch (_) { /* user callback errors don't break the server */ }
      }
      // Patch close to also close the DB handle.
      const originalClose = server.close.bind(server);
      server.close = (cb) => {
        try { db.close(); } catch (_) {}
        originalClose(cb);
      };
      resolve(result);
    });
  });
}

/**
 * Top-level request dispatcher. Routes by method + path. Day 2 surface:
 *   GET  /sync/health     — auth required, version + schema + row counts
 *   anything else         — 404
 *
 * Day 3+ adds /sync/push and /sync/pull here.
 */
function handleRequest(req, res, ctx) {
  // Default headers — JSON everywhere
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Crude routing — fine for a 3-endpoint surface. If we ever hit 6+
  // routes we'll switch to a small router.
  const url = new URL(req.url, 'https://placeholder.local');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/sync/health') {
    if (!requireBearer(req, res, ctx.bearer)) return;
    return handleHealth(req, res, ctx);
  }
  if (req.method === 'POST' && path === '/sync/push') {
    if (!requireBearer(req, res, ctx.bearer)) return;
    return ctx.pushHandler(req, res);
  }
  if (req.method === 'GET' && path === '/sync/pull') {
    if (!requireBearer(req, res, ctx.bearer)) return;
    return ctx.pullHandler(req, res);
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found' }));
}

function handleHealth(req, res, ctx) {
  try {
    // Cheap counts — both queried via the read-only handle, no FTS5 hit.
    const rowCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    const lastIdRow = ctx.db.prepare('SELECT MAX(id) AS last_id FROM messages').get();
    const lastId = lastIdRow?.last_id ?? 0;

    res.statusCode = 200;
    res.end(JSON.stringify({
      version: getMemexVersion(),
      schema_version: SYNC_SCHEMA_VERSION,
      row_count: rowCount,
      last_id: lastId,
    }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'internal', detail: String(err.message || err) }));
  }
}

/**
 * Read the running memex-mvp version from its package.json. Best-effort —
 * if we can't resolve it (e.g. weird install layout), report "unknown".
 */
let _cachedVersion = null;
function getMemexVersion() {
  if (_cachedVersion) return _cachedVersion;
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf-8'));
    _cachedVersion = pkg.version || 'unknown';
  } catch (_) {
    _cachedVersion = 'unknown';
  }
  return _cachedVersion;
}
