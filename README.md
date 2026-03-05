# Unified Proxy

A self-hosted OpenAI-compatible API proxy that routes requests to **Anthropic Claude** and **OpenAI GPT** using OAuth subscriptions — no API credits needed.

- **Anthropic**: Claude Max subscription via PKCE OAuth
- **OpenAI**: ChatGPT Plus/Pro subscription via PKCE OAuth (ChatGPT Backend)
- **Auto-routing**: model name prefix determines the provider automatically
- **Auto-refresh**: tokens refreshed silently in the background
- **OpenAI-compatible API**: drop-in replacement — just change the base URL

---

## Prerequisites

- Node.js >= 20
- At least one active subscription:
  - Anthropic Claude Max (for Claude models)
  - ChatGPT Plus or Pro (for GPT/o-series models)

---

## Quick Start (local)

```bash
# 1. Clone and enter the directory
git clone <repo-url>
cd unified-proxy

# 2. Log in (OAuth, requires a browser)
node server.js --login all      # both Anthropic + OpenAI
# or individually:
node server.js --login          # Anthropic only
node server.js --login openai   # OpenAI only

# 3. Start the proxy (no PROXY_API_KEY needed locally — auth is disabled)
node server.js

# 4. Verify
curl http://localhost:3456/health
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"Hi"}]}'
```

---

## API Endpoints

All endpoints are exposed at `https://<your-domain>` (or `http://localhost:3456` locally).

### Health Check

```
GET /health
GET /
```

Returns status of both providers and token expiry. **No API key required.**

```bash
curl https://your-proxy.example.com/health
```

```json
{
  "status": "ok",
  "version": "5.0.0",
  "mode": "unified-proxy",
  "features": ["anthropic-oauth", "openai-oauth", "auto-refresh", "model-routing", "tools", "xml-history"],
  "providers": {
    "anthropic": { "status": "valid", "hoursRemaining": 23.4 },
    "openai":    { "status": "valid", "hoursRemaining": 11.2 }
  }
}
```

`status` is `"ok"` if at least one provider is valid, `"degraded"` if both are unavailable.

---

### List Models

```
GET /v1/models
Authorization: Bearer <PROXY_API_KEY>
```

```bash
curl https://your-proxy.example.com/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

```json
{
  "object": "list",
  "data": [
    { "id": "claude-opus-4-6",   "object": "model", "owned_by": "anthropic" },
    { "id": "claude-sonnet-4-6", "object": "model", "owned_by": "anthropic" },
    { "id": "claude-opus-4-5",   "object": "model", "owned_by": "anthropic" },
    { "id": "claude-sonnet-4-5", "object": "model", "owned_by": "anthropic" },
    { "id": "claude-haiku-4-5",  "object": "model", "owned_by": "anthropic" },
    { "id": "gpt-5.2",           "object": "model", "owned_by": "openai" },
    { "id": "o3-pro",            "object": "model", "owned_by": "openai" }
  ]
}
```

---

### Chat Completions

```
POST /v1/chat/completions
Authorization: Bearer <PROXY_API_KEY>
Content-Type: application/json
```

Fully compatible with the OpenAI Chat Completions API. Supports streaming, system prompts, and tool calls.

**Model routing** is automatic based on model name prefix:

| Model prefix | Routes to |
|---|---|
| `gpt-`, `o1`, `o3`, `o4` | OpenAI (ChatGPT Backend) |
| Everything else | Anthropic (Claude API) |

#### Non-streaming example

```bash
curl https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

#### Streaming example

```bash
curl -N https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Count from 1 to 5."}],
    "stream": true
  }'
```

#### OpenAI model example

> **Note:** The ChatGPT Backend requires a `system` message. Requests without one will fail with `{"detail":"Instructions are required"}`.

```bash
curl https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "o3-pro",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain quantum entanglement."}
    ],
    "stream": false
  }'
```

#### 推理 / Thinking 参数

##### Claude 扩展思考（Anthropic 模型）

Claude 支持在回答前进行深度思考（Extended Thinking）。开启后，模型会先在内部推理，再给出最终答案。思考过程不会出现在返回内容里，对客户端透明。

**开启方式**：在请求体中传入 `thinking` 字段：

```bash
curl https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "请帮我分析这道算法题的最优解..."}],
    "thinking": {
      "type": "enabled",
      "budget_tokens": 10000
    }
  }'
```

| 字段 | 说明 |
|---|---|
| `thinking.type` | 固定填 `"enabled"` |
| `thinking.budget_tokens` | 允许思考消耗的最多 token 数，建议 5000–16000 |

> **注意**：开启 `thinking` 时不能同时设置 `temperature`（两者不兼容，Anthropic API 会报错）。代理会自动处理这个冲突——有 `thinking` 时忽略 `temperature`。

> **适用模型**：claude-sonnet-4-6、claude-opus-4-6 等支持扩展思考的模型。haiku 系列不支持。

---

##### OpenAI 推理强度（OpenAI 模型）

o-series（o1/o3/o4）和 gpt-5.x 模型内置了推理能力，可以通过 `reasoning_effort` 控制推理的深度，在速度和质量之间权衡。

**使用方式**：在请求体中传入 `reasoning_effort` 字段：

```bash
curl https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "o3-pro",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Solve this math problem step by step..."}
    ],
    "reasoning_effort": "high"
  }'
```

| 值 | 说明 |
|---|---|
| `"low"` | 快速响应，推理较浅，适合简单任务 |
| `"medium"` | 默认值，均衡速度与质量 |
| `"high"` | 深度推理，耗时更长，适合复杂问题 |

> **不传时的行为**：不传 `reasoning_effort` 则使用后端默认（通常是 medium）。对于 o/gpt-5.x 系列，推理是始终开启的，该参数只控制推理深度。

---

#### Model aliases

Short aliases are supported for Anthropic models:

| Alias | Resolves to |
|---|---|
| `opus` | `claude-opus-4-5-20251101` |
| `sonnet` | `claude-sonnet-4-5-20250929` |
| `haiku` | `claude-3-5-haiku-20241022` |
| `claude-opus-4` | `claude-opus-4-5-20251101` |
| `claude-sonnet-4` | `claude-sonnet-4-5-20250929` |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

---

## Using with AI Clients

Any OpenAI-compatible client can point to this proxy. Set:

- **Base URL**: `https://your-proxy.example.com/v1`
- **API Key**: your `PROXY_API_KEY`

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-proxy.example.com/v1",
    api_key="your-proxy-api-key",
)

response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### Cursor / VS Code Copilot / other editors

Set the OpenAI API base URL to `https://your-proxy.example.com/v1` and API key to your `PROXY_API_KEY`.

### Opencode

[Opencode](https://opencode.ai) is a terminal-based AI coding assistant that supports OpenAI-compatible providers. To point it at this proxy, add a provider entry to `~/.config/opencode/config.json`:

```json
{
  "provider": {
    "unified-proxy": {
      "name": "Unified Proxy",
      "api": "openai",
      "models": [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        "gpt-5.2",
        "o3-pro"
      ],
      "apiKey": "<your PROXY_API_KEY>",
      "baseURL": "https://your-proxy.example.com/v1"
    }
  }
}
```

Replace `<your PROXY_API_KEY>` and `https://your-proxy.example.com/v1` with your actual values.

After saving the config, select the provider in Opencode:

```bash
opencode
# Press 'p' to open provider selection, then choose "Unified Proxy"
```

You can use any model listed under `models`. The model name is passed through to this proxy, which routes it to the correct upstream provider automatically.

---

## Configuration

Environment variables (set in `/opt/unified-proxy/.env` on the server, or export locally):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `PROXY_API_KEY` | _(none)_ | API key for all non-health endpoints. **If unset, auth is disabled** (fine for local use). |
| `PROXY_AUTH_FILE` | `~/.unified-proxy/auth.json` | Path to OAuth token storage |
| `CLAUDE_ACCESS_TOKEN` | _(none)_ | Fallback Anthropic access token. Used if no token is found in `auth.json` or the system Keychain. |
| `OPENAI_ACCESS_TOKEN` | _(none)_ | Fallback OpenAI access token. Used if no token is found in `auth.json`. Must be paired with `OPENAI_ACCOUNT_ID`. |
| `OPENAI_ACCOUNT_ID` | _(none)_ | ChatGPT account ID, required when using `OPENAI_ACCESS_TOKEN`. |

---

## Authentication Setup (OAuth Login)

OAuth tokens must be obtained on a **machine with a browser**. Tokens auto-refresh — you only need to re-login if the refresh token expires (roughly every 30 days).

### Anthropic (Claude Max)

```bash
node server.js --login
# or
node server.js --login anthropic
```

Opens a browser window. After authorizing on claude.ai, paste the authorization code back into the terminal.

### OpenAI (ChatGPT Plus/Pro)

```bash
node server.js --login openai
```

Opens a browser and starts a local callback server on port 1455. After authorizing, the token is captured automatically.

### Both providers at once

```bash
node server.js --login all
```

Tokens are stored at `~/.unified-proxy/auth.json` (or `$PROXY_AUTH_FILE`) with file permissions `0600`.

---

## Deployment (OCI VM)

The proxy runs as a systemd service behind Caddy for TLS termination.

### First-time setup: upload auth.json to the server

The OCI VM is a headless server — `--login` cannot open a browser there. Log in on your local Mac first, then copy the token file to the server:

> [!WARNING]
> Do not run the local server and the OCI server simultaneously with the same `auth.json`. Both providers use single-use rolling refresh tokens — whichever instance refreshes first invalidates the other's token, causing `invalid_grant` errors. **Stop the local server immediately after `--login` and before uploading.**

```bash
# On your local Mac
node server.js --login all

# Stop the local server before uploading (see warning above)
pkill -f "node server.js" 2>/dev/null; true

# Upload the token file to the server
scp ~/.unified-proxy/auth.json ubuntu@<oci-ip>:/opt/unified-proxy/auth.json

# Fix permissions
ssh ubuntu@<oci-ip> "chmod 600 /opt/unified-proxy/auth.json"

# Restart the service to load the new tokens
ssh ubuntu@<oci-ip> "sudo systemctl restart unified-proxy"
```

> The server's `.env` sets `PROXY_AUTH_FILE=/opt/unified-proxy/auth.json`, which differs from the local default of `~/.unified-proxy/auth.json`.

### Token renewal

**In normal operation you don't need to do anything.** The proxy auto-refreshes access tokens in the background (checked every 30 minutes, renewed 2 hours before expiry). Both Anthropic and OpenAI use rolling refresh tokens — each refresh issues a new refresh token, effectively resetting the expiry window. As long as the server runs continuously, tokens never actually expire.

Manual re-login is only needed if:
- The server was **offline for 30+ consecutive days** (refresh token expired without being rotated), or
- The token was **explicitly revoked** (e.g. you signed out of claude.ai or ChatGPT on all devices).

When that happens, repeat the first-time setup:

```bash
# Re-login on your local Mac
node server.js --login all

# Upload and restart
scp ~/.unified-proxy/auth.json ubuntu@<oci-ip>:/opt/unified-proxy/auth.json
ssh ubuntu@<oci-ip> "chmod 600 /opt/unified-proxy/auth.json && sudo systemctl restart unified-proxy"
```

### Service management

```bash
# Status
sudo systemctl status unified-proxy

# Restart
sudo systemctl restart unified-proxy

# Logs (live)
sudo journalctl -u unified-proxy -f

# Logs (last 100 lines)
sudo journalctl -u unified-proxy -n 100
```

### File layout

```
/opt/unified-proxy/
├── server.js              # main proxy server
├── package.json
├── auth.json              # OAuth tokens (pointed to by PROXY_AUTH_FILE)
├── .env                   # PROXY_API_KEY, PORT, HOST, PROXY_AUTH_FILE
└── deploy/
    ├── unified-proxy.service  # systemd unit
    └── Caddyfile              # reverse proxy + TLS config
```

---

## Continuous Deployment (CD)

Push to `main` → GitHub Actions automatically deploys to the OCI VM and restarts the service. A smoke test (health check + models list) runs after each deploy to verify the endpoint is up.

### Secret management

Secrets are stored locally in `.env.secrets` (gitignored) and pushed to GitHub with a one-liner.

**First-time setup:**

```bash
# 1. Copy the template
cp .env.secrets.example .env.secrets

# 2. Fill in the values
#    OCI_HOST, OCI_USER, OCI_SSH_KEY_FILE, PROXY_DOMAIN, PROXY_API_KEY

# 3. Push all secrets to GitHub (requires gh CLI, logged in)
./scripts/push-secrets.sh
```

Re-run `./scripts/push-secrets.sh` any time a value changes.

**Required secrets:**

| Secret | Description |
|---|---|
| `OCI_HOST` | OCI VM IP or hostname |
| `OCI_USER` | SSH username (typically `ubuntu`) |
| `OCI_SSH_KEY` | Full SSH private key — set via `OCI_SSH_KEY_FILE` in `.env.secrets`, the script reads the file content |
| `PROXY_DOMAIN` | Public domain of the proxy (e.g. `proxy.yourdomain.com`) |
| `PROXY_API_KEY` | API key used to authenticate against the proxy (same value as on the server) |

### API key rotation

One command keeps all three locations in sync (server `.env`, local `.env.secrets`, GitHub secret):

```bash
./scripts/rotate-proxy-key.sh
```

Remember to update any clients still using the old key after rotating.

---

## Development

```bash
# No dependencies — just run (requires Node.js >= 20)
node server.js

# Auto-reload
npm run dev

# Unit + integration tests (no real tokens needed — spins up isolated test server)
npm test

# Integration smoke test against local server (no auth)
./test.sh

# Integration smoke test with auth
PROXY_API_KEY=xxx ./test.sh

# Integration smoke test against remote server
BASE_URL=https://proxy.example.com PROXY_API_KEY=xxx ./test.sh
```

`PROXY_API_KEY` is not required locally — the proxy runs without authentication when the variable is unset.

### Live smoke test (real inference)

Verifies the deployed proxy can actually reach upstream models end-to-end:

```bash
# Reads BASE_URL and PROXY_API_KEY from .env.secrets automatically
npm run smoke

# Or override explicitly
BASE_URL=https://proxy.example.com PROXY_API_KEY=xxx npm run smoke
```

Calls `claude-sonnet-4-6` and `gpt-5.2` with a real prompt and verifies a non-empty response is returned.

---

## License

MIT
