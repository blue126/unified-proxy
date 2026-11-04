#!/usr/bin/env python3
"""Re-authenticate a Claude or Codex account through CLIProxyAPI's private management API.

Runs on the server over SSH from server-maintenance.yml; no browser, port forward
or interactive stdin. `start` prints a login URL. After approving it, copy the
final callback URL (or the `code#state` text) and pass it to `complete` through
the OAUTH_CALLBACK environment variable. Nothing secret is ever printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

API = 'http://127.0.0.1:8317/v0/management'
TOKEN = r'[A-Za-z0-9_.~+/=-]+'

# provider -> (label, auth-url endpoint, callback provider, callback URL, stored credential types)
PROVIDERS = {
    'claude': ('Claude', 'anthropic-auth-url?is_webui=true', 'anthropic',
               'http://localhost:54545/callback', ('claude', 'anthropic')),
    'codex': ('Codex', 'codex-auth-url?is_webui=true', 'codex',
              'http://localhost:1455/auth/callback', ('codex',)),
}


class RejectRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Management API redirect rejected.')


def management_key(root: Path) -> str:
    path = root / '.cli-proxy-api' / 'management-key'
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('Unsafe management key path or permissions.')
    key = path.read_text().strip()
    if not key:
        raise RuntimeError('The management key is missing.')
    return key


def call(key: str, path: str, payload: dict | None = None) -> dict:
    headers = {'Authorization': 'Bearer ' + key}
    body = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        body = json.dumps(payload).encode()
    # Neither environment proxy settings nor redirects may receive this key.
    with build_opener(ProxyHandler({}), RejectRedirect()).open(
            Request(API + path, headers=headers, data=body), timeout=30) as response:
        return json.load(response)


def parse_callback(text: str) -> tuple[str, str]:
    """Accept a localhost callback URL or the `code#state` form; return (code, state)."""
    text = text.strip()
    pair = re.fullmatch(f'({TOKEN})#({TOKEN})', text)
    if pair:
        return pair.group(1), pair.group(2)
    url = urlsplit(text)
    query = parse_qs(url.query)
    code, state = (query.get(name, [''])[0] for name in ('code', 'state'))
    if url.hostname not in ('localhost', '127.0.0.1') or not re.fullmatch(TOKEN, code) \
            or not re.fullmatch(TOKEN, state):
        raise ValueError('Expected the localhost callback URL or code#state from the browser.')
    return code, state


def start(key: str, provider: str) -> None:
    label, endpoint = PROVIDERS[provider][:2]
    reply = call(key, '/' + endpoint)
    if not reply.get('url') or not reply.get('state'):
        raise RuntimeError('CLIProxyAPI returned no login URL.')
    print(f'Open this URL, sign in with the {label} subscription account, and approve:')
    print(reply['url'])
    print('The browser then fails to load a localhost page. That is expected: copy the')
    print('full address-bar URL (or the code#state text shown) into the complete step.')
    print('The login expires after a few minutes.')


def complete(key: str, provider: str, callback: str, wait: float = 60) -> None:
    label, _, callback_provider, callback_url, _ = PROVIDERS[provider]
    code, state = parse_callback(callback)
    call(key, '/oauth-callback', {
        'provider': callback_provider,
        'redirect_url': callback_url + '?' + urlencode({'code': code, 'state': state}),
    })
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        status = call(key, '/get-auth-status?' + urlencode({'state': state})).get('status')
        if status == 'ok':
            print(f'{label} login saved.')
            return
        if status == 'error':
            raise RuntimeError(f'CLIProxyAPI rejected the {label} login; start a new one.')
        time.sleep(2)
    raise RuntimeError(f'Timed out waiting for the {label} login to be saved.')


def status(key: str) -> None:
    reply = call(key, '/auth-files')
    files = reply.get('files', reply) if isinstance(reply, dict) else reply
    kinds = {kind for provider in PROVIDERS.values() for kind in provider[4]}
    shown = 0
    for item in files if isinstance(files, list) else []:
        kind = str(item.get('provider') or item.get('type') or '')
        if kind.lower() not in kinds:
            continue
        fields = {name: item.get(name) for name in ('provider', 'name', 'status', 'disabled', 'expired', 'expires_at')
                  if item.get(name) not in (None, '')}
        print(json.dumps(fields, sort_keys=True))
        shown += 1
    if not shown:
        print('No Claude or Codex credential is stored.')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('start', 'complete', 'status'))
    parser.add_argument('--provider', choices=PROVIDERS, default='claude')
    parser.add_argument('--root', type=Path, default=Path('/opt/unified-proxy'))
    args = parser.parse_args()
    try:
        key = management_key(args.root)
        if args.command == 'start':
            start(key, args.provider)
        elif args.command == 'status':
            status(key)
        else:
            complete(key, args.provider, os.environ.get('OAUTH_CALLBACK', ''))
    except HTTPError as error:
        print(f'Management API returned HTTP {error.code}.', file=sys.stderr)
        return 1
    except (OSError, URLError, ValueError, RuntimeError) as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
