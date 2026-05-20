"""Unit tests for the MCP tool dispatch surface."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes.store import MemexStore  # noqa: E402
from memex_hermes import tools  # noqa: E402


class TestToolSchemas(unittest.TestCase):
    def test_three_tools_exposed(self):
        names = {t["name"] for t in tools.TOOL_SCHEMAS}
        self.assertEqual(names, {"memex_search", "memex_get", "memex_recent"})

    def test_search_has_required_query(self):
        s = next(t for t in tools.TOOL_SCHEMAS if t["name"] == "memex_search")
        self.assertIn("query", s["parameters"]["required"])

    def test_get_has_required_ids(self):
        s = next(t for t in tools.TOOL_SCHEMAS if t["name"] == "memex_get")
        self.assertIn("ids", s["parameters"]["required"])


class TestDispatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = MemexStore(str(Path(self.tmp.name) / "m.db"))
        self.store.insert_message(
            conversation_id="conv-a", msg_id="m1", role="user",
            text="install ffmpeg from brew",
            ts=1700000000, channel="cli",
        )
        self.store.insert_message(
            conversation_id="conv-a", msg_id="m2", role="assistant",
            text="brew install ffmpeg succeeded",
            ts=1700000001, channel="cli",
        )
        self.store.insert_message(
            conversation_id="conv-b", msg_id="m3", role="user",
            text="unrelated chat about whiskey",
            ts=1700000002, channel="telegram",
        )

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_search_returns_json_string(self):
        r = tools.dispatch("memex_search", {"query": "ffmpeg"}, store=self.store)
        self.assertIsInstance(r, str)
        parsed = json.loads(r)
        self.assertIn("results", parsed)
        self.assertEqual(parsed["count"], 2)
        self.assertEqual(parsed["results"][0]["conversation_id"], "conv-a")

    def test_search_channel_filter(self):
        r = tools.dispatch(
            "memex_search",
            {"query": "whiskey", "channel": "telegram"},
            store=self.store,
        )
        parsed = json.loads(r)
        self.assertEqual(parsed["count"], 1)

    def test_search_empty_results(self):
        r = tools.dispatch("memex_search", {"query": "nonexistent"}, store=self.store)
        parsed = json.loads(r)
        self.assertEqual(parsed["results"], [])

    def test_get_returns_full_text(self):
        # find ids first
        s = json.loads(tools.dispatch("memex_search", {"query": "ffmpeg"}, store=self.store))
        ids = [r["id"] for r in s["results"]]
        r = tools.dispatch("memex_get", {"ids": ids}, store=self.store)
        parsed = json.loads(r)
        self.assertEqual(parsed["count"], len(ids))
        for rec in parsed["records"]:
            self.assertIn("text", rec)
            self.assertTrue(rec["text"])

    def test_get_missing_ids_arg(self):
        r = tools.dispatch("memex_get", {}, store=self.store)
        parsed = json.loads(r)
        self.assertIn("error", parsed)

    def test_get_caps_at_20(self):
        # 25 fake ids — only first 20 should be requested + truncated flag set
        r = tools.dispatch("memex_get", {"ids": list(range(1, 26))}, store=self.store)
        parsed = json.loads(r)
        self.assertTrue(parsed.get("truncated", False))

    def test_recent_uses_default_conv_id(self):
        r = tools.dispatch(
            "memex_recent", {},
            store=self.store, default_conv_id="conv-a",
        )
        parsed = json.loads(r)
        self.assertEqual(parsed["conversation_id"], "conv-a")
        self.assertEqual(parsed["count"], 2)

    def test_recent_explicit_conv_id_overrides_default(self):
        r = tools.dispatch(
            "memex_recent", {"conversation_id": "conv-b"},
            store=self.store, default_conv_id="conv-a",
        )
        parsed = json.loads(r)
        self.assertEqual(parsed["conversation_id"], "conv-b")
        self.assertEqual(parsed["count"], 1)

    def test_recent_no_conv_id_anywhere(self):
        r = tools.dispatch("memex_recent", {}, store=self.store, default_conv_id=None)
        parsed = json.loads(r)
        self.assertIn("error", parsed)

    def test_unknown_tool(self):
        r = tools.dispatch("memex_blahblah", {}, store=self.store)
        parsed = json.loads(r)
        self.assertIn("error", parsed)
        self.assertIn("unknown tool", parsed["error"])

    def test_handler_exception_returns_json_error(self):
        # Pass a non-int id that survives args validation but fails downstream
        r = tools.dispatch("memex_get", {"ids": ["not-an-int"]}, store=self.store)
        parsed = json.loads(r)
        # Either {error: ...} or {records: [], count: 0} — both acceptable
        self.assertTrue("error" in parsed or "records" in parsed)


if __name__ == "__main__":
    unittest.main()
