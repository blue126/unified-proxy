#!/usr/bin/env python3
"""Schedule WorkBuddy OAuth refresh through CLIProxyAPI's private management API."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import stat
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

REFRESH_LEAD_SECONDS = 600
TIMER = 'unified-proxy-workbuddy-refresh.timer'
SERVICE = 'unified-proxy-workbuddy-refresh.service'


def require_private(path: Path, *, directory: bool = False) -> None:
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('Unsafe WorkBuddy credential path or permissions.')


def read_json(path: Path) -> dict:
    require_private(path)
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise RuntimeError('Invalid credential document.')
    return data


def expiry(data: dict) -> float:
    auth = data.get('auth')
    if not isinstance(auth, dict) or not auth.get('accessToken') or not auth.get('refreshToken'):
        raise RuntimeError('WorkBuddy OAuth refresh credentials are missing; login is required.')
    raw = auth.get('expiresAt')
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw) or raw <= 0:
        raise RuntimeError('WorkBuddy OAuth expiry is missing or invalid.')
    return float(raw)


def eligible(data: dict) -> bool:
    if data.get('type') != 'workbuddy':
        return False
    disabled = data.get('disabled', False)
    if disabled is True or str(disabled).lower() in ('true', '1'):
        return False
    return str(data.get('auth_type', 'oauth')).lower() == 'oauth'


class RejectRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Management API redirect rejected.')


def refresh(path: Path, management_key: str) -> None:
    # CPA handles token exchange, synchronization and atomic persistence. Never
    # refresh upstream directly or rewrite a rotating token from a stale copy.
    request = Request(
        'http://127.0.0.1:8317/v0/management/auth-files/refresh',
        data=json.dumps({'name': path.name}).encode(),
        headers={'Authorization': 'Bearer ' + management_key, 'Content-Type': 'application/json'},
    )
    # Neither environment proxy settings nor redirects may receive this key.
    with build_opener(ProxyHandler({}), RejectRedirect()).open(request, timeout=90) as response:
        result = json.load(response)
    if result.get('ok') is not True:
        raise RuntimeError('CLIProxyAPI did not confirm WorkBuddy refresh.')


def check_timer() -> None:
    def systemctl(*args):
        result = subprocess.run(['systemctl', *args], text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError('WorkBuddy refresh timer is not enabled and active.')
        return result.stdout.strip()

    systemctl('is-enabled', '--quiet', TIMER)
    systemctl('is-active', '--quiet', TIMER)
    if systemctl('show', SERVICE, '--property=Result', '--value') != 'success':
        raise RuntimeError('The latest WorkBuddy refresh job failed.')
    # systemctl formats monotonic durations for humans on Ubuntu. D-Bus returns
    # the actual uint64 microseconds, independent of locale or pretty formatting.
    result = subprocess.run([
        'busctl', 'get-property', 'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1/unit/unified_2dproxy_2dworkbuddy_2drefresh_2etimer',
        'org.freedesktop.systemd1.Timer', 'LastTriggerUSecMonotonic',
    ], text=True, capture_output=True)
    parts = result.stdout.split()
    if result.returncode or len(parts) != 2 or parts[0] != 't':
        raise RuntimeError('Cannot read WorkBuddy timer trigger time.')
    triggered = int(parts[1])
    uptime = float(Path('/proc/uptime').read_text().split()[0])
    if triggered <= 0 or uptime - triggered / 1_000_000 > 660:
        raise RuntimeError('The WorkBuddy refresh timer has not run recently.')


def execute(root: Path, *, force: bool = False, check: bool = False) -> tuple[int, int]:
    private = root / '.cli-proxy-api'
    auth_dir = private / 'auths'
    require_private(private, directory=True)
    require_private(auth_dir, directory=True)
    count, refreshed = 0, 0
    # Serialize timer/manual invocations, including checks while a token rotates.
    lock_path = private / 'workbuddy-refresh.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        require_private(lock_path)
        fcntl.flock(lock, fcntl.LOCK_EX)
        management_key = None
        for path in sorted(auth_dir.glob('*.json')):
            data = read_json(path)
            if not eligible(data):
                continue
            count += 1
            before = expiry(data)
            now = time.time()
            if check:
                if before <= now:
                    raise RuntimeError('WorkBuddy OAuth token expired; check the refresh job or log in again.')
                continue
            if not force and before - now > REFRESH_LEAD_SECONDS:
                continue
            if management_key is None:
                key_path = private / 'management-key'
                require_private(key_path)
                management_key = key_path.read_text().strip()
                if not management_key:
                    raise RuntimeError('The management key is missing.')
            refresh(path, management_key)
            # Success is insufficient if new credentials were not persisted.
            after = expiry(read_json(path))
            if after <= time.time() + REFRESH_LEAD_SECONDS or after <= before:
                raise RuntimeError('WorkBuddy refresh did not persist an extended expiry.')
            refreshed += 1
        if not count:
            raise RuntimeError('No enabled WorkBuddy OAuth account is configured.')
    return count, refreshed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--force', action='store_true', help='Verify one real refresh before expiry.')
    mode.add_argument('--check', action='store_true', help='Check expiry without refreshing any token.')
    parser.add_argument('--check-timer', action='store_true', help='Also verify timer and latest job health.')
    args = parser.parse_args()
    try:
        if args.check_timer:
            check_timer()
        count, refreshed = execute(args.root, force=args.force, check=args.check)
    except HTTPError as error:
        raise SystemExit('WorkBuddy refresh failed (management HTTP ' + str(error.code) + ').') from None
    except RuntimeError as error:
        raise SystemExit('WorkBuddy refresh check failed: ' + str(error)) from None
    except (OSError, URLError, ValueError, TypeError, KeyError):
        # Upstream responses and credential paths can contain tokens/account IDs.
        raise SystemExit('WorkBuddy refresh check failed; inspect job health and account authorization.') from None
    print(f'WorkBuddy OAuth accounts checked: {count}; refreshed and persisted: {refreshed}.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
