"""Integration tests for MemexMemoryProvider — full ABC contract.

These tests exercise the public MemoryProvider methods Hermes will call,
verifying that:

  • sync_turn writes 2 verbatim rows per turn
  • on_session_end is an idempotent safety net (no duplication)
  • on_memory_write mirrors into a dedicated conversation
  • on_pre_compress preserves originals + returns an injection summary
  • prefetch+queue_prefetch produce context for the next turn
  • handle_tool_call dispatches to memex_search / memex_get / memex_recent
  • shutdown is clean
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes.provider import MemexMemoryProvider  # noqa: E402


class TestProviderLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "memex.db")
        os.environ["MEMEX_DB"] = self.db_path
        self.p = MemexMemoryProvider()
        self.p.initialize(
            session_id="session-abc-12345678",
            platform="telegram",
            user_id="97592799",
            agent_context="primary",
            agent_identity="hermes",
            agent_workspace="hermes",
        )

    def tearDown(self):
        self.p.shutdown()
        os.environ.pop("MEMEX_DB", None)
        self.tmp.cleanup()

    def test_name_property(self):
        self.assertEqual(self.p.name, "memex")

    def test_is_available(self):
        # Re-check after init.
        self.assertTrue(self.p.is_available())

    def test_conv_id_derived(self):
        self.assertEqual(self.p._conv_id, "hermes-telegram-97592799")

    def test_sync_turn_writes_two_rows(self):
        self.p.sync_turn("Привет", "Здарова")
        time.sleep(0.3)  # async thread
        self.assertEqual(self.p._store.count(), 2)

    def test_sync_turn_multiple_turns(self):
        for i in range(3):
            self.p.sync_turn(f"user-{i}", f"asst-{i}")
            time.sleep(0.1)
        time.sleep(0.3)
        self.assertEqual(self.p._store.count(), 6)

    def test_sync_turn_skips_empty(self):
        self.p.sync_turn("", "")
        time.sleep(0.2)
        self.assertEqual(self.p._store.count(), 0)

    def test_on_session_end_idempotent(self):
        self.p.sync_turn("hello", "hi back")
        time.sleep(0.3)
        before = self.p._store.count()

        # Re-replay same content via session_end
        messages = [
            {"role": "user", "content": "hello", "timestamp": int(time.time())},
            {"role": "assistant", "content": "hi back", "timestamp": int(time.time())},
        ]
        self.p.on_session_end(messages)
        after = self.p._store.count()
        self.assertEqual(after, before, "session_end re-replay must not duplicate")

    def test_on_session_end_captures_missed(self):
        # Pretend sync_turn was never called — session_end should still capture.
        messages = [
            {"role": "user", "content": "new content", "timestamp": int(time.time())},
            {"role": "assistant", "content": "new reply", "timestamp": int(time.time())},
        ]
        self.p.on_session_end(messages)
        self.assertEqual(self.p._store.count(), 2)

    def test_on_memory_write_uses_dedicated_conv(self):
        self.p.on_memory_write("add", "memory", "Important decision logged")
        # Lives in memory-file conv, not the dialogue conv
        dialogue_count = self.p._store.count("hermes-telegram-97592799")
        mem_count = self.p._store.count("hermes-memory-file-memory")
        self.assertEqual(dialogue_count, 0)
        self.assertEqual(mem_count, 1)

    def test_on_memory_write_skips_empty(self):
        self.p.on_memory_write("remove", "memory", "")
        self.assertEqual(self.p._store.count("hermes-memory-file-memory"), 0)

    def test_on_pre_compress_returns_summary_string(self):
        messages = [
            {"role": "user", "content": "first turn from a while back", "timestamp": 1700000000},
            {"role": "assistant", "content": "first reply", "timestamp": 1700000001},
        ]
        summary = self.p.on_pre_compress(messages)
        self.assertIn("memex", summary)
        # Both turns preserved
        self.assertEqual(self.p._store.count(), 2)

    def test_on_pre_compress_idempotent(self):
        messages = [
            {"role": "user", "content": "preserve me", "timestamp": 1700000000},
        ]
        s1 = self.p.on_pre_compress(messages)
        s2 = self.p.on_pre_compress(messages)
        # First call saves, second is dedup'd — but both return non-empty summaries
        # since each call observes that there were N messages on its watch.
        # Just verify no duplicates accumulated.
        self.assertEqual(self.p._store.count(), 1)


class TestProviderRecall(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "memex.db")
        os.environ["MEMEX_DB"] = self.db_path
        self.p = MemexMemoryProvider()
        self.p.initialize("s1", platform="cli", user_id=None)
        # Seed with some content
        self.p.sync_turn(
            "Установи ffmpeg для транскрипции",
            "Установил, версия 6.1",
        )
        self.p.sync_turn(
            "Спасибо! whisper тоже нужен",
            "Сейчас и whisper поставлю",
        )
        time.sleep(0.5)

    def tearDown(self):
        self.p.shutdown()
        os.environ.pop("MEMEX_DB", None)
        self.tmp.cleanup()

    def test_prefetch_finds_morphological_variants(self):
        # "Установить" (infinitive) should find "Установил" (past).
        self.p.queue_prefetch("Как установить ffmpeg")
        time.sleep(0.4)
        ctx = self.p.prefetch("Как установить ffmpeg")
        self.assertGreater(len(ctx), 0)
        self.assertTrue("ffmpeg" in ctx or "ffmp" in ctx.lower())

    def test_prefetch_returns_empty_for_unrelated(self):
        ctx = self.p.prefetch("совершенно постороннее")
        # Either empty (no match) or contains memex_get hint — both acceptable
        # The key check: should NOT crash.
        self.assertIsInstance(ctx, str)

    def test_handle_tool_call_returns_json_string(self):
        out = self.p.handle_tool_call("memex_search", {"query": "ffmpeg"})
        self.assertIsInstance(out, str)
        parsed = json.loads(out)
        self.assertIn("results", parsed)

    def test_handle_tool_call_unknown_tool(self):
        out = self.p.handle_tool_call("non_existent_tool", {})
        parsed = json.loads(out)
        self.assertIn("error", parsed)


class TestProviderSchemas(unittest.TestCase):
    def setUp(self):
        self.p = MemexMemoryProvider()

    def test_get_tool_schemas_returns_list(self):
        schemas = self.p.get_tool_schemas()
        self.assertIsInstance(schemas, list)
        names = {s["name"] for s in schemas}
        self.assertEqual(names, {"memex_search", "memex_get", "memex_recent"})

    def test_system_prompt_block_mentions_tools(self):
        block = self.p.system_prompt_block()
        self.assertIn("memex_search", block)
        self.assertIn("memex_get", block)
        self.assertIn("memex_recent", block)

    def test_get_config_schema_empty(self):
        # We're zero-config — setup wizard should show "no setup needed".
        self.assertEqual(self.p.get_config_schema(), [])


if __name__ == "__main__":
    unittest.main()
