#!/usr/bin/env python3
"""Verify client authentication and all four authorized subscription providers."""

from __future__ import annotations

import argparse
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

GPT_MODELS = {
    "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
}
CODEBUDDY_MODELS = {
    "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.1", "glm-5.2", "glm-5v-turbo",
    "hy3", "hy3-preview", "hy3-preview-agent", "kimi-k2.7", "minimax-m3-pay",
}


def request(base: str, path: str, key: str = "", payload: dict | None = None) -> dict:
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    with urlopen(Request(base.rstrip("/") + path, headers=headers, data=body), timeout=90) as response:
        return json.load(response)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public", action="store_true", help="Require private management routes to be blocked.")
    args = parser.parse_args()
    base = os.environ.get("BASE_URL", "http://127.0.0.1:8317")
    key = os.environ.get("PROXY_API_KEY", "")
    if not key:
        raise SystemExit("PROXY_API_KEY is required.")
    try:
        if request(base, "/").get("message") != "CLI Proxy API Server":
            raise ValueError("Unexpected gateway runtime")
        ids = {item.get("id") for item in request(base, "/v1/models", key).get("data", [])}
        if not (GPT_MODELS | CODEBUDDY_MODELS | {"claude-sonnet-5", "gemini-3-flash"}).issubset(ids):
            raise ValueError("Expected subscription model is absent")
        try:
            request(base, "/v1/models")
        except HTTPError as error:
            if error.code != 401:
                raise
        else:
            raise ValueError("Unauthenticated model access was accepted")
        if args.public:
            for path in ("/v0/management/plugins", "/v8/management/plugins", "/management.html"):
                try:
                    request(base, path, key)
                except HTTPError as error:
                    if error.code != 404:
                        raise
                else:
                    raise ValueError("Management route is publicly reachable")
        reply = request(base, "/v1/responses", key, {
            "model": "gpt-6-luna", "input": "Reply with exactly: pong",
            "reasoning": {"effort": "none"}, "stream": False,
        })
        text = "".join(
            part.get("text", "") for item in reply.get("output", [])
            for part in item.get("content", []) if part.get("type") == "output_text"
        )
        if reply.get("status") != "completed" or not text.strip():
            raise ValueError("GPT Responses returned no completed text")
        for model in ("claude-sonnet-5", "gemini-3-flash", "glm-5.2"):
            reply = request(base, "/v1/chat/completions", key, {
                "model": model, "messages": [{"role": "user", "content": "Reply with exactly: pong"}],
                "max_tokens": 128, "stream": False,
            })
            choices = reply.get("choices", [])
            content = (choices[0].get("message") or {}).get("content") if choices else None
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Subscription model returned no text")
    except HTTPError as error:
        raise SystemExit(f"CLIProxyAPI smoke failed (HTTP {error.code}).") from None
    except (OSError, URLError, ValueError, TypeError, KeyError) as error:
        raise SystemExit(f"CLIProxyAPI smoke failed ({type(error).__name__}).") from None
    print("CLIProxyAPI client authentication, original GPT names, GPT Responses, Claude, Gemini, and CodeBuddy passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
