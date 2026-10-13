#!/usr/bin/env python3
"""One-time, operator-run cutover from the Node service to LiteLLM."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.litellm"
COMPOSE = [
    "docker", "compose", "--env-file", str(ENV_FILE),
    "-f", str(ROOT / "compose.yaml"), "-p", "unified-proxy-litellm",
]
LEGACY_SERVICE = "unified-proxy"
MARKER = ROOT / ".litellm-active"


def settings() -> dict[str, str]:
    result: dict[str, str] = {}
    for line in ENV_FILE.read_text().splitlines():
        name, separator, value = line.partition("=")
        if separator and not name.lstrip().startswith("#"):
            result[name.strip()] = value.strip().strip("'\"")
    return result


def set_host_port(port: int) -> None:
    lines = ENV_FILE.read_text().splitlines()
    changed = False
    for index, line in enumerate(lines):
        if line.startswith("LITELLM_HOST_PORT="):
            lines[index] = f"LITELLM_HOST_PORT={port}"
            changed = True
            break
    if not changed:
        raise RuntimeError("LITELLM_HOST_PORT is missing from .env.litellm")
    descriptor, name = tempfile.mkstemp(prefix=".env.litellm-", dir=ROOT)
    replacement = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write("\n".join(lines) + "\n")
        os.replace(replacement, ENV_FILE)
    finally:
        replacement.unlink(missing_ok=True)


def run(*args: str) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def compose_up() -> None:
    run(*COMPOSE, "up", "-d", "--wait", "--wait-timeout", "180")


def readiness(port: int) -> None:
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            with urlopen(
                f"http://127.0.0.1:{port}/health/readiness", timeout=3
            ) as response:
                if response.status == 200:
                    return
        except (OSError, URLError):
            pass
        time.sleep(2)
    raise RuntimeError(f"LiteLLM did not become ready on localhost:{port}")


def smoke(port: int, client_key: str) -> None:
    env = {
        **os.environ,
        "BASE_URL": f"http://127.0.0.1:{port}",
        "PROXY_API_KEY": client_key,
    }
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "litellm-smoke.py")],
        cwd=ROOT,
        env=env,
        check=True,
    )


def main() -> int:
    if os.geteuid() != 0:
        print("Run this cutover as root (sudo).", file=sys.stderr)
        return 1
    if MARKER.exists():
        print("LiteLLM is already marked active.", file=sys.stderr)
        return 1
    if not ENV_FILE.is_file():
        print("Copy .env.litellm and ChatGPT auth.json to the host first.", file=sys.stderr)
        return 1
    config = settings()
    db_password = config.get("LITELLM_DB_PASSWORD", "")
    if (
        not db_password
        or config.get("LITELLM_DATABASE_URL")
        != f"postgresql://litellm:{db_password}@postgres:5432/litellm"
    ):
        print("Database URL and password are missing or inconsistent.", file=sys.stderr)
        return 1
    if config.get("LITELLM_DEPLOY_WORKFLOW_READY") != "1":
        print(
            "Update the main-branch deploy workflow before cutover, then set "
            "LITELLM_DEPLOY_WORKFLOW_READY=1.",
            file=sys.stderr,
        )
        return 1
    if config.get("LITELLM_HOST_PORT") != "4000":
        print("Stage LiteLLM on port 4000 before cutover.", file=sys.stderr)
        return 1
    token_dir = Path(config.get("CHATGPT_TOKEN_DIR", ""))
    if not token_dir.is_absolute():
        token_dir = ROOT / token_dir
    auth_file = token_dir / "auth.json"
    try:
        auth = json.loads(auth_file.read_text())
    except (OSError, ValueError):
        print("A readable LiteLLM ChatGPT auth.json is required.", file=sys.stderr)
        return 1
    if not auth.get("access_token") or not auth.get("refresh_token"):
        print("LiteLLM ChatGPT auth.json is incomplete.", file=sys.stderr)
        return 1
    client_key = config.get("PROXY_API_KEY", "")
    claude_code_key = config.get("CLAUDE_CODE_PROXY_KEY", "")
    if (
        not client_key.startswith("sk-")
        or not claude_code_key.startswith("sk-")
        or len({client_key, claude_code_key, config.get("LITELLM_MASTER_KEY")}) != 3
    ):
        print("Distinct sk- prefixed admin, GPT, and Claude Code keys are required.", file=sys.stderr)
        return 1
    run("systemctl", "is-active", "--quiet", LEGACY_SERVICE)

    stopped_legacy = False
    try:
        print("Starting the new gateway on localhost:4000.")
        compose_up()
        readiness(4000)
        run(sys.executable, str(ROOT / "scripts" / "litellm-bootstrap-key.py"))
        smoke(4000, client_key)

        print("Switching localhost:3456 to LiteLLM.")
        stopped_legacy = True
        run("systemctl", "stop", LEGACY_SERVICE)
        set_host_port(3456)
        compose_up()
        readiness(3456)
        smoke(3456, client_key)
        run("systemctl", "disable", LEGACY_SERVICE)
        MARKER.write_text("LiteLLM active\n")
        MARKER.chmod(0o600)
        print("LiteLLM is active on localhost:3456. Update client and CI keys.")
        return 0
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Cutover failed: {type(error).__name__}.", file=sys.stderr)
        if stopped_legacy:
            print("Restoring the Node service.", file=sys.stderr)
            try:
                set_host_port(4000)
                compose_up()
            except (OSError, RuntimeError, subprocess.CalledProcessError):
                subprocess.run([*COMPOSE, "stop", "litellm"], cwd=ROOT, check=False)
            subprocess.run(
                ["systemctl", "enable", LEGACY_SERVICE], cwd=ROOT, check=False
            )
            subprocess.run(
                ["systemctl", "start", LEGACY_SERVICE], cwd=ROOT, check=False
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
