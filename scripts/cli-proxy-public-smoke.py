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


def describe(error: Exception) -> str:
    """One-line, secret-free reason for a failed provider check."""
    if isinstance(error, HTTPError):
        detail = ""
        try:
            body = json.loads(error.read().decode("utf-8", "replace"))
            detail = body.get("error", body)
            detail = detail.get("message", detail) if isinstance(detail, dict) else detail
        except (ValueError, OSError, AttributeError):
            pass
        detail = " ".join(str(detail).split())[:200]
        return f"HTTP {error.code}" + (f": {detail}" if detail else "")
    return f"{type(error).__name__}: {' '.join(str(error).split())[:200]}".rstrip(": ")


def chat_text(base: str, key: str, model: str) -> None:
    reply = request(base, "/v1/chat/completions", key, {
        "model": model, "messages": [{"role": "user", "content": "Reply with exactly: pong"}],
        "max_tokens": 128, "stream": False,
    })
    choices = reply.get("choices", [])
    content = (choices[0].get("message") or {}).get("content") if choices else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError(f"{model} returned no text")


def gpt_text(base: str, key: str) -> None:
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


# provider -> (required catalog models, live inference check)
PROVIDERS = {
    "gpt": (GPT_MODELS, lambda base, key: gpt_text(base, key)),
    "claude": ({"claude-sonnet-5"}, lambda base, key: chat_text(base, key, "claude-sonnet-5")),
    "gemini": ({"gemini-3-flash"}, lambda base, key: chat_text(base, key, "gemini-3-flash")),
    "codebuddy": (CODEBUDDY_MODELS, lambda base, key: chat_text(base, key, "glm-5.2")),
}


def check_gateway(base: str, key: str, public: bool) -> set:
    """Gateway-wide checks; any failure here means no provider can be trusted."""
    if request(base, "/").get("message") != "CLI Proxy API Server":
        raise ValueError("Unexpected gateway runtime")
    ids = {item.get("id") for item in request(base, "/v1/models", key).get("data", [])}
    try:
        request(base, "/v1/models")
    except HTTPError as error:
        if error.code != 401:
            raise
    else:
        raise ValueError("Unauthenticated model access was accepted")
    if public:
        for path in ("/v0/management/plugins", "/v8/management/plugins", "/management.html"):
            try:
                request(base, path, key)
            except HTTPError as error:
                if error.code != 404:
                    raise
            else:
                raise ValueError("Management route is publicly reachable")
    return ids


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public", action="store_true", help="Require private management routes to be blocked.")
    parser.add_argument("--monitor", action="store_true",
                        help="Check every provider independently; exit non-zero only when all of them fail.")
    parser.add_argument("--results", help="Write per-provider results as JSON to this path.")
    args = parser.parse_args()
    base = os.environ.get("BASE_URL", "http://127.0.0.1:8317")
    key = os.environ.get("PROXY_API_KEY", "")
    if not key:
        raise SystemExit("PROXY_API_KEY is required.")

    results = {name: {"ok": False, "reason": "not checked"} for name in PROVIDERS}
    gateway_error = ""
    try:
        ids = check_gateway(base, key, args.public)
    except (OSError, URLError, ValueError, TypeError, KeyError) as error:
        gateway_error = describe(error)
        ids = set()
    else:
        missing = {name: sorted(models - ids) for name, (models, _) in PROVIDERS.items() if models - ids}
        if missing and not args.monitor:
            gateway_error = "Expected subscription model is absent: " + ", ".join(sum(missing.values(), []))
        for name, (_, check) in PROVIDERS.items():
            if gateway_error:
                break
            if name in missing:
                results[name] = {"ok": False, "reason": "model absent: " + ", ".join(missing[name])}
                continue
            try:
                check(base, key)
                results[name] = {"ok": True, "reason": ""}
            except (OSError, URLError, ValueError, TypeError, KeyError) as error:
                results[name] = {"ok": False, "reason": describe(error)}
                if not args.monitor:
                    break

    if gateway_error:
        for name in results:
            results[name] = {"ok": False, "reason": "gateway: " + gateway_error}
    failed = [name for name, result in results.items() if not result["ok"]]
    if args.results:
        with open(args.results, "w") as handle:
            json.dump({"gateway_error": gateway_error, "providers": results}, handle)

    if args.monitor:
        for name in failed:
            level = "error" if len(failed) == len(results) else "warning"
            print(f"::{level} title=Provider {name} failed::{results[name]['reason']}")
        print("Providers OK: " + (", ".join(n for n in results if n not in failed) or "none"))
        return 1 if len(failed) == len(results) else 0

    if failed:
        raise SystemExit(f"CLIProxyAPI smoke failed ({results[failed[0]]['reason']}).")
    print("CLIProxyAPI client authentication, original GPT names, GPT Responses, Claude, Gemini, and CodeBuddy passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
