"""Tests for the shim install/uninstall/status CLI.

The shim is what makes the plugin discoverable in Hermes' folder-based
loader. These tests verify:

  • `memex-hermes init`     creates the right files at the right path
  • The generated __init__.py contains the textual markers Hermes scans
    for (`MemoryProvider` or `register_memory_provider`)
  • `memex-hermes uninstall` removes the shim folder
  • `memex-hermes status`   reports correctly in both states
  • Idempotency: init twice is fine
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memex_hermes import install_shim  # noqa: E402


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
        init_py = self.hermes_home / "plugins" / "memory" / "memex" / "__init__.py"
        plugin_yaml = self.hermes_home / "plugins" / "memory" / "memex" / "plugin.yaml"
        self.assertTrue(init_py.exists())
        self.assertTrue(plugin_yaml.exists())

    def test_init_satisfies_hermes_text_scan(self):
        """Hermes scans __init__.py text for MemoryProvider OR register_memory_provider.
        Our shim must contain at least one of those strings."""
        install_shim.cmd_init(self._args())
        init_py = self.hermes_home / "plugins" / "memory" / "memex" / "__init__.py"
        content = init_py.read_text(encoding="utf-8")
        has_marker = (
            "MemoryProvider" in content
            or "register_memory_provider" in content
        )
        self.assertTrue(has_marker, "shim must contain Hermes scan marker")

    def test_init_idempotent(self):
        # Two inits in a row → both succeed, file content stays same.
        install_shim.cmd_init(self._args())
        content_a = (self.hermes_home / "plugins" / "memory" / "memex" / "__init__.py").read_text()
        install_shim.cmd_init(self._args())
        content_b = (self.hermes_home / "plugins" / "memory" / "memex" / "__init__.py").read_text()
        self.assertEqual(content_a, content_b)

    def test_init_missing_hermes_home_errors(self):
        ns = argparse.Namespace()
        ns.hermes_home = str(self.hermes_home.parent / "nonexistent")
        rc = install_shim.cmd_init(ns)
        self.assertEqual(rc, 2)

    def test_plugin_yaml_has_name_and_version(self):
        install_shim.cmd_init(self._args())
        yaml_path = self.hermes_home / "plugins" / "memory" / "memex" / "plugin.yaml"
        content = yaml_path.read_text(encoding="utf-8")
        self.assertIn("name: memex", content)
        self.assertIn("version:", content)

    def test_uninstall_removes_shim(self):
        install_shim.cmd_init(self._args())
        shim_dir = self.hermes_home / "plugins" / "memory" / "memex"
        self.assertTrue(shim_dir.exists())
        rc = install_shim.cmd_uninstall(self._args())
        self.assertEqual(rc, 0)
        self.assertFalse(shim_dir.exists())

    def test_uninstall_when_not_installed(self):
        # Should be a no-op exit-0, not an error.
        rc = install_shim.cmd_uninstall(self._args())
        self.assertEqual(rc, 0)

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
                self.assertTrue((hermes / "plugins" / "memory" / "memex" / "__init__.py").exists())
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
