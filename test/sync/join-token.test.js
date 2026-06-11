/**
 * v0.13 join token (memex-join:) — the lazy-flow variant of the pair blob.
 *
 * The join token carries everything a pair blob does PLUS ssh_target, and
 * pins host to 127.0.0.1 (loopback hub reached through the client's own
 * forward tunnel). parsePairBlob() handles BOTH prefixes and reports `kind`
 * so sync-join can branch. These tests lock that contract.
 *
 * Run: node test/sync/join-token.test.js
 */

import assert from 'node:assert/strict';
import {
  encodePairBlob, encodeJoinBlob, parsePairBlob,
  PAIR_PREFIX, JOIN_PREFIX, DEFAULT_JOIN_TTL_SEC,
} from '../../lib/sync/pair.js';

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const TOKEN = 'a'.repeat(64);

console.log('join token:');

t('round trip preserves ssh_target/port/cert_fp/token', () => {
  const blob = encodeJoinBlob({
    ssh_target: 'openclaw@203.0.113.7', port: 8766,
    cert_fp: 'sha256:AA:BB', token: TOKEN,
  });
  const p = parsePairBlob(blob);
  assert.equal(p.kind, 'join');
  assert.equal(p.ssh_target, 'openclaw@203.0.113.7');
  assert.equal(p.port, 8766);
  assert.equal(p.cert_fp, 'sha256:AA:BB');
  assert.equal(p.token, TOKEN);
});

t('host is pinned to loopback (server is never dialed directly)', () => {
  const p = parsePairBlob(encodeJoinBlob({ ssh_target: 'u@h', token: TOKEN }));
  assert.equal(p.host, '127.0.0.1');
  assert.equal(p.url, 'https://127.0.0.1:8766');
});

t('uses the memex-join: prefix (distinct from memex-pair:)', () => {
  const blob = encodeJoinBlob({ ssh_target: 'u@h', token: TOKEN });
  assert.ok(blob.startsWith(JOIN_PREFIX));
  assert.ok(!blob.startsWith(PAIR_PREFIX));
  assert.match(blob.slice(JOIN_PREFIX.length), /^[A-Za-z0-9_-]+$/, 'base64url-safe');
});

t('plain pair blobs still parse, with kind="pair" and ssh_target=null', () => {
  const p = parsePairBlob(encodePairBlob({ host: 'example.com', token: TOKEN }));
  assert.equal(p.kind, 'pair');
  assert.equal(p.ssh_target, null);
  assert.equal(p.host, 'example.com');
});

t('encode requires a user@host ssh_target', () => {
  assert.throws(() => encodeJoinBlob({ token: TOKEN }), /ssh_target/);
  assert.throws(() => encodeJoinBlob({ ssh_target: 'no-at-sign', token: TOKEN }), /ssh_target/);
});

t('a join payload with a stripped ssh_target is rejected at parse', () => {
  // Forge: take a valid pair payload and slap the join prefix on it.
  const pairBlob = encodePairBlob({ host: 'h', token: TOKEN });
  const forged = JOIN_PREFIX + pairBlob.slice(PAIR_PREFIX.length);
  assert.throws(() => parsePairBlob(forged), /ssh_target/);
});

t('expiry applies to join tokens too', () => {
  const old = Date.now() - 10 * 60 * 1000;
  const blob = encodeJoinBlob({ ssh_target: 'u@h', token: TOKEN, ttlSec: 1, now: old });
  assert.throws(() => parsePairBlob(blob), /expired/);
});

t('default join TTL is 30 minutes (longer than pair — join is a longer dance)', () => {
  const now = Date.now();
  const p = parsePairBlob(encodeJoinBlob({ ssh_target: 'u@h', token: TOKEN, now }));
  assert.equal(p.exp, Math.floor(now / 1000) + DEFAULT_JOIN_TTL_SEC);
  assert.equal(DEFAULT_JOIN_TTL_SEC, 1800);
});

console.log(failed === 0 ? '\nJoin token checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
