/**
 * Day 2 smoke test for lib/sync/server.js.
 *
 * Verifies:
 *   1. ensureCert generates a real PEM + SHA-256 fingerprint on first call,
 *      reuses them on second call.
 *   2. generateBearerToken yields 64-hex chars, two calls differ.
 *   3. parseAuthHeader / tokensMatch return the expected booleans.
 *   4. startSyncServer({ephemeral: true}) binds an OS-assigned HTTPS port,
 *      responds 401 without auth on /sync/health, 200 with valid token,
 *      404 on unknown route.
 *
 * Runs against a temp ~/.memex dir (via MEMEX_DIR env var) so it doesn't
 * touch the user's real config or DB.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';

// Per-test isolated MEMEX_DIR. Must be set BEFORE importing modules that
// resolve paths from it (lib/sync/config.js reads process.env.MEMEX_DIR).
const TMP = mkdtempSync(join(tmpdir(), 'memex-sync-test-'));
process.env.MEMEX_DIR = TMP;

// Create the DB the server expects, using the real schema (the server's
// push handler prepares statements at start-up that require the full
// columns from db-init, not just a synthetic two-column messages table).
const { initializeDb } = await import('../../lib/db-init.js');
const dbDir = join(TMP, 'data');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'memex.db');
{
  const db = initializeDb(dbPath);
  db.prepare(`INSERT INTO messages (source, conversation_id, msg_id, role, text, ts)
              VALUES ('test', 'c', 'm1', 'user', 'hello', 1700000000)`).run();
  db.prepare(`INSERT INTO messages (source, conversation_id, msg_id, role, text, ts)
              VALUES ('test', 'c', 'm2', 'assistant', 'world', 1700000001)`).run();
  db.close();
}

// Now import — modules pick up MEMEX_DIR.
const { ensureCert, sha256FingerprintFromFile, fingerprintsMatch } = await import('../../lib/sync/cert.js');
const { generateBearerToken, parseAuthHeader, tokensMatch } = await import('../../lib/sync/auth.js');
const { startSyncServer } = await import('../../lib/sync/server.js');
const { syncExperimentEnabled, loadSyncConfig } = await import('../../lib/sync/config.js');

let failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    });
}

console.log('cert.js:');
await t('ensureCert generates a new cert on first call', async () => {
  const certPath = join(TMP, 'sync-cert.pem');
  const keyPath  = join(TMP, 'sync-key.pem');
  const info = await ensureCert({ certPath, keyPath });
  assert.equal(info.reused, false, 'first call should not reuse');
  assert.ok(existsSync(certPath), 'cert file should exist');
  assert.ok(existsSync(keyPath),  'key file should exist');
  assert.match(info.fingerprint, /^sha256:([A-F0-9]{2}:){31}[A-F0-9]{2}$/, 'fingerprint shape');
});

await t('ensureCert reuses cert on second call', async () => {
  const certPath = join(TMP, 'sync-cert.pem');
  const keyPath  = join(TMP, 'sync-key.pem');
  const info1 = await ensureCert({ certPath, keyPath });
  const info2 = await ensureCert({ certPath, keyPath });
  assert.equal(info2.reused, true, 'second call should reuse');
  assert.equal(info1.fingerprint, info2.fingerprint, 'fingerprint must be identical');
});

await t('sha256FingerprintFromFile matches ensureCert output', async () => {
  const certPath = join(TMP, 'sync-cert.pem');
  const keyPath  = join(TMP, 'sync-key.pem');
  const info = await ensureCert({ certPath, keyPath });
  const fp = sha256FingerprintFromFile(certPath);
  assert.ok(fingerprintsMatch(info.fingerprint, fp), 'fingerprints should match');
});

await t('fingerprintsMatch tolerates formatting variations', () => {
  const a = 'sha256:AB:CD:EF:01:23:45:67:89:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77';
  const b = 'abcdef0123456789001122334455667788 99 aa bb cc dd ee ff 00 11 22 33 44 55 66 77';
  assert.equal(fingerprintsMatch(a, b), true, 'should match across formats');
});

console.log('auth.js:');
await t('generateBearerToken yields 64-hex chars, two calls differ', () => {
  const a = generateBearerToken();
  const b = generateBearerToken();
  assert.match(a, /^[0-9a-f]{64}$/, 'a is 64-hex');
  assert.match(b, /^[0-9a-f]{64}$/, 'b is 64-hex');
  assert.notEqual(a, b, 'tokens should differ');
});

await t('parseAuthHeader handles Bearer prefix and trims', () => {
  assert.equal(parseAuthHeader('Bearer abc123def'), 'abc123def');
  assert.equal(parseAuthHeader('Bearer  ABC123DEF  '), 'abc123def');
  assert.equal(parseAuthHeader('Basic abc'), null);
  assert.equal(parseAuthHeader(''), null);
  assert.equal(parseAuthHeader(undefined), null);
});

await t('tokensMatch is constant-time and forgiving', () => {
  const tok = generateBearerToken();
  assert.equal(tokensMatch(tok, tok), true);
  assert.equal(tokensMatch(tok, tok.slice(0, -2) + '00'), false);
  assert.equal(tokensMatch(tok, 'short'), false);
  assert.equal(tokensMatch('', tok), false);
  assert.equal(tokensMatch(tok, 'not-hex-at-all'), false);
});

console.log('config.js:');
await t('syncExperimentEnabled reads env var', () => {
  delete process.env.MEMEX_SYNC_EXPERIMENTAL;
  assert.equal(syncExperimentEnabled(), false);
  process.env.MEMEX_SYNC_EXPERIMENTAL = '1';
  assert.equal(syncExperimentEnabled(), true);
  process.env.MEMEX_SYNC_EXPERIMENTAL = 'true';
  assert.equal(syncExperimentEnabled(), true);
  process.env.MEMEX_SYNC_EXPERIMENTAL = 'no';
  assert.equal(syncExperimentEnabled(), false);
  delete process.env.MEMEX_SYNC_EXPERIMENTAL;
});

console.log('server.js:');
let runningServer = null;
let serverPort = null;
let serverBearer = null;
let serverFingerprint = null;

await t('startSyncServer binds an ephemeral port and persists nothing', async () => {
  const result = await startSyncServer({
    ephemeral: true,
    port: 0,
    bind: '127.0.0.1',
    dbPath,
    certPath: join(TMP, 'sync-cert.pem'),
    keyPath:  join(TMP, 'sync-key.pem'),
  });
  assert.ok(result.server, 'server returned');
  assert.ok(result.port > 0, 'port assigned');
  assert.ok(result.bearer && result.bearer.length === 64, 'bearer minted (64 hex)');
  assert.ok(result.fingerprint.startsWith('sha256:'), 'fingerprint present');
  runningServer = result.server;
  serverPort = result.port;
  serverBearer = result.bearer;
  serverFingerprint = result.fingerprint;

  // ephemeral=true must NOT have persisted to config
  const cfg = loadSyncConfig();
  assert.notEqual(cfg.server.bearer, result.bearer, 'ephemeral should not persist bearer');
});

await t('GET /sync/health without auth returns 401', async () => {
  const { status, body } = await httpsGet({
    port: serverPort,
    path: '/sync/health',
    fingerprint: serverFingerprint,
  });
  assert.equal(status, 401);
  assert.equal(JSON.parse(body).error, 'unauthorized');
});

await t('GET /sync/health with valid token returns 200 + version/row_count/last_id', async () => {
  const { status, body } = await httpsGet({
    port: serverPort,
    path: '/sync/health',
    fingerprint: serverFingerprint,
    bearer: serverBearer,
  });
  assert.equal(status, 200);
  const parsed = JSON.parse(body);
  assert.ok(parsed.version, 'version field present');
  assert.equal(parsed.schema_version, 12, 'schema_version is 12');
  assert.equal(parsed.row_count, 2, 'matches seeded rows');
  assert.equal(parsed.last_id, 2, 'last id matches');
});

await t('GET /unknown returns 404', async () => {
  const { status, body } = await httpsGet({
    port: serverPort,
    path: '/nope',
    fingerprint: serverFingerprint,
    bearer: serverBearer,
  });
  assert.equal(status, 404);
  assert.equal(JSON.parse(body).error, 'not_found');
});

if (runningServer) {
  await new Promise((resolve) => runningServer.close(resolve));
}

// Cleanup temp dir.
rmSync(TMP, { recursive: true, force: true });

console.log(failed === 0 ? '\nAll Day 2 smoke checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

/**
 * Minimal HTTPS GET that ignores cert validation (since we're talking to
 * a self-signed test server). In real client code we'd verify against the
 * pinned fingerprint — that's Day 5's job.
 */
function httpsGet({ port, path, bearer, fingerprint }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      rejectUnauthorized: false, // self-signed; pin via fingerprint instead
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
