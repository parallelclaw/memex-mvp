"""MCP tool schemas exposed by memex-hermes to the Hermes LLM.

Three tools, designed around progressive disclosure (the pattern claude-mem
proved gives ~10× token savings):

  memex_search   — Tier 1: query → list of {id, ts, role, preview}. Cheap.
  memex_get      — Tier 2: ids[] → full verbatim text. Expensive, by request only.
  memex_recent   — recent N messages in a conversation thread.

The model uses memex_search to browse, picks relevant IDs, then memex_get for
the few records it actually wants in full. Saves tokens vs returning full text
in search results upfront.

Hermes' MemoryProvider contract: handle_tool_call returns a JSON STRING
(not dict), so each handler json.dumps its output. Schemas follow the
OpenAI tool format used internally by Hermes.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "name": "memex_search",
        "description": (
            "Search verbatim past conversations across all sources unified in memex "
            "(Hermes, Claude Code, OpenClaw, Telegram, saved web docs, etc.). "
            "Uses SQLite FTS5. "
            "Returns abbreviated records — id + 100-char preview + role + timestamp. "
            "Call memex_get(ids) afterwards to fetch full text of specific records. "
            "Use this BEFORE memex_get to find what's relevant; rarely call memex_get directly.\n\n"
            "💡 If the user wants to save a NEW URL (Perplexity thread, article, "
            "AI-chat share) — that's memex_store_document, not memex_search. "
            "For Cloudflare-protected pages fetch via Jina Reader first: "
            "`curl -H \"Accept: text/markdown\" https://r.jina.ai/https://<URL>`."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "FTS5 query. Simple keywords work; phrases use double quotes. "
                        "Example: 'install ffmpeg' or '\"docker compose\" production'."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (default 10, max 50).",
                    "default": 10,
                },
                "channel": {
                    "type": "string",
                    "description": (
                        "Filter by channel (e.g. 'telegram', 'discord', 'kimi-web', "
                        "'cli'). Omit for all channels."
                    ),
                },
                "since_days": {
                    "type": "integer",
                    "description": "Restrict to messages from the last N days.",
                },
                "conversation_id": {
                    "type": "string",
                    "description": "Restrict to one conversation thread.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "memex_get",
        "description": (
            "Fetch full verbatim text of specific records by ID. "
            "Call this after memex_search to read the records that look "
            "relevant. Returns the original text in full, not a summary."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "ids": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Record IDs returned by memex_search.",
                },
            },
            "required": ["ids"],
        },
    },
    {
        "name": "memex_store_document",
        "description": (
            "Save an external document (web page, AI chat share, pasted text) "
            "to memex memory. Memex stores verbatim what you pass — it does "
            "NOT fetch URLs itself, that's your job (memex stays 100% local).\n\n"
            "TYPICAL FLOW for a URL:\n"
            "  content = WebFetch(url)\n"
            "  memex_store_document(content, url, title)\n\n"
            "⚠ JINA TRICK for Cloudflare-protected pages (Perplexity, "
            "npm.com, X/Twitter, Medium, ChatGPT shares):\n"
            "  Field-tested recipe (fixed empirically 2026-05):\n"
            "    curl -H \"Accept: text/markdown\" "
            "https://r.jina.ai/https://<original-url>\n"
            "  Critical: keep the `https://` AFTER r.jina.ai/ (NOT http://) "
            "and add the Accept header for clean markdown.\n\n"
            "PERPLEXITY GOTCHA: the URL in the address bar "
            "(perplexity.ai/search/<id>) is the OWNER's private URL — Jina "
            "returns 'this thread is private'. Ask the user to make it "
            "public: open thread → Share → toggle Public link → copy the "
            "NEW URL. memex auto-detects this case and returns a "
            "type=perplexity-private warning with the exact instructions; "
            "surface that message verbatim.\n\n"
            "Returns JSON: {stored, conversation_id, title, length, warnings[]}. "
            "If stored=false, the warnings array tells you exactly what to "
            "say to the user."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": (
                        "The fetched page content as text or markdown. YOU "
                        "(the agent) fetch this via WebFetch / curl / Jina. "
                        "Memex stores it verbatim — no LLM processing, no "
                        "summarization."
                    ),
                },
                "url": {
                    "type": "string",
                    "description": (
                        "The original source URL. Used to compute a stable "
                        "conversation_id (sha256 of the canonical URL), so "
                        "re-storing the same article is idempotent. Omit "
                        "for non-URL pastes — memex assigns a content-hash "
                        "based id."
                    ),
                },
                "title": {
                    "type": "string",
                    "description": (
                        "Page title or document name. If omitted, memex "
                        "extracts from content (markdown H1 → H2 → HTML "
                        "title → URL slug → 'Untitled document')."
                    ),
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional tags stored in metadata (e.g. ['research', "
                        "'perplexity']). Lowercased + deduped on store."
                    ),
                },
                "refresh": {
                    "type": "boolean",
                    "default": False,
                    "description": (
                        "If a document with the same canonical URL is already "
                        "stored, set true to overwrite (re-fetch). Default "
                        "false = skip with 'already in memex' note + the "
                        "existing conversation_id."
                    ),
                },
            },
            "required": ["content"],
        },
    },
    {
        "name": "memex_recent",
        "description": (
            "Last N messages in a conversation thread, in chronological order. "
            "Useful for resuming context in an existing thread."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "conversation_id": {
                    "type": "string",
                    "description": (
                        "Conversation ID. Defaults to current Hermes session's "
                        "conversation if omitted."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": "How many recent messages (default 20, max 100).",
                    "default": 20,
                },
            },
        },
    },
]


def handle_search(store, args: Dict[str, Any]) -> str:
    """memex_search handler. Returns JSON string per MemoryProvider contract."""
    query = (args or {}).get("query", "")
    limit = min(max(int((args or {}).get("limit", 10) or 10), 1), 50)
    channel = (args or {}).get("channel")
    conv_id = (args or {}).get("conversation_id")
    since_days = (args or {}).get("since_days")
    since_ts = None
    if since_days:
        since_ts = int(time.time()) - int(since_days) * 86400

    rows = store.search(
        query,
        limit=limit,
        channel=channel,
        since_ts=since_ts,
        conversation_id=conv_id,
    )
    if not rows:
        return json.dumps({"results": [], "hint": "No matches. Try different keywords."})
    return json.dumps({
        "results": rows,
        "count": len(rows),
        "hint": "Call memex_get(ids=[...]) for full text of records you want to read.",
    }, ensure_ascii=False)


def handle_get(store, args: Dict[str, Any]) -> str:
    """memex_get handler."""
    ids = (args or {}).get("ids", []) or []
    if not isinstance(ids, list) or not ids:
        return json.dumps({"error": "ids must be a non-empty list of integers"})
    # Cap at 20 to avoid runaway token usage even if model asks for many.
    capped = ids[:20]
    rows = store.get_by_ids([int(x) for x in capped])
    truncated = len(ids) > len(capped)
    out: Dict[str, Any] = {"records": rows, "count": len(rows)}
    if truncated:
        out["truncated"] = True
        out["hint"] = f"Capped at 20 records; {len(ids) - 20} more were not fetched."
    return json.dumps(out, ensure_ascii=False)


def handle_store_document(store, args: Dict[str, Any]) -> str:
    """memex_store_document handler. Returns JSON string.

    v0.2.2: lets Hermes save URLs (Perplexity threads, articles, AI-chat
    shares) into memex.db with the same conv_id/dedup semantics as
    memex-mvp's MCP server. Detection logic (Cloudflare challenge,
    Perplexity-private, login-walls, paywalls) is ported from
    memex-mvp's lib/store-doc/ — see store_doc.py.

    Returns JSON:
      success path:    {stored: true, conversation_id, title, length}
      already in memex: {stored: false, conversation_id, reason: 'duplicate'}
      blocked by content: {stored: false, conversation_id, warnings: [...]}
      empty content:   {error: 'content is required and must be non-empty'}
    """
    # Lazy-import store_doc to keep cold-start fast on memex-hermes
    # paths that never store a document.
    from memex_hermes.store_doc import (
        canonicalize,
        conversation_id_for_url,
        detect_issues,
        extract_domain,
        extract_title,
        is_blocked,
    )

    a = args or {}
    content = a.get("content")
    if not isinstance(content, str) or not content.strip():
        return json.dumps({"error": "content is required and must be a non-empty string"})

    url = a.get("url")
    if url is not None and not isinstance(url, str):
        return json.dumps({"error": "url, if provided, must be a string"})

    tags_in = a.get("tags") or []
    if not isinstance(tags_in, list):
        return json.dumps({"error": "tags, if provided, must be a list of strings"})
    tags = sorted({str(t).lower().strip() for t in tags_in if str(t).strip()})

    refresh = bool(a.get("refresh", False))

    # Detect content issues BEFORE storing — blocking warnings short-circuit.
    warnings = detect_issues(content, url)
    if is_blocked(warnings):
        return json.dumps({
            "stored": False,
            "warnings": warnings,
            "hint": "Surface the warning message to the user verbatim — it tells them exactly how to fix it.",
        }, ensure_ascii=False)

    conv_id = conversation_id_for_url(url, content=content)

    # Idempotency: don't re-store same URL unless refresh=True.
    if not refresh and store.web_document_exists(conv_id):
        return json.dumps({
            "stored": False,
            "conversation_id": conv_id,
            "reason": "duplicate",
            "hint": (
                "This document is already in memex (matched by canonical URL). "
                "Pass refresh=true to overwrite with the new content."
            ),
        })

    title = a.get("title") or extract_title(content, url)
    domain = extract_domain(url) if url else None
    canonical_url = canonicalize(url) if url else None
    msg_id = hashlib.sha1(
        f"web\x00{conv_id}\x00{content}".encode("utf-8")
    ).hexdigest()[:16]
    ts = int(time.time())

    metadata = {
        "title": title,
        "url": canonical_url,
        "original_url": url if (url and url != canonical_url) else None,
        "domain": domain,
        "tags": tags,
        "warnings": warnings,  # non-blocking warnings, if any
    }
    metadata = {k: v for k, v in metadata.items() if v is not None and v != []}

    stored = store.insert_web_document(
        conversation_id=conv_id,
        msg_id=msg_id,
        text=content,
        ts=ts,
        title=title,
        url=canonical_url,
        domain=domain,
        metadata=metadata,
    )
    if stored:
        store.upsert_web_conversation(
            conversation_id=conv_id,
            title=title,
            url=canonical_url,
            ts=ts,
        )

    out = {
        "stored": stored,
        "conversation_id": conv_id,
        "title": title,
        "length": len(content),
    }
    if warnings:
        out["warnings"] = warnings
    if not stored:
        out["hint"] = "INSERT OR IGNORE hit a UNIQUE collision — same content already stored under this conv_id."
    return json.dumps(out, ensure_ascii=False)


def handle_recent(store, args: Dict[str, Any], *, default_conv_id: Optional[str] = None) -> str:
    """memex_recent handler. Uses default_conv_id if no conversation_id given."""
    conv_id = (args or {}).get("conversation_id") or default_conv_id
    if not conv_id:
        return json.dumps({"error": "no conversation_id given and no current session conv_id available"})
    limit = min(max(int((args or {}).get("limit", 20) or 20), 1), 100)
    rows = store.recent(conv_id, limit=limit)
    return json.dumps(
        {"conversation_id": conv_id, "messages": rows, "count": len(rows)},
        ensure_ascii=False,
    )


def dispatch(
    tool_name: str,
    args: Dict[str, Any],
    *,
    store,
    default_conv_id: Optional[str] = None,
) -> str:
    """Route a tool call to the right handler. Returns JSON string.

    Unknown tool names produce a JSON error rather than raising — keeps the
    LLM-facing surface predictable.
    """
    try:
        if tool_name == "memex_search":
            return handle_search(store, args)
        if tool_name == "memex_get":
            return handle_get(store, args)
        if tool_name == "memex_recent":
            return handle_recent(store, args, default_conv_id=default_conv_id)
        if tool_name == "memex_store_document":  # v0.2.2+
            return handle_store_document(store, args)
        return json.dumps({"error": f"unknown tool: {tool_name}"})
    except Exception as e:  # noqa: BLE001
        log.exception("memex-hermes: tool %s failed", tool_name)
        return json.dumps({"error": f"{type(e).__name__}: {e}"})
