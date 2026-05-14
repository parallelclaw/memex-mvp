/**
 * Pattern detection for memex_store_document.
 *
 * When the agent passes content to memex_store_document, memex sniffs it
 * for known failure signatures (Cloudflare challenge, Perplexity-private,
 * paywalls, …) and returns actionable warnings.
 *
 * Each detector returns either null or an object:
 *   { type, blocking, message }
 *
 * `blocking: true` → memex returns stored:false to the agent. Use only for
 * clear-cut failures where storing the content would pollute the corpus.
 * `blocking: false` → memex stores the content but appends the warning so
 * the agent can decide whether to surface it to the user.
 *
 * Patterns may grow over time as new failure modes appear in real use.
 * Single-purpose regexes — order matters (more specific first).
 */

const CLOUDFLARE_PATTERNS = [
  /Just a moment\.\.\./i,
  /Verifying you are human/i,
  /cf-turnstile/i,
  /cf_chl_opt/i,
  /__cf_bm/i,                      // Cloudflare's bot-management cookie name in challenge pages
  /Checking your browser before accessing/i,
];

const PERPLEXITY_PRIVATE_PATTERNS = [
  /This thread is private/i,
  /Sign in if you are the owner of this thread/i,
];

const LOGIN_REQUIRED_PATTERNS = [
  /Sign in to continue/i,
  /Please log in to continue/i,
  /Login required/i,
  /<form[^>]+action=["']\/?(login|signin|sign-in|auth)/i,
  /You must be logged in/i,
];

const PAYWALL_PATTERNS = [
  /Subscribe to (read|continue)/i,
  /Continue reading with subscription/i,
  /\bpaywall\b/i,
  /You've reached your free article limit/i,
  /metered access/i,
  /Become a (member|subscriber)/i,
];

/**
 * Detect a Cloudflare bot-challenge page. Blocking.
 */
function detectCloudflareChallenge(content, _url) {
  for (const re of CLOUDFLARE_PATTERNS) {
    if (re.test(content)) {
      return {
        type: 'cloudflare-challenge',
        blocking: true,
        message:
          'The content you passed looks like a Cloudflare bot-challenge page, not the actual content. The page is protected by Cloudflare and your direct fetch was blocked.\n\n' +
          'Retry by prepending https://r.jina.ai/ to the URL:\n\n' +
          '  WebFetch("https://r.jina.ai/" + originalUrl)\n\n' +
          'Jina AI Reader runs a real browser server-side and bypasses Cloudflare. Returns clean markdown. Free for personal use, no API key needed.\n\n' +
          'If Jina ALSO fails or returns "private/login required", the page needs authentication — Jina can\'t bypass that.',
      };
    }
  }
  return null;
}

/**
 * Detect a private Perplexity thread. Blocking — Jina can't help here,
 * the user needs to make the thread public first.
 */
function detectPerplexityPrivate(content, url) {
  // Only flag if we have a URL hint that it's Perplexity, OR if the message
  // text is unambiguously Perplexity's phrasing.
  const isPerplexityUrl =
    typeof url === 'string' && /perplexity\.ai/i.test(url);

  let matched = false;
  for (const re of PERPLEXITY_PRIVATE_PATTERNS) {
    if (re.test(content)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;
  if (!isPerplexityUrl && !/perplexity/i.test(content)) {
    // Same phrasing might appear on other sites — only act if we're confident
    return null;
  }

  return {
    type: 'perplexity-private',
    blocking: true,
    message:
      'This Perplexity thread is marked private — even Jina Reader can\'t access it (this is an authentication wall, not Cloudflare bot protection).\n\n' +
      'Tell the user: "To save this Perplexity thread to memex, you need to make it public first:\n' +
      '  1. Open the thread in Perplexity\n' +
      '  2. Click Share (top right)\n' +
      '  3. Toggle \'Public link\' on\n' +
      '  4. Copy the new shareable URL Perplexity shows\n' +
      '  5. Send me THAT URL — it\'ll work"\n\n' +
      'The URL in the user\'s address bar (perplexity.ai/search/<id>) is the owner\'s private URL, not the shareable one.',
  };
}

/**
 * Suspiciously short content from a URL that should be substantive.
 * Non-blocking — we store it, but warn.
 */
function detectSuspiciouslySmall(content, url) {
  const trimmed = (content || '').trim();
  // Threshold: documents shorter than 200 chars are almost certainly noise
  // (error pages, redirects, JS-only stubs). Pasted snippets can legitimately
  // be that short, so only flag when we have a URL (suggesting a fetch was
  // attempted) — pastes get a free pass.
  if (!url) return null;
  if (trimmed.length >= 200) return null;
  return {
    type: 'suspiciously-small',
    blocking: false,
    message:
      `The content you passed is very short (${trimmed.length} chars). ` +
      'The page might have been blocked, redirect-failed, or be JS-rendered with no SSR. ' +
      'Stored as-is — consider verifying with the user that this is what they expected.',
  };
}

/**
 * Login required (form / prompt). Non-blocking but worth flagging.
 */
function detectLoginRequired(content, _url) {
  for (const re of LOGIN_REQUIRED_PATTERNS) {
    if (re.test(content)) {
      return {
        type: 'login-required',
        blocking: false,
        message:
          'The page appears to require login (sign-in prompt / login form detected). ' +
          'The content you stored may be a login page, not the actual content the user wanted. ' +
          'Ask the user to paste the content manually if this isn\'t what they expected.',
      };
    }
  }
  return null;
}

/**
 * Paywall / subscription-gated content. Non-blocking.
 */
function detectPaywalled(content, _url) {
  for (const re of PAYWALL_PATTERNS) {
    if (re.test(content)) {
      return {
        type: 'paywalled',
        blocking: false,
        message:
          'The page appears to be paywalled (subscription/payment prompt detected). ' +
          'The content stored may just be the teaser. ' +
          'If the user has full access, they can paste the complete article manually.',
      };
    }
  }
  return null;
}

/**
 * Returns array of warnings sorted with blocking warnings first.
 * If the first warning is blocking, memex should refuse the store
 * and return that warning to the agent.
 *
 * Detectors run in this order (more-specific first):
 *   1. cloudflare-challenge  (blocking)
 *   2. perplexity-private    (blocking)
 *   3. suspiciously-small    (non-blocking)
 *   4. login-required        (non-blocking)
 *   5. paywalled             (non-blocking)
 */
export function detectIssues(content, url) {
  const safeContent = typeof content === 'string' ? content : '';
  const warnings = [];

  // Blocking first — stop on first hit so we surface the most actionable.
  const blocking =
    detectCloudflareChallenge(safeContent, url) ||
    detectPerplexityPrivate(safeContent, url);
  if (blocking) {
    warnings.push(blocking);
    return warnings;
  }

  // Non-blocking — collect all that match.
  for (const fn of [detectSuspiciouslySmall, detectLoginRequired, detectPaywalled]) {
    const w = fn(safeContent, url);
    if (w) warnings.push(w);
  }

  return warnings;
}

/**
 * Convenience: is any warning blocking?
 */
export function isBlocked(warnings) {
  return Array.isArray(warnings) && warnings.some((w) => w.blocking);
}
