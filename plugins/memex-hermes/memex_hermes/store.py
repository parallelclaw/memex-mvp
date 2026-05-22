"""SQLite layer for memex-hermes.

Opens the shared memex.db at ~/.memex/data/memex.db, creates schema if
absent, and exposes the verbatim-insert + search operations the plugin
needs.

Design choices:

  • WAL mode — concurrent reads from `memex` CLI / MCP server are safe
    while we write. Hermes calls sync_turn frequently; WAL prevents
    "database is locked" errors.

  • Schema parity with memex-mvp (Node) — same tables, same columns,
    same UNIQUE(source, conversation_id, msg_id) constraint. So the DB
    is fully interoperable with the Node CLI. Users can install
    memex-mvp via npm OR get a working DB from this Python plugin
    alone — neither side blocks the other.

  • Stdlib sqlite3 — no extra dependencies. The Python sqlite3 module
    ships with all supported Python versions and includes FTS5 (since
    Python 3.7 on most distros).

  • Schema migrations idempotent — every CREATE uses IF NOT EXISTS,
    every ALTER is wrapped to swallow "duplicate column" errors. Re-
    initialising against an existing DB is a no-op.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


# Path priority: explicit > env var > default.
DEFAULT_DB_PATH = "~/.memex/data/memex.db"


def resolve_db_path(explicit: Optional[str] = None) -> Path:
    """Return the absolute path to memex.db, expanding ~ as needed."""
    if explicit:
        return Path(os.path.expanduser(explicit)).resolve()
    env = os.environ.get("MEMEX_DB")
    if env:
        return Path(os.path.expanduser(env)).resolve()
    return Path(os.path.expanduser(DEFAULT_DB_PATH)).resolve()


def _safe_exec(conn: sqlite3.Connection, sql: str) -> None:
    """Run a DDL statement, swallowing 'duplicate column' from ALTER."""
    try:
        conn.execute(sql)
    except sqlite3.OperationalError as e:
        if "duplicate column" in str(e).lower():
            return
        raise


def initialise_schema(conn: sqlite3.Connection) -> None:
    """Create memex tables + FTS5 if they don't exist.

    Mirrors lib/db-init.js in memex-mvp. Idempotent. Safe to call against
    a memex-mvp-created DB — every CREATE checks IF NOT EXISTS.
    """
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS messages (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          source          TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          msg_id          TEXT,
          role            TEXT,
          sender          TEXT,
          text            TEXT,
          ts              INTEGER,
          metadata        TEXT,
          UNIQUE(source, conversation_id, msg_id)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text, sender, conversation_id, source,
          content=messages, content_rowid=id,
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TABLE IF NOT EXISTS conversations (
          conversation_id        TEXT PRIMARY KEY,
          source                 TEXT NOT NULL,
          title                  TEXT,
          first_ts               INTEGER,
          last_ts                INTEGER,
          message_count          INTEGER DEFAULT 0
        );
    """)

    # ALTER-style migrations to match memex-mvp v0.11.x schema.
    _safe_exec(conn, "ALTER TABLE messages ADD COLUMN edited_at INTEGER")
    _safe_exec(conn, "ALTER TABLE messages ADD COLUMN uuid TEXT")
    _safe_exec(conn, "ALTER TABLE messages ADD COLUMN channel TEXT")
    _safe_exec(conn, "ALTER TABLE conversations ADD COLUMN archived_at INTEGER")
    _safe_exec(conn, "ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT")
    _safe_exec(conn, "ALTER TABLE conversations ADD COLUMN project_path TEXT")
    _safe_exec(conn, "ALTER TABLE conversations ADD COLUMN pending_parent_uuid TEXT")

    conn.executescript("""
        CREATE INDEX IF NOT EXISTS idx_messages_uuid
          ON messages(uuid) WHERE uuid IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_messages_channel
          ON messages(channel) WHERE channel IS NOT NULL;

        DROP TRIGGER IF EXISTS messages_fts_ai;
        DROP TRIGGER IF EXISTS messages_fts_ad;
        DROP TRIGGER IF EXISTS messages_fts_au;
        CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
          WHEN new.role != 'summary' BEGIN
            INSERT INTO messages_fts(rowid, text, sender, conversation_id, source)
            VALUES (new.id, new.text, new.sender, new.conversation_id, new.source);
          END;
        CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.id;
          INSERT INTO messages_fts(rowid, text, sender, conversation_id, source)
            SELECT new.id, new.text, new.sender, new.conversation_id, new.source
             WHERE new.role != 'summary';
        END;
    """)
    conn.commit()


class MemexStore:
    """Thread-safe SQLite writer/reader for memex.db.

    Hermes calls our hooks (sync_turn, prefetch, on_session_end, ...) from
    its own threads. sqlite3 connections aren't sharable across threads
    by default, so we serialize all DB access through a single lock +
    single connection. For our write/read volumes (handful per turn) this
    is fine — sqlite + WAL handles it.
    """

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = resolve_db_path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; we manage transactions explicitly
        )
        self._conn.row_factory = sqlite3.Row
        initialise_schema(self._conn)
        log.info("memex-hermes: opened %s", self.db_path)

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass

    # ----- Writes -----

    def insert_message(
        self,
        *,
        conversation_id: str,
        msg_id: str,
        role: str,
        text: str,
        ts: int,
        channel: Optional[str] = None,
        sender: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Insert one verbatim message. Returns True if a new row was created,
        False if it was a duplicate (UNIQUE constraint hit — idempotent).
        """
        if not text or not text.strip():
            return False
        meta_json = json.dumps(metadata or {}, ensure_ascii=False)
        sender_norm = sender or ("me" if role == "user" else "hermes")
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT OR IGNORE INTO messages
                  (source, conversation_id, msg_id, role, sender, text, ts, metadata, channel)
                VALUES ('hermes', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (conversation_id, msg_id, role, sender_norm, text, ts, meta_json, channel),
            )
            return cur.rowcount > 0

    def upsert_conversation(
        self,
        *,
        conversation_id: str,
        title: Optional[str] = None,
        first_ts: Optional[int] = None,
        last_ts: Optional[int] = None,
    ) -> None:
        """Create / update the conversations row for a Hermes thread.

        Called lazily from sync_turn — keeps the conv list in memex CLI
        showing reasonable titles + date ranges.
        """
        if not title:
            title = conversation_id
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO conversations
                  (conversation_id, source, title, first_ts, last_ts, message_count)
                VALUES (?, 'hermes', ?, ?, ?, 0)
                ON CONFLICT(conversation_id) DO UPDATE SET
                  title    = COALESCE(conversations.title, excluded.title),
                  first_ts = MIN(COALESCE(conversations.first_ts, excluded.first_ts), excluded.first_ts),
                  last_ts  = MAX(COALESCE(conversations.last_ts,  excluded.last_ts),  excluded.last_ts),
                  message_count = (
                    SELECT COUNT(*) FROM messages
                     WHERE messages.conversation_id = conversations.conversation_id
                  )
                """,
                (conversation_id, title, first_ts, last_ts),
            )

    # ----- Reads -----

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        channel: Optional[str] = None,
        since_ts: Optional[int] = None,
        conversation_id: Optional[str] = None,
        order_by_relevance: bool = False,
    ) -> List[Dict[str, Any]]:
        """FTS5 search. Returns abbreviated rows (id, ts, role, preview).

        Full text is fetched via get_by_ids() — this is the
        progressive-disclosure pattern that keeps token usage low.

        order_by_relevance=False (default, user-facing) → ORDER BY ts DESC
            shows recent matches first; matches how a chat search feels.

        order_by_relevance=True (prefetch path) → ORDER BY bm25(messages_fts)
            best matches first regardless of date; useful when query has
            many OR-tokens and you want the most relevant of the bunch.
        """
        if not query or not query.strip():
            return []
        filters = []
        params: List[Any] = [query.strip()]
        if channel:
            filters.append("m.channel = ?")
            params.append(channel)
        if since_ts:
            filters.append("m.ts >= ?")
            params.append(since_ts)
        if conversation_id:
            filters.append("m.conversation_id = ?")
            params.append(conversation_id)
        where = (" AND " + " AND ".join(filters)) if filters else ""
        order_clause = "bm25(messages_fts)" if order_by_relevance else "m.ts DESC"
        sql = f"""
          SELECT m.id, m.ts, m.role, m.conversation_id, m.channel,
                 substr(m.text, 1, 100) AS preview
            FROM messages_fts f
            JOIN messages m ON m.id = f.rowid
           WHERE f.text MATCH ? {where}
           ORDER BY {order_clause}
           LIMIT ?
        """
        params.append(int(limit))
        with self._lock:
            try:
                rows = self._conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError as e:
                # Malformed FTS query — return empty rather than crash.
                log.warning("memex-hermes: FTS query failed: %s (query=%r)", e, query)
                return []
        return [dict(r) for r in rows]

    def get_by_ids(self, ids: List[int]) -> List[Dict[str, Any]]:
        """Full verbatim rows by primary key. Used after search()."""
        if not ids:
            return []
        placeholders = ",".join("?" * len(ids))
        sql = f"""
          SELECT id, ts, role, sender, conversation_id, channel, text, metadata
            FROM messages
           WHERE id IN ({placeholders})
           ORDER BY ts ASC
        """
        with self._lock:
            rows = self._conn.execute(sql, [int(i) for i in ids]).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["metadata"] = json.loads(d.get("metadata") or "{}")
            except (TypeError, ValueError):
                d["metadata"] = {}
            out.append(d)
        return out

    def recent(
        self,
        conversation_id: str,
        *,
        limit: int = 20,
    ) -> List[Dict[str, Any]]:
        """Last N messages in a conversation, chronological."""
        if not conversation_id:
            return []
        sql = """
          SELECT id, ts, role, sender, text
            FROM messages
           WHERE conversation_id = ?
           ORDER BY ts DESC
           LIMIT ?
        """
        with self._lock:
            rows = self._conn.execute(sql, (conversation_id, int(limit))).fetchall()
        # Reverse to chronological order (oldest first) for readability.
        return [dict(r) for r in reversed(rows)]

    def count(self, conversation_id: Optional[str] = None) -> int:
        """Row count, optionally filtered by conv. Useful for diagnostics."""
        with self._lock:
            if conversation_id:
                row = self._conn.execute(
                    "SELECT COUNT(*) FROM messages WHERE conversation_id = ?",
                    (conversation_id,),
                ).fetchone()
            else:
                row = self._conn.execute(
                    "SELECT COUNT(*) FROM messages WHERE source = 'hermes'"
                ).fetchone()
        return int(row[0]) if row else 0

    def exists(self, conversation_id: str, msg_id: str) -> bool:
        """Check whether a (source='hermes', conversation_id, msg_id) triple
        already exists in memex.db. Used by backfill --dry-run to predict
        what an actual run would dedup vs. insert.

        Matches exactly the UNIQUE constraint used by insert_message, so
        existence here ⇔ INSERT OR IGNORE would be a no-op.
        """
        if not conversation_id or not msg_id:
            return False
        with self._lock:
            row = self._conn.execute(
                """
                SELECT 1
                  FROM messages
                 WHERE source = 'hermes'
                   AND conversation_id = ?
                   AND msg_id = ?
                 LIMIT 1
                """,
                (conversation_id, msg_id),
            ).fetchone()
        return row is not None
