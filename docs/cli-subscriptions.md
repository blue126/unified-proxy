# CLIProxyAPI operations and recovery

The active gateway is CLIProxyAPI v8.0.27 behind Caddy, with the WorkBuddy v0.3.2 plugin. Both components are pinned by SHA-256. ChatGPT, Claude, Antigravity, and CodeBuddy/WorkBuddy OAuth accounts are authorized. GPT Responses, Claude and Gemini calls, and CodeBuddy GLM/Kimi calls have passed through the public endpoint with the existing key. CodeBuddy GLM streaming also passed. The gateway uses provider endpoints with stored OAuth credentials; it does not launch the official CLI for each request.

## Deploy and verify

From `/opt/unified-proxy` on the Linux ARM64 host:

```bash
# Only on a new installation: creates keys without overwriting existing state.
python3 scripts/cli-proxy-init.py
python3 scripts/cli-proxy-install-plugin.py
docker compose -f compose.cli-proxy.yaml up -d
python3 scripts/cli-proxy-smoke.py --expect-model glm-5.2
```

On a new installation the initializer generates a client key and a distinct management key. Configure clients and the GitHub `PROXY_API_KEY` secret to match the private `upstream-key`; the current deployment already has a matching key and must retain it. Caddy must already route the existing HTTPS domain to localhost:8317, block `/v0/*`, `/v8/*`, `/management.html`, and OAuth callback paths, and map `/health/readiness` and `/health` to `/`. The deployment workflow requires `.cli-proxy-active` and never falls back to a retired service. It updates the Compose file and helpers, checks the pinned plugin, reconciles the gateway, and checks the public API.

Run `npm run smoke` from a checkout with its ignored `.env.secrets`, or provide `BASE_URL` and `PROXY_API_KEY` in the environment. The public check verifies authenticated models, anonymous-request rejection, blocked management routes, the original seven GPT names, and live GPT, Claude, Gemini, and CodeBuddy replies. The scheduled workflow runs the same check every six hours. Live checks consume subscription quota; `npm test` uses temporary data and simulated HTTP replies.

## Renew account authorization

Use the gateway's private management API through SSH forwarding. Forward main port 8317 and callback ports 1455 (Codex), 54545 (Claude), and 51121 (Antigravity). Use a system browser: the Google consent screen can stall in an embedded browser. Callback listeners redirect to the main port, so forwarding only callback ports or an alternate management port is insufficient.

Create a fresh login with the management key via these private endpoints:

| Account | Authentication URL endpoint |
| --- | --- |
| ChatGPT/Codex | `/v0/management/codex-auth-url?is_webui=true` |
| Claude | `/v0/management/anthropic-auth-url?is_webui=true` |
| Antigravity | `/v0/management/antigravity-auth-url?is_webui=true` |
| CodeBuddy/WorkBuddy | `/v0/management/workbuddy-auth-url` |

The response contains a short-lived URL and state. Complete login with the intended account, then check `/v0/management/get-auth-status?state=<state>` privately. Keep `auths/` mode 700 and credential files mode 600. Never place management keys, browser passwords, or OAuth tokens in GitHub issues or logs. An expired session needs a new URL; successfully saved account credentials do not need to be authorized again.

After login, query the actual catalog and verify a model:

```bash
python3 scripts/cli-proxy-smoke.py --expect-model '<model-id>' --infer-model '<model-id>'
```

CodeBuddy added ten names, listed in [README](../README.md). Its shared Credits are separate from Tencent TokenHub Token Plan. LiteLLM's old per-key RPM/TPM limits were not transferred; provider quotas apply.

## Legacy retirement and recovery

`scripts/cli-proxy-retire-legacy.py` is a one-time, explicitly invoked operator tool; deployment never invokes it. By default it only checks the current public four-provider API, Node service state, stopped legacy containers, and ownership of the database volume. With `--apply`, it archives the old installation, OAuth credentials, systemd unit, old Caddy backup, and stopped Postgres data under `.retired-proxy/<UTC-timestamp>/legacy.tar.gz` (directory mode 700, archive mode 600).

It compares archived contents and owner/permission metadata with every original file before removing anything, and writes `SHA256SUMS`. It then masks the old Node unit, removes only the legacy containers, named database volume, and empty project network, and removes the archived installation files. Other applications and Docker resources are untouched. The current Caddy configuration, client key, active OAuth state, and CLIProxyAPI container remain in place. A final public four-provider check verifies the result. If cleanup stops partway through, recovery data remains available; inspect the reported state before continuing.

For manual recovery:

1. Identify the timestamped recovery folder and run `sudo sha256sum -c SHA256SUMS` there.
2. Inspect the archive with `sudo tar -tzf legacy.tar.gz`. It contains paths relative to `/`: `opt/unified-proxy/...`, the old systemd unit, and `var/lib/docker/volumes/unified-proxy-litellm_postgres_data/_data/...`.
3. Check out [the last migration version](https://github.com/blue126/unified-proxy/tree/ef54ad375b8840746fb9203a9bada88c80abfb78) in a separate recovery checkout for the legacy code and runbook. Extract to a private temporary directory first; copy only the required old state. The original client key is archived, but active CLIProxyAPI credentials should remain untouched.
4. To restore LiteLLM, recreate its named database volume and restore the archived `_data` contents with their numeric owners before starting Postgres. Restore `.env.litellm`, `.litellm/`, `compose.yaml`, and `litellm/`, then start the old Compose project and wait for readiness. Docker image caches may still be available; otherwise pull the historical images.
5. Only after real calls pass, restore the archived Caddyfile, validate it, and reload Caddy. The current deployment intentionally has no legacy fallback; suspend its automatic deployment or prepare a separately reviewed recovery change before changing markers or public routing.
6. If restoring the original Node runtime, explicitly unmask its unit before reinstalling the archived unit and reloading systemd. No automatic workflow re-enables it.

Archive deletion and retention changes are separate operator decisions; this cleanup retains the verified archive. It must never be committed or uploaded with a PR.
