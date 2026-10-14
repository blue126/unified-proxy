"""Verify private state preservation and public subscription health checks."""

import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError


def load(name):
    source = Path(__file__).resolve().parent.parent / 'scripts' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PublicSmokeTests(unittest.TestCase):
    def setUp(self):
        self.module = load('cli-proxy-public-smoke')
        self.catalog = self.module.GPT_MODELS | self.module.CODEBUDDY_MODELS | {'claude-sonnet-5', 'gemini-3-flash'}
        self.empty_model = None
        self.allow_anonymous = False
        self.allow_management = False
        self.completed = True
        self.called = []

    def request(self, base, path, key='', payload=None):
        if path == '/':
            return {'message': 'CLI Proxy API Server'}
        if path == '/v1/models':
            if not key and not self.allow_anonymous:
                raise HTTPError('https://example.invalid', 401, '', {}, None)
            return {'data': [{'id': model} for model in self.catalog]}
        if 'management' in path:
            if not self.allow_management:
                raise HTTPError('https://example.invalid', 404, '', {}, None)
            return {}
        self.called.append(payload['model'])
        if path == '/v1/responses':
            return {'status': 'completed' if self.completed else 'incomplete',
                    'output': [{'content': [{'type': 'output_text', 'text': 'pong'}]}]}
        return {'choices': [{'message': {'content': '  ' if payload['model'] == self.empty_model else 'pong'}}]}

    def invoke(self):
        with patch.object(self.module, 'request', side_effect=self.request), \
                patch.dict(os.environ, {'PROXY_API_KEY': 'test-only'}, clear=True), \
                patch('sys.argv', ['smoke', '--public']), contextlib.redirect_stdout(io.StringIO()):
            return self.module.main()

    def test_all_four_providers_are_called(self):
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.called, ['gpt-6-luna', 'claude-sonnet-5', 'gemini-3-flash', 'glm-5.2'])

    def test_missing_codebuddy_catalog_fails_before_inference(self):
        self.catalog.remove('glm-5.2')
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertEqual(self.called, [])

    def test_codebuddy_empty_reply_is_a_failure(self):
        self.empty_model = 'glm-5.2'
        with self.assertRaises(SystemExit):
            self.invoke()

    def test_anonymous_access_is_a_failure(self):
        self.allow_anonymous = True
        with self.assertRaises(SystemExit):
            self.invoke()

    def test_public_management_access_is_a_failure(self):
        self.allow_management = True
        with self.assertRaises(SystemExit):
            self.invoke()

    def test_incomplete_gpt_response_is_a_failure(self):
        self.completed = False
        with self.assertRaises(SystemExit):
            self.invoke()


class PrivateInitializationTests(unittest.TestCase):
    def setUp(self):
        self.module = load('cli-proxy-init')
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def initialize(self):
        with patch('sys.argv', ['init', '--root', str(self.root)]), contextlib.redirect_stdout(io.StringIO()):
            self.module.main()

    def test_repeated_initialization_preserves_keys_and_config(self):
        self.initialize()
        private = self.root / '.cli-proxy-api'
        original = {name: (private / name).read_bytes() for name in ('upstream-key', 'management-key', 'config.yaml')}
        self.initialize()
        self.assertEqual(original, {name: (private / name).read_bytes() for name in original})
        self.assertNotEqual(original['upstream-key'], original['management-key'])
        for name in original:
            self.assertEqual((private / name).stat().st_mode & 0o777, 0o600)

    def test_changed_config_is_rejected_without_overwrite(self):
        self.initialize()
        config = self.root / '.cli-proxy-api/config.yaml'
        config.write_text('operator-modified config')
        with self.assertRaises(RuntimeError):
            self.initialize()
        self.assertEqual(config.read_text(), 'operator-modified config')

    def test_shared_private_directory_is_rejected(self):
        self.initialize()
        (self.root / '.cli-proxy-api').chmod(0o755)
        with self.assertRaises(RuntimeError):
            self.initialize()

    def test_credential_symlink_is_rejected(self):
        self.initialize()
        key = self.root / '.cli-proxy-api/upstream-key'
        key.unlink()
        target = self.root / 'other-key'
        target.write_text('other')
        key.symlink_to(target)
        with self.assertRaises(RuntimeError):
            self.initialize()
        self.assertEqual(target.read_text(), 'other')


class LegacyRetirementTests(unittest.TestCase):
    def setUp(self):
        self.module = load('cli-proxy-retire-legacy')
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.module.ROOT = self.root
        self.addCleanup(self.directory.cleanup)

    def container(self, running=False, restart='no', project='unified-proxy-litellm'):
        return {'State': {'Running': running}, 'HostConfig': {'RestartPolicy': {'Name': restart}},
                'Config': {'Labels': {'com.docker.compose.project': project}}}

    def test_running_or_restartable_containers_are_rejected(self):
        for data in (self.container(running=True), self.container(restart='unless-stopped')):
            with self.assertRaises(RuntimeError):
                self.module.validate_container(data)

    def test_unrelated_containers_are_rejected(self):
        with self.assertRaises(RuntimeError):
            self.module.validate_container(self.container(project='another-app'))

    def test_archive_is_private_and_preserves_original(self):
        source = self.root / 'credentials'
        source.write_bytes(os.urandom(32))
        source.chmod(0o600)
        with contextlib.redirect_stdout(io.StringIO()):
            archive = self.module.verified_archive([source])
        self.assertTrue(source.exists())
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(archive.parent.stat().st_mode & 0o777, 0o700)
        self.assertTrue(archive.with_name('SHA256SUMS').is_file())

    def test_archive_verification_detects_changed_data_before_deletion(self):
        source = self.root / 'credentials'
        source.write_bytes(os.urandom(32))
        run = self.module.run

        def mutate_after_archive(*args):
            result = run(*args)
            source.write_bytes(os.urandom(32))
            return result

        with patch.object(self.module, 'run', side_effect=mutate_after_archive):
            with self.assertRaises(RuntimeError):
                self.module.verified_archive([source])
        self.assertTrue(source.exists())


if __name__ == '__main__':
    unittest.main()
