"""Unit tests for the SQLite store layer."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes.store import MemexStore, initialise_schema, resolve_db_path  # noqa: E402


class TestStoreBasics(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "memex.db"
        self.store = MemexStore(str(self.db_path))

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_insert_basic(self):
        ok = self.store.insert_message(
            conversation_id="conv-1",
            msg_id="m-1",
            role="user",
            text="hello world",
            ts=1700000000,
            channel="cli",
        )
        self.assertTrue(ok)
        self.assertEqual(self.store.count(), 1)

    def test_insert_dedup(self):
        kwargs = dict(
            conversation_id="conv-1",
            msg_id="m-1",
            role="user",
            text="hello",
            ts=1700000000,
        )
        self.assertTrue(self.store.insert_message(**kwargs))
        # Second insert with same msg_id should be deduped.
        self.assertFalse(self.store.insert_message(**kwargs))
        self.assertEqual(self.store.count(), 1)

    def test_empty_text_skipped(self):
        ok = self.store.insert_message(
            conversation_id="conv-1",
            msg_id="m-x",
            role="user",
            text="",
            ts=1700000000,
        )
        self.assertFalse(ok)
        self.assertEqual(self.store.count(), 0)

    def test_search_finds_match(self):
        self.store.insert_message(
            conversation_id="conv-1",
            msg_id="m-1",
            role="user",
            text="install ffmpeg please",
            ts=1700000000,
            channel="cli",
        )
        results = self.store.search("ffmpeg")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["role"], "user")
        self.assertIn("ffmpeg", results[0]["preview"])

    def test_search_channel_filter(self):
        self.store.insert_message(
            conversation_id="c1", msg_id="m1", role="user",
            text="alpha beta", ts=1700000000, channel="telegram",
        )
        self.store.insert_message(
            conversation_id="c2", msg_id="m2", role="user",
            text="alpha beta", ts=1700000001, channel="discord",
        )
        all_results = self.store.search("alpha")
        tg_only = self.store.search("alpha", channel="telegram")
        self.assertEqual(len(all_results), 2)
        self.assertEqual(len(tg_only), 1)
        self.assertEqual(tg_only[0]["channel"], "telegram")

    def test_search_relevance_order(self):
        # bm25-ordered: most relevant first regardless of ts.
        self.store.insert_message(
            conversation_id="c", msg_id="old", role="user",
            text="just some random text ffmpeg",
            ts=1000000000, channel="cli",
        )
        self.store.insert_message(
            conversation_id="c", msg_id="new", role="user",
            text="ffmpeg ffmpeg ffmpeg installation",
            ts=2000000000, channel="cli",
        )
        # Default (ts DESC): newer first — also happens to be relevant
        ts_order = self.store.search("ffmpeg")
        self.assertEqual(ts_order[0]["id"], 2)
        # Relevance: same answer here (denser ffmpeg row scores higher AND
        # is newer), but check that the param is accepted without error.
        rel = self.store.search("ffmpeg", order_by_relevance=True)
        self.assertGreater(len(rel), 0)

    def test_search_malformed_query_returns_empty(self):
        # FTS5 syntax error shouldn't crash the plugin.
        results = self.store.search('foo"bar')
        self.assertEqual(results, [])

    def test_get_by_ids(self):
        self.store.insert_message(
            conversation_id="c", msg_id="m1", role="user",
            text="first message", ts=1700000000,
        )
        self.store.insert_message(
            conversation_id="c", msg_id="m2", role="assistant",
            text="second message", ts=1700000001,
        )
        rows = self.store.get_by_ids([1, 2])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["text"], "first message")
        self.assertEqual(rows[1]["role"], "assistant")

    def test_get_by_ids_empty(self):
        self.assertEqual(self.store.get_by_ids([]), [])
        self.assertEqual(self.store.get_by_ids([999]), [])

    def test_get_by_ids_parses_metadata_json(self):
        self.store.insert_message(
            conversation_id="c", msg_id="m1", role="user",
            text="hi", ts=1700000000,
            metadata={"foo": "bar", "n": 42},
        )
        rows = self.store.get_by_ids([1])
        self.assertEqual(rows[0]["metadata"], {"foo": "bar", "n": 42})

    def test_recent_chronological(self):
        for i, t in enumerate(["one", "two", "three"]):
            self.store.insert_message(
                conversation_id="c", msg_id=f"m{i}", role="user",
                text=t, ts=1700000000 + i,
            )
        rows = self.store.recent("c", limit=10)
        # Recent returns chronological (oldest → newest)
        self.assertEqual([r["text"] for r in rows], ["one", "two", "three"])

    def test_recent_other_conv_empty(self):
        self.store.insert_message(
            conversation_id="c1", msg_id="m1", role="user",
            text="hi", ts=1700000000,
        )
        rows = self.store.recent("c2")
        self.assertEqual(rows, [])

    def test_count_filtered(self):
        self.store.insert_message(
            conversation_id="c1", msg_id="m1", role="user", text="hi", ts=1,
        )
        self.store.insert_message(
            conversation_id="c2", msg_id="m2", role="user", text="hi", ts=2,
        )
        self.assertEqual(self.store.count(), 2)
        self.assertEqual(self.store.count("c1"), 1)
        self.assertEqual(self.store.count("c-nonexistent"), 0)


class TestStorePersistence(unittest.TestCase):
    def test_close_and_reopen_preserves_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "m.db"
            s1 = MemexStore(str(db))
            s1.insert_message(
                conversation_id="c", msg_id="m", role="user",
                text="persistent", ts=1700000000,
            )
            s1.close()

            s2 = MemexStore(str(db))
            self.assertEqual(s2.count(), 1)
            results = s2.search("persistent")
            self.assertEqual(len(results), 1)
            s2.close()


class TestResolvePath(unittest.TestCase):
    def test_explicit_path(self):
        # Note: on macOS /tmp is a symlink to /private/tmp, so .resolve()
        # may unwrap it. Just verify the basename + absolute path shape.
        p = resolve_db_path("/tmp/explicit.db")
        self.assertTrue(str(p).endswith("/tmp/explicit.db"))
        self.assertTrue(p.is_absolute())

    def test_tilde_expansion(self):
        p = resolve_db_path("~/m.db")
        self.assertNotIn("~", str(p))

    def test_default_when_none(self):
        p = resolve_db_path()
        self.assertTrue(str(p).endswith(".db"))
        self.assertNotIn("~", str(p))


if __name__ == "__main__":
    unittest.main()
