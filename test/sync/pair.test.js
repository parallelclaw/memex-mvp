/**
 * Phase 4 test: pair blob encode/parse.
 *
 * Verifies the round trip, the "memex-pair:" framing, base64url safety,
 * version gating, expiry enforcement, and friendly errors on corruption.
 */

import assert from 'node:assert/strict';
import { encodePairBlob, parsePairBlob, PAIR_PREFIX, PAIR_VERSION } from '../../lib/sync/pair.js';

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const FP = 'sha256:74:0A:C1:4E:01:27:40:AA:0F:B0:1D:A4:AE:5B:7E:52:88:B5:84:93:17:DC:7D:47:E5:85:8B:62:2B:49:4F:20';
const TOKEN = '3d90ee425fc2969647bc105a151db0216664f34fff0f7eec3a1f6015e353903a';

console.log('pair blob:');

t('round trip preserves host/port/cert_fp/token', () => {
  const blob = encodePairBlob({ host: '82.22.38.245', port: 8766, cert_fp: FP, token: TOKEN });
  const p = parsePairBlob(blob);
  assert.equal(p.host, '82.22.38.245');
  assert.equal(p.port, 8766);
  assert.equal(p.cert_fp, FP);
  assert.equal(p.token, TOKEN);
  assert.equal(p.url, 'https://82.22.38.245:8766');
});

t('has memex-pair: prefix and is base64url-safe (no + / =)', () => {
  const blob = encodePairBlob({ host: 'h', token: TOKEN });
  assert.ok(blob.startsWith(PAIR_PREFIX));
  const body = blob.slice(PAIR_PREFIX.length);
  assert.doesNotMatch(body, /[+/=]/, 'base64url must not contain + / =');
});

t('defaults port to 8766', () => {
  const p = parsePairBlob(encodePairBlob({ host: 'h', token: TOKEN }));
  assert.equal(p.port, 8766);
});

t('cert_fp null (transport-trusted) round-trips as null', () => {
  const p = parsePairBlob(encodePairBlob({ host: 'localhost', token: TOKEN, cert_fp: null }));
  assert.equal(p.cert_fp, null);
});

t('rejects a blob without the prefix', () => {
  assert.throws(() => parsePairBlob('eyJ2IjoxfQ'), /must start with/);
});

t('rejects corrupt base64/JSON', () => {
  assert.throws(() => parsePairBlob(PAIR_PREFIX + '!!!not-valid!!!'), /corrupt/);
});

t('rejects an expired blob', () => {
  // Mint with a 1s TTL "10 minutes ago"
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const blob = encodePairBlob({ host: 'h', token: TOKEN, ttlSec: 1, now: tenMinAgo });
  assert.throws(() => parsePairBlob(blob), /expired/);
});

t('accepts a fresh (non-expired) blob', () => {
  const blob = encodePairBlob({ host: 'h', token: TOKEN, ttlSec: 600 });
  assert.doesNotThrow(() => parsePairBlob(blob));
});

t('rejects an unknown version', () => {
  // Hand-craft a v999 payload
  const payload = Buffer.from(JSON.stringify({ v: 999, host: 'h', token: TOKEN, exp: 9999999999 }), 'utf-8').toString('base64url');
  assert.throws(() => parsePairBlob(PAIR_PREFIX + payload), /unsupported pair blob version/);
});

t('requires host and token at encode time', () => {
  assert.throws(() => encodePairBlob({ token: TOKEN }), /host required/);
  assert.throws(() => encodePairBlob({ host: 'h' }), /token required/);
});

t('current version is 1', () => {
  assert.equal(PAIR_VERSION, 1);
});

console.log(failed === 0 ? '\nPair blob checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
