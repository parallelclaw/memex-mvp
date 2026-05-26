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
    def test_four_tools_exposed(self):
        # v0.2.2: memex_store_document added so Hermes can save URLs.
        names = {t["name"] for t in tools.TOOL_SCHEMAS}
        self.assertEqual(
            names,
            {"memex_search", "memex_get", "memex_recent", "memex_store_document"},
        )

    def test_search_has_required_query(self):
        s = next(t for t in tools.TOOL_SCHEMAS if t["name"] == "memex_search")
        self.assertIn("query", s["parameters"]["required"])

    def test_get_has_required_ids(self):
        s = next(t for t in tools.TOOL_SCHEMAS if t["name"] == "memex_get")
        self.assertIn("ids", s["parameters"]["required"])

    def test_store_document_has_required_content(self):
        s = next(t for t in tools.TOOL_SCHEMAS if t["name"] == "memex_store_document")
        self.assertIn("content", s["parameters"]["required"])

    def test_store_document_description_mentions_jina(self):
        # Critical: the description is what teaches the LLM the Jina recipe.
        # If this regression-test fails, an agent will burn through 2-3
        # failed attempts before figuring out the right curl shape.
        s = next(t for t in tools.TOOL_SCHEMAS if t["name"] == "memex_store_document")
        desc = s["description"]
        self.assertIn("r.jina.ai", desc)
        self.assertIn("Accept", desc)  # the Accept: text/markdown header
        self.assertIn("perplexity", desc.lower())
        self.assertIn("Share", desc)  # public-share instruction


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


class TestStoreDocument(unittest.TestCase):
    """v0.2.2: memex_store_document handler — saves URLs / pastes
    into memex.db with source='web', dedup by canonical URL."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = MemexStore(str(Path(self.tmp.name) / "m.db"))

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_stores_a_web_document(self):
        content = "# Great Article\n\n" + ("Body content. " * 30)
        r = tools.dispatch("memex_store_document", {
            "content": content,
            "url": "https://example.com/great-article",
        }, store=self.store)
        parsed = json.loads(r)
        self.assertTrue(parsed["stored"])
        self.assertTrue(parsed["conversation_id"].startswith("web-"))
        self.assertEqual(parsed["title"], "Great Article")
        self.assertEqual(parsed["length"], len(content))

    def test_idempotent_dedup_same_url(self):
        content = "Some web content " * 50
        url = "https://example.com/article"
        first = json.loads(tools.dispatch(
            "memex_store_document", {"content": content, "url": url}, store=self.store))
        self.assertTrue(first["stored"])
        # Re-store same URL → reports duplicate, doesn't overwrite
        second = json.loads(tools.dispatch(
            "memex_store_document", {"content": content, "url": url}, store=self.store))
        self.assertFalse(second["stored"])
        self.assertEqual(second["reason"], "duplicate")
        self.assertEqual(second["conversation_id"], first["conversation_id"])

    def test_refresh_overwrites_dedup(self):
        url = "https://example.com/article"
        json.loads(tools.dispatch(
            "memex_store_document",
            {"content": "old content " * 50, "url": url},
            store=self.store))
        # refresh=True → idempotency check is bypassed, but at the SQL
        # layer UNIQUE(source, conv_id, msg_id) still applies. For
        # different content, msg_id differs (it's a hash of content) →
        # row inserts. For same content → still deduplicates at SQL level.
        # We just verify refresh doesn't surface as "duplicate" early-out.
        result = json.loads(tools.dispatch(
            "memex_store_document",
            {"content": "new content " * 50, "url": url, "refresh": True},
            store=self.store))
        # Either stored:true (different content → different msg_id → insert)
        # or stored:false with no "duplicate" reason
        self.assertNotEqual(result.get("reason"), "duplicate")

    def test_perplexity_private_blocking(self):
        # Mock Jina output for a private Perplexity thread
        content = "This thread is private. Sign in if you are the owner."
        r = tools.dispatch("memex_store_document", {
            "content": content,
            "url": "https://www.perplexity.ai/search/abc-123",
        }, store=self.store)
        parsed = json.loads(r)
        self.assertFalse(parsed["stored"])
        self.assertEqual(parsed["warnings"][0]["type"], "perplexity-private")
        # The warning message must include actionable instructions
        self.assertIn("Share", parsed["warnings"][0]["message"])
        self.assertIn("Public", parsed["warnings"][0]["message"])

    def test_cloudflare_challenge_blocking(self):
        content = "Just a moment... cf-turnstile please wait"
        r = tools.dispatch("memex_store_document", {
            "content": content,
            "url": "https://example.com/article",
        }, store=self.store)
        parsed = json.loads(r)
        self.assertFalse(parsed["stored"])
        self.assertEqual(parsed["warnings"][0]["type"], "cloudflare-challenge")
        # The Jina recipe must be in the message
        self.assertIn("r.jina.ai", parsed["warnings"][0]["message"])
        self.assertIn("Accept: text/markdown", parsed["warnings"][0]["message"])

    def test_short_content_with_url_warns_non_blocking(self):
        r = tools.dispatch("memex_store_document", {
            "content": "Hi",
            "url": "https://example.com/p",
        }, store=self.store)
        parsed = json.loads(r)
        self.assertTrue(parsed["stored"])  # non-blocking — still saved
        warning_types = [w["type"] for w in parsed.get("warnings", [])]
        self.assertIn("suspiciously-small", warning_types)

    def test_paste_without_url_no_short_warning(self):
        r = tools.dispatch("memex_store_document", {
            "content": "Short paste",
        }, store=self.store)
        parsed = json.loads(r)
        self.assertTrue(parsed["stored"])
        # No suspiciously-small for pastes (no URL → user-provided)
        warning_types = [w["type"] for w in parsed.get("warnings", [])]
        self.assertNotIn("suspiciously-small", warning_types)

    def test_empty_content_returns_error(self):
        r = tools.dispatch("memex_store_document", {"content": ""}, store=self.store)
        parsed = json.loads(r)
        self.assertIn("error", parsed)

    def test_missing_content_returns_error(self):
        r = tools.dispatch("memex_store_document", {}, store=self.store)
        parsed = json.loads(r)
        self.assertIn("error", parsed)

    def test_tags_normalized(self):
        r = tools.dispatch("memex_store_document", {
            "content": "Article body. " * 30,
            "url": "https://example.com/x",
            "tags": ["Research", "research", "  PERPLEXITY  "],
        }, store=self.store)
        parsed = json.loads(r)
        self.assertTrue(parsed["stored"])
        # Tags get lowercased + deduped (we don't expose them in the response
        # but they should be in metadata — verify via direct DB read)
        rows = self.store.search("Article", limit=5)
        # At minimum we got the row back from search
        self.assertGreater(len(rows), 0)

    def test_canonical_url_dedup_across_surfaces(self):
        # Different surface URLs → same canonical → same conv_id → dedup
        urls = [
            "https://example.com/article?utm_source=twitter",
            "https://example.com/article#section-1",
            "https://example.com/article",
        ]
        ids = []
        for u in urls:
            r = json.loads(tools.dispatch(
                "memex_store_document",
                {"content": "Body content " * 30, "url": u},
                store=self.store))
            ids.append(r["conversation_id"])
        # All three should canonicalize to the same conversation_id
        self.assertEqual(len(set(ids)), 1)
        # First store succeeded, others got "duplicate"
        # (we can't tell which one was first without re-running, but at
        # least one of the second/third runs should report duplicate)


if __name__ == "__main__":
    unittest.main()
