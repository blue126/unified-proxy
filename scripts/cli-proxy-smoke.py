#!/usr/bin/env python3
"""Check the CLIProxyAPI gateway and optional real model calls."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def request(base: str, path: str, key: str, payload: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {key}"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    with urlopen(
        Request(
            base.rstrip("/") + path,
            headers=headers,
            data=body,
            method="POST" if body is not None else "GET",
        ),
        timeout=90 if body is not None else 10,
    ) as response:
        return json.load(response)


def await_plugins(base: str, key: str) -> dict:
    for attempt in range(30):
        try:
            return request(base, "/v0/management/plugins", key)
        except (OSError, URLError):
            if attempt == 29:
                raise
            time.sleep(1)
    raise AssertionError("unreachable")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--base-url", default="http://127.0.0.1:8317")
    parser.add_argument("--expect-model", action="append", default=[])
    parser.add_argument("--infer-model", action="append", default=[])
    args = parser.parse_args()
    private = args.root.resolve() / ".cli-proxy-api"
    client_key = (private / "upstream-key").read_text().strip()
    management_key = (private / "management-key").read_text().strip()

    try:
        plugin_list = await_plugins(args.base_url, management_key)
        workbuddy = next(
            (item for item in plugin_list.get("plugins", []) if item.get("id") == "workbuddy"),
            None,
        )
        if not workbuddy or not workbuddy.get("enabled") or not workbuddy.get("registered"):
            raise RuntimeError("WorkBuddy plugin is not loaded and registered.")
        catalog = request(args.base_url, "/v1/models", client_key)
        models = {
            item.get("id")
            for item in catalog.get("data", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        missing = set(args.expect_model) - models
        if missing:
            raise RuntimeError("Expected model is absent: " + ", ".join(sorted(missing)))
        for model in args.infer_model:
            result = request(
                args.base_url,
                "/v1/chat/completions",
                client_key,
                {
                    "model": model,
                    "messages": [{"role": "user", "content": "Reply with exactly: pong"}],
                    "max_tokens": 64,
                    "stream": False,
                },
            )
            choices = result.get("choices", [])
            content = (choices[0].get("message") or {}).get("content") if choices else None
            if not content:
                raise RuntimeError("Model returned no text: " + model)
            print("Inference passed: " + model)
    except HTTPError as error:
        raise SystemExit(f"CLIProxyAPI request failed (HTTP {error.code}).") from None
    except (OSError, URLError):
        raise SystemExit("CLIProxyAPI did not become reachable in 30 seconds.") from None

    print(f"CLIProxyAPI and WorkBuddy plugin are ready; {len(models)} models listed.")


if __name__ == "__main__":
    main()
