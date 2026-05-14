/**
 * URL canonicalization for stable deduplication of stored web documents.
 *
 * Goal: two URLs that point to "the same document" should map to the same
 * canonical form, so memex_store_document gives them the same conversation_id
 * via sha256(canonical).
 *
 * What we normalize:
 *   - Lowercase scheme + host
 *   - Strip known tracking params (utm_*, fbclid, gclid, ref, mc_*, _ga, …)
 *   - Drop the fragment (#anchor) — same document
 *   - Normalize trailing slash on pathname
 *
 * What we DON'T normalize:
 *   - Path case (some servers are case-sensitive)
 *   - Non-tracking query params (?q= search, ?id= permalinks — meaningful)
 *   - Port (rare in public URLs)
 *
 * If the input isn't a valid URL, we return the input unchanged. Callers
 * should still hash the result for deduplication.
 */

// Well-known tracking-param families. Case-insensitive prefix match.
const TRACKING_PREFIXES = [
  'utm_',         // Google Analytics
  'mc_',          // Mailchimp
];
const TRACKING_EXACT = new Set([
  'fbclid',       // Facebook
  'gclid',        // Google ads
  'dclid',        // Google DoubleClick
  'gbraid',       // Google
  'wbraid',       // Google
  'yclid',        // Yandex
  'msclkid',      // Microsoft ads
  'twclid',       // Twitter
  'igshid',       // Instagram
  'ref',          // generic referrer
  'ref_source',
  'ref_url',
  'referrer',
  'source',       // common referrer flag (NOT always tracking but very often)
  '_ga',          // Google Analytics
  '_gl',          // Google Analytics linker
  'hsCtaTracking',
  'hsenc',
  'hsmi',
  'mkt_tok',
  'pk_campaign',
  'pk_source',
  'pk_medium',
  'pk_keyword',
  'pk_content',
  'vero_id',
  'vero_conv',
]);

function isTrackingParam(name) {
  const lower = name.toLowerCase();
  if (TRACKING_EXACT.has(lower)) return true;
  for (const prefix of TRACKING_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * @param {string} rawUrl
 * @returns {string} canonicalized URL (or the input unchanged if unparseable)
 */
export function canonicalize(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return rawUrl;

  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch (_) {
    return rawUrl.trim();
  }

  // Lowercase scheme + host (URL parser already does that, but be explicit)
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  // Drop the fragment
  u.hash = '';

  // Strip tracking params
  const cleanParams = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (!isTrackingParam(k)) cleanParams.append(k, v);
  }
  u.search = cleanParams.toString();

  // Normalize trailing slash: drop trailing slash on non-root paths,
  // so /foo and /foo/ are treated as the same document
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString();
}

/**
 * Best-effort domain extraction for metadata (e.g. "perplexity.ai").
 * Returns null for unparseable URLs.
 */
export function extractDomain(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return null;
  }
}
