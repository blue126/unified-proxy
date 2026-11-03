#!/usr/bin/env python3
"""Re-authenticate a subscription account from this Mac.

    ./scripts/reauth.py claude        # or codex, antigravity, workbuddy
    ./scripts/reauth.py status        # stored credential status per provider

Reads the ignored .env.secrets, opens an SSH tunnel to the server's private
management API and the provider's OAuth callback port, opens the login page in
the system browser, waits until CLIProxyAPI saves the credential, then runs a
live inference check for that provider through the public endpoint.

The management key is read over SSH into memory only; it is never written to
this machine or printed. If the browser cannot reach the callback (for example
you approved on another device), paste the final address-bar URL when asked.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import select
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent.parent
REMOTE_KEY = "/opt/unified-proxy/.cli-proxy-api/management-key"
API_PORT = 8317
API = f"http://127.0.0.1:{API_PORT}/v0/management"
LOGIN_TIMEOUT = 600

# provider -> (auth-url endpoint, callback port or None, callback provider, smoke provider)
PROVIDERS = {
    "codex": ("codex-auth-url?is_webui=true", 1455, "codex", "gpt"),
    "claude": ("anthropic-auth-url?is_webui=true", 54545, "anthropic", "claude"),
    "antigravity": ("antigravity-auth-url?is_webui=true", 51121, "antigravity", "gemini"),
    "workbuddy": ("workbuddy-auth-url", None, None, "codebuddy"),
}


def read_secrets(path: Path) -> dict:
    values = {}
    for line in path.read_text().splitlines():
        name, sep, value = line.partition("=")
        if sep and not name.lstrip().startswith("#"):
            values[name.strip()] = value.split("#", 1)[0].strip()
    missing = [n for n in ("OCI_HOST", "OCI_USER", "OCI_SSH_KEY_FILE", "PROXY_DOMAIN", "PROXY_API_KEY")
               if not values.get(n)]
    if missing:
        raise SystemExit(f"{path.name} is missing: {', '.join(missing)}")
    return values


def ssh_base(secrets: dict) -> list:
    key_file = os.path.expanduser(secrets["OCI_SSH_KEY_FILE"])
    return ["ssh", "-i", key_file, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
            f"{secrets['OCI_USER']}@{secrets['OCI_HOST']}"]


def port_free(port: int) -> bool:
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) != 0


def open_tunnel(secrets: dict, ports: list) -> subprocess.Popen:
    busy = [p for p in ports if not port_free(p)]
    if busy:
        raise SystemExit(f"Local port(s) {busy} are in use; close the other tunnel first.")
    forwards = sum((["-L", f"{p}:127.0.0.1:{p}"] for p in ports), [])
    base = ssh_base(secrets)
    tunnel = subprocess.Popen(base[:-1] + ["-N", "-o", "ExitOnForwardFailure=yes", *forwards, base[-1]])
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if tunnel.poll() is not None:
            raise SystemExit("SSH tunnel failed to start.")
        if not port_free(API_PORT):
            return tunnel
        time.sleep(0.3)
    tunnel.terminate()
    raise SystemExit("SSH tunnel did not come up within 20 seconds.")


def management_key(secrets: dict) -> str:
    result = subprocess.run(ssh_base(secrets) + ["cat", REMOTE_KEY], capture_output=True, text=True)
    key = result.stdout.strip()
    if result.returncode or not key:
        raise SystemExit("Could not read the management key on the server.")
    return key


class RejectRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Management API redirect rejected.")


def call(key: str, path: str, payload: dict | None = None) -> dict:
    headers = {"Authorization": "Bearer " + key}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode()
    # Neither environment proxy settings nor redirects may receive this key.
    with build_opener(ProxyHandler({}), RejectRedirect()).open(
            Request(API + path, headers=headers, data=body), timeout=30) as response:
        return json.load(response)


def pasted_line(timeout: float) -> str:
    """Return a line typed on stdin within `timeout` seconds, or ''."""
    if not sys.stdin.isatty():
        time.sleep(timeout)
        return ""
    ready, _, _ = select.select([sys.stdin], [], [], timeout)
    return sys.stdin.readline().strip() if ready else ""


def wait_for_login(key: str, state: str, callback_provider: str | None,
                   timeout: float = LOGIN_TIMEOUT, read_line=pasted_line) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = call(key, "/get-auth-status?" + urlencode({"state": state}))
        if status.get("status") == "ok":
            return
        if status.get("status") == "error":
            raise SystemExit("Login failed: " + str(status.get("error") or "unknown error")[:200])
        line = read_line(2)
        if line and callback_provider:
            # Approved elsewhere: hand the final address-bar URL to the server.
            try:
                call(key, "/oauth-callback", {"provider": callback_provider, "redirect_url": line})
            except HTTPError as error:
                print(f"Callback was rejected (HTTP {error.code}); check the URL and paste it again.")
    raise SystemExit("Timed out waiting for the login; run the command again for a new link.")


def verify(secrets: dict, smoke_provider: str) -> None:
    source = ROOT / "scripts" / "cli-proxy-public-smoke.py"
    spec = importlib.util.spec_from_file_location("public_smoke", source)
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    _, check = smoke.PROVIDERS[smoke_provider]
    try:
        check("https://" + secrets["PROXY_DOMAIN"], secrets["PROXY_API_KEY"])
    except (OSError, URLError, ValueError, TypeError, KeyError) as error:
        raise SystemExit(f"Login saved, but live {smoke_provider} check failed: {smoke.describe(error)}")
    print(f"Live {smoke_provider} inference passed.")


def status(key: str) -> None:
    reply = call(key, "/auth-files")
    files = reply.get("files", reply) if isinstance(reply, dict) else reply
    for item in files if isinstance(files, list) else []:
        fields = {name: item.get(name) for name in ("provider", "type", "name", "status", "status_message",
                                                     "disabled", "unavailable") if item.get(name) not in (None, "")}
        print(json.dumps(fields, ensure_ascii=False, sort_keys=True)[:300])


def login(secrets: dict, key: str, provider: str) -> None:
    endpoint, _, callback_provider, smoke_provider = PROVIDERS[provider]
    reply = call(key, "/" + endpoint)
    url, state = reply.get("url"), reply.get("state")
    if not url or not state:
        raise SystemExit("CLIProxyAPI returned no login URL.")
    print(f"Opening the {provider} login in your browser. Sign in with the subscription account.")
    print(url)
    webbrowser.open(url)
    if callback_provider:
        print("Waiting for the login... If the browser shows an unreachable localhost page,")
        print("paste its full address-bar URL here and press Enter.")
    else:
        print("Waiting for the login (scan the QR code or finish in the browser)...")
    wait_for_login(key, state, callback_provider)
    print(f"{provider} credential saved.")
    verify(secrets, smoke_provider)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("provider", choices=[*PROVIDERS, "status"])
    parser.add_argument("--secrets", type=Path, default=ROOT / ".env.secrets")
    args = parser.parse_args()
    secrets = read_secrets(args.secrets)
    callback_port = PROVIDERS.get(args.provider, (None, None))[1]
    tunnel = open_tunnel(secrets, [API_PORT] + ([callback_port] if callback_port else []))
    try:
        key = management_key(secrets)
        if args.provider == "status":
            status(key)
        else:
            login(secrets, key, args.provider)
    except HTTPError as error:
        raise SystemExit(f"Management API returned HTTP {error.code}.") from None
    except (URLError, OSError, RuntimeError) as error:
        raise SystemExit(f"{type(error).__name__}: {error}") from None
    finally:
        tunnel.terminate()
        tunnel.wait(timeout=10)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
