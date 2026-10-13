#!/usr/bin/env python3
"""Check the LiteLLM gateway and one ChatGPT subscription inference request."""

from __future__ import annotations

import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def parse_response(body: bytes, content_type: str) -> dict:
    text = body.decode("utf-8")
    if "text/event-stream" not in content_type:
        return json.loads(text)

    completed = None
    deltas: list[str] = []
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        event = json.loads(data)
        if event.get("type") == "response.completed":
            completed = event.get("response")
        elif event.get("type") == "response.output_text.delta":
            deltas.append(event.get("delta", ""))
        elif event.get("type") == "response.failed":
            raise ValueError("Upstream response failed")
    if isinstance(completed, dict):
        return completed
    if deltas:
        return {"output_text": "".join(deltas)}
    raise ValueError("No completed response in SSE stream")


def request(base: str, path: str, key: str = "", payload: dict | None = None):
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    req = Request(
        base.rstrip("/") + path,
        data=body,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    with urlopen(req, timeout=75) as response:
        return parse_response(response.read(), response.headers.get("Content-Type", ""))


def main() -> int:
    base = os.environ.get("BASE_URL", "http://127.0.0.1:4000")
    key = os.environ.get("PROXY_API_KEY", "")
    if not key:
        print("PROXY_API_KEY is required.", file=sys.stderr)
        return 1
    try:
        request(base, "/health/readiness")
        models = request(base, "/v1/models", key).get("data", [])
        ids = {model.get("id") for model in models}
        if "gpt-6-luna" not in ids:
            print("gpt-6-luna is missing from the model list.", file=sys.stderr)
            return 1
        reply = request(
            base,
            "/v1/responses",
            key,
            {
                "model": "gpt-6-luna",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "Reply with exactly: pong"}
                        ],
                    }
                ],
            },
        )
        chunks = [
            part.get("text", "")
            for item in reply.get("output", [])
            for part in item.get("content", [])
            if isinstance(part, dict) and part.get("type") == "output_text"
        ]
        if not ("".join(chunks).strip() or str(reply.get("output_text", "")).strip()):
            print("GPT-6 Luna returned no text.", file=sys.stderr)
            return 1
    except HTTPError as error:
        print(f"LiteLLM smoke request failed (HTTP {error.code}).", file=sys.stderr)
        return 1
    except (OSError, URLError, ValueError, TypeError) as error:
        print(f"LiteLLM smoke request failed ({type(error).__name__}).", file=sys.stderr)
        return 1
    print("LiteLLM readiness, model list, and GPT-6 Luna inference passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
