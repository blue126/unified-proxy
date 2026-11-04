"""Verify headless Claude and Codex re-authentication against a fake management API."""

import contextlib
import importlib.util
import io
import unittest
from pathlib import Path
from unittest.mock import patch


def load():
    source = Path(__file__).resolve().parent.parent / 'scripts' / 'cli-proxy-oauth-login.py'
    spec = importlib.util.spec_from_file_location('cli_proxy_oauth_login', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ParseCallbackTests(unittest.TestCase):
    def setUp(self):
        self.module = load()

    def test_accepts_localhost_callback_url(self):
        url = 'http://localhost:54545/callback?code=abc_DEF-1&state=st-ate_2&extra=1'
        self.assertEqual(self.module.parse_callback(url), ('abc_DEF-1', 'st-ate_2'))

    def test_accepts_codex_callback_url(self):
        url = 'http://localhost:1455/auth/callback?code=ac_1.x-Y&scope=openid+email&state=0123abcd'
        self.assertEqual(self.module.parse_callback(url), ('ac_1.x-Y', '0123abcd'))

    def test_accepts_code_hash_state(self):
        self.assertEqual(self.module.parse_callback(' abc#def \n'), ('abc', 'def'))

    def test_rejects_other_hosts_and_garbage(self):
        for bad in ('https://evil.example/callback?code=a&state=b', 'http://localhost/cb?code=a',
                    '', 'not a code', 'a#b#c', 'http://localhost/cb?code=a%0Ab&state=c'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.module.parse_callback(bad)


class CompleteTests(unittest.TestCase):
    def setUp(self):
        self.module = load()
        self.calls = []
        self.statuses = ['wait', 'ok']

    def call(self, key, path, payload=None):
        self.calls.append((path, payload))
        if path.startswith('/get-auth-status'):
            return {'status': self.statuses.pop(0)}
        return {'status': 'ok'}

    def run_complete(self, text='code1#state1', provider='claude'):
        out = io.StringIO()
        with patch.object(self.module, 'call', side_effect=self.call), \
                patch.object(self.module.time, 'sleep'), contextlib.redirect_stdout(out):
            self.module.complete('k', provider, text)
        return out.getvalue()

    def test_submits_callback_then_waits_for_saved_login(self):
        out = self.run_complete()
        self.assertEqual(self.calls[0], ('/oauth-callback', {
            'provider': 'anthropic',
            'redirect_url': 'http://localhost:54545/callback?code=code1&state=state1'}))
        self.assertIn('state=state1', self.calls[1][0])
        self.assertEqual(out.strip(), 'Claude login saved.')
        self.assertNotIn('code1', out)

    def test_codex_uses_its_provider_and_callback(self):
        out = self.run_complete(provider='codex')
        self.assertEqual(self.calls[0], ('/oauth-callback', {
            'provider': 'codex',
            'redirect_url': 'http://localhost:1455/auth/callback?code=code1&state=state1'}))
        self.assertEqual(out.strip(), 'Codex login saved.')

    def test_error_status_is_a_failure_without_leaking_values(self):
        self.statuses = ['error']
        with self.assertRaises(RuntimeError) as raised:
            self.run_complete()
        self.assertNotIn('code1', str(raised.exception))

    def test_timeout_is_a_failure(self):
        self.statuses = ['wait'] * 100
        with patch.object(self.module.time, 'monotonic', side_effect=[0, 1, 100]):
            with patch.object(self.module, 'call', side_effect=self.call), \
                    patch.object(self.module.time, 'sleep'):
                with self.assertRaises(RuntimeError):
                    self.module.complete('k', 'claude', 'a#b')


class StartTests(unittest.TestCase):
    def test_each_provider_requests_its_own_login_url(self):
        module = load()
        for provider, endpoint, label in (('claude', '/anthropic-auth-url?is_webui=true', 'Claude'),
                                          ('codex', '/codex-auth-url?is_webui=true', 'Codex')):
            out = io.StringIO()
            reply = {'url': 'https://login.example/authorize', 'state': 's'}
            with self.subTest(provider=provider), patch.object(module, 'call', return_value=reply) as call, \
                    contextlib.redirect_stdout(out):
                module.start('k', provider)
                call.assert_called_once_with('k', endpoint)
                self.assertIn(label, out.getvalue())
                self.assertIn(reply['url'], out.getvalue())


class StatusTests(unittest.TestCase):
    def test_lists_only_whitelisted_claude_and_codex_fields(self):
        module = load()
        reply = {'files': [
            {'name': 'claude-a.json', 'provider': 'claude', 'status': 'active', 'access_token': 'SECRET'},
            {'name': 'codex.json', 'provider': 'codex', 'status': 'active'},
            {'name': 'gemini.json', 'provider': 'gemini', 'status': 'active'},
        ]}
        out = io.StringIO()
        with patch.object(module, 'call', return_value=reply), contextlib.redirect_stdout(out):
            module.status('k')
        self.assertIn('claude-a.json', out.getvalue())
        self.assertNotIn('SECRET', out.getvalue())
        self.assertIn('codex.json', out.getvalue())
        self.assertNotIn('gemini', out.getvalue())


if __name__ == '__main__':
    unittest.main()
