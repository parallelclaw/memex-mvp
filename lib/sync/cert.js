/**
 * Self-signed TLS cert generation + fingerprint computation for sync server.
 *
 * Design choice: every sync server gets its OWN self-signed cert. We don't
 * use Let's Encrypt because the typical sync deployment has no public DNS
 * name (it's behind Tailscale, an SSH tunnel, or addressed by raw IP).
 *
 * Clients pin the cert fingerprint baked into the pair blob — same trust
 * model as Plex device pairing or Tailscale's node identity. If the server's
 * cert ever changes (e.g. you ran `memex sync rotate-cert`), pre-existing
 * clients refuse to connect until they're re-paired. This is the right
 * default: silent cert changes are how MITM happens.
 *
 * Cert files live in ~/.memex/ alongside the DB:
 *   sync-cert.pem  — the cert (public)
 *   sync-key.pem   — the private key (mode 0600)
 *
 * Validity period: 10 years. Self-signed; no renewal needed in practice
 * since clients pin the fingerprint, not the CA chain or expiry.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import selfsigned from 'selfsigned';

/**
 * Generate a fresh self-signed cert + key, write them to disk (with 0600
 * on the key file), return { certPath, keyPath, fingerprint }.
 *
 * If files already exist, overwrites them — this is the "rotate" path.
 * Callers who want idempotent "generate-if-missing" should use ensureCert().
 *
 * Async because selfsigned ≥5.0 dropped the sync API.
 */
export async function generateCert({ certPath, keyPath, commonName = 'memex-sync' }) {
  if (!certPath || !keyPath) {
    throw new Error('generateCert: certPath and keyPath are required');
  }
  mkdirSync(dirname(certPath), { recursive: true });
  mkdirSync(dirname(keyPath),  { recursive: true });

  // 10-year validity, 2048-bit RSA. SubjectAltName covers localhost +
  // the conventional .local mDNS form, so the same cert works for SSH
  // tunnel localhost connections and LAN-discovery hosts without
  // extra alt names. We don't bother with public DNS names because
  // we're pinning by fingerprint anyway.
  const now = new Date();
  const tenYears = new Date(now.getTime() + 365 * 10 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: commonName }];
  const opts = {
    notBeforeDate: now,
    notAfterDate:  tenYears,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 2, value: commonName },
          { type: 2, value: `${commonName}.local` },
        ],
      },
    ],
  };

  const pems = await selfsigned.generate(attrs, opts);
  // pems = { private, public, cert, fingerprint }

  writeFileSync(certPath, pems.cert);
  writeFileSync(keyPath,  pems.private);
  // Best-effort 0600 on the key; non-fatal on platforms where chmod doesn't apply.
  try { chmodSync(keyPath, 0o600); } catch (_) { /* windows etc. */ }

  // Compute our own SHA-256 fingerprint — selfsigned reports SHA-1 historically
  // and we want consistent sha256:hex for pair-blob pinning.
  const fingerprint = sha256FingerprintFromPem(pems.cert);

  return { certPath, keyPath, fingerprint, cert: pems.cert, key: pems.private };
}

/**
 * Idempotent: if cert+key already exist on disk, returns the existing
 * fingerprint without regenerating. Otherwise creates new ones.
 *
 * Use this on `memex sync server start` to avoid silently rotating
 * a cert that paired clients depend on.
 *
 * Async because generateCert is async.
 */
export async function ensureCert({ certPath, keyPath, commonName = 'memex-sync' }) {
  if (existsSync(certPath) && existsSync(keyPath)) {
    const fingerprint = sha256FingerprintFromFile(certPath);
    return { certPath, keyPath, fingerprint, reused: true };
  }
  const fresh = await generateCert({ certPath, keyPath, commonName });
  return { ...fresh, reused: false };
}

/**
 * Read a PEM-encoded cert from disk and compute its SHA-256 fingerprint
 * in the "sha256:AA:BB:CC:..." form that's standard in TLS tooling
 * (OpenSSL, browsers, Tailscale).
 */
export function sha256FingerprintFromFile(certPath) {
  const pem = readFileSync(certPath, 'utf-8');
  return sha256FingerprintFromPem(pem);
}

export function sha256FingerprintFromPem(pem) {
  // Strip PEM header/footer and decode base64 → raw DER bytes.
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  const hash = createHash('sha256').update(der).digest('hex').toUpperCase();
  // Format as "sha256:AA:BB:..." (every two hex chars colon-joined)
  const colonized = hash.match(/.{2}/g).join(':');
  return `sha256:${colonized}`;
}

/**
 * Compare a (possibly user-supplied) fingerprint against a server's
 * actual one, tolerant of formatting variations:
 *   - case-insensitive
 *   - "sha256:" prefix optional
 *   - colon-separation optional
 *
 * Returns true iff the underlying 32 hex bytes match.
 */
export function fingerprintsMatch(a, b) {
  return normalizeFingerprint(a) === normalizeFingerprint(b);
}

function normalizeFingerprint(s) {
  if (!s) return '';
  let v = String(s).toLowerCase();
  v = v.replace(/^sha256:/, '');
  v = v.replace(/:/g, '');
  v = v.replace(/\s+/g, '');
  return v;
}
