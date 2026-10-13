#!/usr/bin/env python3
"""Install the pinned Linux ARM64 WorkBuddy plugin into private sidecar state."""

from __future__ import annotations

import argparse
import hashlib
import os
import stat
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen


VERSION = "0.3.2"
URL = (
    "https://github.com/WslzGmzs/workbuddy-cli-proxy/releases/download/"
    f"v{VERSION}/workbuddy_{VERSION}_linux_arm64.zip"
)
ARCHIVE_SHA256 = "6e4da6f184c77e32159010c5706372762bb8e622c6ce7124d1a29c329d56fb29"
PLUGIN_SHA256 = "bf1c50a9f40bee0adda6309a87f02e3c101a0a322194bdddc9446e7a73928470"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parent.parent
    )
    root = parser.parse_args().root.resolve()
    directory = root / ".cli-proxy-api" / "plugins"
    info = directory.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise RuntimeError("Initialize the private CLIProxyAPI directory first.")
    target = directory / "workbuddy.so"
    if target.exists() or target.is_symlink():
        target_info = target.lstat()
        if not stat.S_ISREG(target_info.st_mode) or target_info.st_uid != os.getuid():
            raise RuntimeError("Existing WorkBuddy plugin path is unsafe.")
        if digest(target.read_bytes()) != PLUGIN_SHA256:
            raise RuntimeError("Existing WorkBuddy plugin differs from the pinned release.")
        print("Pinned WorkBuddy plugin is already installed.")
        return

    with urlopen(URL, timeout=30) as response:
        archive = response.read(16 * 1024 * 1024 + 1)
    if len(archive) > 16 * 1024 * 1024 or digest(archive) != ARCHIVE_SHA256:
        raise RuntimeError("WorkBuddy release archive failed SHA-256 verification.")
    with zipfile.ZipFile(BytesIO(archive)) as zipped:
        if zipped.namelist() != ["workbuddy.so"]:
            raise RuntimeError("Unexpected WorkBuddy release archive contents.")
        plugin = zipped.read("workbuddy.so")
    if digest(plugin) != PLUGIN_SHA256:
        raise RuntimeError("WorkBuddy plugin failed SHA-256 verification.")

    descriptor, name = tempfile.mkstemp(prefix=".workbuddy-", dir=directory)
    replacement = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(plugin)
        replacement.chmod(0o400)
        os.replace(replacement, target)
    finally:
        replacement.unlink(missing_ok=True)
    print("Pinned WorkBuddy plugin installed.")


if __name__ == "__main__":
    main()
