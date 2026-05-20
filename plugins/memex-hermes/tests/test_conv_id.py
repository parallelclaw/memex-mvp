"""Unit tests for conv_id derivation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Make memex_hermes importable without requiring `pip install -e .`
sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes.conv_id import (
    derive_conv_id,
    derive_memory_file_conv_id,
    derive_msg_id,
)


class TestDeriveConvId(unittest.TestCase):
    def test_telegram_with_user_id(self):
        self.assertEqual(
            derive_conv_id("telegram", "97592799", "abc-123"),
            "hermes-telegram-97592799",
        )

    def test_discord_with_user_id(self):
        self.assertEqual(
            derive_conv_id("discord", "123abc", "sess-x"),
            "hermes-discord-123abc",
        )

    def test_cli_no_user_id_falls_back_to_session(self):
        self.assertEqual(
            derive_conv_id("cli", None, "abc12345-ea6e-4e08-a83a-c596288bcfe3"),
            "hermes-cli-abc12345",
        )

    def test_no_platform_no_user(self):
        self.assertEqual(
            derive_conv_id(None, None, "abc12345-ea6e-4e08"),
            "hermes-abc12345",
        )

    def test_empty_session_id(self):
        self.assertEqual(
            derive_conv_id(None, None, ""),
            "hermes-unknown",
        )

    def test_platform_normalised_to_lower(self):
        self.assertEqual(
            derive_conv_id("Telegram", "42", "x"),
            "hermes-telegram-42",
        )

    def test_user_id_coerced_to_string(self):
        # Hermes occasionally passes user_id as int — make sure we cope.
        self.assertEqual(
            derive_conv_id("telegram", 42, "x"),
            "hermes-telegram-42",
        )


class TestDeriveMsgId(unittest.TestCase):
    def test_stable_across_calls(self):
        a = derive_msg_id("user", "hello", "conv-1")
        b = derive_msg_id("user", "hello", "conv-1")
        self.assertEqual(a, b)

    def test_role_changes_id(self):
        u = derive_msg_id("user", "hello", "conv-1")
        a = derive_msg_id("assistant", "hello", "conv-1")
        self.assertNotEqual(u, a)

    def test_conv_changes_id(self):
        a = derive_msg_id("user", "hello", "conv-1")
        b = derive_msg_id("user", "hello", "conv-2")
        self.assertNotEqual(a, b)

    def test_text_changes_id(self):
        a = derive_msg_id("user", "hello", "conv-1")
        b = derive_msg_id("user", "hello!", "conv-1")
        self.assertNotEqual(a, b)

    def test_format(self):
        msg_id = derive_msg_id("user", "hi", "c")
        self.assertTrue(msg_id.startswith("hermes-"))
        self.assertEqual(len(msg_id), len("hermes-") + 16)


class TestMemoryFileConvId(unittest.TestCase):
    def test_memory_target(self):
        self.assertEqual(
            derive_memory_file_conv_id("memory"),
            "hermes-memory-file-memory",
        )

    def test_user_target(self):
        self.assertEqual(
            derive_memory_file_conv_id("user"),
            "hermes-memory-file-user",
        )

    def test_normalised_lower(self):
        self.assertEqual(
            derive_memory_file_conv_id("MEMORY"),
            "hermes-memory-file-memory",
        )


if __name__ == "__main__":
    unittest.main()
