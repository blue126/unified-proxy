#!/usr/bin/env python3
"""Archive and remove the stopped Node/LiteLLM runtimes on the production host."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/opt/unified-proxy')
UNIT = Path('/etc/systemd/system/unified-proxy.service')
VOLUME = 'unified-proxy-litellm_postgres_data'
VOLUME_DATA = Path('/var/lib/docker/volumes') / VOLUME / '_data'
CONTAINERS = ('unified-proxy-litellm-litellm-1', 'unified-proxy-litellm-postgres-1')
LEGACY = (
    '.env', '.env.litellm', '.litellm', '.litellm-active', '.maintenance',
    'auth.json', 'auth.json.bak-20260731-073617', 'server.js',
    'server.js.backup-20260904133731', 'server.js.backup-20260904133850',
    'package.json', 'compose.yaml', 'litellm',
    'scripts/litellm-bootstrap-key.py', 'scripts/litellm-cutover.py',
    'scripts/litellm-init-env.py', 'scripts/litellm-smoke.py',
    'scripts/cli-proxy-adopt-key.py', 'scripts/cli-proxy-cutover.py',
    '.cli-proxy-api/rollback',
)


def run(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        # Commands can include private paths; never print captured service logs.
        raise RuntimeError('Operation failed: ' + args[0])
    return result.stdout


def validate_container(data: dict) -> None:
    if data['State']['Running'] or data['HostConfig']['RestartPolicy']['Name'] != 'no':
        raise RuntimeError('A legacy container is running or has automatic restart enabled.')
    if data['Config']['Labels'].get('com.docker.compose.project') != 'unified-proxy-litellm':
        raise RuntimeError('Unexpected legacy container ownership.')


def smoke() -> None:
    env = os.environ.copy()
    if not env.get('BASE_URL', '').startswith('https://'):
        raise RuntimeError('BASE_URL must be the existing HTTPS endpoint.')
    env['PROXY_API_KEY'] = (ROOT / '.cli-proxy-api/upstream-key').read_text().strip()
    result = subprocess.run(
        [sys.executable, str(Path(__file__).with_name('cli-proxy-public-smoke.py')), '--public'],
        env=env, capture_output=True, text=True,
    )
    if result.returncode:
        raise RuntimeError('Four-provider public verification failed; no recovery data is removed.')
    print(result.stdout.strip(), flush=True)


def preflight() -> list[Path]:
    if os.geteuid() != 0:
        raise RuntimeError('Run this one-time cleanup as root.')
    if ROOT.is_symlink() or not (ROOT / '.cli-proxy-active').is_file():
        raise RuntimeError('CLIProxyAPI is not activated in the expected installation.')
    state = run('systemctl', 'show', 'unified-proxy', '--property=ActiveState', '--value').strip()
    if state != 'inactive':
        raise RuntimeError('The old Node service must already be inactive.')
    if UNIT.is_symlink() or not UNIT.is_file():
        raise RuntimeError('Expected the original Node unit, not a replaced or missing unit.')
    text = UNIT.read_text()
    if 'WorkingDirectory=/opt/unified-proxy' not in text or '/opt/unified-proxy/server.js' not in text:
        raise RuntimeError('Unexpected Node unit configuration.')
    dropins = Path(str(UNIT) + '.d')
    if dropins.exists() and list(dropins.iterdir()):
        raise RuntimeError('Inspect Node service drop-ins before retirement.')
    for name in CONTAINERS:
        validate_container(json.loads(run('docker', 'inspect', name))[0])
    volume = json.loads(run('docker', 'volume', 'inspect', VOLUME))[0]
    if (volume['Labels'].get('com.docker.compose.project') != 'unified-proxy-litellm'
            or volume['Mountpoint'] != str(VOLUME_DATA)):
        raise RuntimeError('Unexpected legacy database volume.')
    users = set(run('docker', 'ps', '-aq', '--filter', 'volume=' + VOLUME).split())
    expected = {json.loads(run('docker', 'inspect', name))[0]['Id'][:12] for name in CONTAINERS}
    if not users or not users <= expected:
        raise RuntimeError('The legacy database volume is used by an unexpected container.')
    paths = [ROOT / name for name in LEGACY if (ROOT / name).exists()]
    if any(path.is_symlink() for path in paths) or VOLUME_DATA.is_symlink():
        raise RuntimeError('Refusing unexpected symlink in legacy state.')
    smoke()
    return paths + [UNIT, VOLUME_DATA]


def verified_archive(paths: list[Path]) -> Path:
    parent = ROOT / '.retired-proxy'
    parent.mkdir(mode=0o700, exist_ok=True)
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError('Unsafe recovery archive directory.')
    folder = parent / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder.mkdir(mode=0o700)
    archive = folder / 'legacy.tar.gz'
    run('tar', '-czf', str(archive), '-C', '/', *[str(p.relative_to('/')) for p in paths])
    archive.chmod(0o600)
    # Verify every byte and permission, not just a tar listing, before deletion.
    with tarfile.open(archive) as saved:
        members = {item.name: item for item in saved.getmembers()}
        for path in paths:
            for actual in ([path] if path.is_file() else [path, *path.rglob('*')]):
                name = str(actual.relative_to('/'))
                item = members[name]
                info = actual.lstat()
                if (item.mode, item.uid, item.gid) != (stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid):
                    raise RuntimeError('Archive metadata verification failed.')
                if actual.is_symlink():
                    if not item.issym() or item.linkname != os.readlink(actual):
                        raise RuntimeError('Archive symlink verification failed.')
                elif actual.is_file():
                    if not item.isfile() or saved.extractfile(item).read() != actual.read_bytes():
                        raise RuntimeError('Archive content verification failed.')
                elif not actual.is_dir():
                    raise RuntimeError('Unexpected special file in recovery data.')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    manifest = folder / 'SHA256SUMS'
    manifest.write_text(digest + '  legacy.tar.gz\n')
    manifest.chmod(0o600)
    print('Verified private recovery archive: ' + str(archive), flush=True)
    return archive


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Archive, verify, then remove legacy resources.')
    args = parser.parse_args()
    paths = preflight()
    if not args.apply:
        print('Preflight passed; legacy resources are stopped; nothing removed.')
        return 0
    verified_archive(paths)
    run('systemctl', 'disable', 'unified-proxy')
    UNIT.unlink()
    run('systemctl', 'daemon-reload')
    run('systemctl', 'mask', 'unified-proxy')
    run('docker', 'rm', *CONTAINERS)
    run('docker', 'volume', 'rm', VOLUME)
    # Only remove the old project's empty network; never prune Docker globally.
    network = 'unified-proxy-litellm_default'
    networks = run('docker', 'network', 'ls', '--format', '{{.Name}}').splitlines()
    if network in networks:
        data = json.loads(run('docker', 'network', 'inspect', network))[0]
        if not data.get('Containers') and data.get('Labels', {}).get('com.docker.compose.project') == 'unified-proxy-litellm':
            run('docker', 'network', 'rm', network)
    for path in paths:
        if path == UNIT or path == VOLUME_DATA:
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    smoke()
    print('Legacy Node unit masked; old containers, database volume, and installation files retired.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, KeyError, ValueError, tarfile.TarError) as error:
        raise SystemExit('Legacy cleanup failed: ' + str(error)) from None
