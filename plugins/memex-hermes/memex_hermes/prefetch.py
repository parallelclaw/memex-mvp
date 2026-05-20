"""Two-phase recall: queue_prefetch (async, fire-and-forget) + prefetch (sync, consume).

How it fits in the Hermes turn cycle:

  turn N:
    user sends message
    Hermes calls plugin.queue_prefetch(user_msg, session_id=...)
      → we start a background thread that runs FTS5 search, stores result
    LLM generates assistant reply, tools run, sync_turn fires
    Hermes calls plugin.queue_prefetch again (with new message) for turn N+1
      → result is cached for the NEXT prefetch call

  turn N+1:
    Hermes calls plugin.prefetch(user_msg, session_id=...)
      → we consume the cached result if it matches, else search synchronously
    The returned string is injected into the user message (NOT system
    prompt) so prompt cache stays valid across turns.

Token budget: we cap the rendered context at ~500 tokens (estimated by
character length × 0.25). If too many results, we trim.

Cache key matches on query approximate equality — Hermes sometimes calls
queue_prefetch with one query and prefetch with a slightly different one
(e.g. extra context). We compare first 200 chars; if mismatch we re-search.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


# How long a cached prefetch result remains valid before we re-search.
CACHE_TTL_SECONDS = 60

# Target rendered context size — roughly 500 tokens (~2000 chars at 4 chars/token).
MAX_CONTEXT_CHARS = 2000


# Tokens we drop because they're rarely indicative (basic stopword set).
# Not exhaustive — just the highest-frequency conversational filler in
# the languages we expect to see (English, Russian, plus connectors).
# Stopwords are normalised to lowercase before lookup.
_STOPWORDS = frozenset({
    # English filler
    "the", "and", "for", "with", "this", "that", "from", "what", "where",
    "when", "how", "why", "are", "was", "were", "have", "has", "had",
    "but", "not", "you", "your", "they", "them", "our", "his", "her",
    "its", "all", "any", "can", "could", "would", "should", "will",
    # Russian filler
    "как", "что", "где", "когда", "почему", "чтобы", "если", "это",
    "то", "так", "уже", "ещё", "еще", "был", "была", "было", "были",
    "есть", "буду", "будет", "его", "её", "ее", "их", "нет", "или",
    "для", "под", "над", "при", "без", "из-за", "через", "между",
})


def _expand_query_for_prefetch(query: str) -> str:
    """Build a recall-friendly FTS5 query from a free-text prompt.

    Two key transformations:

    1. Trim+prefix every content token.
       FTS5 doesn't stem — `Установить*` won't catch "Установи" because
       prefix match is forward-only. Trick: drop the last 2 chars of
       long tokens before adding `*` so "Установить" → "Установ*"
       catches Установи / Установка / Установлен etc.

    2. Use OR between tokens.
       Default FTS5 semantics is AND. For prefetch we want recall, not
       precision — return ANY row that mentions ANY content word.
       Ranking via bm25() in the search call promotes the best matches.

    Stopwords are dropped (basic English + Russian list); tokens shorter
    than 3 chars are dropped; max 8 tokens to keep the query bounded.

    Used ONLY in automatic prefetch — user-facing memex_search keeps
    the original query so explicit phrase searches still work.
    """
    if not query or not query.strip():
        return ""
    tokens: list[str] = []
    for raw in query.split():
        token = raw.strip().strip('.,!?;:()[]{}"\'`«»')
        if len(token) < 3:
            continue
        if token.lower() in _STOPWORDS:
            continue
        # Skip FTS5 syntax tokens
        if token.upper() in ("AND", "OR", "NOT", "NEAR"):
            continue
        # Already a prefix or has special chars — leave it alone
        if any(c in token for c in '*"():^'):
            tokens.append(token)
            continue
        # Trim inflectional ending for tokens ≥6 chars (heuristic stemmer)
        if len(token) >= 6:
            tokens.append(f"{token[:-2]}*")
        else:
            tokens.append(f"{token}*")
        if len(tokens) >= 8:
            break
    # OR between tokens for recall; bm25 ranking in search picks the best.
    return " OR ".join(tokens) if tokens else ""


def _query_match(a: str, b: str) -> bool:
    """Loose equality for prefetch query reuse.

    Hermes may queue_prefetch with one query and prefetch with a slightly
    different one (extra system context appended, etc.). We accept reuse
    if the first 200 chars match (case-insensitive, whitespace-normalized).
    """
    a = " ".join((a or "").lower().split())[:200]
    b = " ".join((b or "").lower().split())[:200]
    return bool(a) and a == b


def _render_context(rows: List[Dict[str, Any]]) -> str:
    """Format search rows as a compact context string for LLM injection.

    Format chosen to be short, scannable, and to include the record ID so
    the LLM can call memex_get(ids) for full text if it cares about a
    specific record. No fancy markdown — just a tight enumerated list.
    """
    if not rows:
        return ""
    lines = ["Relevant past context (memex verbatim store):"]
    used_chars = len(lines[0])
    for r in rows:
        ts = r.get("ts") or 0
        role = r.get("role") or "?"
        preview = (r.get("text") or r.get("preview") or "").strip().replace("\n", " ")
        if len(preview) > 120:
            preview = preview[:117] + "..."
        date = time.strftime("%Y-%m-%d", time.gmtime(ts)) if ts else "?"
        line = f"  [#{r['id']}, {date}, {role}] {preview}"
        if used_chars + len(line) + 1 > MAX_CONTEXT_CHARS:
            lines.append("  (more results — call memex_search to browse all)")
            break
        lines.append(line)
        used_chars += len(line) + 1
    lines.append(
        "Call memex_get(ids=[...]) for full text of any record above; "
        "memex_search(query) for broader recall."
    )
    return "\n".join(lines)


class PrefetchCache:
    """Background-prefetch result cache.

    Hermes' MemoryProvider lifecycle gives us TWO callbacks for recall:

      queue_prefetch(query) — fired AFTER each turn for the NEXT turn's recall.
                              We do the search in a background thread so it's
                              ready by the time prefetch() is called.

      prefetch(query)       — fired BEFORE each LLM call. Must be FAST. We
                              return the cached result if it matches, else
                              do a synchronous search (small price for first
                              turn where no cache exists yet).
    """

    def __init__(self, store):
        self._store = store
        self._lock = threading.Lock()
        self._cached_query: Optional[str] = None
        self._cached_result: Optional[str] = None
        self._cached_at: float = 0.0
        self._thread: Optional[threading.Thread] = None

    def queue(self, query: str) -> None:
        """Start a background search for `query`. Non-blocking."""
        if not query:
            return
        # Cancel pending work by simply overwriting — the old thread will
        # complete and store its result, but we'll prefer the newer one
        # via timestamp on consumption.
        t = threading.Thread(
            target=self._worker,
            args=(query,),
            daemon=True,
            name="memex-hermes-prefetch",
        )
        with self._lock:
            self._thread = t
        t.start()

    def _worker(self, query: str) -> None:
        try:
            expanded = _expand_query_for_prefetch(query)
            rows = self._store.search(expanded or query, limit=5, order_by_relevance=True)
            # Use full text where available (search returns preview by
            # design; we re-fetch top hits for richer context).
            ids = [r["id"] for r in rows[:5]]
            full = self._store.get_by_ids(ids) if ids else []
            rendered = _render_context(full or rows)
            with self._lock:
                self._cached_query = query
                self._cached_result = rendered
                self._cached_at = time.time()
            log.debug(
                "memex-hermes prefetch cached: query=%r rows=%d chars=%d",
                query[:60], len(rows), len(rendered),
            )
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes prefetch worker failed")

    def consume(self, query: str) -> str:
        """Return cached result if matches+fresh, else do synchronous search.

        Always returns a non-empty string OR empty string when nothing
        relevant — caller can decide whether to inject.
        """
        # Wait briefly for in-flight background work.
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=2.0)

        with self._lock:
            ok = (
                self._cached_result
                and self._cached_query
                and time.time() - self._cached_at < CACHE_TTL_SECONDS
                and _query_match(query, self._cached_query)
            )
            if ok:
                result = self._cached_result
                # Consume — clear so we don't reuse stale data on a totally
                # different next query.
                self._cached_query = None
                self._cached_result = None
                return result or ""

        # Cache miss → synchronous search. Small latency hit (~ms).
        try:
            expanded = _expand_query_for_prefetch(query or "")
            rows = self._store.search(expanded or (query or ""), limit=5, order_by_relevance=True)
            ids = [r["id"] for r in rows[:5]]
            full = self._store.get_by_ids(ids) if ids else []
            return _render_context(full or rows)
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes prefetch sync search failed")
            return ""

    def shutdown(self) -> None:
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=3.0)
