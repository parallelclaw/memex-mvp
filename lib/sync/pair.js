/**
 * Pair blob — collapse {host, port, cert_fp, bearer} into one copy-pasteable
 * string so a peer can be added with a single paste instead of three CLI args.
 *
 *   memex-pair:<base64url(JSON)>
 *
 * The JSON payload:
 *   { v, host, port, cert_fp, token, exp }
 *
 * Design notes:
 *   • base64url (no +/=) so it survives chat clients, URLs, and shell args
 *     without escaping.
 *   • `exp` (unix seconds) — a short TTL (default 10 min). A leaked blob is
 *     only useful until it expires; after that the client refuses it and the
 *     operator mints a fresh one. The bearer itself doesn't rotate on expiry
 *     (it persists server-side); expiry just bounds the pairing window.
 *   • `v` version gate — a client that doesn't understand the version refuses
 *     rather than mis-parsing.
 *   • This is transport-agnostic: `host` is whatever the CLIENT will dial —
 *     a public IP, a localhost SSH-tunnel port, or a Tailscale MagicDNS name.
 *     The server can't know that, so the invite step chooses/declares it.
 *
 * Security model unchanged from the 3-arg path: cert_fp gives TLS pinning,
 * token is the 256-bit bearer. The blob just bundles them.
 */

const PREFIX = 'memex-pair:';
const PAIR_VERSION = 1;
export const DEFAULT_PAIR_TTL_SEC = 600; // 10 minutes

/**
 * Encode a pair blob. Returns the "memex-pair:..." string.
 *   host    — required; what the client will connect to
 *   port    — default 8766
 *   cert_fp — TLS fingerprint to pin (sha256:AA:BB:...); may be null for
 *             transport-trusted setups (SSH tunnel / Tailscale)
 *   token   — required; 256-bit hex bearer
 *   ttlSec  — seconds until the blob expires (default 10 min)
 *   now     — injectable clock (ms) for tests
 */
export function encodePairBlob({ host, port = 8766, cert_fp = null, token, ttlSec = DEFAULT_PAIR_TTL_SEC, now = Date.now() }) {
  if (!host) throw new Error('encodePairBlob: host required');
  if (!token) throw new Error('encodePairBlob: token required');
  const payload = {
    v: PAIR_VERSION,
    host,
    port: Number(port) || 8766,
    cert_fp: cert_fp || null,
    token,
    exp: Math.floor(now / 1000) + Math.max(1, Math.floor(ttlSec)),
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  return PREFIX + b64;
}

/**
 * Parse + validate a pair blob. Throws a friendly Error on any problem.
 * Returns { host, port, url, cert_fp, token, exp }.
 *
 *   now — injectable clock (ms) for tests.
 */
export function parsePairBlob(blob, { now = Date.now() } = {}) {
  if (typeof blob !== 'string' || !blob.trim()) {
    throw new Error('pair blob must be a non-empty string');
  }
  let s = blob.trim();
  if (!s.startsWith(PREFIX)) {
    throw new Error(`not a memex-pair token (must start with "${PREFIX}")`);
  }
  s = s.slice(PREFIX.length).trim();

  let payload;
  try {
    payload = JSON.parse(Buffer.from(s, 'base64url').toString('utf-8'));
  } catch (_) {
    throw new Error('pair blob is corrupt (base64/JSON decode failed) — re-copy it whole');
  }

  if (payload.v !== PAIR_VERSION) {
    throw new Error(`unsupported pair blob version ${payload.v} — this memex speaks v${PAIR_VERSION}; upgrade the older side`);
  }
  if (!payload.host || !payload.token) {
    throw new Error('pair blob missing host or token');
  }
  if (payload.exp && Math.floor(now / 1000) > payload.exp) {
    const agoMin = Math.round((Math.floor(now / 1000) - payload.exp) / 60);
    throw new Error(`pair blob expired ${agoMin}m ago — mint a fresh one with \`memex-sync sync-server invite\``);
  }

  const port = Number(payload.port) || 8766;
  return {
    host: payload.host,
    port,
    url: `https://${payload.host}:${port}`,
    cert_fp: payload.cert_fp || null,
    token: payload.token,
    exp: payload.exp || null,
  };
}

export { PREFIX as PAIR_PREFIX, PAIR_VERSION };
