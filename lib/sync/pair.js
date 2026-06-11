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
// Join token (v0.13 lazy-user flow) — same payload as a pair blob PLUS
// `ssh_target` ("user@host"). The presence of ssh_target tells the client to
// reach the server through a forward SSH tunnel (-L) instead of dialing
// host:port directly — the canonical loopback-hub topology where the server
// never exposes a public port. A distinct prefix so old clients fail with
// "not a memex-pair token" instead of silently dialing 127.0.0.1.
const JOIN_PREFIX = 'memex-join:';
const PAIR_VERSION = 1;
export const DEFAULT_PAIR_TTL_SEC = 600;  // 10 minutes
export const DEFAULT_JOIN_TTL_SEC = 1800; // 30 minutes — join is a longer dance

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
 * Encode a JOIN token — the lazy-user variant. Same fields as a pair blob,
 * plus `ssh_target`. `host` is pinned to 127.0.0.1: the server binds loopback
 * and the client reaches it through its own `-L` tunnel, so loopback is the
 * only address that's ever dialed.
 */
export function encodeJoinBlob({ ssh_target, port = 8766, cert_fp = null, token, ttlSec = DEFAULT_JOIN_TTL_SEC, now = Date.now() }) {
  if (!ssh_target || !/^[^@\s]+@[^@\s]+$/.test(ssh_target)) {
    throw new Error('encodeJoinBlob: ssh_target required (user@host)');
  }
  if (!token) throw new Error('encodeJoinBlob: token required');
  const payload = {
    v: PAIR_VERSION,
    host: '127.0.0.1',
    ssh_target,
    port: Number(port) || 8766,
    cert_fp: cert_fp || null,
    token,
    exp: Math.floor(now / 1000) + Math.max(1, Math.floor(ttlSec)),
  };
  return JOIN_PREFIX + Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

/**
 * Parse + validate a pair OR join blob. Throws a friendly Error on any problem.
 * Returns { kind, host, port, url, cert_fp, token, exp, ssh_target }.
 *   kind       — 'pair' | 'join' (by prefix)
 *   ssh_target — "user@host" for join tokens, null for plain pair blobs
 *
 *   now — injectable clock (ms) for tests.
 */
export function parsePairBlob(blob, { now = Date.now() } = {}) {
  if (typeof blob !== 'string' || !blob.trim()) {
    throw new Error('pair blob must be a non-empty string');
  }
  let s = blob.trim();
  let kind;
  if (s.startsWith(JOIN_PREFIX)) {
    kind = 'join';
    s = s.slice(JOIN_PREFIX.length).trim();
  } else if (s.startsWith(PREFIX)) {
    kind = 'pair';
    s = s.slice(PREFIX.length).trim();
  } else {
    throw new Error(`not a memex pair/join token (must start with "${PREFIX}" or "${JOIN_PREFIX}")`);
  }

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
  if (kind === 'join' && !/^[^@\s]+@[^@\s]+$/.test(payload.ssh_target || '')) {
    throw new Error('join token missing ssh_target (user@host) — re-emit it with `sync-server invite --join`');
  }
  if (payload.exp && Math.floor(now / 1000) > payload.exp) {
    const agoMin = Math.round((Math.floor(now / 1000) - payload.exp) / 60);
    throw new Error(`pair blob expired ${agoMin}m ago — mint a fresh one with \`memex-sync sync-server invite\``);
  }

  const port = Number(payload.port) || 8766;
  return {
    kind,
    host: payload.host,
    port,
    url: `https://${payload.host}:${port}`,
    cert_fp: payload.cert_fp || null,
    token: payload.token,
    exp: payload.exp || null,
    ssh_target: kind === 'join' ? payload.ssh_target : null,
  };
}

export { PREFIX as PAIR_PREFIX, JOIN_PREFIX, PAIR_VERSION };
