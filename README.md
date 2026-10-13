# Unified Proxy

The production gateway runs [LiteLLM](https://docs.litellm.ai/) on the existing HTTPS domain. OpenAI and Codex clients use one ChatGPT subscription login held by the server. Claude Code users sign in to their own Claude subscription; the gateway forwards each user's OAuth credential with that request. The former Node proxy is disabled on the server and retained in the repository for rollback.

## Connect a client

| Client | Base URL | Gateway key | Subscription credential |
| --- | --- | --- | --- |
| OpenAI / Codex | `https://<your-domain>/v1` | `PROXY_API_KEY` | Server's ChatGPT login |
| Claude Code | `https://<your-domain>` | `CLAUDE_CODE_PROXY_KEY` in a custom header | The user's Claude Code login |

The production domain and GPT key are in the ignored local `.env.secrets` and server private config. The Claude Code gateway key is in the server's private `.env.litellm`. Keep these values out of commits and logs. The two keys are scoped separately: the GPT key cannot call Claude models, and the Claude Code key cannot call GPT models. Both have request and token rate limits. LiteLLM currently records ChatGPT subscription spend as $0, so a dollar budget does not limit that traffic.

OpenAI-compatible clients can list their permitted models with `GET /v1/models` and call `POST /v1/responses` or, for supported models, `POST /v1/chat/completions` using `Authorization: Bearer <PROXY_API_KEY>`. The configured catalog includes `gpt-6-luna` and `gpt-6.1-sol`; catalog presence does not guarantee an account can call every model. `GET /health/readiness` checks the gateway without a key.

For Claude Code, log in with your own Claude subscription and set:

```bash
export ANTHROPIC_BASE_URL="https://<your-domain>"
export ANTHROPIC_CUSTOM_HEADERS="x-litellm-api-key: Bearer <CLAUDE_CODE_PROXY_KEY>"
claude
```

Claude Code provides its OAuth `Authorization` header. Do not set `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `apiKeyHelper` in that client session if you intend to use the subscription. Other Claude clients need a separately billed Anthropic API key and a separately scoped gateway key; the Claude subscription route is specific to Claude Code.

## Operate the gateway

The stack is defined in `compose.yaml` and `litellm/config.yaml`. LiteLLM binds to localhost port 3456 behind Caddy, and Postgres uses a private persistent Docker volume. `/opt/unified-proxy/.env.litellm` holds the admin key, encryption salt, database password, and client keys. `/opt/unified-proxy/.litellm/chatgpt/auth.json` holds the refreshable ChatGPT login. Keep the token file writable for the single LiteLLM instance and preserve the salt and database volume across restarts.

Pushing reviewed changes to `main` runs [the deploy workflow](.github/workflows/deploy.yml). The server's `.litellm-active` marker selects the LiteLLM deployment path. [The monitor workflow](.github/workflows/monitor.yml) checks public readiness, the model list, and a real GPT-6 Luna response using the GitHub `PROXY_API_KEY` secret. To run the same check locally, put the current key and domain in `.env.secrets` and use `npm run smoke`. This live check consumes subscription quota. `npm test` runs side-effect-free unit tests.

The original `PROXY_API_KEY` ceased working at cutover. Update any external clients still holding it to the new key; the local `.env.secrets` and GitHub Actions secret already use the new key. The [migration and rollback guide](docs/litellm-migration.md) covers credential scope, deployment, and recovery. The [legacy Node guide](docs/legacy-node.md) documents the retired runtime.
