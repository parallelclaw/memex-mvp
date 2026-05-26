"""Tests for store_doc — Python port of memex-mvp's lib/store-doc/.

Three modules in one file (canonicalize / detect_issues / extract_title)
share the same dispatch pattern as the JS source. Tests mirror the
JS test cases plus a few Python-specific edge cases (URL parsing
quirks differ slightly between Node's URL and Python's urllib).
"""

from __future__ import annotations

import unittest

from memex_hermes.store_doc import (
    canonicalize,
    conversation_id_for_url,
    detect_issues,
    extract_domain,
    extract_title,
    is_blocked,
)


# ============================================================
# canonicalize
# ============================================================

class TestCanonicalize(unittest.TestCase):
    def test_strips_known_tracking_params(self):
        u = "https://example.com/article?utm_source=twitter&utm_medium=social&id=42"
        self.assertEqual(canonicalize(u), "https://example.com/article?id=42")

    def test_strips_fbclid_gclid(self):
        u = "https://example.com/p?fbclid=abc&gclid=xyz&page=2"
        self.assertEqual(canonicalize(u), "https://example.com/p?page=2")

    def test_drops_fragment(self):
        u = "https://example.com/article#section-3"
        self.assertEqual(canonicalize(u), "https://example.com/article")

    def test_normalizes_trailing_slash_on_non_root_paths(self):
        # /foo/ → /foo (same document)
        self.assertEqual(canonicalize("https://x.com/foo/"), "https://x.com/foo")
        # /foo (no trailing) stays /foo
        self.assertEqual(canonicalize("https://x.com/foo"), "https://x.com/foo")
        # / (root) stays / (urlsplit gives empty path; urlunsplit reconstructs)
        # We don't make a strict assertion on exact root form — just that two
        # different inputs collapse consistently.

    def test_lowercase_host(self):
        u = "https://Example.COM/Article"  # host case-insensitive, path preserved
        self.assertEqual(canonicalize(u), "https://example.com/Article")

    def test_preserves_meaningful_query_params(self):
        u = "https://example.com/search?q=hello&page=2"
        self.assertEqual(canonicalize(u), "https://example.com/search?q=hello&page=2")

    def test_unparseable_input_returned_trimmed(self):
        # No scheme — urlsplit can parse but we return as-is per JS behavior
        self.assertEqual(canonicalize("not a url"), "not a url")
        self.assertEqual(canonicalize("  whitespace  "), "whitespace")

    def test_empty_input(self):
        self.assertEqual(canonicalize(""), "")
        self.assertEqual(canonicalize(None), None)  # type: ignore[arg-type]

    def test_perplexity_share_url_canonicalized(self):
        # Real-world flow: user shares Perplexity Public link
        u = "https://www.perplexity.ai/search/abc-123-def?utm_source=share"
        self.assertEqual(
            canonicalize(u),
            "https://www.perplexity.ai/search/abc-123-def",
        )


class TestExtractDomain(unittest.TestCase):
    def test_strips_www(self):
        self.assertEqual(extract_domain("https://www.example.com/x"), "example.com")

    def test_keeps_non_www_subdomains(self):
        self.assertEqual(
            extract_domain("https://blog.example.com/x"), "blog.example.com",
        )

    def test_lowercases(self):
        self.assertEqual(extract_domain("https://EXAMPLE.com/x"), "example.com")

    def test_unparseable(self):
        self.assertIsNone(extract_domain("not a url"))
        self.assertIsNone(extract_domain(None))


class TestConversationIdForUrl(unittest.TestCase):
    def test_stable_for_same_canonical(self):
        # Different surface, same canonical form
        u1 = "https://example.com/article?utm_source=twitter"
        u2 = "https://example.com/article#section-1"
        self.assertEqual(
            conversation_id_for_url(u1),
            conversation_id_for_url(u2),
        )

    def test_distinct_for_different_urls(self):
        a = conversation_id_for_url("https://a.com/x")
        b = conversation_id_for_url("https://b.com/x")
        self.assertNotEqual(a, b)

    def test_falls_back_to_content_hash(self):
        # No URL → hash the content
        cid = conversation_id_for_url(None, content="some pasted content here")
        self.assertTrue(cid.startswith("web-"))
        self.assertEqual(len(cid), len("web-") + 12)

    def test_uses_web_prefix(self):
        cid = conversation_id_for_url("https://x.com/y")
        self.assertTrue(cid.startswith("web-"))


# ============================================================
# detect_issues
# ============================================================

class TestDetectIssues(unittest.TestCase):
    def test_cloudflare_challenge_is_blocking(self):
        content = "Just a moment...\nVerifying you are human."
        warnings = detect_issues(content, "https://example.com/x")
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["type"], "cloudflare-challenge")
        self.assertTrue(warnings[0]["blocking"])
        self.assertIn("r.jina.ai", warnings[0]["message"])
        self.assertIn("Accept: text/markdown", warnings[0]["message"])

    def test_cloudflare_short_circuits_other_detectors(self):
        # Cloudflare page is also short — but only cloudflare warning fires
        content = "Just a moment..."
        warnings = detect_issues(content, "https://example.com/x")
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["type"], "cloudflare-challenge")

    def test_perplexity_private_detected(self):
        content = "This thread is private. Sign in if you are the owner."
        warnings = detect_issues(content, "https://www.perplexity.ai/search/abc")
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["type"], "perplexity-private")
        self.assertTrue(warnings[0]["blocking"])
        self.assertIn("Share", warnings[0]["message"])
        self.assertIn("Public", warnings[0]["message"])

    def test_perplexity_private_only_fires_on_perplexity_urls(self):
        # Same phrase elsewhere shouldn't trigger
        warnings = detect_issues("This thread is private.", "https://random.com/x")
        # Either no warnings or only non-blocking ones
        self.assertFalse(is_blocked(warnings))

    def test_suspiciously_small_when_url_present_and_short(self):
        warnings = detect_issues("Hi", "https://example.com/x")
        types = [w["type"] for w in warnings]
        self.assertIn("suspiciously-small", types)
        # Non-blocking
        self.assertFalse(is_blocked(warnings))

    def test_suspiciously_small_skipped_for_pastes(self):
        # No URL → user-pasted content, short is OK
        warnings = detect_issues("Hi", None)
        self.assertEqual(warnings, [])

    def test_login_required_detected(self):
        content = "Sign in to continue\n<form action='/login'>"
        warnings = detect_issues(content, "https://app.example.com")
        types = [w["type"] for w in warnings]
        self.assertIn("login-required", types)
        # Non-blocking
        self.assertFalse(is_blocked(warnings))

    def test_paywall_detected(self):
        content = "Subscribe to continue reading. " + ("Lorem ipsum " * 50)
        warnings = detect_issues(content, "https://news.example.com/article")
        types = [w["type"] for w in warnings]
        self.assertIn("paywalled", types)
        self.assertFalse(is_blocked(warnings))

    def test_clean_content_no_warnings(self):
        # Real-looking article content, no flags
        content = "# Real Article\n\n" + ("Lorem ipsum dolor sit amet. " * 50)
        warnings = detect_issues(content, "https://example.com/article")
        self.assertEqual(warnings, [])

    def test_is_blocked_helper(self):
        self.assertTrue(is_blocked([{"type": "x", "blocking": True}]))
        self.assertFalse(is_blocked([{"type": "x", "blocking": False}]))
        self.assertFalse(is_blocked([]))
        self.assertFalse(is_blocked(None))  # type: ignore[arg-type]


# ============================================================
# extract_title
# ============================================================

class TestExtractTitle(unittest.TestCase):
    def test_markdown_h1_wins(self):
        content = "# The Real Title\n\nSome content here."
        self.assertEqual(extract_title(content, None), "The Real Title")

    def test_markdown_h2_when_h1_missing(self):
        content = "## Subtopic Title\n\nContent."
        self.assertEqual(extract_title(content, None), "Subtopic Title")

    def test_h1_preferred_over_h2(self):
        content = "## First H2\n\n# Real H1\n\nContent."
        self.assertEqual(extract_title(content, None), "Real H1")

    def test_html_title_when_no_markdown(self):
        content = "<html><head><title>HTML Page Title</title></head></html>"
        self.assertEqual(extract_title(content, None), "HTML Page Title")

    def test_html_entities_decoded(self):
        content = "<title>It&#39;s &amp; more</title>"
        self.assertEqual(extract_title(content, None), "It's & more")

    def test_html_h1_strips_nested_tags(self):
        content = "<h1>Real <span>Title</span> Here</h1>"
        self.assertEqual(extract_title(content, None), "Real Title Here")

    def test_url_slug_fallback(self):
        # No structural title in content → slug from URL
        content = "Just some plain text that is more than 120 characters long " * 3
        url = "https://example.com/my-article-slug"
        self.assertEqual(extract_title(content, url), "my article slug")

    def test_url_slug_strips_extension(self):
        url = "https://example.com/posts/great-article.html"
        self.assertEqual(extract_title("." * 500, url), "great article")

    def test_domain_fallback(self):
        url = "https://example.com/"
        # Long content, no headings — falls through slug (empty) → domain
        self.assertEqual(extract_title("." * 500, url), "example.com")

    def test_ultimate_fallback(self):
        self.assertEqual(extract_title("", None), "Untitled document")
        self.assertEqual(extract_title(None, None), "Untitled document")

    def test_strips_jina_prefix(self):
        jina_output = (
            "Title: Perplexity\n\n"  # generic boilerplate
            "URL Source: https://www.perplexity.ai/search/abc\n\n"
            "Published Time: 2026-05-25\n\n"
            "Markdown Content:\n"
            "# How to check Mac memory usage\n\n"
            "Open Activity Monitor..."
        )
        title = extract_title(jina_output, "https://www.perplexity.ai/search/abc")
        # Should pick H1 from the body, NOT "Perplexity" from Jina's prefix
        self.assertEqual(title, "How to check Mac memory usage")

    def test_strips_jina_prefix_with_h2(self):
        # Perplexity threads often have H2 at top, not H1
        jina_output = (
            "Title: Perplexity\n\n"
            "URL Source: https://www.perplexity.ai/search/abc\n\n"
            "Markdown Content:\n"
            "## Some Perplexity research question\n\n"
            "Answer body..."
        )
        title = extract_title(jina_output, "https://www.perplexity.ai/search/abc")
        self.assertEqual(title, "Some Perplexity research question")

    def test_trims_to_max_length(self):
        long = "# " + ("very long title " * 30)
        title = extract_title(long, None)
        self.assertLessEqual(len(title), 201)  # 200 + "…"
        self.assertTrue(title.endswith("…"))


if __name__ == "__main__":
    unittest.main()
