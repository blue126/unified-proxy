# Experimental subscription sidecar

This project can stage CLIProxyAPI beside the running LiteLLM gateway. The
sidecar listens only on localhost port 8317 and shares LiteLLM's private Docker
network. Staging it does not change the public API, model catalog, or client key.

The pinned components are [CLIProxyAPI v8.0.27](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.27)
and the [WorkBuddy plugin v0.3.2](https://github.com/WslzGmzs/workbuddy-cli-proxy/releases/tag/v0.3.2).
The image and plugin release hashes are fixed in the Compose file and installer.
The plugin registers successfully with v8.0.27 in an isolated Linux ARM64 run.
This verifies loading, not account access or inference.

## Stage without changing public traffic

Run on the Linux ARM64 host from `/opt/unified-proxy`:

```bash
python3 scripts/cli-proxy-init.py
python3 scripts/cli-proxy-install-plugin.py
docker compose -f compose.cli-proxy.yaml up -d
python3 scripts/cli-proxy-smoke.py
```

The first command generates distinct sidecar client and management keys in the
ignored `.cli-proxy-api/` directory. It never overwrites an existing config or
key. The directory and authentication files are owner-only. The installer
checks the release archive and extracted plugin against pinned SHA-256 hashes.
The smoke check verifies the authenticated API, plugin registration, and model
catalog; the empty catalog is expected before account login.

Claude, Google Antigravity, and CodeBuddy each require their own interactive
authorization. Complete those logins only with the intended account. The
sidecar's management and OAuth callback ports bind to server localhost; use
SSH forwarding for a browser on another machine. After login, verify the
actual account's model catalog and run a real model call, for example:

```bash
python3 scripts/cli-proxy-smoke.py \
  --expect-model '<model-id-from-catalog>' \
  --infer-model '<model-id-from-catalog>'
```

The community project reads OAuth credentials and calls provider endpoints;
its name does not mean it launches the official CLI for every API request.
These credentials stay separate from LiteLLM's existing ChatGPT and Claude Code
credentials.

## Public entry options after validation

| Entry | Benefit | Work required |
| --- | --- | --- |
| LiteLLM → CLIProxyAPI | Retains the current public key, GPT route, rate limits, and deployment monitor | Add selected sidecar models to LiteLLM and keep two gateway processes |
| CLIProxyAPI directly | One gateway process for the subscription routes | Revalidate ChatGPT authentication, key scope, rate limits, monitoring, and client compatibility before replacing the public port |

Keep the public LiteLLM route until the selected accounts and model calls have
passed on the sidecar. Only then update the deployment workflow and public
routing for the chosen entry.
