"""Validate that cutover failures restore public routing and the old runtime."""

import contextlib
import importlib.util
import io
import secrets
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class CutoverRecoveryTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parent.parent / "scripts" / "cli-proxy-cutover.py"
        spec = importlib.util.spec_from_file_location("cutover_under_test", source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        m = self.module
        m.ROOT = self.root
        m.PRIVATE = self.root / ".cli-proxy-api"
        m.PRIVATE.mkdir(mode=0o700)
        m.CADDYFILE = self.root / "Caddyfile"
        self.original = "proxy.example.invalid {\n\treverse_proxy 127.0.0.1:3456\n}\n"
        m.CADDYFILE.write_text(self.original)
        m.CADDYFILE.chmod(0o640)
        self.owner = (m.CADDYFILE.stat().st_uid, m.CADDYFILE.stat().st_gid)
        m.MARKER = self.root / ".cli-proxy-active"
        m.BACKUP = m.PRIVATE / "rollback" / "Caddyfile.before-cli-proxy"
        m.LEGACY_COMPOSE = ["legacy-compose"]
        self.key = "sk-" + secrets.token_hex(32)
        (m.PRIVATE / "upstream-key").write_text(self.key + "\n")
        (self.root / ".env.litellm").write_text("PROXY_API_KEY=" + self.key + "\n")
        self.calls = []
        self.stopped = False
        self.policy = "unless-stopped"
        self.public_calls = 0
        self.fail_on_public = None

        def run(args):
            self.calls.append(args)
            if args[:1] == ["legacy-compose"]:
                if "ps" in args:
                    return "old-gateway\nold-database\n"
                if "stop" in args:
                    self.stopped = True
                if "up" in args:
                    self.stopped = False
            if args[:2] == ["docker", "update"]:
                self.policy = args[2].split("=", 1)[1]
            return ""

        def smoke(base, key, *, public):
            self.assertEqual(key, self.key)
            if public:
                self.public_calls += 1
                if self.public_calls == self.fail_on_public:
                    raise RuntimeError("Synthetic public verification failure")

        m.run = run
        m.smoke = smoke

    def tearDown(self):
        self.directory.cleanup()

    def invoke(self, *extra):
        argv = ["cutover", "--base-url", "https://proxy.example.invalid", *extra]
        with patch("sys.argv", argv), patch.object(self.module.os, "geteuid", return_value=0):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                return self.module.main()

    def assert_restored(self):
        self.assertEqual(self.module.CADDYFILE.read_text(), self.original)
        self.assertFalse(self.module.MARKER.exists())
        self.assertFalse(self.stopped)
        self.assertEqual(self.policy, "unless-stopped")
        info = self.module.CADDYFILE.stat()
        self.assertEqual((info.st_uid, info.st_gid), self.owner)
        self.assertEqual(info.st_mode & 0o777, 0o640)

    def test_check_mode_leaves_public_runtime_untouched(self):
        self.assertEqual(self.invoke("--check"), 0)
        self.assert_restored()
        self.assertFalse(self.module.BACKUP.exists())
        self.assertEqual(self.public_calls, 0)

    def test_success_preserves_backup_and_retires_old_runtime(self):
        self.assertEqual(self.invoke("--workflow-ready"), 0)
        self.assertEqual(self.module.BACKUP.read_text(), self.original)
        self.assertTrue(self.module.MARKER.exists())
        self.assertTrue(self.stopped)
        self.assertEqual(self.policy, "no")
        self.assertEqual(self.public_calls, 2)
        self.assertIn("handle @cli_private", self.module.CADDYFILE.read_text())
        self.assertEqual(self.module.CADDYFILE.stat().st_mode & 0o777, 0o640)

    def test_failed_public_call_restores_gateway_and_allows_retry(self):
        self.fail_on_public = 1
        self.assertEqual(self.invoke("--workflow-ready"), 1)
        self.assert_restored()
        self.fail_on_public = None
        self.assertEqual(self.invoke("--workflow-ready"), 0)

    def test_failure_after_retirement_restores_container_policies(self):
        self.fail_on_public = 2
        self.assertEqual(self.invoke("--workflow-ready"), 1)
        self.assert_restored()


if __name__ == "__main__":
    unittest.main()
