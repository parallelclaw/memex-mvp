"""Tests for state.db tailing (v0.1.2 fix).

Hermes doesn't call sync_turn for resumed sessions — only writes to its
own state.db. We tail state.db on every queue_prefetch (which always
fires) to capture missed turns. These tests verify the tail logic:

  • _tail_state_db catches new rows
  • Idempotent on re-tail (UNIQUE dedup)
  • Tracks _last_state_db_msg_id correctly to avoid re-reading
  • initialize() does a catch-up tail
  • on_session_end forces a final tail
  • Resilient to shutdown-race (re-opens store via _ensure_store)
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes.provider import MemexMemoryProvider  # noqa: E402


def _make_hermes_state_db(path: Path) -> None:
    """Create a minimal state.db matching Hermes' real schema."""
    conn = sqlite3.connect(str(path))
    conn.executescript("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            user_id TEXT,
            started_at REAL NOT NULL,
            title TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            timestamp REAL NOT NULL
        );
    """)
    conn.commit()
    conn.close()


def _add_state_message(state_db: Path, *, session_id: str, role: str, content: str, ts: float) -> int:
    conn = sqlite3.connect(str(state_db))
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        (session_id, role, content, ts),
    )
    new_id = cur.lastrowid
    conn.commit()
    conn.close()
    return new_id


class TestStateTail(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes_home = Path(self.tmp.name) / ".hermes"
        self.hermes_home.mkdir()
        self.state_db = self.hermes_home / "state.db"
        _make_hermes_state_db(self.state_db)

        memex_db = str(Path(self.tmp.name) / "memex.db")
        os.environ["MEMEX_DB"] = memex_db

        self.session_id = "sess-resumed-abc-123"

        # Seed state.db with sessions row + 2 messages BEFORE init.
        conn = sqlite3.connect(str(self.state_db))
        conn.execute(
            "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?, ?, ?, ?)",
            (self.session_id, "telegram", "42", time.time() - 1000),
        )
        conn.commit()
        conn.close()
        _add_state_message(
            self.state_db, session_id=self.session_id,
            role="user", content="historical user msg", ts=time.time() - 900,
        )
        _add_state_message(
            self.state_db, session_id=self.session_id,
            role="assistant", content="historical assistant msg", ts=time.time() - 890,
        )

        self.p = MemexMemoryProvider()

    def tearDown(self):
        try:
            self.p.shutdown()
        except Exception:
            pass
        os.environ.pop("MEMEX_DB", None)
        self.tmp.cleanup()

    def _init(self):
        self.p.initialize(
            session_id=self.session_id,
            platform="telegram",
            user_id="42",
            hermes_home=str(self.hermes_home),
        )

    def test_initialize_catches_up_existing_state(self):
        """On first init, all pre-existing rows from this session in
        state.db should land in memex.db (catch-up tail)."""
        self._init()
        # Wait a moment in case any init-side thread is still going
        # (init's tail is synchronous, but be safe).
        time.sleep(0.1)
        count = self.p._store.count("hermes-telegram-42")
        self.assertEqual(count, 2, "init should catch up 2 existing rows")

    def test_tail_picks_up_new_rows(self):
        """After init, a NEW row in state.db should be captured on the
        next _tail_state_db() call (i.e. next queue_prefetch)."""
        self._init()
        # Hermes writes a new turn to state.db (out of our sight).
        _add_state_message(
            self.state_db, session_id=self.session_id,
            role="user", content="brand new user message", ts=time.time(),
        )
        # Trigger our tail (this is what queue_prefetch does).
        inserted = self.p._tail_state_db()
        self.assertEqual(inserted, 1)
        # Now it's in memex.db.
        count = self.p._store.count("hermes-telegram-42")
        self.assertEqual(count, 3)

    def test_tail_idempotent_on_no_new_rows(self):
        self._init()
        first = self.p._tail_state_db()
        second = self.p._tail_state_db()
        third = self.p._tail_state_db()
        # All three should report 0 new (init already grabbed everything).
        self.assertEqual(first, 0)
        self.assertEqual(second, 0)
        self.assertEqual(third, 0)

    def test_tail_advances_pointer_to_avoid_rework(self):
        """_last_state_db_msg_id should advance so subsequent tails
        don't re-read old rows."""
        self._init()
        before = self.p._last_state_db_msg_id
        _add_state_message(
            self.state_db, session_id=self.session_id,
            role="user", content="msg-X", ts=time.time(),
        )
        self.p._tail_state_db()
        after = self.p._last_state_db_msg_id
        self.assertGreater(after, before)

    def test_tail_ignores_other_sessions(self):
        """Only THIS session's rows get captured; other sessions are
        someone else's problem (their own MemexMemoryProvider init
        will pick them up)."""
        self._init()
        # Other session in same state.db
        conn = sqlite3.connect(str(self.state_db))
        conn.execute(
            "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?, ?, ?, ?)",
            ("OTHER-SESSION", "discord", "99", time.time()),
        )
        conn.commit()
        conn.close()
        _add_state_message(
            self.state_db, session_id="OTHER-SESSION",
            role="user", content="not for me", ts=time.time(),
        )

        inserted = self.p._tail_state_db()
        self.assertEqual(inserted, 0, "should only tail current session")

    def test_tail_skips_tool_messages(self):
        """Hermes' state.db has role='tool' rows (tool_result records).
        Backfill schema only takes user+assistant — tail should match.
        """
        self._init()
        _add_state_message(
            self.state_db, session_id=self.session_id,
            role="tool", content='{"tool":"output"}', ts=time.time(),
        )
        inserted = self.p._tail_state_db()
        self.assertEqual(inserted, 0)

    def test_tail_skips_empty_content(self):
        self._init()
        _add_state_message(
            self.state_db, session_id=self.session_id,
            role="user", content="", ts=time.time(),
        )
        inserted = self.p._tail_state_db()
        self.assertEqual(inserted, 0)

    def test_queue_prefetch_triggers_tail(self):
        """The integration: queue_prefetch should kick off a background
        tail that captures any new state.db rows."""
        self._init()
        _add_state_message(
            self.state_db, session_id=self.session_id,
            role="user", content="captured via prefetch tail", ts=time.time(),
        )
        self.p.queue_prefetch("anything")
        # Background tail runs in daemon thread — give it a moment.
        for _ in range(10):
            if self.p._store.count("hermes-telegram-42") >= 3:
                break
            time.sleep(0.1)
        self.assertEqual(self.p._store.count("hermes-telegram-42"), 3)


class TestShutdownResilience(unittest.TestCase):
    """Verify that hooks called AFTER shutdown still work (re-open store)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["MEMEX_DB"] = str(Path(self.tmp.name) / "memex.db")
        self.p = MemexMemoryProvider()
        self.p.initialize("s-resilient", platform="cli", user_id=None)

    def tearDown(self):
        os.environ.pop("MEMEX_DB", None)
        self.tmp.cleanup()

    def test_on_session_end_after_shutdown(self):
        """Hermes v0.10.x sometimes calls on_session_end AFTER shutdown.
        Our re-open path should keep working."""
        # First a sync_turn to verify normal write path works
        self.p.sync_turn("hi", "hello")
        time.sleep(0.3)
        before = self.p._store.count()

        # Now shutdown — closes the connection.
        self.p.shutdown()
        self.assertTrue(self.p._shutdown_requested)

        # Hermes calls on_session_end AFTER shutdown (the bug scenario).
        # Should not raise; should re-open and insert.
        self.p.on_session_end([
            {"role": "user", "content": "post-shutdown msg", "timestamp": time.time()},
        ])
        after = self.p._store.count()
        self.assertGreaterEqual(after, before + 1,
                                "post-shutdown on_session_end must still capture")

    def test_on_memory_write_after_shutdown(self):
        self.p.shutdown()
        # Should not raise, store re-opens
        self.p.on_memory_write("add", "memory", "post-shutdown memory write")
        self.assertGreaterEqual(self.p._store.count("hermes-memory-file-memory"), 1)

    def test_ensure_store_reopens_after_close(self):
        first = self.p._store
        first.close()
        # _ensure_store should detect the closed connection and re-open.
        reopened = self.p._ensure_store()
        self.assertIsNotNone(reopened)
        # Insert via reopened store works
        reopened.insert_message(
            conversation_id="probe",
            msg_id="m-probe",
            role="user",
            text="after re-open",
            ts=int(time.time()),
        )
        self.assertEqual(reopened.count("probe"), 1)


if __name__ == "__main__":
    unittest.main()
