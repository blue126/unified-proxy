# Unified Proxy

The gateway runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) behind Caddy on the existing HTTPS domain. It forwards requests through separately authorized ChatGPT, Claude, and Google Antigravity accounts. The WorkBuddy plugin is authorized with the CodeBuddy/WorkBuddy shared-Credits account. The client API key and the existing seven GPT model IDs are preserved from the LiteLLM deployment.

## Connect a client

OpenAI-compatible clients retain `https://<your-domain>/v1` and their existing `PROXY_API_KEY`. Use `Authorization: Bearer <PROXY_API_KEY>`, list models with `GET /v1/models`, and call `POST /v1/chat/completions` or `POST /v1/responses`. The catalog also exposes Claude and Gemini names after those accounts are authorized. Catalog presence does not prove every model is currently served by the account.

| Provider | Tested model | Authentication held by the gateway |
| --- | --- | --- |
| GPT / Codex | `gpt-6-luna` | Dedicated ChatGPT OAuth login |
| Claude | `claude-sonnet-5` | Dedicated Claude OAuth login |
| Google | `gemini-3-flash` | Dedicated Antigravity OAuth login |
| CodeBuddy / WorkBuddy | `glm-5.2`, `kimi-k2.7` | Dedicated WorkBuddy plugin OAuth login |

The seven preserved GPT IDs are `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. GPT Responses JSON and streaming, Claude streaming and function calls, and CodeBuddy GLM streaming were tested. CodeBuddy adds `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.1`, `glm-5.2`, `glm-5v-turbo`, `hy3`, `hy3-preview`, `hy3-preview-agent`, `kimi-k2.7`, and `minimax-m3-pay`; GLM and Kimi have passed real calls. The authorized catalog currently lists 50 models.

Claude-compatible clients can call `POST /v1/messages` using the gateway key. For a new Claude Code client configuration:

```bash
export ANTHROPIC_BASE_URL="https://<your-domain>"
export ANTHROPIC_AUTH_TOKEN="<PROXY_API_KEY>"
claude
```

The community bridge calls provider endpoints using stored OAuth credentials; it does not launch the official CLI for every request. See the provider terms before using subscription authentication in another application.

## Operate the gateway

`compose.cli-proxy.yaml` pins CLIProxyAPI v8.0.27 by image digest and binds its API and OAuth callback ports to server localhost. `scripts/cli-proxy-install-plugin.py` installs WorkBuddy v0.3.2 only after verifying both archive and binary SHA-256 hashes. Caddy forwards public client requests to localhost port 8317, blocks management and OAuth callback routes, and maps `/health/readiness` and `/health` to the gateway's process-level response.

Private state lives in `/opt/unified-proxy/.cli-proxy-api/`: `config.yaml` holds gateway settings, `upstream-key` mirrors its client key, `management-key` is separate, and `auths/` holds refreshable OAuth credentials. Keep the directory at mode 700 and credential files at mode 600. The local ignored `.env.secrets` and GitHub Actions `PROXY_API_KEY` retain the same client key. Never commit or log these values or the real host/domain.

The current public key permits the registered subscription models. LiteLLM's former per-key 120 RPM and 1,000,000 TPM limits do not carry over; provider account quotas still apply. No separately billed Anthropic API key is configured.

ChatGPT, Claude, and Antigravity use CLIProxyAPI's built-in OAuth refresh. WorkBuddy v0.3.2 has a refresh handler but does not supply the host's automatic scheduling metadata. A local systemd timer therefore checks WorkBuddy expiry every five minutes and calls the private management refresh API within ten minutes of expiry. CLIProxyAPI exchanges and persists rotated tokens; the timer checks that the saved expiry was extended. Revoked or invalid refresh credentials still require a new login. Client API keys do not rotate with upstream tokens.

Pushing reviewed code to `main` runs [the deploy workflow](.github/workflows/deploy.yml). The server must have its `.cli-proxy-active` marker; missing activation fails deployment without starting a legacy service. Otherwise, the workflow preserves private account state, verifies the pinned plugin, reconciles Compose, installs/checks the WorkBuddy refresh timer, and checks the public API. [The monitor workflow](.github/workflows/monitor.yml) runs every six hours and checks the timer, latest job result, recent execution, and token validity as well as client authentication, GPT model names, and real GPT, Claude, Gemini, and CodeBuddy replies. Run the API checks with `npm run smoke`; live checks consume subscription quota. `npm test` runs side-effect-free Python unit tests; Python 3.10 or later is required.

The old Node service is masked. LiteLLM/Postgres containers, their database volume, and the old installation files have been removed after verifying a private recovery archive under `/opt/unified-proxy/.retired-proxy/`. Caddy, active OAuth state, the public endpoint, and the current client key are preserved. Legacy runtime code, maintenance workflows, and key-rotation tools are removed from this branch; [the previous version](https://github.com/blue126/unified-proxy/tree/ef54ad375b8840746fb9203a9bada88c80abfb78) retains their history. See [operations and recovery](docs/cli-subscriptions.md).
