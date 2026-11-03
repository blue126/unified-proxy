#!/usr/bin/env python3
"""Turn the monitor's per-provider results into Bark pushes.

Some providers down: a normal Bark push naming them.
Every provider down: a time-sensitive Bark push.
Everything healthy: nothing is sent.
"""

from __future__ import annotations

import json
import os
import sys
from urllib.request import Request, urlopen


def bark(title: str, body: str, level: str) -> None:
    device = os.environ.get("BARK_KEY", "")
    if not device:
        print("::warning title=Bark not configured::BARK_KEY is unset, so no push was sent.")
        return
    server = os.environ.get("BARK_SERVER", "https://api.day.app").rstrip("/")
    payload = {"device_key": device, "title": title, "body": body, "level": level, "group": "unified-proxy"}
    if os.environ.get("RUN_URL"):
        payload["url"] = os.environ["RUN_URL"]
    request = Request(server + "/push", data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json"})
    try:
        urlopen(request, timeout=20).read()
    except OSError as error:
        print(f"::warning title=Bark push failed::{type(error).__name__}")


def main() -> int:
    with open(sys.argv[1]) as handle:
        results = json.load(handle)
    providers = results["providers"]
    if os.environ.get("TIMER_OUTCOME", "success") not in ("success", "skipped"):
        timer = "WorkBuddy refresh timer check failed"
        old = providers["codebuddy"]
        providers["codebuddy"] = {"ok": False, "reason": timer if old["ok"] else f"{old['reason']}; {timer}"}
    failed = {name: result["reason"] for name, result in providers.items() if not result["ok"]}
    if not failed:
        print("All providers healthy.")
        return 0
    body = "; ".join(f"{name}: {reason}" for name, reason in failed.items())[:300]
    if len(failed) == len(providers):
        bark("All providers down", body, "timeSensitive")
    else:
        bark("Provider down: " + ", ".join(failed), body, "active")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
