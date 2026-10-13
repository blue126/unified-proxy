#!/usr/bin/env python3
"""Register separate rate-limited GPT and Claude Code LiteLLM keys."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def load_settings(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value.strip().strip("'\"")
    return values


def call(
    url: str, key: str, method: str = "GET", payload: dict | None = None
) -> tuple[int, dict]:
    headers = {"Authorization": f"Bearer {key}"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=15) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        error.read()
        return error.code, {}


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    settings_path = Path(os.environ.get("LITELLM_ENV_FILE", root / ".env.litellm"))
    if not settings_path.is_file():
        print(f"Missing settings file: {settings_path}", file=sys.stderr)
        return 1
    settings = load_settings(settings_path)
    admin_key = settings.get("LITELLM_MASTER_KEY", "")
    client_key = settings.get("PROXY_API_KEY", "")
    claude_code_key = settings.get("CLAUDE_CODE_PROXY_KEY", "")
    if (
        not admin_key.startswith("sk-")
        or not client_key.startswith("sk-")
        or not claude_code_key.startswith("sk-")
        or len({admin_key, client_key, claude_code_key}) != 3
    ):
        print(
            "Set distinct sk- prefixed admin, GPT, and Claude Code keys.",
            file=sys.stderr,
        )
        return 1
    try:
        rpm = int(settings.get("LITELLM_RPM_LIMIT", "120"))
        tpm = int(settings.get("LITELLM_TPM_LIMIT", "1000000"))
        port = int(settings.get("LITELLM_HOST_PORT", "4000"))
        if min(rpm, tpm, port) <= 0:
            raise ValueError
    except ValueError:
        print("RPM, TPM, and host port must be positive integers.", file=sys.stderr)
        return 1

    base = f"http://127.0.0.1:{port}"
    try:
        status, catalog = call(f"{base}/v1/models", admin_key)
        if status != 200:
            print(f"Admin model catalog failed (HTTP {status}).", file=sys.stderr)
            return 1
        if not any(
            isinstance(item, dict) and item.get("id") == "gpt-6-luna"
            for item in catalog.get("data", [])
        ):
            print("Configured GPT catalog is missing gpt-6-luna.", file=sys.stderr)
            return 1

        key_specs = (
            ("gpt-clients", client_key, ["chatgpt-subscription"]),
            ("claude-code", claude_code_key, ["anthropic/*"]),
        )
        for alias, key, models in key_specs:
            existing, _ = call(f"{base}/v1/models", key)
            if existing != 200:
                created, _ = call(
                    f"{base}/key/generate",
                    admin_key,
                    "POST",
                    {
                        "key": key,
                        "key_alias": alias,
                        "key_type": "llm_api",
                        "models": models,
                        "rpm_limit": rpm,
                        "tpm_limit": tpm,
                    },
                )
                if created not in (200, 201):
                    print(
                        f"{alias} key registration failed (HTTP {created}).",
                        file=sys.stderr,
                    )
                    return 1
            listed, visible = call(f"{base}/v1/models", key)
            ids = {
                item.get("id")
                for item in visible.get("data", [])
                if isinstance(item, dict)
            }
            if listed != 200 or (
                alias == "gpt-clients"
                and ("gpt-6-luna" not in ids or any("claude" in str(x) for x in ids))
            ) or (
                alias == "claude-code"
                and (not any("claude" in str(x) for x in ids)
                     or any(str(x).startswith("gpt-") for x in ids))
            ):
                print(f"{alias} model access is not scoped correctly.", file=sys.stderr)
                return 1
            admin_status, _ = call(f"{base}/key/list", key)
            if admin_status not in (401, 403):
                print(
                    f"{alias} key must not access management APIs (HTTP {admin_status}).",
                    file=sys.stderr,
                )
                return 1
    except (OSError, URLError, ValueError, TypeError) as error:
        print(f"Cannot reach local LiteLLM gateway: {type(error).__name__}", file=sys.stderr)
        return 1

    print("GPT and Claude Code keys are active with separate model access.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
