#!/usr/bin/env python3
"""Turn the monitor's per-provider results into alerts.

Some providers down: open or update a GitHub issue (GitHub emails the repository owner).
Every provider down: the same issue plus a Bark push to the phone.
Everything healthy: close the open alert issue.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from urllib.request import Request, urlopen

LABEL = "provider-alert"
TITLE = "Provider monitor alert"
MARKER = "<!-- failed:"


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def bark(title: str, body: str) -> None:
    device = os.environ.get("BARK_KEY", "")
    if not device:
        print("::warning title=Bark not configured::BARK_KEY is unset, so no push was sent.")
        return
    server = os.environ.get("BARK_SERVER", "https://api.day.app").rstrip("/")
    payload = json.dumps({"device_key": device, "title": title, "body": body,
                          "level": "timeSensitive", "group": "unified-proxy"}).encode()
    request = Request(server + "/push", data=payload, headers={"Content-Type": "application/json"})
    try:
        urlopen(request, timeout=20).read()
    except OSError as error:
        print(f"::warning title=Bark push failed::{type(error).__name__}")


def open_alert() -> dict | None:
    found = json.loads(gh("issue", "list", "--label", LABEL, "--state", "open",
                          "--json", "number,body", "--limit", "1"))
    return found[0] if found else None


def render(failed: dict, healthy: list, run_url: str, everything_down: bool) -> str:
    lines = [("All providers are failing." if everything_down else "Some providers are failing."), ""]
    lines += [f"- **{name}**: {reason}" for name, reason in failed.items()]
    lines += ["", "Healthy: " + (", ".join(healthy) or "none"), "", f"Run: {run_url}",
              f"{MARKER}{','.join(sorted(failed))} -->"]
    return "\n".join(lines)


def main() -> int:
    with open(sys.argv[1]) as handle:
        results = json.load(handle)
    providers = results["providers"]
    if os.environ.get("TIMER_OUTCOME", "success") not in ("success", "skipped"):
        timer = "WorkBuddy refresh timer check failed"
        old = providers["codebuddy"]
        providers["codebuddy"] = {"ok": False, "reason": timer if old["ok"] else f"{old['reason']}; {timer}"}
    failed = {name: result["reason"] for name, result in providers.items() if not result["ok"]}
    healthy = [name for name, result in providers.items() if result["ok"]]
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    existing = open_alert()

    if not failed:
        if existing:
            gh("issue", "close", str(existing["number"]), "--comment", f"All providers recovered. Run: {run_url}")
        print("All providers healthy.")
        return 0

    everything_down = not healthy
    body = render(failed, healthy, run_url, everything_down)
    if everything_down:
        bark("All providers down", "; ".join(f"{n}: {r}" for n, r in failed.items())[:300])
    marker = f"{MARKER}{','.join(sorted(failed))} -->"
    if existing and marker in existing["body"]:
        print("Alert already open for the same providers.")
        return 0
    if existing:
        gh("issue", "edit", str(existing["number"]), "--body", body)
        gh("issue", "comment", str(existing["number"]), "--body", body)
    else:
        gh("label", "create", LABEL, "--color", "D93F0B", "--force")
        gh("issue", "create", "--title", TITLE, "--label", LABEL, "--body", body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
