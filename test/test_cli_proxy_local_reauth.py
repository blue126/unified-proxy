"""Verify the local re-authentication helper without SSH, browser or network."""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def load():
    source = Path(__file__).resolve().parent.parent / 'scripts' / 'reauth.py'
    spec = importlib.util.spec_from_file_location('local_reauth', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SecretsTests(unittest.TestCase):
    def test_reads_values_and_strips_comments(self):
        module = load()
        with tempfile.NamedTemporaryFile('w', suffix='.env') as handle:
            handle.write('# comment\nOCI_HOST=h  # ip\nOCI_USER=u\nOCI_SSH_KEY_FILE=~/.ssh/k\n'
                         'PROXY_DOMAIN=d\nPROXY_API_KEY=k\n')
            handle.flush()
            values = module.read_secrets(Path(handle.name))
        self.assertEqual(values['OCI_HOST'], 'h')

    def test_missing_values_are_named(self):
        module = load()
        with tempfile.NamedTemporaryFile('w', suffix='.env') as handle:
            handle.write('OCI_HOST=h\n')
            handle.flush()
            with self.assertRaises(SystemExit) as raised:
                module.read_secrets(Path(handle.name))
        self.assertIn('PROXY_API_KEY', str(raised.exception))


class ProviderTableTests(unittest.TestCase):
    def test_every_provider_has_a_live_check(self):
        module = load()
        source = Path(module.__file__).parent / 'cli-proxy-public-smoke.py'
        spec = importlib.util.spec_from_file_location('smoke', source)
        smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(smoke)
        for provider, (_, _, _, smoke_provider) in module.PROVIDERS.items():
            with self.subTest(provider=provider):
                self.assertIn(smoke_provider, smoke.PROVIDERS)


class WaitForLoginTests(unittest.TestCase):
    def setUp(self):
        self.module = load()
        self.calls = []
        self.statuses = []

    def call(self, key, path, payload=None):
        self.calls.append((path, payload))
        if path.startswith('/get-auth-status'):
            return {'status': self.statuses.pop(0)}
        return {'status': 'ok'}

    def wait(self, lines=(), provider='anthropic'):
        lines = list(lines)
        with patch.object(self.module, 'call', side_effect=self.call):
            self.module.wait_for_login('k', 'st', provider, timeout=60,
                                       read_line=lambda t: lines.pop(0) if lines else '')

    def test_automatic_callback_completes(self):
        self.statuses = ['wait', 'ok']
        self.wait()
        self.assertFalse(any(p == '/oauth-callback' for p, _ in self.calls))

    def test_pasted_callback_is_submitted(self):
        self.statuses = ['wait', 'ok']
        self.wait(lines=['http://localhost:54545/callback?code=c&state=st'])
        self.assertIn(('/oauth-callback', {'provider': 'anthropic',
                                           'redirect_url': 'http://localhost:54545/callback?code=c&state=st'}),
                      self.calls)

    def test_paste_is_ignored_for_qr_login(self):
        self.statuses = ['wait', 'ok']
        self.wait(lines=['anything'], provider=None)
        self.assertFalse(any(p == '/oauth-callback' for p, _ in self.calls))

    def test_error_status_fails(self):
        self.statuses = ['error']
        with self.assertRaises(SystemExit):
            self.wait()


if __name__ == '__main__':
    unittest.main()
