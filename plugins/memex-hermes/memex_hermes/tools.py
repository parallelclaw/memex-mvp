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
            "(Hermes, Claude Code, OpenClaw, Telegram, etc.). Uses SQLite FTS5. "
            "Returns abbreviated records — id + 100-char preview + role + timestamp. "
            "Call memex_get(ids) afterwards to fetch full text of specific records. "
            "Use this BEFORE memex_get to find what's relevant; rarely call memex_get directly."
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
        return json.dumps({"error": f"unknown tool: {tool_name}"})
    except Exception as e:  # noqa: BLE001
        log.exception("memex-hermes: tool %s failed", tool_name)
        return json.dumps({"error": f"{type(e).__name__}: {e}"})
