"""Unit tests for the prefetch (two-phase recall) layer."""

from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes.prefetch import (  # noqa: E402
    PrefetchCache,
    _expand_query_for_prefetch,
    _query_match,
    _render_context,
)
from memex_hermes.store import MemexStore  # noqa: E402


class TestExpandQueryForPrefetch(unittest.TestCase):
    def test_short_tokens_dropped(self):
        # "Я", "ты" — too short to keep
        out = _expand_query_for_prefetch("Я ты пишу")
        self.assertNotIn("Я", out)
        self.assertNotIn("ты", out)

    def test_stopwords_dropped(self):
        out = _expand_query_for_prefetch("как установить ffmpeg")
        self.assertNotIn("как", out.lower())

    def test_or_between_tokens(self):
        out = _expand_query_for_prefetch("ffmpeg whisper")
        self.assertIn(" OR ", out)

    def test_long_tokens_trimmed(self):
        # "Установить" (10 chars) → "Установи*" (drop last 2 chars → 8 chars)
        out = _expand_query_for_prefetch("Установить")
        self.assertIn("Установи*", out)
        self.assertNotIn("Установить*", out)
        # And a longer token loses exactly 2 chars:
        out2 = _expand_query_for_prefetch("транскрипция")  # 12 chars
        self.assertIn("транскрипц*", out2)  # 10 chars + *

    def test_short_tokens_not_trimmed(self):
        out = _expand_query_for_prefetch("ffmpeg cat dog")
        # "cat" (3) and "dog" (3) get * but no trim
        self.assertIn("cat*", out)
        self.assertIn("dog*", out)

    def test_empty_query(self):
        self.assertEqual(_expand_query_for_prefetch(""), "")
        self.assertEqual(_expand_query_for_prefetch("   "), "")

    def test_punctuation_stripped(self):
        out = _expand_query_for_prefetch("ffmpeg!?,")
        self.assertIn("ffmp*", out)
        self.assertNotIn("!", out)

    def test_max_8_tokens(self):
        # Throw 20 words at it — should cap.
        out = _expand_query_for_prefetch(
            "alpha bravo charlie delta echo foxtrot golf hotel india julia kilo lima"
        )
        # count OR delimiters → 7 of them for 8 tokens
        self.assertLessEqual(out.count(" OR "), 7)


class TestQueryMatch(unittest.TestCase):
    def test_exact_match(self):
        self.assertTrue(_query_match("hello world", "hello world"))

    def test_whitespace_normalised(self):
        self.assertTrue(_query_match("hello  world", " hello world  "))

    def test_case_insensitive(self):
        self.assertTrue(_query_match("Hello", "hello"))

    def test_first_200_chars_only(self):
        a = "x" * 200 + "different"
        b = "x" * 200 + "tail"
        self.assertTrue(_query_match(a, b))

    def test_mismatch(self):
        self.assertFalse(_query_match("hello", "goodbye"))

    def test_empty(self):
        self.assertFalse(_query_match("", ""))
        self.assertFalse(_query_match("hi", ""))


class TestRenderContext(unittest.TestCase):
    def test_empty_rows(self):
        self.assertEqual(_render_context([]), "")

    def test_basic_rendering(self):
        rows = [
            {"id": 7, "ts": 1700000000, "role": "user", "text": "hello there"},
        ]
        out = _render_context(rows)
        self.assertIn("[#7", out)
        self.assertIn("hello there", out)
        self.assertIn("memex_get", out)

    def test_long_preview_truncated(self):
        rows = [{"id": 1, "ts": 1700000000, "role": "user", "text": "x" * 500}]
        out = _render_context(rows)
        self.assertIn("...", out)


class TestPrefetchCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = MemexStore(str(Path(self.tmp.name) / "m.db"))
        self.store.insert_message(
            conversation_id="c", msg_id="m1", role="user",
            text="installed ffmpeg and whisper for transcription",
            ts=1700000000, channel="cli",
        )
        self.cache = PrefetchCache(self.store)

    def tearDown(self):
        self.cache.shutdown()
        self.store.close()
        self.tmp.cleanup()

    def test_queue_then_consume_returns_context(self):
        self.cache.queue("How to install ffmpeg")
        time.sleep(0.3)
        ctx = self.cache.consume("How to install ffmpeg")
        self.assertGreater(len(ctx), 0)
        self.assertIn("ffmpeg", ctx)

    def test_consume_without_queue_does_sync_search(self):
        ctx = self.cache.consume("ffmpeg")
        self.assertGreater(len(ctx), 0)

    def test_consume_clears_cache_after_use(self):
        self.cache.queue("ffmpeg")
        time.sleep(0.3)
        first = self.cache.consume("ffmpeg")
        # Second consume should fall through to sync (cache cleared).
        # Still returns something since DB has the row, but cache was reset.
        with self.cache._lock:
            self.assertIsNone(self.cache._cached_result)
        # Sanity:
        self.assertGreater(len(first), 0)

    def test_consume_with_different_query_does_sync(self):
        # queue for X, consume for Y — should re-search synchronously.
        self.cache.queue("first query about something")
        time.sleep(0.3)
        ctx = self.cache.consume("ffmpeg")
        # Still gets results because the DB matches "ffmpeg"
        self.assertGreater(len(ctx), 0)


if __name__ == "__main__":
    unittest.main()
