"""End-to-end test for backfill against a synthetic Hermes state.db.

We don't need a real Hermes install — we just need an SQLite file with
the schema described in the agent's diagnostic. Build one, populate it,
run the backfill module, then assert that memex.db got the rows with
the right conversation_id derivation.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes.backfill import run_backfill  # noqa: E402
from memex_hermes.store import MemexStore  # noqa: E402


def _make_hermes_state_db(path: Path) -> None:
    """Recreate the subset of Hermes' state.db schema we care about."""
    conn = sqlite3.connect(str(path))
    conn.executescript("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            user_id TEXT,
            model TEXT,
            started_at REAL NOT NULL,
            ended_at REAL,
            message_count INTEGER DEFAULT 0,
            title TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            role TEXT NOT NULL,
            content TEXT,
            timestamp REAL NOT NULL,
            tool_call_id TEXT,
            tool_calls TEXT,
            tool_name TEXT,
            token_count INTEGER
        );
    """)
    # Session 1: Telegram user Oleg, several turns
    conn.execute(
        """INSERT INTO sessions
              (id, source, user_id, started_at, ended_at, title)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("sess-tg-1", "telegram", "97592799", 1700000000, 1700001000, "Chat with Oleg"),
    )
    # Session 2: same user, different session — should share conv_id with sess-tg-1
    conn.execute(
        """INSERT INTO sessions
              (id, source, user_id, started_at, ended_at, title)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("sess-tg-2", "telegram", "97592799", 1700100000, 1700101000, "Chat continued"),
    )
    # Session 3: CLI without user_id
    conn.execute(
        """INSERT INTO sessions
              (id, source, user_id, started_at, ended_at, title)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("sess-cli-1", "cli", None, 1700200000, 1700201000, "Local CLI session"),
    )

    rows = [
        ("sess-tg-1", "user", "Привет, как дела?", 1700000010),
        ("sess-tg-1", "assistant", "Здарова, всё хорошо.", 1700000011),
        ("sess-tg-1", "user", "Установи ffmpeg", 1700000020),
        ("sess-tg-1", "assistant", "Установил.", 1700000021),
        # Tool messages must be filtered out — backfill only takes user+assistant
        ("sess-tg-1", "tool", '{"output":"ffmpeg installed"}', 1700000022),
        ("sess-tg-2", "user", "Продолжим", 1700100010),
        ("sess-tg-2", "assistant", "Конечно.", 1700100011),
        ("sess-cli-1", "user", "ls -la", 1700200010),
        ("sess-cli-1", "assistant", "Listing files.", 1700200011),
        # Empty content should be skipped
        ("sess-cli-1", "user", "", 1700200012),
    ]
    conn.executemany(
        """INSERT INTO messages (session_id, role, content, timestamp)
           VALUES (?, ?, ?, ?)""",
        rows,
    )
    conn.commit()
    conn.close()


class TestBackfill(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes_home = Path(self.tmp.name) / "hermes-home"
        self.hermes_home.mkdir()
        _make_hermes_state_db(self.hermes_home / "state.db")
        self.memex_db = str(Path(self.tmp.name) / "memex.db")

    def tearDown(self):
        self.tmp.cleanup()

    def test_backfill_inserts_expected_rows(self):
        totals = run_backfill(
            hermes_home=str(self.hermes_home),
            memex_db=self.memex_db,
        )
        # 3 sessions processed
        self.assertEqual(totals["sessions"], 3)
        # 8 dialogue rows (2+2+2+2 = 8; tool/empty filtered)
        self.assertEqual(totals["inserted"], 8)
        self.assertEqual(totals["errors"], 0)

    def test_backfill_routes_tg_to_per_user_conv(self):
        run_backfill(hermes_home=str(self.hermes_home), memex_db=self.memex_db)

        store = MemexStore(self.memex_db)
        # Telegram conv (cross-session per-user): 4+2 = 6 rows
        tg_count = store.count("hermes-telegram-97592799")
        # CLI conv (per-session fallback): 2 rows
        cli_rows = store._conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id LIKE 'hermes-cli-%'"
        ).fetchone()[0]
        store.close()

        self.assertEqual(tg_count, 6, "TG: both sessions should share one conv_id")
        self.assertEqual(cli_rows, 2)

    def test_backfill_idempotent(self):
        first = run_backfill(hermes_home=str(self.hermes_home), memex_db=self.memex_db)
        second = run_backfill(hermes_home=str(self.hermes_home), memex_db=self.memex_db)

        # First run inserts everything new.
        self.assertEqual(first["inserted"], 8)
        self.assertEqual(first["skipped"], 0)
        # Second run: 0 new, 8 dedup.
        self.assertEqual(second["inserted"], 0)
        self.assertEqual(second["skipped"], 8)

    def test_backfill_dry_run_no_writes(self):
        totals = run_backfill(
            hermes_home=str(self.hermes_home),
            memex_db=self.memex_db,
            dry_run=True,
        )
        self.assertEqual(totals["inserted"], 8)  # reported as "would have"
        # But DB has nothing
        store = MemexStore(self.memex_db)
        self.assertEqual(store.count(), 0)
        store.close()

    def test_backfill_since_filter(self):
        # All test sessions have started_at = 17xxxxxxxx (Nov 2023). Pick
        # a since-cutoff earlier than that — all should pass.
        totals = run_backfill(
            hermes_home=str(self.hermes_home),
            memex_db=self.memex_db,
            since="2023-01-01",
        )
        self.assertEqual(totals["sessions"], 3)

    def test_backfill_since_filter_excludes_old(self):
        # Cutoff AFTER all sessions → none included.
        totals = run_backfill(
            hermes_home=str(self.hermes_home),
            memex_db=self.memex_db,
            since="2030-01-01",
        )
        self.assertEqual(totals["sessions"], 0)
        self.assertEqual(totals["inserted"], 0)

    def test_backfill_missing_state_db_raises(self):
        with self.assertRaises(FileNotFoundError):
            run_backfill(
                hermes_home=str(Path(self.tmp.name) / "nonexistent"),
                memex_db=self.memex_db,
            )


if __name__ == "__main__":
    unittest.main()
