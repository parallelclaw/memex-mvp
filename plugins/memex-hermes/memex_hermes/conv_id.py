"""Conversation-ID derivation for Hermes messages.

Hermes is a multi-gateway agent (Telegram, Discord, Slack, WhatsApp, CLI,
cron, ...). For memory routing we want all messages from the same user on
the same gateway to share a conversation thread, even when they span many
Hermes sessions — same model as memex's OpenClaw integration where
`openclaw-tg-<sender_id>` groups all Telegram messages from one user.

Strategy:
    platform + user_id present  → hermes-<platform>-<user_id>
      (per-user thread, cross-session, the common case for gateways)
    platform only (no user_id)  → hermes-<platform>-<session8>
      (CLI sessions and similar single-user platforms)
    nothing                     → hermes-<session8>
      (fallback for unusual setups)

`platform` mirrors Hermes' `sessions.source` column values:
    "cli", "telegram", "discord", "whatsapp", "slack", "cron"
"""

from __future__ import annotations

import hashlib
from typing import Optional


def _session_short(session_id: str) -> str:
    """First 8 hex-ish chars of session_id, dashes stripped.

    Hermes session_ids are UUIDs like "abc12345-ea6e-4e08-a83a-c596288bcfe3".
    We use the first 8 chars as a short identifier — same convention as
    memex-mvp uses for Claude Code and OpenClaw session UUIDs.
    """
    if not session_id:
        return "unknown"
    return session_id.replace("-", "").lower()[:8] or "unknown"


def derive_conv_id(
    platform: Optional[str],
    user_id: Optional[str],
    session_id: str,
) -> str:
    """Compute conversation_id for a Hermes message.

    Examples:
        >>> derive_conv_id("telegram", "97592799", "abc-123")
        'hermes-telegram-97592799'
        >>> derive_conv_id("cli", None, "abc12345-ea6e-4e08")
        'hermes-cli-abc12345'
        >>> derive_conv_id(None, None, "abc12345-ea6e-4e08")
        'hermes-abc12345'
    """
    platform = (platform or "").strip().lower() or None
    user_id = (str(user_id).strip() if user_id is not None else "") or None

    if platform and user_id:
        # Per-user thread across all sessions on this platform.
        return f"hermes-{platform}-{user_id}"
    if platform:
        # Platform without per-user identifier (cli, cron, etc.).
        return f"hermes-{platform}-{_session_short(session_id)}"
    # Fallback when Hermes didn't tell us the platform — shouldn't happen
    # in practice but kept for safety.
    return f"hermes-{_session_short(session_id)}"


def derive_msg_id(role: str, text: str, conv_id: str) -> str:
    """Stable message-ID for the verbatim row.

    UNIQUE(source, conversation_id, msg_id) in memex.db gives us
    idempotency: re-running sync_turn or backfill with the same content
    won't create duplicates. The hash includes role + conv_id so the
    same text said by different sides (or in different conversations)
    produces distinct IDs.

    Format: hermes-<sha1(role|text|conv_id)[:16]>
    """
    payload = f"{role}\x00{text}\x00{conv_id}".encode("utf-8")
    digest = hashlib.sha1(payload).hexdigest()[:16]
    return f"hermes-{digest}"


def derive_memory_file_conv_id(target: str) -> str:
    """Conversation ID for built-in memory-file mirror writes.

    When Hermes' built-in memory writes to MEMORY.md or USER.md, we capture
    those edits into a dedicated conversation so they're searchable
    alongside dialogue history.

    target: "memory" (MEMORY.md) or "user" (USER.md)
    """
    target_norm = (target or "unknown").strip().lower()
    return f"hermes-memory-file-{target_norm}"
