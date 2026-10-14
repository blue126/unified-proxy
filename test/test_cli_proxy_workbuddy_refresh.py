"""Verify expiry scheduling, rotating-token persistence and timer health."""

import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


class WorkBuddyRefreshTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parent.parent / 'scripts/cli-proxy-refresh-workbuddy.py'
        spec = importlib.util.spec_from_file_location('workbuddy_refresh_test', source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        private = self.root / '.cli-proxy-api'
        private.mkdir(mode=0o700)
        auths = private / 'auths'
        auths.mkdir(mode=0o700)
        self.path = auths / 'workbuddy.json'
        self.now = time.time()
        self.data = {'type': 'workbuddy', 'auth_type': 'oauth', 'auth': {
            'accessToken': os.urandom(16).hex(), 'refreshToken': os.urandom(16).hex(),
            'expiresAt': int(self.now + 300)}}
        self.save(self.data)
        key = private / 'management-key'
        key.write_text(os.urandom(16).hex())
        key.chmod(0o600)

    def save(self, data):
        self.path.write_text(json.dumps(data))
        self.path.chmod(0o600)

    def rotate(self, path, key):
        self.assertEqual(path, self.path)
        self.assertTrue(key)
        data = json.loads(path.read_text())
        data['auth']['refreshToken'] = os.urandom(16).hex()
        data['auth']['accessToken'] = os.urandom(16).hex()
        data['auth']['expiresAt'] = int(self.now + 3600)
        self.save(data)

    def test_unexpired_token_does_not_refresh(self):
        self.data['auth']['expiresAt'] = int(self.now + 3600)
        self.save(self.data)
        with patch.object(self.module, 'refresh') as refresh:
            self.assertEqual(self.module.execute(self.root), (1, 0))
        refresh.assert_not_called()

    def test_due_token_refreshes_and_rotating_credentials_are_persisted(self):
        old = self.path.read_bytes()
        with patch.object(self.module, 'refresh', side_effect=self.rotate) as refresh:
            self.assertEqual(self.module.execute(self.root), (1, 1))
        refresh.assert_called_once()
        self.assertNotEqual(self.path.read_bytes(), old)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_expired_token_can_recover(self):
        self.data['auth']['expiresAt'] = int(self.now - 60)
        self.save(self.data)
        with patch.object(self.module, 'refresh', side_effect=self.rotate):
            self.assertEqual(self.module.execute(self.root), (1, 1))

    def test_explicit_force_refresh_verifies_a_still_valid_token(self):
        self.data['auth']['expiresAt'] = int(self.now + 1800)
        self.save(self.data)
        with patch.object(self.module, 'refresh', side_effect=self.rotate) as refresh:
            self.assertEqual(self.module.execute(self.root, force=True), (1, 1))
        refresh.assert_called_once()

    def test_invalid_expiry_is_rejected_without_a_request(self):
        for value in (True, 0, 'tomorrow', float('nan')):
            self.data['auth']['expiresAt'] = value
            self.save(self.data)
            with patch.object(self.module, 'refresh') as refresh:
                with self.assertRaisesRegex(RuntimeError, 'expiry'):
                    self.module.execute(self.root)
            refresh.assert_not_called()

    def test_refresh_failure_does_not_overwrite_credentials(self):
        old = self.path.read_bytes()
        with patch.object(self.module, 'refresh', side_effect=RuntimeError('simulated failure')):
            with self.assertRaises(RuntimeError):
                self.module.execute(self.root)
        self.assertEqual(self.path.read_bytes(), old)

    def test_success_without_persisted_extension_is_rejected(self):
        with patch.object(self.module, 'refresh'):
            with self.assertRaisesRegex(RuntimeError, 'persist'):
                self.module.execute(self.root)

    def test_check_mode_never_refreshes_and_detects_expired_token(self):
        with patch.object(self.module, 'refresh') as refresh:
            self.assertEqual(self.module.execute(self.root, check=True), (1, 0))
            self.data['auth']['expiresAt'] = int(self.now - 60)
            self.save(self.data)
            with self.assertRaisesRegex(RuntimeError, 'expired'):
                self.module.execute(self.root, check=True)
        refresh.assert_not_called()

    def test_api_keys_disabled_and_other_providers_are_skipped(self):
        for skipped in ({'type': 'claude'}, {'type': 'workbuddy', 'auth_type': 'api_key'},
                        {'type': 'workbuddy', 'auth_type': 'oauth', 'disabled': True}):
            self.save(skipped)
            with patch.object(self.module, 'refresh') as refresh:
                with self.assertRaisesRegex(RuntimeError, 'No enabled'):
                    self.module.execute(self.root)
            refresh.assert_not_called()

    def test_symlinked_auth_file_is_rejected(self):
        target = self.root / 'other'
        self.path.rename(target)
        self.path.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
            self.module.execute(self.root)

    def test_management_request_is_local_and_selects_one_credential(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self):
                return b'{"ok":true}'
        with patch.object(self.module, 'build_opener') as opener:
            opener.return_value.open.return_value = Response()
            self.module.refresh(self.path, 'test-only')
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8317/v0/management/auth-files/refresh')
        self.assertEqual(json.loads(request.data), {'name': 'workbuddy.json'})

    def test_timer_health_rejects_failure_and_stale_execution(self):
        def run(args, **kwargs):
            from types import SimpleNamespace
            if '--property=Result' in args:
                return SimpleNamespace(returncode=0, stdout=self.result)
            if args[0] == 'busctl':
                return SimpleNamespace(returncode=0, stdout='t ' + str(self.trigger))
            return SimpleNamespace(returncode=0, stdout='')
        self.result, self.trigger = 'success', 900_000_000
        with patch.object(self.module.subprocess, 'run', side_effect=run), \
                patch.object(self.module.Path, 'read_text', return_value='1000.0 0.0'):
            self.module.check_timer()
            self.result = 'exit-code'
            with self.assertRaisesRegex(RuntimeError, 'failed'):
                self.module.check_timer()
            self.result, self.trigger = 'success', 1_000_000
            with self.assertRaisesRegex(RuntimeError, 'recently'):
                self.module.check_timer()


if __name__ == '__main__':
    unittest.main()
