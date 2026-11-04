"""Verify the iPhone shortcut targets the current maintenance workflow."""

import importlib.util
import re
import unittest
from pathlib import Path


def load():
    source = Path(__file__).resolve().parent.parent / 'scripts' / 'build-reauth-shortcut.py'
    spec = importlib.util.spec_from_file_location('reauth_shortcut', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ShortcutTests(unittest.TestCase):
    def setUp(self):
        self.module = load()
        self.workflow = self.module.Shortcut('owner/repo', 'actor', None).build()
        self.text = repr(self.workflow)

    def test_dispatch_uses_current_workflow_inputs(self):
        source = (Path(__file__).resolve().parent.parent / '.github/workflows/server-maintenance.yml').read_text()
        for name in ('claude-login-start', 'claude-login-complete', 'codex-login-start',
                     'codex-login-complete', 'callback'):
            self.assertIn(name, source)
            self.assertIn(name, self.text)
        self.assertNotIn('authorization_code', self.text)

    def test_callback_pattern_matches_what_the_workflow_accepts(self):
        pattern = re.compile(self.module.PROVIDERS['claude']['callback'])
        for good in ('http://localhost:54545/callback?code=abc_DEF-1&state=0123abcd', 'abc#def'):
            self.assertTrue(pattern.match(good), good)
        for bad in ('https://evil.example/callback?code=a', 'not a code', 'a b#c'):
            self.assertFalse(pattern.match(bad), bad)

    def test_codex_callback_pattern_needs_its_own_localhost_url(self):
        pattern = re.compile(self.module.PROVIDERS['codex']['callback'])
        self.assertTrue(pattern.match('http://localhost:1455/auth/callback?code=ac_1&scope=openid&state=ab'))
        for bad in ('http://localhost:54545/callback?code=a', 'abc#def', 'https://evil.example/auth/callback?code=a'):
            self.assertFalse(pattern.match(bad), bad)

    def test_rejected_dispatch_stops_before_waiting_for_a_run(self):
        actions = self.workflow['WFWorkflowActions']
        names = [a['WFWorkflowActionIdentifier'].rsplit('.', 1)[-1] for a in actions]
        url = next(i for i, a in enumerate(actions) if 'dispatches' in repr(a['WFWorkflowActionParameters'].get('WFURL')))
        key = actions[url + 1]['WFWorkflowActionParameters']
        self.assertEqual(key['WFDictionaryKey'], 'message')
        self.assertEqual(names[url + 2], 'conditional')
        self.assertLess(names.index('alert', url), names.index('count', url))
        self.assertIn('GitHub 拒绝了维护请求', self.text)

    def test_every_menu_item_has_a_branch(self):
        actions = [a['WFWorkflowActionParameters'] for a in self.workflow['WFWorkflowActions']
                   if a['WFWorkflowActionIdentifier'].endswith('choosefrommenu')]
        items = next(a['WFMenuItems'] for a in actions if 'WFMenuItems' in a)
        self.assertEqual(len(items), 5)
        self.assertEqual([a['WFMenuItemTitle'] for a in actions if 'WFMenuItemTitle' in a], items)


if __name__ == '__main__':
    unittest.main()
