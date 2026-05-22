"""Tests for the shim install/uninstall/status CLI.

The shim is what makes the plugin discoverable in Hermes' folder-based
loader. These tests verify:

  • `memex-hermes init`     creates the right files at the right path
  • The generated __init__.py contains the textual markers Hermes scans
    for (`MemoryProvider` or `register_memory_provider`)
  • `memex-hermes uninstall` removes the shim folder
  • `memex-hermes status`   reports correctly in both states
  • Idempotency: init twice is fine
  • v0.1.5: init auto-backfills history from state.db unless --no-backfill
"""

from __future__ import annotations

import argparse
import io
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes import install_shim  # noqa: E402
from memex_hermes.store import MemexStore  # noqa: E402


def _seed_hermes_state_db(state_path: Path) -> None:
    """Create a synthetic ~/.hermes/state.db with one Telegram session
    containing 2 dialogue messages. Used to exercise the v0.1.5 init
    auto-backfill behavior end-to-end without needing a real Hermes.
    """
    conn = sqlite3.connect(str(state_path))
    conn.executescript(
        """
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
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            timestamp REAL NOT NULL,
            tool_call_id TEXT,
            tool_calls TEXT,
            tool_name TEXT,
            token_count INTEGER
        );
        """
    )
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, started_at) VALUES (?,?,?,?)",
        ("sess-1", "telegram", "97592799", 1700000000),
    )
    conn.executemany(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)",
        [
            ("sess-1", "user", "Привет", 1700000010),
            ("sess-1", "assistant", "Здарова", 1700000011),
        ],
    )
    conn.commit()
    conn.close()


class TestShimInstall(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes_home = Path(self.tmp.name) / "hermes-home"
        self.hermes_home.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _args(self):
        ns = argparse.Namespace()
        ns.hermes_home = str(self.hermes_home)
        return ns

    def test_init_creates_files(self):
        rc = install_shim.cmd_init(self._args())
        self.assertEqual(rc, 0)
        # Correct path per Hermes' _iter_provider_dirs (user-installed
        # plugins live directly in ~/.hermes/plugins/<name>/, no memory/
        # subdir). v0.1.0 had the wrong path; v0.1.1+ fixed.
        init_py = self.hermes_home / "plugins" / "memex" / "__init__.py"
        plugin_yaml = self.hermes_home / "plugins" / "memex" / "plugin.yaml"
        self.assertTrue(init_py.exists())
        self.assertTrue(plugin_yaml.exists())

    def test_init_does_NOT_use_legacy_memory_subdir(self):
        """v0.1.0 created the shim at plugins/memory/memex/ — wrong path.
        v0.1.1+ must NOT create that directory."""
        install_shim.cmd_init(self._args())
        wrong_path = self.hermes_home / "plugins" / "memory" / "memex"
        self.assertFalse(wrong_path.exists(),
                         "shim must not be at the legacy 0.1.0 path")

    def test_init_satisfies_hermes_text_scan(self):
        """Hermes scans __init__.py text for MemoryProvider OR register_memory_provider.
        Our shim must contain at least one of those strings."""
        install_shim.cmd_init(self._args())
        init_py = self.hermes_home / "plugins" / "memex" / "__init__.py"
        content = init_py.read_text(encoding="utf-8")
        has_marker = (
            "MemoryProvider" in content
            or "register_memory_provider" in content
        )
        self.assertTrue(has_marker, "shim must contain Hermes scan marker")

    def test_init_idempotent(self):
        # Two inits in a row → both succeed, file content stays same.
        install_shim.cmd_init(self._args())
        content_a = (self.hermes_home / "plugins" / "memex" / "__init__.py").read_text()
        install_shim.cmd_init(self._args())
        content_b = (self.hermes_home / "plugins" / "memex" / "__init__.py").read_text()
        self.assertEqual(content_a, content_b)

    def test_init_missing_hermes_home_errors(self):
        ns = argparse.Namespace()
        ns.hermes_home = str(self.hermes_home.parent / "nonexistent")
        rc = install_shim.cmd_init(ns)
        self.assertEqual(rc, 2)

    def test_plugin_yaml_has_name_and_version(self):
        install_shim.cmd_init(self._args())
        yaml_path = self.hermes_home / "plugins" / "memex" / "plugin.yaml"
        content = yaml_path.read_text(encoding="utf-8")
        self.assertIn("name: memex", content)
        self.assertIn("version:", content)

    def test_uninstall_removes_shim(self):
        install_shim.cmd_init(self._args())
        shim_dir = self.hermes_home / "plugins" / "memex"
        self.assertTrue(shim_dir.exists())
        rc = install_shim.cmd_uninstall(self._args())
        self.assertEqual(rc, 0)
        self.assertFalse(shim_dir.exists())

    def test_init_migrates_legacy_0_1_0_path(self):
        """v0.1.0 left the shim at the wrong path. v0.1.1+ init should
        detect and clean it up so users don't have to manually mv."""
        # Simulate a 0.1.0 install: shim at wrong path.
        legacy_dir = self.hermes_home / "plugins" / "memory" / "memex"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "__init__.py").write_text("from memex_hermes import register\n")

        rc = install_shim.cmd_init(self._args())
        self.assertEqual(rc, 0)

        # Legacy path gone, new path present.
        self.assertFalse(legacy_dir.exists(), "legacy 0.1.0 shim should be removed")
        new_dir = self.hermes_home / "plugins" / "memex"
        self.assertTrue(new_dir.exists())
        self.assertTrue((new_dir / "__init__.py").exists())

    def test_init_migrates_and_removes_empty_memory_parent(self):
        """When migrating from 0.1.0, the now-empty plugins/memory/
        directory should also be cleaned up (if nothing else is in it)."""
        legacy_dir = self.hermes_home / "plugins" / "memory" / "memex"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "__init__.py").write_text("# stub")

        install_shim.cmd_init(self._args())

        # plugins/memory/ was created only for our shim — should be gone.
        legacy_parent = self.hermes_home / "plugins" / "memory"
        self.assertFalse(legacy_parent.exists())

    def test_init_preserves_other_plugins_in_legacy_dir(self):
        """If user has other plugins in plugins/memory/ (e.g. they
        manually placed them there for some reason), don't delete it."""
        legacy_dir = self.hermes_home / "plugins" / "memory" / "memex"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "__init__.py").write_text("# old")
        # Decoy: another plugin in the same parent
        decoy = self.hermes_home / "plugins" / "memory" / "other-plugin"
        decoy.mkdir()
        (decoy / "__init__.py").write_text("# someone else's")

        install_shim.cmd_init(self._args())

        # Our legacy gone, decoy preserved, parent kept.
        self.assertFalse(legacy_dir.exists())
        self.assertTrue(decoy.exists())
        self.assertTrue((decoy / "__init__.py").exists())

    def test_uninstall_also_removes_legacy(self):
        """Uninstall should clean up both correct path AND legacy path
        in case a user installed 0.1.0 and never re-ran init."""
        legacy_dir = self.hermes_home / "plugins" / "memory" / "memex"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "__init__.py").write_text("# stub")

        rc = install_shim.cmd_uninstall(self._args())
        self.assertEqual(rc, 0)
        self.assertFalse(legacy_dir.exists())

    def test_uninstall_when_not_installed(self):
        # Should be a no-op exit-0, not an error.
        rc = install_shim.cmd_uninstall(self._args())
        self.assertEqual(rc, 0)

    # ---------- v0.1.5: auto-backfill on init ----------

    def _args_with_backfill_opts(self, *, no_backfill=False, memex_db=None, since=None):
        """Build argparse.Namespace mirroring what main() would create
        with the new v0.1.5 flags on `init`. Helper for the backfill tests."""
        ns = argparse.Namespace()
        ns.hermes_home = str(self.hermes_home)
        ns.no_backfill = no_backfill
        ns.memex_db = memex_db
        ns.since = since
        return ns

    def test_init_auto_backfills_history_by_default(self):
        """v0.1.5: init must default to importing pre-install history
        from state.db so the user gets a usable memex.db immediately
        (the "wow moment" the design calls for)."""
        _seed_hermes_state_db(self.hermes_home / "state.db")
        memex_db = str(Path(self.tmp.name) / "memex.db")

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_init(
                self._args_with_backfill_opts(memex_db=memex_db),
            )
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("Importing your Hermes history", out)
        self.assertIn("new messages added:", out)

        # And the data is actually in memex.db.
        store = MemexStore(memex_db)
        try:
            self.assertEqual(store.count(), 2, "both seeded messages should land in memex.db")
        finally:
            store.close()

    def test_init_no_backfill_flag_skips_import(self):
        """--no-backfill must skip the import (for users with sensitive
        history or huge corpora who want to control timing)."""
        _seed_hermes_state_db(self.hermes_home / "state.db")
        memex_db = str(Path(self.tmp.name) / "memex.db")

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_init(
                self._args_with_backfill_opts(no_backfill=True, memex_db=memex_db),
            )
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("backfill skipped", out.lower())
        self.assertNotIn("Importing your Hermes history", out)

        # The memex.db should either not exist OR be empty — definitely
        # no Hermes rows.
        if Path(memex_db).exists():
            store = MemexStore(memex_db)
            try:
                self.assertEqual(store.count(), 0)
            finally:
                store.close()

    def test_init_handles_missing_state_db_gracefully(self):
        """First-time Hermes users may not have state.db yet (e.g. they
        installed the plugin before ever running Hermes). init must
        succeed with a friendly message rather than blow up."""
        # No state.db seeded — clean hermes_home only contains plugins/ dir
        # (created by cmd_init implicitly).
        memex_db = str(Path(self.tmp.name) / "memex.db")

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_init(
                self._args_with_backfill_opts(memex_db=memex_db),
            )
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("No Hermes history found yet", out)
        # No memex.db rows; file might not even exist.
        if Path(memex_db).exists():
            store = MemexStore(memex_db)
            try:
                self.assertEqual(store.count(), 0)
            finally:
                store.close()

    def test_init_handles_backfill_error_gracefully(self):
        """If state.db is corrupt or unreadable, init must NOT fail —
        live capture should still work after restart, so plugin install
        is the more important guarantee."""
        # Write a non-SQLite file at state.db path → backfill will raise.
        bad_state = self.hermes_home / "state.db"
        bad_state.write_bytes(b"this is not a sqlite database")
        memex_db = str(Path(self.tmp.name) / "memex.db")

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_init(
                self._args_with_backfill_opts(memex_db=memex_db),
            )
        self.assertEqual(rc, 0, "init must succeed even when backfill blows up")
        out = buf.getvalue()
        self.assertTrue(
            "Backfill failed" in out or "errors" in out.lower(),
            f"expected a non-fatal backfill error message, got:\n{out}",
        )

    def test_init_via_main_default_runs_backfill(self):
        """Smoke-test through main() argv parsing — the CLI surface the
        user actually invokes (or that an agent invokes on their behalf)."""
        _seed_hermes_state_db(self.hermes_home / "state.db")
        memex_db = str(Path(self.tmp.name) / "memex.db")

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.main([
                "init",
                "--hermes-home", str(self.hermes_home),
                "--memex-db", memex_db,
            ])
        self.assertEqual(rc, 0)
        self.assertIn("Importing your Hermes history", buf.getvalue())
        store = MemexStore(memex_db)
        try:
            self.assertEqual(store.count(), 2)
        finally:
            store.close()

    def test_init_via_main_no_backfill_flag(self):
        """Smoke-test --no-backfill through main()."""
        _seed_hermes_state_db(self.hermes_home / "state.db")
        memex_db = str(Path(self.tmp.name) / "memex.db")

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.main([
                "init",
                "--hermes-home", str(self.hermes_home),
                "--memex-db", memex_db,
                "--no-backfill",
            ])
        self.assertEqual(rc, 0)
        self.assertIn("backfill skipped", buf.getvalue().lower())

    def test_status_reports_installed(self):
        install_shim.cmd_init(self._args())
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_status(self._args())
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("Shim installed: True", out)
        self.assertIn("recognised (auto-generated)", out)

    def test_status_reports_not_installed(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_status(self._args())
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("Shim installed: False", out)


class TestEnvHermesHome(unittest.TestCase):
    def test_env_var_used_when_no_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            hermes = Path(tmp) / "envhermes"
            hermes.mkdir()
            os.environ["HERMES_HOME"] = str(hermes)
            try:
                ns = argparse.Namespace(hermes_home=None)
                rc = install_shim.cmd_init(ns)
                self.assertEqual(rc, 0)
                self.assertTrue((hermes / "plugins" / "memex" / "__init__.py").exists())
            finally:
                os.environ.pop("HERMES_HOME", None)


class TestMainCLI(unittest.TestCase):
    """Smoke-test that argv routing works."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes_home = Path(self.tmp.name) / "h"
        self.hermes_home.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_init_via_main(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.main(["init", "--hermes-home", str(self.hermes_home)])
        self.assertEqual(rc, 0)
        self.assertIn("shim installed", buf.getvalue())

    def test_status_via_main(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.main(["status", "--hermes-home", str(self.hermes_home)])
        self.assertEqual(rc, 0)

    def test_uninstall_via_main(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            install_shim.main(["init", "--hermes-home", str(self.hermes_home)])
            rc = install_shim.main(["uninstall", "--hermes-home", str(self.hermes_home)])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
