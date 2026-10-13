# CLIProxyAPI deployment and rollback

This project can stage CLIProxyAPI beside the running LiteLLM gateway. The
sidecar listens only on localhost port 8317 on its own private Docker network.
Staging it does not change the public API, model catalog, or client key.

The pinned components are [CLIProxyAPI v8.0.27](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.27)
and the [WorkBuddy plugin v0.3.2](https://github.com/WslzGmzs/workbuddy-cli-proxy/releases/tag/v0.3.2).
The image and plugin release hashes are fixed in the Compose file and installer.
The plugin registers successfully with v8.0.27 in an isolated Linux ARM64 run.
ChatGPT, Claude, and Google logins and real calls were verified on the server,
including recovery after restarting the gateway. CodeBuddy login is deferred;
it does not block the independently verified providers from being deployed.

## Stage without changing public traffic

Run on the Linux ARM64 host from `/opt/unified-proxy`:

```bash
python3 scripts/cli-proxy-init.py
python3 scripts/cli-proxy-install-plugin.py
python3 scripts/cli-proxy-adopt-key.py
docker compose -f compose.cli-proxy.yaml up -d
python3 scripts/cli-proxy-smoke.py
```

The first command generates a sidecar client key and a distinct management key
in the ignored `.cli-proxy-api/` directory. It never overwrites an existing
config or key. The adoption step replaces the temporary sidecar client key
with the current `PROXY_API_KEY` from the private `.env.litellm`, so existing
clients can retain their key and `https://<your-domain>/v1` after a validated
direct cutover. It does not change the running LiteLLM key. The directory and
authentication files are owner-only. The installer
checks the release archive and extracted plugin against pinned SHA-256 hashes.
The smoke check verifies the authenticated API, plugin registration, and model
catalog; the empty catalog is expected before account login.

ChatGPT/Codex, Claude, Google Antigravity, and CodeBuddy each require their own interactive
authorization. Complete those logins only with the intended account. The
sidecar's management and OAuth callback ports bind to server localhost; use
SSH forwarding for a browser on another machine. Forward the main port 8317
as well as callback ports 1455 (Codex), 54545 (Claude), and 51121 (Google).
The callback listeners redirect the browser to the main port; forwarding only
an alternate management port leaves the last authorization step unreachable.
Use a normal system browser for authorization. The Google consent flow can
stall in an embedded browser even when account selection works.
Create a fresh login session if an earlier one expired; saved credentials from
a completed login do not need to be authorized again.

After login, verify the
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
| CLIProxyAPI directly | One gateway process for the subscription routes; its own key can preserve the current public key value | Revalidate ChatGPT authentication and client compatibility; recreate the current RPM/TPM limits and deployment monitor if still wanted |
| LiteLLM → CLIProxyAPI | Retains the current GPT route and LiteLLM key controls | Connect the Docker networks, add selected sidecar models to LiteLLM, and keep two gateway processes |

Direct CLIProxyAPI is the simpler target if its real account logins and model
calls pass. Reusing a client key and adapting the smoke workflow are small
changes. The current LiteLLM RPM/TPM key limits do not transfer automatically;
decide whether to recreate them at the edge. OAuth refresh, model availability,
and protocol compatibility are the substantive validation gates.

Keep the public LiteLLM route until the selected accounts and model calls have
passed on the sidecar. Only then update the deployment workflow and public
routing for the chosen entry.

## Apply the direct cutover

The helper first validates the actual Caddy replacement and makes GPT, Claude,
and Gemini calls on port 8317. Its check mode leaves public routing untouched:

```bash
sudo python3 scripts/cli-proxy-cutover.py --check --base-url 'https://<your-domain>'
```

After the updated main deployment workflow has passed, apply it with
`--workflow-ready` in place of `--check`. The helper saves the prior Caddyfile
under `.cli-proxy-api/rollback/`, changes the upstream to port 8317 while keeping
the original domain, blocks public management/callback paths, and runs the same
live checks through HTTPS with the original key. After those pass, it stops
LiteLLM and Postgres and disables their container restart policies. It validates
the public API once more after retirement. Failure restores the prior Caddyfile
and LiteLLM containers. Private configuration, OAuth state, and the database
volume are retained for recovery.

The `.cli-proxy-active` marker takes priority in the deployment workflow.
Scheduled monitoring detects the gateway runtime and tests three authorized
providers. Add CodeBuddy inference coverage after its account is logged in.

For a later manual rollback, restore the legacy container policies to
`unless-stopped`, run the original Compose stack with `.env.litellm` and wait for
readiness, copy `.cli-proxy-api/rollback/Caddyfile.before-cli-proxy` over the
existing Caddyfile, validate and reload Caddy, then remove `.cli-proxy-active`.
The client key has the same value in both gateways.
