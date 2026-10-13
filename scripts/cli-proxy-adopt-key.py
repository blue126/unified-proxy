#!/usr/bin/env python3
"""Make the private CLIProxyAPI gateway accept the current LiteLLM client key."""

from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
from pathlib import Path


def require_private_file(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"Unsafe private file: {path}")


def atomic_write(path: Path, content: str) -> None:
    descriptor, name = tempfile.mkstemp(prefix=".cli-key-", dir=path.parent)
    replacement = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(content)
        os.replace(replacement, path)
    finally:
        replacement.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    root = parser.parse_args().root.resolve()
    private = root / ".cli-proxy-api"
    env_file = root / ".env.litellm"
    client_file = private / "upstream-key"
    config_file = private / "config.yaml"
    for path in (env_file, client_file, config_file):
        require_private_file(path)

    matches = [
        line.split("=", 1)[1].strip().strip("'\"")
        for line in env_file.read_text().splitlines()
        if line.startswith("PROXY_API_KEY=")
    ]
    if len(matches) != 1 or not matches[0].startswith("sk-") or len(matches[0]) < 50:
        raise RuntimeError("Expected one sk- prefixed PROXY_API_KEY in .env.litellm.")
    existing = client_file.read_text().strip()
    desired = matches[0]
    config = config_file.read_text()
    old_stanza = f"access:\n  api-keys:\n    - {json.dumps(existing)}\n"
    if config.count(old_stanza) != 1:
        raise RuntimeError("Sidecar access key stanza differs from the generated config.")
    if existing == desired:
        print("CLIProxyAPI already accepts the current client key.")
        return
    new_stanza = f"access:\n  api-keys:\n    - {json.dumps(desired)}\n"
    updated_config = config.replace(old_stanza, new_stanza, 1)
    try:
        atomic_write(config_file, updated_config)
        atomic_write(client_file, desired + "\n")
    except OSError:
        atomic_write(config_file, config)
        raise
    print("CLIProxyAPI now accepts the existing PROXY_API_KEY.")


if __name__ == "__main__":
    main()
