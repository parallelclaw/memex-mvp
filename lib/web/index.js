/**
 * memex web dashboard — HTTP server.
 *
 * Opt-in: invoked via `memex web` CLI command. Binds 127.0.0.1 by default.
 * Read-only by design (only POST endpoints are pending review actions).
 *
 * Stack:
 *   • Node.js raw http module (no Express, no framework)
 *   • Tagged template literals for HTML
 *   • htmx for client-side reactivity (from CDN)
 *   • Better-sqlite3 read-only DB handle
 *
 * Routes:
 *   GET  /                         → dashboard
 *   GET  /conversations            → list + search
 *   GET  /conversations/search     → htmx partial
 *   GET  /c/:id                    → full transcript
 *   GET  /pending                  → telegram exports awaiting decision
 *   POST /pending/import           → import selected
 *   POST /pending/skip             → skip selected
 *   GET  /settings                 → daemon status, sources, hooks
 *   GET  /static/<file>            → static assets (CSS, etc)
 *   GET  /api/health               → JSON liveness probe
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, 'static');

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
const DB_PATH = join(MEMEX_DIR, 'data', 'memex.db');

// ----- Helpers -----

function send(res, status, body, contentType = 'text/html; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8');
}

function notFound(res) {
  send(res, 404, '<h1>404 — not in memex</h1><p><a href="/">back to dashboard</a></p>');
}

function serverError(res, e) {
  console.error('[memex web] error:', e);
  send(res, 500, `<h1>500 — server error</h1><pre>${escapeHtml(e.message || String(e))}</pre>`);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Parse the URL into { pathname, query }
function parseUrl(url) {
  const i = url.indexOf('?');
  if (i === -1) return { pathname: url, query: {} };
  const pathname = url.slice(0, i);
  const queryStr = url.slice(i + 1);
  const query = {};
  for (const pair of queryStr.split('&')) {
    if (!pair) continue;
    const [k, v] = pair.split('=');
    query[decodeURIComponent(k)] = v != null ? decodeURIComponent(v.replace(/\+/g, ' ')) : '';
  }
  return { pathname, query };
}

// ----- Static file serving (CSS, etc) -----

const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname.replace(/^\/static\//, '').replace(/\.\./g, '');
  const full = join(STATIC_DIR, rel);
  if (!existsSync(full)) return notFound(res);
  const ext = full.slice(full.lastIndexOf('.'));
  const type = STATIC_TYPES[ext] || 'application/octet-stream';
  const body = readFileSync(full);
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(body);
}

// ----- DB handle (read-only) -----

let _db = null;
function getDb() {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) {
    throw new Error(`memex.db not found at ${DB_PATH}. Run 'memex-sync install' first.`);
  }
  _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}

// ----- Sync status (daemon health) -----

function getDaemonStatus() {
  try {
    // Inline check — read the LaunchAgent plist + try to ps the daemon
    const plistPath = join(HOME, 'Library/LaunchAgents/com.parallelclaw.memex.sync.plist');
    const installed = existsSync(plistPath);
    if (!installed) return { installed: false, running: false, lastCaptureMs: null };

    // Recent activity from ingest.log
    const logPath = join(MEMEX_DIR, 'data', 'ingest.log');
    let lastCaptureMs = null;
    if (existsSync(logPath)) {
      const ageMs = Date.now() - statSync(logPath).mtimeMs;
      lastCaptureMs = ageMs;
    }

    // Process check via launchctl (best effort)
    let running = false;
    try {
      const out = execSync('launchctl list | grep com.parallelclaw.memex.sync', { encoding: 'utf-8', timeout: 1000 });
      running = !out.match(/^\s*-\s/m); // "-" means not running
    } catch (_) { /* not running */ }

    return { installed: true, running, lastCaptureMs };
  } catch (_) {
    return { installed: false, running: false, lastCaptureMs: null };
  }
}

// ----- Read-only auth (optional bearer token) -----

function checkAuth(req, expectedToken) {
  if (!expectedToken) return true; // no auth required
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${expectedToken}`;
}

// ----- Request handler -----

async function handleRequest(req, res, opts) {
  const { pathname, query } = parseUrl(req.url);

  // Static files (no auth required)
  if (pathname.startsWith('/static/')) {
    return serveStatic(res, pathname);
  }

  // Health check (no auth required, used by tests)
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, db: existsSync(DB_PATH) });
  }

  // Auth check
  if (!checkAuth(req, opts.token)) {
    return send(res, 401, '<h1>401 — auth required</h1><p>Pass <code>--token</code> when starting <code>memex web</code> and include <code>Authorization: Bearer &lt;token&gt;</code></p>');
  }

  try {
    // Route dispatch
    if (pathname === '/') {
      const { renderDashboard } = await import('./routes/dashboard.js');
      return send(res, 200, await renderDashboard(getDb(), getDaemonStatus()));
    }
    if (pathname === '/conversations') {
      const { renderConversations } = await import('./routes/conversations.js');
      return send(res, 200, await renderConversations(getDb(), query, getDaemonStatus()));
    }
    if (pathname === '/conversations/search') {
      const { renderConversationsPartial } = await import('./routes/conversations.js');
      return send(res, 200, await renderConversationsPartial(getDb(), query));
    }
    if (pathname.startsWith('/c/')) {
      const { renderConversation } = await import('./routes/conversation.js');
      const id = decodeURIComponent(pathname.slice(3));
      return send(res, 200, await renderConversation(getDb(), id, query, getDaemonStatus()));
    }
    if (pathname === '/pending') {
      const { renderPending } = await import('./routes/pending.js');
      return send(res, 200, await renderPending(getDaemonStatus()));
    }
    if (pathname === '/pending/import' && req.method === 'POST') {
      const { handleImport } = await import('./routes/pending.js');
      const body = await readBody(req);
      return send(res, 200, await handleImport(body));
    }
    if (pathname === '/pending/skip' && req.method === 'POST') {
      const { handleSkip } = await import('./routes/pending.js');
      const body = await readBody(req);
      return send(res, 200, await handleSkip(body));
    }
    if (pathname === '/settings') {
      const { renderSettings } = await import('./routes/settings.js');
      return send(res, 200, await renderSettings(getDb(), getDaemonStatus()));
    }
    return notFound(res);
  } catch (e) {
    return serverError(res, e);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      // Parse form-encoded body
      const params = {};
      for (const pair of raw.split('&')) {
        if (!pair) continue;
        const [k, v] = pair.split('=');
        const key = decodeURIComponent(k);
        const val = v != null ? decodeURIComponent(v.replace(/\+/g, ' ')) : '';
        // Handle repeated keys (e.g., index=1&index=3 → array)
        if (key in params) {
          params[key] = Array.isArray(params[key]) ? [...params[key], val] : [params[key], val];
        } else {
          params[key] = val;
        }
      }
      resolve(params);
    });
    req.on('error', reject);
  });
}

// ----- Public entry point -----

export function startServer({ port = 8765, host = '127.0.0.1', token = null, open = false } = {}) {
  const server = createServer((req, res) => {
    handleRequest(req, res, { token }).catch((e) => serverError(res, e));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
      console.log(`memex web listening on ${url}`);
      if (token) console.log(`  auth: bearer token required (Authorization: Bearer ${token})`);
      if (open) {
        // Best-effort open browser on macOS / Linux
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch (_) {}
      }
      resolve({ server, url });
    });
  });
}
