#!/usr/bin/env python3
"""Create private, stable credentials for the optional CLIProxyAPI sidecar."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import stat
from pathlib import Path


def require_private(path: Path, *, directory: bool) -> None:
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"Unsafe private path: {path}")


def read_or_create(path: Path, value: str) -> str:
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        require_private(path, directory=False)
        existing = path.read_text().strip()
        if not existing:
            raise RuntimeError(f"Invalid private credential file: {path}")
        return existing
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(value + "\n")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parent.parent
    )
    root = parser.parse_args().root.resolve()
    private = root / ".cli-proxy-api"
    for directory in (private, private / "auths", private / "plugins"):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        require_private(directory, directory=True)

    upstream = read_or_create(private / "upstream-key", "sk-" + secrets.token_hex(32))
    admin = read_or_create(private / "management-key", secrets.token_urlsafe(48))
    config = private / "config.yaml"
    expected = f"""config-version: 8
server:
  host: "0.0.0.0"
  port: 8317
management:
  allow-remote: true
  secret-key: {json.dumps(admin)}
  disable-control-panel: true
access:
  api-keys:
    - {json.dumps(upstream)}
oauth:
  auth-dir: "/state"
plugins:
  enabled: true
  dir: "/plugins"
  configs:
    workbuddy:
      enabled: true
      priority: 100
"""
    try:
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        require_private(config, directory=False)
        if config.read_text() != expected:
            raise RuntimeError("Existing CLIProxyAPI config differs; inspect it manually.")
    else:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(expected)
    print("CLIProxyAPI private config and keys are ready.")


if __name__ == "__main__":
    main()
