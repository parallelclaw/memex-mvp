/**
 * Bearer-token auth for the sync server.
 *
 * Every protected endpoint requires:
 *   Authorization: Bearer <hex-token>
 *
 * The token is the same one baked into the pair blob the client received
 * (256-bit random, hex-encoded). We compare in constant time to avoid
 * timing oracles.
 *
 * On failure: 401 with JSON {error: "unauthorized"} — no detail leaked.
 *
 * Why bearer (not OAuth/mTLS):
 *   - Days vs weeks to ship for the same security model
 *   - One device pair = one token; rotation by re-pairing
 *   - mTLS is reasonable to layer on if the user fronts with Caddy
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generate a 256-bit (32-byte) bearer token, hex-encoded.
 * Output is 64 chars [0-9a-f].
 */
export function generateBearerToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Extract the bearer token from an Authorization header.
 * Returns the hex string or null if the header is missing/malformed.
 */
export function parseAuthHeader(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const m = headerValue.match(/^Bearer\s+([0-9a-fA-F]{8,})\s*$/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Constant-time string comparison. Returns true iff the two strings
 * are equal as bytes. We hex-decode both to fixed-length buffers so
 * timingSafeEqual sees same-length inputs (it throws otherwise).
 *
 * If either token is malformed hex or wrong length, returns false
 * without throwing.
 */
export function tokensMatch(expected, provided) {
  if (!expected || !provided) return false;
  if (expected.length !== provided.length) return false;
  let bufExpected, bufProvided;
  try {
    bufExpected = Buffer.from(expected, 'hex');
    bufProvided = Buffer.from(provided, 'hex');
  } catch (_) {
    return false;
  }
  if (bufExpected.length !== bufProvided.length) return false;
  // timingSafeEqual requires same-length Buffers
  return timingSafeEqual(bufExpected, bufProvided);
}

/**
 * Middleware used by lib/sync/server.js: checks Authorization header
 * against the server-configured token. Calls `next()` on success,
 * writes 401 + ends the response on failure.
 *
 * Usage:
 *   if (!requireBearer(req, res, expectedToken)) return;
 *   // ... handler proceeds
 */
export function requireBearer(req, res, expectedToken) {
  const provided = parseAuthHeader(req.headers.authorization);
  if (!provided || !tokensMatch(expectedToken, provided)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}
