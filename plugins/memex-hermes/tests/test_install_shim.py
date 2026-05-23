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
import json
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


# ============================================================
# v0.2.0 — `memex-hermes setup` one-shot install
# ============================================================

class TestWireHermesConfig(unittest.TestCase):
    """Unit tests for wire_hermes_config()."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes_home = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_creates_config_when_absent(self):
        result = install_shim.wire_hermes_config(self.hermes_home)
        self.assertEqual(result["action"], "created")
        cfg_path = self.hermes_home / "config.yaml"
        self.assertTrue(cfg_path.exists())
        content = cfg_path.read_text()
        self.assertIn("memory:", content)
        self.assertIn("memex", content)

    def test_appends_when_memory_section_absent(self):
        cfg_path = self.hermes_home / "config.yaml"
        cfg_path.write_text("other_setting: value\n")
        result = install_shim.wire_hermes_config(self.hermes_home)
        self.assertEqual(result["action"], "wired")
        # Original setting must still be present.
        content = cfg_path.read_text()
        self.assertIn("other_setting", content)
        self.assertIn("memex", content)

    def test_no_op_when_already_memex(self):
        cfg_path = self.hermes_home / "config.yaml"
        cfg_path.write_text('memory:\n  provider: "memex"\n')
        mtime_before = cfg_path.stat().st_mtime
        result = install_shim.wire_hermes_config(self.hermes_home)
        self.assertEqual(result["action"], "already_set")
        # File should not have been rewritten.
        self.assertEqual(cfg_path.stat().st_mtime, mtime_before)

    def test_refuses_to_overwrite_other_provider(self):
        cfg_path = self.hermes_home / "config.yaml"
        cfg_path.write_text('memory:\n  provider: "mem0"\n')
        result = install_shim.wire_hermes_config(self.hermes_home)
        self.assertEqual(result["action"], "conflicting")
        self.assertEqual(result["existing_provider"], "mem0")
        # File must be unchanged.
        self.assertIn("mem0", cfg_path.read_text())
        self.assertNotIn("memex", cfg_path.read_text())

    def test_force_overrides_conflict(self):
        cfg_path = self.hermes_home / "config.yaml"
        cfg_path.write_text('memory:\n  provider: "mem0"\n')
        result = install_shim.wire_hermes_config(self.hermes_home, force=True)
        self.assertEqual(result["action"], "force_overwritten")
        self.assertEqual(result["replaced_provider"], "mem0")
        self.assertIn("memex", cfg_path.read_text())
        self.assertNotIn("mem0", cfg_path.read_text())

    def test_parse_failed_when_invalid_yaml(self):
        cfg_path = self.hermes_home / "config.yaml"
        # Tabs in YAML mappings = invalid for safe_load
        cfg_path.write_text("memory:\n\tprovider: bad\n")
        result = install_shim.wire_hermes_config(self.hermes_home)
        self.assertEqual(result["action"], "parse_failed")
        self.assertIn("warning", result)

    def test_parse_failed_when_top_level_not_dict(self):
        cfg_path = self.hermes_home / "config.yaml"
        cfg_path.write_text("- just a list\n- nothing more\n")
        result = install_shim.wire_hermes_config(self.hermes_home)
        self.assertEqual(result["action"], "parse_failed")

    def test_parse_failed_when_memory_section_not_dict(self):
        cfg_path = self.hermes_home / "config.yaml"
        cfg_path.write_text('memory: "just a string"\n')
        result = install_shim.wire_hermes_config(self.hermes_home)
        self.assertEqual(result["action"], "parse_failed")


class TestDetectRestartMechanism(unittest.TestCase):
    """detect_restart_mechanism — heuristically exercised via mocks.

    We can't realistically `systemctl is-active hermes` from a test —
    instead, patch subprocess.run to return canned responses and verify
    the function picks the right branch and emits the right command.
    """

    def _make_run_mock(self, responses):
        """Build a fake subprocess.run that pops a planned response per call.

        Each response is a dict with keys returncode + stdout.
        After responses run out, returns a default failure.
        """
        import subprocess as sp

        class _R:
            def __init__(self, rc, out):
                self.returncode = rc
                self.stdout = out

        def fake_run(cmd, *args, **kwargs):
            if responses:
                r = responses.pop(0)
                return _R(r["returncode"], r["stdout"])
            return _R(1, "")
        return fake_run

    def test_systemd_user_detected_first(self):
        from unittest import mock

        # First call: `systemctl --user is-active hermes` → active
        responses = [{"returncode": 0, "stdout": "active\n"}]
        with mock.patch("memex_hermes.install_shim.subprocess.run",
                         side_effect=self._make_run_mock(responses)), \
             mock.patch("memex_hermes.install_shim.shutil.which",
                        return_value="/usr/bin/systemctl"):
            result = install_shim.detect_restart_mechanism()
        self.assertEqual(result["method"], "systemd-user")
        self.assertIn("systemctl --user restart hermes", result["command"])

    def test_pkill_fallback_when_only_process_found(self):
        from unittest import mock

        # All systemctl probes fail; launchctl absent (not macOS); pgrep works.
        def fake_which(name):
            return "/usr/bin/" + name if name in ("systemctl", "pgrep") else None

        # 4 systemctl probes fail, then pgrep succeeds with a PID.
        responses = [
            {"returncode": 1, "stdout": ""},  # systemctl --user hermes
            {"returncode": 1, "stdout": ""},  # systemctl --user hermes-agent
            {"returncode": 1, "stdout": ""},  # systemctl hermes
            {"returncode": 1, "stdout": ""},  # systemctl hermes-agent
            {"returncode": 0, "stdout": "12345\n"},  # pgrep
        ]
        with mock.patch("memex_hermes.install_shim.subprocess.run",
                         side_effect=self._make_run_mock(responses)), \
             mock.patch("memex_hermes.install_shim.shutil.which",
                        side_effect=fake_which), \
             mock.patch("memex_hermes.install_shim.platform.system",
                        return_value="Linux"):
            result = install_shim.detect_restart_mechanism()
        self.assertEqual(result["method"], "pkill")
        self.assertIn("pkill", result["command"])

    def test_manual_when_nothing_detected(self):
        from unittest import mock

        with mock.patch("memex_hermes.install_shim.shutil.which",
                         return_value=None), \
             mock.patch("memex_hermes.install_shim.platform.system",
                        return_value="Linux"):
            result = install_shim.detect_restart_mechanism()
        self.assertEqual(result["method"], "manual")
        self.assertEqual(result["command"], "")

    def test_handles_subprocess_timeouts_gracefully(self):
        from unittest import mock
        import subprocess as sp

        def fake_run(*a, **kw):
            raise sp.TimeoutExpired(cmd=a[0], timeout=3)

        with mock.patch("memex_hermes.install_shim.subprocess.run",
                         side_effect=fake_run), \
             mock.patch("memex_hermes.install_shim.shutil.which",
                        return_value="/usr/bin/systemctl"):
            # Should fall through to manual instead of crashing.
            result = install_shim.detect_restart_mechanism()
        self.assertEqual(result["method"], "manual")


class TestScheduleSelfRestart(unittest.TestCase):
    """schedule_self_restart — must Popen with start_new_session=True
    and never block on the parent. We can't actually trigger a real
    restart in tests; mock Popen to verify the call shape.
    """

    def test_returns_scheduled_true_on_success(self):
        from unittest import mock
        with mock.patch("memex_hermes.install_shim.subprocess.Popen") as p:
            result = install_shim.schedule_self_restart(
                "echo test", delay_seconds=2,
            )
        self.assertTrue(result["scheduled"])
        self.assertEqual(result["delay_seconds"], 2)
        # Popen was called with start_new_session — detaches background work.
        kwargs = p.call_args.kwargs
        self.assertTrue(kwargs.get("start_new_session"))
        self.assertTrue(kwargs.get("shell"))

    def test_returns_scheduled_false_on_popen_error(self):
        from unittest import mock
        with mock.patch(
            "memex_hermes.install_shim.subprocess.Popen",
            side_effect=OSError("simulated"),
        ):
            result = install_shim.schedule_self_restart("echo test")
        self.assertFalse(result["scheduled"])
        self.assertIn("simulated", result["error"])

    def test_rejects_empty_command(self):
        result = install_shim.schedule_self_restart("")
        self.assertFalse(result["scheduled"])
        result2 = install_shim.schedule_self_restart("   ")
        self.assertFalse(result2["scheduled"])

    def test_clamps_negative_delay_to_minimum(self):
        from unittest import mock
        with mock.patch("memex_hermes.install_shim.subprocess.Popen"):
            result = install_shim.schedule_self_restart("echo test", delay_seconds=-5)
        # Implementation clamps to 1.
        self.assertEqual(result["delay_seconds"], 1)


class TestCmdSetup(unittest.TestCase):
    """End-to-end smoke tests for cmd_setup — composes all the pieces."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes_home = Path(self.tmp.name) / "hermes-home"
        self.hermes_home.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _args(self, **overrides):
        ns = argparse.Namespace(
            hermes_home=str(self.hermes_home),
            no_backfill=False,
            no_wire_config=False,
            auto_restart=False,
            no_auto_restart=True,  # for tests, never actually restart
            restart_delay=3,
            force=False,
            since=None,
            memex_db=str(Path(self.tmp.name) / "memex.db"),
            json=False,
        )
        for k, v in overrides.items():
            setattr(ns, k, v)
        return ns

    def test_setup_human_output_no_history_no_restart(self):
        # Fresh hermes_home, no state.db → backfill says "no_history".
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_setup(self._args())
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("setup complete", out.lower())
        self.assertIn("Config wired", out)  # config.yaml created
        # Shim exists.
        self.assertTrue((self.hermes_home / "plugins" / "memex" / "__init__.py").exists())
        # Config.yaml created with memex provider.
        cfg = self.hermes_home / "config.yaml"
        self.assertTrue(cfg.exists())
        self.assertIn("memex", cfg.read_text())

    def test_setup_json_output_parseable(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_setup(self._args(json=True))
        self.assertEqual(rc, 0)
        # Parse the JSON
        out = buf.getvalue().strip()
        # In JSON mode we may have init_log + the structured JSON. The
        # JSON is the ONLY thing on stdout (init's prints captured).
        data = json.loads(out)
        self.assertEqual(data["status"], "ready")
        self.assertIn("shim", data)
        self.assertEqual(data["shim"]["status"], "ok")
        self.assertIn("backfill", data)
        self.assertIn("config", data)
        self.assertIn("restart", data)
        self.assertIn("agent_instructions", data)
        # Restart was opt-out → no scheduling.
        self.assertEqual(data["restart"].get("auto_restart"), "opt_out")

    def test_setup_with_seeded_history_imports_and_reports(self):
        _seed_hermes_state_db(self.hermes_home / "state.db")
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_setup(self._args(json=True))
        self.assertEqual(rc, 0)
        data = json.loads(buf.getvalue())
        # Backfill imported the 2 seeded messages.
        self.assertEqual(data["backfill"]["status"], "imported")
        self.assertEqual(data["backfill"]["sessions"], 1)
        # After the real run, dry-run dedup count == messages now in memex.
        self.assertEqual(data["backfill"]["inserted"], 2)

    def test_setup_no_wire_config_leaves_config_alone(self):
        cfg = self.hermes_home / "config.yaml"
        cfg.write_text("other: value\n")
        original = cfg.read_text()
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.cmd_setup(self._args(no_wire_config=True))
        self.assertEqual(rc, 0)
        # Config untouched.
        self.assertEqual(cfg.read_text(), original)

    def test_setup_via_main_smoke(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = install_shim.main([
                "setup",
                "--hermes-home", str(self.hermes_home),
                "--memex-db", str(Path(self.tmp.name) / "memex.db"),
                "--no-auto-restart",
                "--json",
            ])
        self.assertEqual(rc, 0)
        data = json.loads(buf.getvalue())
        self.assertEqual(data["status"], "ready")


class TestAgentInstructions(unittest.TestCase):
    """The agent_instructions string is what the LLM relays to the user.
    Verify it adapts to each combination of outcomes."""

    def test_mentions_imported_history_when_present(self):
        result = {
            "backfill": {"status": "imported", "inserted": 42, "skipped": 0},
            "config": {"action": "wired"},
            "restart": {"method": "systemd-user",
                        "command": "systemctl --user restart hermes",
                        "auto_restart": "scheduled",
                        "delay_seconds": 3},
        }
        text = install_shim._format_agent_instructions(result)
        self.assertIn("42", text)
        self.assertIn("imported", text.lower())
        self.assertIn("restart", text.lower())

    def test_explains_no_terminal_path_when_manual(self):
        """For Telegram users without VPS shell — manual restart should
        tell them to ask the agent to restart itself, NOT to open a
        terminal."""
        result = {
            "backfill": {"status": "imported", "inserted": 0, "skipped": 10},
            "config": {"action": "already_set"},
            "restart": {"method": "manual"},
        }
        text = install_shim._format_agent_instructions(result)
        self.assertIn("restart yourself", text.lower())
        # Should NOT instruct user to open a terminal.
        self.assertNotIn("open", text.lower())

    def test_warns_about_conflicting_provider(self):
        result = {
            "backfill": {"status": "no_history"},
            "config": {"action": "conflicting", "existing_provider": "mem0"},
            "restart": {"method": "systemd-user",
                        "command": "systemctl --user restart hermes",
                        "auto_restart": "scheduled",
                        "delay_seconds": 3},
        }
        text = install_shim._format_agent_instructions(result)
        self.assertIn("mem0", text)
        self.assertTrue("--force" in text or "manually" in text.lower())


if __name__ == "__main__":
    unittest.main()
