"""URL canonicalization, content-issue detection, and title extraction
for `memex_store_document` — direct Python port of the memex-mvp
JS modules under lib/store-doc/ (canonicalize.js, detect.js,
extract-title.js).

Kept as a single file because the three concerns share data flow:
the store_document handler runs canonicalize → detect → extract_title
in sequence, and exposing them together makes the call site obvious.

The patterns here are field-tested in memex-mvp (Cloudflare regexes,
Perplexity-private detection, Jina-prefix stripping for titles).
This Python port preserves the EXACT behavior so a URL stored via
Hermes ends up with the same canonical form, same conversation_id
(sha256 of canonical), and same warnings as if stored via Claude
Code's MCP path. memex.db UNIQUE constraint then dedups across
clients transparently.
"""

from __future__ import annotations

import hashlib
import html
import re
from typing import List, Optional
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, unquote


# ============================================================
# canonicalize — URL normalization for stable dedup
# ============================================================

# Tracking-param families. Case-insensitive prefix match.
TRACKING_PREFIXES = ("utm_", "mc_")

TRACKING_EXACT = frozenset({
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "yclid",
    "msclkid", "twclid", "igshid",
    "ref", "ref_source", "ref_url", "referrer", "source",
    "_ga", "_gl",
    "hsctatracking", "hsenc", "hsmi",
    "mkt_tok",
    "pk_campaign", "pk_source", "pk_medium", "pk_keyword", "pk_content",
    "vero_id", "vero_conv",
})


def _is_tracking_param(name: str) -> bool:
    lower = name.lower()
    if lower in TRACKING_EXACT:
        return True
    return any(lower.startswith(p) for p in TRACKING_PREFIXES)


def canonicalize(raw_url: str) -> str:
    """Normalize a URL for stable deduplication.

    Two URLs that point to "the same document" should canonicalize
    to the same string, so sha256(canonical) gives a stable
    conversation_id. Lowercase scheme + host, drop fragment, strip
    tracking params, normalize trailing slash on non-root paths.

    Does NOT lowercase the path (case-sensitive on many servers)
    or strip non-tracking query params.

    Unparseable input → returned trimmed-but-unchanged.
    """
    if not isinstance(raw_url, str) or not raw_url.strip():
        return raw_url
    s = raw_url.strip()
    try:
        parts = urlsplit(s)
        if not parts.scheme or not parts.netloc:
            return s
    except ValueError:
        return s

    scheme = parts.scheme.lower()
    netloc = parts.hostname.lower() if parts.hostname else ""
    if parts.port is not None:
        netloc = f"{netloc}:{parts.port}"
    # Preserve userinfo if any (rare in public URLs).
    if parts.username:
        cred = parts.username
        if parts.password is not None:
            cred = f"{cred}:{parts.password}"
        netloc = f"{cred}@{netloc}"

    # Strip tracking params.
    clean = [(k, v) for (k, v) in parse_qsl(parts.query, keep_blank_values=True)
             if not _is_tracking_param(k)]
    query = urlencode(clean, doseq=True)

    # Normalize trailing slash on non-root paths.
    path = parts.path or ""
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
        if not path:
            path = "/"  # safety: never leave it empty

    # Always drop the fragment.
    return urlunsplit((scheme, netloc, path, query, ""))


def extract_domain(raw_url: Optional[str]) -> Optional[str]:
    """Lowercased hostname with leading www. stripped. None on failure."""
    if not isinstance(raw_url, str):
        return None
    try:
        host = (urlsplit(raw_url).hostname or "").lower()
    except ValueError:
        return None
    if not host:
        return None
    return host[4:] if host.startswith("www.") else host


def conversation_id_for_url(raw_url: Optional[str], content: Optional[str] = None) -> str:
    """Stable conversation_id for memex_store_document.

    URL present → web-<first 12 hex of sha256(canonical url)>
    URL absent  → web-<first 12 hex of sha256(content)>   (paste, no URL)

    The 12-char prefix is enough for the deduplication scope in
    practice (~10^14 entries before any meaningful collision risk).
    """
    if raw_url and isinstance(raw_url, str) and raw_url.strip():
        canon = canonicalize(raw_url)
        digest = hashlib.sha256(canon.encode("utf-8")).hexdigest()
        return f"web-{digest[:12]}"
    payload = (content or "").encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    return f"web-{digest[:12]}"


# ============================================================
# detect — content issue detection (Cloudflare / Perplexity / etc.)
# ============================================================

CLOUDFLARE_PATTERNS = [
    re.compile(r"Just a moment\.\.\.", re.I),
    re.compile(r"Verifying you are human", re.I),
    re.compile(r"cf-turnstile", re.I),
    re.compile(r"cf_chl_opt", re.I),
    re.compile(r"__cf_bm", re.I),
    re.compile(r"Checking your browser before accessing", re.I),
]

PERPLEXITY_PRIVATE_PATTERNS = [
    re.compile(r"This thread is private", re.I),
    re.compile(r"Sign in if you are the owner of this thread", re.I),
]

LOGIN_REQUIRED_PATTERNS = [
    re.compile(r"Sign in to continue", re.I),
    re.compile(r"Please log in to continue", re.I),
    re.compile(r"Login required", re.I),
    re.compile(r"<form[^>]+action=[\"']/?(login|signin|sign-in|auth)", re.I),
    re.compile(r"You must be logged in", re.I),
]

PAYWALL_PATTERNS = [
    re.compile(r"Subscribe to (read|continue)", re.I),
    re.compile(r"Continue reading with subscription", re.I),
    re.compile(r"\bpaywall\b", re.I),
    re.compile(r"You've reached your free article limit", re.I),
    re.compile(r"metered access", re.I),
    re.compile(r"Become a (member|subscriber)", re.I),
]


def _detect_cloudflare(content: str, _url: Optional[str]) -> Optional[dict]:
    for pat in CLOUDFLARE_PATTERNS:
        if pat.search(content):
            return {
                "type": "cloudflare-challenge",
                "blocking": True,
                "message": (
                    "The content you passed looks like a Cloudflare bot-challenge "
                    "page, not the actual content. The page is protected by "
                    "Cloudflare and your direct fetch was blocked.\n\n"
                    "Retry by prepending https://r.jina.ai/ to the URL — and "
                    "use this exact recipe (field-tested 2026-05):\n\n"
                    "  curl -H \"Accept: text/markdown\" "
                    "https://r.jina.ai/https://<original-url>\n\n"
                    "The `https://` AFTER r.jina.ai/ is required (not http://). "
                    "The Accept header gets clean markdown back instead of HTML.\n\n"
                    "If Jina ALSO fails or returns 'private/login required', the "
                    "page needs authentication — Jina can't bypass that."
                ),
            }
    return None


def _detect_perplexity_private(content: str, url: Optional[str]) -> Optional[dict]:
    is_perplexity_url = isinstance(url, str) and bool(re.search(r"perplexity\.ai", url, re.I))
    matched = any(p.search(content) for p in PERPLEXITY_PRIVATE_PATTERNS)
    if not matched:
        return None
    if not is_perplexity_url and not re.search(r"perplexity", content, re.I):
        return None
    return {
        "type": "perplexity-private",
        "blocking": True,
        "message": (
            "This Perplexity thread is marked private — even Jina Reader can't "
            "access it (this is an authentication wall, not Cloudflare bot "
            "protection).\n\n"
            "Tell the user: \"To save this Perplexity thread to memex, you need "
            "to make it public first:\n"
            "  1. Open the thread in Perplexity\n"
            "  2. Click Share (top right)\n"
            "  3. Toggle 'Public link' on\n"
            "  4. Copy the new shareable URL Perplexity shows\n"
            "  5. Send me THAT URL — it'll work\"\n\n"
            "The URL in the user's address bar (perplexity.ai/search/<id>) is "
            "the owner's private URL, not the shareable one."
        ),
    }


def _detect_suspiciously_small(content: str, url: Optional[str]) -> Optional[dict]:
    trimmed = (content or "").strip()
    if not url:
        return None  # pastes can legitimately be short
    if len(trimmed) >= 200:
        return None
    return {
        "type": "suspiciously-small",
        "blocking": False,
        "message": (
            f"The content you passed is very short ({len(trimmed)} chars). "
            "The page might have been blocked, redirect-failed, or be "
            "JS-rendered with no SSR. Stored as-is — consider verifying with "
            "the user that this is what they expected."
        ),
    }


def _detect_login_required(content: str, _url: Optional[str]) -> Optional[dict]:
    for pat in LOGIN_REQUIRED_PATTERNS:
        if pat.search(content):
            return {
                "type": "login-required",
                "blocking": False,
                "message": (
                    "The page appears to require login (sign-in prompt / login "
                    "form detected). The content you stored may be a login page, "
                    "not the actual content. Ask the user to paste the content "
                    "manually if this isn't what they expected."
                ),
            }
    return None


def _detect_paywalled(content: str, _url: Optional[str]) -> Optional[dict]:
    for pat in PAYWALL_PATTERNS:
        if pat.search(content):
            return {
                "type": "paywalled",
                "blocking": False,
                "message": (
                    "The page appears to be paywalled (subscription/payment "
                    "prompt detected). The content stored may just be the teaser. "
                    "If the user has full access, they can paste the complete "
                    "article manually."
                ),
            }
    return None


def detect_issues(content: Optional[str], url: Optional[str]) -> List[dict]:
    """Detect issues with stored content. Returns ordered list of warnings.

    Blocking warnings come first and short-circuit non-blocking checks —
    if cloudflare-challenge or perplexity-private fires, no other warnings
    are added. Caller should refuse the store on any blocking warning.
    """
    safe = content if isinstance(content, str) else ""
    blocking = _detect_cloudflare(safe, url) or _detect_perplexity_private(safe, url)
    if blocking:
        return [blocking]
    warnings: List[dict] = []
    for fn in (_detect_suspiciously_small, _detect_login_required, _detect_paywalled):
        w = fn(safe, url)
        if w:
            warnings.append(w)
    return warnings


def is_blocked(warnings: List[dict]) -> bool:
    return any(isinstance(w, dict) and w.get("blocking") for w in (warnings or []))


# ============================================================
# extract_title — best-effort document title from fetched content
# ============================================================

MAX_TITLE_LEN = 200

_RE_JINA_URL_SRC = re.compile(r"^URL Source:\s*https?://", re.M)
_RE_JINA_MARKDOWN_DELIM = re.compile(r"^Markdown Content:\s*\n", re.M)
_RE_MD_H1 = re.compile(r"^[ \t]*#[ \t]+([^\r\n]+?)[ \t]*$", re.M)
_RE_MD_H2 = re.compile(r"^[ \t]*##[ \t]+([^\r\n]+?)[ \t]*$", re.M)
_RE_HTML_TITLE = re.compile(r"<title[^>]*>([^<]+)</title>", re.I)
_RE_HTML_H1 = re.compile(r"<h1[^>]*>([\s\S]*?)</h1>", re.I)
_RE_HTML_TAG = re.compile(r"<[^>]+>")


def _trim_title(s: Optional[str]) -> str:
    if not s:
        return ""
    t = re.sub(r"\s+", " ", str(s)).strip()
    if len(t) > MAX_TITLE_LEN:
        t = t[:MAX_TITLE_LEN].strip() + "…"
    return t


def _strip_jina_prefix(content: str) -> str:
    """Drop Jina Reader's metadata header (Title:, URL Source:, etc.) so
    title extraction looks at the actual page body. Jina's "Title:"
    line is often a generic app shell ("Perplexity", "GitHub") rather
    than the document title — H1/H2 inside the markdown body is what
    we want. Non-Jina content returned unchanged.
    """
    if not _RE_JINA_URL_SRC.search(content[:500]):
        return content
    m = _RE_JINA_MARKDOWN_DELIM.search(content)
    if not m:
        return content
    return content[m.end():]


def _from_md_h1(content: str) -> str:
    m = _RE_MD_H1.search(content)
    return _trim_title(m.group(1)) if m else ""


def _from_md_h2(content: str) -> str:
    m = _RE_MD_H2.search(content)
    return _trim_title(m.group(1)) if m else ""


def _from_html_title(content: str) -> str:
    m = _RE_HTML_TITLE.search(content)
    return _trim_title(html.unescape(m.group(1))) if m else ""


def _from_html_h1(content: str) -> str:
    m = _RE_HTML_H1.search(content)
    if not m:
        return ""
    inner = _RE_HTML_TAG.sub("", m.group(1))
    return _trim_title(html.unescape(inner))


def _from_first_line(content: str) -> str:
    for raw in content.split("\n"):
        line = raw.rstrip("\r").strip()
        if not line:
            continue
        if re.match(r"^[#\-=*>|`]", line):
            continue
        if 0 < len(line) <= 120:
            return _trim_title(line)
        break
    return ""


def _from_url_slug(raw_url: Optional[str]) -> str:
    if not raw_url:
        return ""
    try:
        parts = urlsplit(raw_url)
    except ValueError:
        return ""
    segs = [s for s in (parts.path or "").split("/") if s]
    if segs:
        slug = unquote(segs[-1])
        slug = re.sub(r"[-_]+", " ", slug)
        slug = re.sub(r"\.(html?|md|pdf|txt)$", "", slug, flags=re.I).strip()
        if slug:
            return _trim_title(slug)
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return _trim_title(host)


def extract_title(content: Optional[str], url: Optional[str]) -> str:
    """Best-effort document title. Never returns empty.

    Strategy (first hit wins):
      Markdown H1 → H2 → HTML <title> → HTML <h1> → first short line
      → URL slug → domain → "Untitled document"

    Jina Reader's metadata prefix is stripped before extraction so
    "Title: Perplexity" boilerplate doesn't win over the real H1/H2.
    """
    safe = content if isinstance(content, str) else ""
    body = _strip_jina_prefix(safe)
    return (
        _from_md_h1(body)
        or _from_md_h2(body)
        or _from_html_title(body)
        or _from_html_h1(body)
        or _from_first_line(body)
        or _from_url_slug(url)
        or "Untitled document"
    )
