# Unified Proxy

One OpenAI- and Anthropic-compatible HTTPS endpoint backed by subscription accounts: ChatGPT/Codex, Claude, Google Antigravity (Gemini), and CodeBuddy/WorkBuddy. It runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) behind Caddy on an OCI ARM64 VM. Clients use a single API key; the gateway holds the provider OAuth credentials.

This README is the operator guide. For how the pieces fit together, see [architecture](docs/architecture.md); for installation, recovery, and legacy retirement, see [operations and recovery](docs/cli-subscriptions.md). 中文版见 [README.zh.md](README.zh.md).

## Quick reference

| Task | How |
| --- | --- |
| Is everything up? | Bark alerts, or **Actions → Monitor deployed proxy → Run workflow** |
| Check stored credentials | `./scripts/reauth.py status` |
| Re-authenticate a provider (Mac) | `./scripts/reauth.py claude` (or `codex`, `antigravity`, `workbuddy`) |
| Re-authenticate Claude or Codex (phone) | [iPhone shortcut](docs/iphone-reauth-shortcut.md), or **Actions → Server maintenance**, `claude-login-start` then `claude-login-complete` (Codex: `codex-login-start` then `codex-login-complete`) |
| Live end-to-end check | `npm run smoke` (consumes quota) |
| Deploy | Merge a reviewed PR to `main` |
| Sync secrets to GitHub | `./scripts/push-secrets.sh` |
| Unit tests | `npm test` (Python 3.10+, no network) |

## Connect a client

- Base URL: `https://<PROXY_DOMAIN>/v1`
- Auth: `Authorization: Bearer <PROXY_API_KEY>`
- Endpoints: `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages` (Anthropic format)

| Provider | Tested model | Account held by the gateway |
| --- | --- | --- |
| GPT / Codex | `gpt-6-luna` | ChatGPT OAuth |
| Claude | `claude-sonnet-5` | Claude OAuth |
| Google | `gemini-3-flash` | Antigravity OAuth |
| CodeBuddy / WorkBuddy | `glm-5.2`, `kimi-k2.7` | WorkBuddy plugin OAuth (shared Credits) |

The seven GPT IDs kept from earlier deployments are `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. CodeBuddy adds `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.1`, `glm-5.2`, `glm-5v-turbo`, `hy3`, `hy3-preview`, `hy3-preview-agent`, `kimi-k2.7`, and `minimax-m3-pay`. The catalog lists about 50 models; being listed does not prove the account can serve a model, so test before relying on one.

Claude Code:

```bash
export ANTHROPIC_BASE_URL="https://<PROXY_DOMAIN>"
export ANTHROPIC_AUTH_TOKEN="<PROXY_API_KEY>"
claude
```

There are no per-key rate limits; each provider account's own quota applies. The gateway calls provider endpoints with stored OAuth credentials and does not launch the official CLIs. Check the provider terms before using subscription authentication this way.

## Configuration

This is a public repository: never commit secret values, the real domain, or the host.

**Local `.env.secrets`** (ignored; copy `.env.secrets.example`). Used by `npm run smoke`, `./scripts/reauth.py`, and `./scripts/push-secrets.sh`.

| Variable | Meaning |
| --- | --- |
| `OCI_HOST` | Public IP or hostname of the VM |
| `OCI_USER` | SSH user (`ubuntu`) |
| `OCI_SSH_KEY_FILE` | Path to the SSH private key; its contents are uploaded as `OCI_SSH_KEY` |
| `PROXY_DOMAIN` | Public domain, without scheme |
| `PROXY_API_KEY` | Client API key |
| `BARK_KEY` | Bark device key for monitor alerts (optional; no pushes without it) |

**GitHub Actions secrets**, synced with `./scripts/push-secrets.sh`: `OCI_HOST`, `OCI_USER`, `OCI_SSH_KEY`, `PROXY_DOMAIN`, `PROXY_API_KEY`, `BARK_KEY`. `OCI_SSH_FINGERPRINT` is optional, set by hand, and pins the host key for the maintenance workflow.

**Server private state** in `/opt/unified-proxy/.cli-proxy-api/` (directory mode 700, files 600): `config.yaml` (gateway settings), `upstream-key` (the client key), `management-key` (private management API; leaves the server only into a tool's memory), `auths/` (provider OAuth credentials), `plugins/`.

`PROXY_API_KEY` must be the same in `.env.secrets`, the GitHub secret, and the server's `upstream-key`. Client keys do not change when provider tokens refresh.

## Monitoring and alerts

[The monitor workflow](.github/workflows/monitor.yml) runs every six hours. It checks the WorkBuddy refresh timer over SSH, then client authentication, blocked management routes, the catalog, and a real reply from each provider. Providers are checked independently and each failure is named with its reason, for example `claude: model absent: claude-sonnet-5` or `gemini: HTTP 403: …`.

| Result | Log | Workflow | Bark push |
| --- | --- | --- | --- |
| All providers OK | `Providers OK: …` | passes | none |
| Some providers fail | one warning per provider | passes | normal, titled `Provider down: <names>` |
| All fail, or the gateway is down | errors | fails | time-sensitive, `All providers down` |

A failed WorkBuddy refresh timer counts as a CodeBuddy failure. Alerts keep no state: every failing run pushes again, and recovery sends nothing. Each push links to its run.

Public `/health` is the gateway's process-level response only and does not report providers. Use the monitor, `npm run smoke`, or `./scripts/reauth.py status` for that.

## Re-authenticate an account

Needed when a provider's refresh token is revoked or expired: the monitor reports `model absent` or an auth error for that provider, and `status` shows it as `error`.

**From a Mac** (all providers), in a checkout with `.env.secrets`:

```bash
./scripts/reauth.py status
./scripts/reauth.py claude
```

The script tunnels the private management API and the provider's callback port over SSH, opens the login page in your browser, waits for CLIProxyAPI to save the credential, and ends with a live call for that provider. If you approve on another device, paste the final address-bar URL when prompted. Local port 8317 and the callback port (Codex 1455, Claude 54545, Antigravity 51121) must be free. Signing in with a different account adds a new credential; delete the old one later if it is no longer wanted.

**Claude or Codex from a phone**: run **Actions → Server maintenance** with `claude-login-start` or `codex-login-start`, open the logged URL and approve, copy the failed `localhost` address, then run the matching `*-login-complete` with it as `callback`. Details: [operations](docs/cli-subscriptions.md#claude-or-codex-from-the-actions-tab-no-ssh-forwarding).

## Deploy

Merging to `main` runs [the deploy workflow](.github/workflows/deploy.yml); docs-only changes are skipped. It copies the Compose file, helpers, and systemd units to the server, verifies the pinned WorkBuddy plugin, reconciles the container, installs the WorkBuddy refresh timer, and runs the public smoke check. The server must have its `.cli-proxy-active` marker. Account state and keys are never overwritten.

Like the monitor, a deploy succeeds while at least one provider works; broken providers are warnings. It fails only if the gateway is unreachable, every provider fails, or a deploy-owned step fails (plugin hash, Compose, timer install). Never push directly to `main`; open a PR, and see [AGENTS.md](AGENTS.md) for the branch workflow.

Versions are pinned: CLIProxyAPI v8.0.52 by image digest in [`compose.cli-proxy.yaml`](compose.cli-proxy.yaml), WorkBuddy v0.3.2 by archive and binary SHA-256 in [`scripts/cli-proxy-install-plugin.py`](scripts/cli-proxy-install-plugin.py). An upgrade is a PR that changes the pin.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `<provider>: model absent: …` | That account's credential is invalid, so its models left the catalog | `./scripts/reauth.py status`, then re-authenticate it |
| `HTTP 401/403` from one provider | Revoked token, or the account lost access | Same as above |
| `HTTP 429` or quota messages | Subscription limit reached | Wait; nothing to fix in the gateway |
| `codebuddy: WorkBuddy refresh timer check failed` | Refresh job failed | On the server: `journalctl -u unified-proxy-workbuddy-refresh.service -n 20` |
| Everything fails with `gateway: …` | Container, Caddy, or VM down | On the server: `docker compose -f compose.cli-proxy.yaml ps` in `/opt/unified-proxy` |
| No Bark pushes | `BARK_KEY` secret missing | Set it in `.env.secrets`, then `./scripts/push-secrets.sh` |

## Development

`npm test` runs the side-effect-free unit tests. `npm run smoke` and `./scripts/reauth.py` talk to production. PRs run unit tests and Compose/script syntax checks ([PR validation](.github/workflows/pr-validation.yml)).
