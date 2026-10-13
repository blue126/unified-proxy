#!/usr/bin/env python3
"""Switch Caddy to the verified CLIProxyAPI gateway and retire LiteLLM."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CADDYFILE = Path("/etc/caddy/Caddyfile")
MARKER = ROOT / ".cli-proxy-active"
PRIVATE = ROOT / ".cli-proxy-api"
BACKUP = PRIVATE / "rollback" / "Caddyfile.before-cli-proxy"
LEGACY_COMPOSE = [
    "docker", "compose", "--env-file", str(ROOT / ".env.litellm"),
    "-f", str(ROOT / "compose.yaml"), "-p", "unified-proxy-litellm",
]


def run(args: list[str]) -> str:
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("Command failed: " + args[0])
    return result.stdout


def replace_file(path: Path, content: str) -> None:
    original = path.stat()
    descriptor, name = tempfile.mkstemp(prefix=".cpa-cutover-", dir=path.parent)
    replacement = Path(name)
    try:
        os.fchown(descriptor, original.st_uid, original.st_gid)
        os.fchmod(descriptor, original.st_mode & 0o777)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(content)
        os.replace(replacement, path)
    finally:
        replacement.unlink(missing_ok=True)


def caddy_candidate(original: str) -> str:
    pattern = r"(?m)^([ \t]*)reverse_proxy[ \t]+(?:127\.0\.0\.1|localhost):3456[ \t]*$"
    if len(re.findall(pattern, original)) != 1:
        raise RuntimeError("Expected exactly one existing Caddy upstream on port 3456.")
    def replacement(match: re.Match) -> str:
        indent = match.group(1)
        lines = [
            "# CLIProxyAPI public API; management remains reachable only through localhost/SSH.",
            "@cli_private path /v0/* /v8/* /management.html /anthropic/callback /antigravity/callback /auth/callback",
            "handle @cli_private {", '\trespond "Not found" 404', "}",
            "@cli_health path /health/readiness /health", "handle @cli_health {",
            "\trewrite * /", "\treverse_proxy 127.0.0.1:8317", "}",
            "handle {", "\treverse_proxy 127.0.0.1:8317", "}",
        ]
        return "\n".join(indent + line for line in lines)
    return re.sub(pattern, replacement, original)


def smoke(base: str, key: str, *, public: bool) -> None:
    command = [sys.executable, str(ROOT / "scripts" / "cli-proxy-public-smoke.py")]
    if public:
        command.append("--public")
    result = subprocess.run(command, cwd=ROOT, env={**os.environ, "BASE_URL": base, "PROXY_API_KEY": key})
    if result.returncode:
        raise RuntimeError("Gateway inference validation failed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--check", action="store_true", help="Validate without changing the public route.")
    parser.add_argument("--workflow-ready", action="store_true", help="Confirm the updated main deployment workflow has passed.")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run as root (sudo).")
    if MARKER.exists():
        raise SystemExit("CLIProxyAPI is already marked active.")
    if not args.base_url.startswith("https://"):
        raise SystemExit("The existing HTTPS base URL is required.")
    key = (PRIVATE / "upstream-key").read_text().strip()
    legacy_keys = [
        line.split("=", 1)[1].strip().strip("'\"")
        for line in (ROOT / ".env.litellm").read_text().splitlines()
        if line.startswith("PROXY_API_KEY=")
    ]
    if legacy_keys != [key]:
        raise SystemExit("The candidate and existing client key must match.")
    original = CADDYFILE.read_text()
    updated = caddy_candidate(original)
    descriptor, name = tempfile.mkstemp(prefix="caddy-cli-check-", suffix=".caddyfile")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(updated)
        run(["caddy", "validate", "--adapter", "caddyfile", "--config", name])
    finally:
        Path(name).unlink(missing_ok=True)
    smoke("http://127.0.0.1:8317", key, public=False)
    if args.check:
        print("Caddy replacement and candidate live calls passed; public routing was not changed.")
        return 0
    if not args.workflow_ready:
        raise SystemExit("Merge and validate the main deployment workflow before applying cutover.")
    BACKUP.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if BACKUP.exists():
        if BACKUP.is_symlink() or BACKUP.read_text() != original:
            raise SystemExit("Existing rollback copy differs; inspect it before retrying.")
    else:
        with BACKUP.open("x", encoding="utf-8") as output:
            output.write(original)
        BACKUP.chmod(0o600)
    containers = run([*LEGACY_COMPOSE, "ps", "-aq"]).split()
    switched = False
    try:
        replace_file(CADDYFILE, updated)
        switched = True
        run(["systemctl", "reload", "caddy"])
        smoke(args.base_url, key, public=True)
        MARKER.write_text("CLIProxyAPI active\n")
        MARKER.chmod(0o600)
        run([*LEGACY_COMPOSE, "stop"])
        if containers:
            run(["docker", "update", "--restart=no", *containers])
        smoke(args.base_url, key, public=True)
        print("CLIProxyAPI serves the original public endpoint and key; LiteLLM and Postgres are stopped.")
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError):
        print("Cutover failed; restoring the previous gateway.", file=sys.stderr)
        if switched:
            if containers:
                run(["docker", "update", "--restart=unless-stopped", *containers])
            run([*LEGACY_COMPOSE, "up", "-d", "--wait", "--wait-timeout", "180"])
            replace_file(CADDYFILE, original)
            run(["systemctl", "reload", "caddy"])
            MARKER.unlink(missing_ok=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
