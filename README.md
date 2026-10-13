# Unified Proxy

The gateway runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) behind Caddy on the existing HTTPS domain. It forwards requests through separately authorized ChatGPT, Claude, and Google Antigravity accounts. The WorkBuddy plugin is installed; its CodeBuddy/WorkBuddy account login is pending. The client API key and the existing seven GPT model IDs are preserved from the LiteLLM deployment.

## Connect a client

OpenAI-compatible clients retain `https://<your-domain>/v1` and their existing `PROXY_API_KEY`. Use `Authorization: Bearer <PROXY_API_KEY>`, list models with `GET /v1/models`, and call `POST /v1/chat/completions` or `POST /v1/responses`. The catalog also exposes Claude and Gemini names after those accounts are authorized. Catalog presence does not prove every model is currently served by the account.

| Provider | Tested model | Authentication held by the gateway |
| --- | --- | --- |
| GPT / Codex | `gpt-6-luna` | Dedicated ChatGPT OAuth login |
| Claude | `claude-sonnet-5` | Dedicated Claude OAuth login |
| Google | `gemini-3-flash` | Dedicated Antigravity OAuth login |
| CodeBuddy / WorkBuddy | Pending account login | WorkBuddy plugin OAuth or platform key |

The seven preserved GPT IDs are `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. GPT Responses JSON and streaming, plus Claude streaming and function calls, were tested before cutover.

Claude-compatible clients can call `POST /v1/messages` using the gateway key. For a new Claude Code client configuration:

```bash
export ANTHROPIC_BASE_URL="https://<your-domain>"
export ANTHROPIC_AUTH_TOKEN="<PROXY_API_KEY>"
claude
```

The previous LiteLLM-specific `x-litellm-api-key` setup belongs to the archived LiteLLM runtime. The community bridge calls provider endpoints using stored OAuth credentials; it does not launch the official CLI for every request. See the provider terms before using subscription authentication in another application.

## Operate the gateway

`compose.cli-proxy.yaml` pins CLIProxyAPI v8.0.27 by image digest and binds its API and OAuth callback ports to server localhost. `scripts/cli-proxy-install-plugin.py` installs WorkBuddy v0.3.2 only after verifying both archive and binary SHA-256 hashes. Caddy forwards public client requests to localhost port 8317, blocks management and OAuth callback routes, and maps `/health/readiness` and `/health` to the gateway's process-level response.

Private state lives in `/opt/unified-proxy/.cli-proxy-api/`: `config.yaml` holds gateway settings, `upstream-key` mirrors its client key, `management-key` is separate, and `auths/` holds refreshable OAuth credentials. Keep the directory at mode 700 and credential files at mode 600. The local ignored `.env.secrets` and GitHub Actions `PROXY_API_KEY` retain the same client key. Never commit or log these values or the real host/domain.

The current public key permits the registered subscription models. LiteLLM's former per-key 120 RPM and 1,000,000 TPM limits do not carry over; provider account quotas still apply. No separately billed Anthropic API key is configured.

Pushing reviewed code to `main` runs [the deploy workflow](.github/workflows/deploy.yml). The server's `.cli-proxy-active` marker selects CLIProxyAPI; the workflow preserves private account state, verifies the pinned plugin, reconciles Compose, and checks the public API. [The monitor workflow](.github/workflows/monitor.yml) runs every six hours and verifies client authentication, the GPT model names, and real GPT, Claude, and Gemini replies. Run the same check with `npm run smoke`; live checks consume subscription quota. `npm test` runs side-effect-free unit tests.

LiteLLM and its Postgres container are stopped with automatic restart disabled after the successful public cutover. Their private state and database volume remain available for rollback. See [deployment and rollback](docs/cli-subscriptions.md), the [archived LiteLLM guide](docs/litellm-migration.md), and the [archived Node guide](docs/legacy-node.md). The legacy Node key-rotation script must not be used to rotate the current gateway key.
