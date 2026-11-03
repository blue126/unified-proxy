"""Verify the iPhone shortcut targets the current maintenance workflow."""

import importlib.util
import re
import unittest
from pathlib import Path


def load():
    source = Path(__file__).resolve().parent.parent / 'scripts' / 'build-claude-shortcut.py'
    spec = importlib.util.spec_from_file_location('claude_shortcut', source)
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
        for name in ('claude-login-start', 'claude-login-complete', 'callback'):
            self.assertIn(name, source)
            self.assertIn(name, self.text)
        self.assertNotIn('authorization_code', self.text)

    def test_callback_pattern_matches_what_the_workflow_accepts(self):
        pattern = re.compile(self.module.CALLBACK_PATTERN)
        for good in ('http://localhost:54545/callback?code=abc_DEF-1&state=0123abcd', 'abc#def'):
            self.assertTrue(pattern.match(good), good)
        for bad in ('https://evil.example/callback?code=a', 'not a code', 'a b#c'):
            self.assertFalse(pattern.match(bad), bad)


if __name__ == '__main__':
    unittest.main()
