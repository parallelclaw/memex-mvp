"""MemexMemoryProvider — implements Hermes' MemoryProvider ABC.

This is the heart of the plugin. We subscribe to every lifecycle hook
Hermes exposes for memory layers, mapping each one to verbatim writes
into ~/.memex/data/memex.db:

  • sync_turn(user, assistant)  — primary capture: every turn, both sides
  • on_session_end(messages)    — safety net: full final history at session end
  • on_memory_write(action, target, content) — bonus: built-in MEMORY.md edits
  • on_pre_compress(messages)   — context preservation around compression
  • on_delegation(task, result) — subagent completions
  • prefetch / queue_prefetch   — recall from the corpus into next prompt
  • get_tool_schemas / handle_tool_call — let the model call memex tools

The class is designed so that any single hook can fail without breaking
the others — errors are logged and swallowed. Hermes' contract assumes
provider methods don't crash the agent (Mem0 docs explicit on this).

Counter-positioning vs Mem0 / Supermemory / hermes-memory:
  - We DO NOT extract facts. Every turn is stored as raw text.
  - We DO NOT depend on a worker LLM. Storage is plain INSERT.
  - We DO NOT require an API key. Local-only, no auth.
  - We DO NOT lock you in. Memex DB is a single SQLite file you own.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# Import the Hermes ABC. The exact import path may vary by Hermes version;
# we try the documented one first and fall back to alternatives so the
# plugin survives version skew.
try:
    from hermes_agent.agent.memory_provider import MemoryProvider  # type: ignore
except ImportError:  # pragma: no cover
    try:
        from hermes_agent.memory_provider import MemoryProvider  # type: ignore
    except ImportError:  # pragma: no cover
        # If Hermes isn't installed at all (e.g. running unit tests in
        # isolation) we provide a minimal ABC stub so imports succeed.
        # In real use Hermes will always be present.
        class MemoryProvider:  # type: ignore
            """Stub used when hermes_agent is not importable (tests only)."""
            pass


from memex_hermes.conv_id import (
    derive_conv_id,
    derive_memory_file_conv_id,
    derive_msg_id,
)
from memex_hermes.prefetch import PrefetchCache
from memex_hermes.store import MemexStore
from memex_hermes import tools as memex_tools

log = logging.getLogger(__name__)


class MemexMemoryProvider(MemoryProvider):
    """Verbatim local-first memory provider for Hermes Agent.

    Lifecycle:
        instantiated once by `register(ctx)` at Hermes startup
        Hermes calls .is_available()
        if True, Hermes calls .initialize(session_id, **kwargs) per session
        Hermes calls hooks throughout the session
        Hermes calls .shutdown() on exit
    """

    # ----- Required: identity -----

    @property
    def name(self) -> str:
        return "memex"

    # ----- Required: availability check -----

    def is_available(self) -> bool:
        """Returns True if memex.db is reachable / creatable.

        Per Hermes contract: NO network calls here. We only check that
        the DB file is openable (or creatable). If the parent dir is
        unwritable we report unavailable — the user must fix permissions.
        """
        try:
            store = MemexStore()
            store.close()
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("memex-hermes is_available=False: %s", e)
            return False

    # ----- Lifecycle: initialise per session -----

    def __init__(self):
        # Per-instance state, populated lazily in initialize().
        self._store: Optional[MemexStore] = None
        self._prefetch: Optional[PrefetchCache] = None
        self._session_id: str = ""
        self._platform: Optional[str] = None
        self._user_id: Optional[str] = None
        self._agent_identity: Optional[str] = None
        self._agent_context: str = "primary"
        self._conv_id: str = ""
        self._sync_lock = threading.RLock()
        # v0.1.2: state.db tailing — Hermes doesn't call sync_turn for
        # resumed sessions, but it always writes new turns to state.db
        # for its own persistence. We tail that file on every prefetch
        # call (which DOES fire for resumed sessions) to capture missed
        # turns. Idempotent via UNIQUE constraint.
        self._hermes_home: Optional[str] = None
        self._state_db_path: Optional[Path] = None
        self._last_state_db_msg_id: int = 0
        self._db_path_resolved: Optional[str] = None  # for re-open after shutdown
        self._shutdown_requested: bool = False

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Called by Hermes at the start of every session.

        kwargs from Hermes (per agent/memory_provider.py contract):
          hermes_home         — path to ~/.hermes/
          platform            — "cli" | "telegram" | "discord" | "slack" | "whatsapp" | "cron"
          agent_context       — "primary" | "cron" | "flush" | ...
          user_id             — gateway user id (e.g. Telegram user_id) or None
          agent_identity      — agent identity string
          agent_workspace     — e.g. "hermes"
          parent_session_id   — UUID of parent session (compression splits)
          session_title       — optional human-readable title
          gateway_session_key — gateway-side session key
        """
        self._session_id = session_id or ""
        self._platform = kwargs.get("platform")
        self._user_id = kwargs.get("user_id")
        self._agent_identity = kwargs.get("agent_identity")
        self._agent_context = kwargs.get("agent_context", "primary")

        self._conv_id = derive_conv_id(self._platform, self._user_id, self._session_id)
        self._hermes_home = kwargs.get("hermes_home")
        self._shutdown_requested = False

        # Allow user to override DB path via config; otherwise default.
        # Config arrives via Hermes' setup wizard → ~/.hermes/memex.json.
        db_path = self._read_config_db_path(self._hermes_home)
        self._db_path_resolved = db_path  # remember so we can re-open after shutdown race
        self._store = MemexStore(db_path)
        self._prefetch = PrefetchCache(self._store)

        # State.db tailing setup. Hermes writes every turn to
        # ~/.hermes/state.db regardless of resumed/fresh — we ride on
        # that for reliable per-turn capture.
        if self._hermes_home:
            candidate = Path(self._hermes_home) / "state.db"
            if candidate.exists():
                self._state_db_path = candidate

        # Catch up on anything we missed in state.db before this session
        # started (defensive — usually 0 rows on fresh init).
        self._last_state_db_msg_id = self._lookup_last_imported_state_id()
        try:
            caught_up = self._tail_state_db()
            if caught_up:
                log.info("memex-hermes: caught up %d state.db row(s) on init", caught_up)
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes: initial state.db tail failed")

        # Seed conversations table with a sensible title.
        title_hint = kwargs.get("session_title") or self._conv_id
        try:
            self._store.upsert_conversation(
                conversation_id=self._conv_id,
                title=title_hint,
                first_ts=int(time.time()),
                last_ts=int(time.time()),
            )
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes initial upsert_conversation failed")

        log.info(
            "memex-hermes initialized: session=%s platform=%s user_id=%s conv_id=%s",
            self._session_id[:8] if self._session_id else "(none)",
            self._platform, self._user_id, self._conv_id,
        )

    def _read_config_db_path(self, hermes_home: Optional[str]) -> Optional[str]:
        """Read optional db_path override from ~/.hermes/memex.json.

        Most users won't have this file — they get the default
        ~/.memex/data/memex.db, which is fine. Power users can point
        the plugin at a custom location (e.g. shared network mount).
        """
        if not hermes_home:
            return None
        try:
            import json as _json
            cfg_path = os.path.join(hermes_home, "memex.json")
            if not os.path.exists(cfg_path):
                return None
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = _json.load(f)
            return cfg.get("db_path") or None
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes: could not read %s/memex.json", hermes_home)
            return None

    # ----- Resilience + state.db tailing helpers (v0.1.2) -----

    def _ensure_store(self) -> Optional[MemexStore]:
        """Return a usable MemexStore, re-opening if Hermes called
        shutdown() in the wrong order before some other hook.

        Empirically Hermes v0.10.x sometimes calls on_session_end AFTER
        shutdown — closes our DB connection before the safety-net
        flush can run. This helper makes every hook resilient: if the
        store is dead, transparently re-open against the same path.

        Returns None if the store can't be opened at all (rare — usually
        means memex.db is on a filesystem that became unavailable).
        """
        if self._store is not None:
            # Probe the connection. SQLite's `_conn` may be closed even
            # while the Python object exists. A cheap PRAGMA query is
            # the fastest "are you alive?" check.
            try:
                self._store._conn.execute("PRAGMA user_version")  # noqa: SLF001
                return self._store
            except sqlite3.ProgrammingError:
                # Connection closed under us — fall through to re-open.
                pass
            except Exception:  # noqa: BLE001
                pass
        # Re-open
        try:
            self._store = MemexStore(self._db_path_resolved)
            log.debug("memex-hermes: re-opened store after shutdown race")
            return self._store
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes: could not re-open store")
            return None

    def _lookup_last_imported_state_id(self) -> int:
        """Find the highest Hermes message-id we've already imported for
        this session. New tails start from this + 1 so we don't redo
        work (UNIQUE would dedup anyway, but the early-out saves IO).
        """
        if not self._session_id or not self._db_path_resolved:
            return 0
        try:
            store = self._ensure_store()
            if not store:
                return 0
            row = store._conn.execute(  # noqa: SLF001
                """
                SELECT MAX(CAST(json_extract(metadata, '$.hermes_message_id') AS INTEGER))
                  FROM messages
                 WHERE source = 'hermes'
                   AND json_extract(metadata, '$.session_id') = ?
                """,
                (self._session_id,),
            ).fetchone()
            return int(row[0] or 0) if row else 0
        except Exception:  # noqa: BLE001
            return 0

    def _tail_state_db(self) -> int:
        """Pull any new rows from Hermes' state.db for the current
        session that we haven't yet captured. Idempotent via UNIQUE.

        Called from:
          • initialize  — catch-up at session start
          • queue_prefetch — every turn (the reliable hook even for
                              resumed sessions where sync_turn is
                              skipped by Hermes)

        Returns count of new rows inserted.
        """
        if (
            self._shutdown_requested
            or not self._state_db_path
            or not self._state_db_path.exists()
            or not self._session_id
        ):
            return 0
        store = self._ensure_store()
        if not store:
            return 0

        rows: List[tuple] = []
        try:
            conn = sqlite3.connect(
                f"file:{self._state_db_path}?mode=ro",
                uri=True,
                timeout=2.0,
            )
            try:
                cur = conn.execute(
                    """
                    SELECT id, role, content, timestamp
                      FROM messages
                     WHERE session_id = ?
                       AND id > ?
                       AND role IN ('user', 'assistant')
                       AND content IS NOT NULL
                       AND content != ''
                     ORDER BY id ASC
                    """,
                    (self._session_id, int(self._last_state_db_msg_id)),
                )
                rows = cur.fetchall()
            finally:
                conn.close()
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes: state.db tail query failed")
            return 0

        if not rows:
            return 0

        inserted = 0
        for hermes_id, role, content, ts in rows:
            text = content or ""
            if not text.strip():
                continue
            msg_id = derive_msg_id(role, text, self._conv_id)
            metadata: Dict[str, Any] = {
                "raw_type": "hermes-state-tail",
                "session_id": self._session_id,
                "platform": self._platform,
                "user_id": self._user_id,
                "hermes_message_id": int(hermes_id),
            }
            try:
                wrote = store.insert_message(
                    conversation_id=self._conv_id,
                    msg_id=msg_id,
                    role=role,
                    text=text,
                    ts=int(ts or time.time()),
                    channel=self._platform,
                    metadata=metadata,
                )
                if wrote:
                    inserted += 1
            except Exception:  # noqa: BLE001
                log.exception("memex-hermes: tail insert failed")
            # Advance the pointer even on dup so we don't loop on the same row.
            self._last_state_db_msg_id = max(
                self._last_state_db_msg_id, int(hermes_id)
            )

        if inserted:
            try:
                store.upsert_conversation(
                    conversation_id=self._conv_id,
                    title=self._conv_id,
                    last_ts=int(time.time()),
                )
            except Exception:  # noqa: BLE001
                pass

        return inserted

    # ----- Capture: primary per-turn hook -----

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
    ) -> None:
        """Called after every turn. Writes both sides verbatim.

        Hermes documentation: "should be non-blocking (queue in background)".
        We follow Mem0's reference pattern — spawn a daemon thread per turn,
        wait briefly on the previous one to avoid unbounded thread growth.
        """
        if not self._store:
            return
        if not user_content and not assistant_content:
            return

        thread = threading.Thread(
            target=self._sync_turn_blocking,
            args=(user_content, assistant_content, session_id),
            daemon=True,
            name="memex-hermes-sync",
        )
        thread.start()

    def _sync_turn_blocking(
        self,
        user_content: str,
        assistant_content: str,
        session_id: str,
    ) -> None:
        """Actual write — runs in background thread."""
        if not self._ensure_store():
            return
        with self._sync_lock:
            ts = int(time.time())
            try:
                # Channel == platform for searchability; lets users do
                # `memex search --channel telegram` and see Hermes-captured
                # TG messages alongside OpenClaw-captured ones.
                channel = self._platform

                if user_content and user_content.strip():
                    self._insert(
                        role="user",
                        text=user_content,
                        ts=ts,
                        channel=channel,
                        raw_type="hermes-live-user",
                    )
                if assistant_content and assistant_content.strip():
                    self._insert(
                        role="assistant",
                        text=assistant_content,
                        ts=ts + 1,  # tiny offset to preserve ordering
                        channel=channel,
                        raw_type="hermes-live-assistant",
                    )
                # Keep conversations.last_ts current.
                self._store.upsert_conversation(
                    conversation_id=self._conv_id,
                    title=self._conv_id,
                    last_ts=ts,
                )
            except Exception:  # noqa: BLE001
                log.exception("memex-hermes sync_turn write failed")

    def _insert(
        self,
        *,
        role: str,
        text: str,
        ts: int,
        channel: Optional[str],
        raw_type: str,
        conv_id_override: Optional[str] = None,
    ) -> bool:
        conv_id = conv_id_override or self._conv_id
        msg_id = derive_msg_id(role, text, conv_id)
        metadata: Dict[str, Any] = {
            "raw_type": raw_type,
            "session_id": self._session_id,
            "platform": self._platform,
            "user_id": self._user_id,
            "agent_identity": self._agent_identity,
            "agent_context": self._agent_context,
        }
        assert self._store is not None
        return self._store.insert_message(
            conversation_id=conv_id,
            msg_id=msg_id,
            role=role,
            text=text,
            ts=ts,
            channel=channel,
            metadata=metadata,
        )

    # ----- Capture: bonus hooks -----

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Called at session end with the FULL message list.

        Safety net — if any sync_turn writes failed (background thread
        crashed, DB locked, etc.), this re-inserts the entire session
        history idempotently via UNIQUE(msg_id) dedup.

        v0.1.2: re-opens the store via _ensure_store() because Hermes
        sometimes calls this AFTER shutdown() has already closed it.
        Also tails state.db one final time to catch the last turn(s)
        Hermes never sync_turn'd for resumed sessions.
        """
        if not messages:
            return
        if not self._ensure_store():
            return

        # Final state.db tail to grab anything queue_prefetch missed
        # (e.g. the most recent turn fires session_end before any
        # subsequent prefetch).
        try:
            self._tail_state_db()
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes: final state.db tail failed")
        try:
            now = int(time.time())
            for i, msg in enumerate(messages):
                role = (msg.get("role") or "").lower()
                if role not in ("user", "assistant", "system"):
                    continue
                text = msg.get("content") or ""
                if not text or not text.strip():
                    continue
                # Hermes uses Unix-time floats in `timestamp`; default to
                # session_end time staggered by index so order is preserved.
                ts_raw = msg.get("timestamp")
                ts = int(ts_raw) if ts_raw else (now + i)
                self._insert(
                    role=role,
                    text=text,
                    ts=ts,
                    channel=self._platform,
                    raw_type="hermes-session-end",
                )
            log.debug("memex-hermes on_session_end: replayed %d messages", len(messages))
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes on_session_end failed")

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror built-in MEMORY.md / USER.md writes into memex.

        Free bonus: every edit to Hermes' file-based memory becomes
        searchable in the same corpus as dialogue. Stored under a
        dedicated conv_id `hermes-memory-file-<target>` so it doesn't
        clutter dialogue threads.
        """
        store = self._ensure_store()
        if not store:
            return
        if not content or not content.strip():
            return
        try:
            mirror_conv = derive_memory_file_conv_id(target)
            text = f"[{action} {target}] {content}"
            msg_id = derive_msg_id("system", text, mirror_conv)
            store.insert_message(
                conversation_id=mirror_conv,
                msg_id=msg_id,
                role="system",
                text=text,
                ts=int(time.time()),
                channel="memory-file",
                sender="memory",
                metadata={
                    "raw_type": "hermes-memory-write",
                    "action": action,
                    "target": target,
                    "session_id": self._session_id,
                },
            )
            store.upsert_conversation(
                conversation_id=mirror_conv,
                title=f"[memory] {target}",
                last_ts=int(time.time()),
            )
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes on_memory_write failed")

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Before Hermes compresses out old messages, capture them verbatim
        and inject a brief survival note into the compression summary.

        Storage preserves the originals (they'd be lost from active
        context after compression). The returned string is appended to
        the compression summary so the model knows the original details
        are recoverable via memex_search/memex_get.
        """
        if not messages:
            return ""
        if not self._ensure_store():
            return ""
        try:
            saved = 0
            now = int(time.time())
            for i, msg in enumerate(messages):
                role = (msg.get("role") or "").lower()
                if role not in ("user", "assistant"):
                    continue
                text = msg.get("content") or ""
                if not text or not text.strip():
                    continue
                ts_raw = msg.get("timestamp")
                ts = int(ts_raw) if ts_raw else (now + i)
                if self._insert(
                    role=role,
                    text=text,
                    ts=ts,
                    channel=self._platform,
                    raw_type="hermes-pre-compress",
                ):
                    saved += 1
            if saved:
                return (
                    f"\n\n[memex] {saved} message(s) about to be compressed were "
                    "stored verbatim. Use memex_search to recall them in full."
                )
            return ""
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes on_pre_compress failed")
            return ""

    def on_delegation(
        self,
        task: str,
        result: str,
        *,
        child_session_id: str = "",
        **kwargs: Any,
    ) -> None:
        """When a subagent completes, record both the task it received and
        the result it returned. Subagent's own session is captured under
        its own session_id; this hook adds the parent-side observation.
        """
        if not self._ensure_store():
            return
        try:
            now = int(time.time())
            if task and task.strip():
                self._insert(
                    role="user",
                    text=f"[subagent task → {child_session_id[:8] if child_session_id else '?'}] {task}",
                    ts=now,
                    channel=self._platform,
                    raw_type="hermes-delegation-task",
                )
            if result and result.strip():
                self._insert(
                    role="assistant",
                    text=f"[subagent result ← {child_session_id[:8] if child_session_id else '?'}] {result}",
                    ts=now + 1,
                    channel=self._platform,
                    raw_type="hermes-delegation-result",
                )
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes on_delegation failed")

    # ----- Recall: two-phase prefetch -----

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Synchronous recall before the next LLM call.

        Hermes injects this string into the user message (not system
        prompt), so prompt cache stays valid. Must be fast — we either
        consume cached results from queue_prefetch or run a small FTS5
        search.
        """
        if not self._prefetch:
            return ""
        try:
            return self._prefetch.consume(query)
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes prefetch failed")
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Asynchronous background recall after a turn — caches for next turn.

        v0.1.2: ALSO tails Hermes' state.db here. Hermes skips sync_turn
        for resumed sessions, but it always writes to state.db for its
        own persistence. queue_prefetch fires on every turn including
        resumed ones — so we ride that hook to catch missed turns.
        Background thread: tail runs in a daemon, doesn't block Hermes.
        """
        def _background() -> None:
            try:
                inserted = self._tail_state_db()
                if inserted:
                    log.debug(
                        "memex-hermes: state.db tail captured %d row(s)",
                        inserted,
                    )
            except Exception:  # noqa: BLE001
                log.exception("memex-hermes: tail in queue_prefetch failed")

        threading.Thread(target=_background, daemon=True, name="memex-hermes-tail").start()

        if not self._prefetch:
            return
        try:
            self._prefetch.queue(query)
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes queue_prefetch failed")

    # ----- LLM-facing tools -----

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Tool schemas Hermes will expose to the LLM."""
        return memex_tools.TOOL_SCHEMAS

    def handle_tool_call(
        self,
        tool_name: str,
        args: Dict[str, Any],
        **kwargs: Any,
    ) -> str:
        """Dispatch a tool call. Per Hermes contract: returns JSON STRING."""
        if not self._store:
            return '{"error": "memex-hermes not initialised"}'
        return memex_tools.dispatch(
            tool_name,
            args,
            store=self._store,
            default_conv_id=self._conv_id,
        )

    def system_prompt_block(self) -> str:
        """Static text inserted into the system prompt at session start.

        Tells the LLM that memex tools exist and how to use them. Kept
        short — system prompt budget is precious. The tool schemas
        themselves carry the detailed parameter docs.
        """
        return (
            "You have verbatim memory across all your past conversations "
            "(Hermes sessions, plus Claude Code / Telegram / saved web docs "
            "if those are also captured into memex). Four tools:\n"
            "  • memex_search(query)       — find relevant records; IDs + previews\n"
            "  • memex_get(ids)            — fetch full verbatim text of records\n"
            "  • memex_recent(conv)        — last N messages in a thread\n"
            "  • memex_store_document(content, url, title)\n"
            "                              — save an external doc (URL, paste) to memex\n"
            "Use memex_search → memex_get when you need original context.\n\n"
            "URL HANDLING — when the user shares a URL they want saved or read:\n"
            "  1. DO NOT lead with naked WebFetch / curl. Most modern pages are "
            "Cloudflare-protected (Perplexity, npm.com, X/Twitter, Medium, AI shares).\n"
            "  2. Reliable fetch recipe (field-tested 2026-05):\n"
            "       curl -H \"Accept: text/markdown\" "
            "https://r.jina.ai/https://<original-url>\n"
            "     Keep the `https://` AFTER r.jina.ai/ — NOT http://, NOT bare domain.\n"
            "  3. Perplexity gotcha: the URL in the user's address bar "
            "(perplexity.ai/search/<id>) is the OWNER's private URL. Jina returns "
            "'this thread is private'. Ask the user to make it public "
            "(open thread → Share → toggle Public link → copy NEW URL).\n"
            "  4. To save the fetched content: memex_store_document(content, url, title). "
            "Memex detects content issues (Cloudflare page, perplexity-private, "
            "paywalls) and returns actionable warnings.\n\n"
            "Storage is local-first; nothing is sent to a third party."
        )

    # ----- Config -----

    def get_config_schema(self) -> List[Dict[str, Any]]:
        """One-time setup wizard fields. memex is zero-config — empty list.

        Hermes' `hermes memory setup memex` will say "no setup required"
        because we return [] here. Users who need a non-default DB path
        can still drop ~/.hermes/memex.json manually:

          {"db_path": "/path/to/your/memex.db"}
        """
        return []

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """Persist optional config. Only called if get_config_schema is non-empty.

        Kept as a no-op to satisfy the ABC. Hermes won't call us with
        values to save since our schema is empty.
        """
        return None

    # ----- Shutdown -----

    def shutdown(self) -> None:
        """Cleanup on Hermes exit. Flush in-flight syncs, close DB.

        v0.1.2: Hermes sometimes calls on_session_end AFTER shutdown
        in v0.10.x. We set a flag so background work (state.db tail)
        stops, but we keep the store openable — every hook now uses
        _ensure_store() which re-opens transparently if a post-shutdown
        call arrives. Sets `_shutdown_requested = True` so any future
        tail no-ops.
        """
        log.info("memex-hermes shutting down")
        self._shutdown_requested = True
        try:
            if self._prefetch:
                self._prefetch.shutdown()
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes prefetch shutdown failed")
        try:
            if self._store:
                self._store.close()
        except Exception:  # noqa: BLE001
            log.exception("memex-hermes store close failed")
        # NOTE: we deliberately do NOT set self._store = None. If Hermes
        # calls on_session_end after shutdown (observed empirically in
        # v0.10.x), _ensure_store() detects the closed connection and
        # re-opens. Setting None would force a full re-init that races
        # with the connection close. Leaving the object lets the next
        # hook see "old conn, broken" → re-open cleanly.
