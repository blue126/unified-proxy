# Unified Proxy

自托管的 OpenAI 兼容 API 代理，通过 OAuth 订阅账号（无需 API 额度）将请求路由到 **Anthropic Claude** 和 **OpenAI GPT**。

- **Anthropic**：Claude Max 订阅，PKCE OAuth 授权
- **OpenAI**：ChatGPT Plus/Pro 订阅，PKCE OAuth 授权（ChatGPT Backend）
- **自动路由**：根据模型名前缀自动选择 provider
- **自动刷新**：Token 在后台静默续期
- **OpenAI 兼容**：只需修改 base URL，即可替换现有客户端

---

## 前提条件

- Node.js >= 20
- 至少一个订阅账号：
  - Anthropic Claude Max（用于 Claude 模型）
  - ChatGPT Plus 或 Pro（用于 GPT/o 系列模型）

---

## 快速开始（本地）

```bash
# 1. 克隆并进入目录
git clone <repo-url>
cd unified-proxy

# 2. 登录（获取 OAuth token，需要浏览器）
node server.js --login all      # 同时登录 Anthropic + OpenAI
# 或单独登录：
node server.js --login          # 仅 Anthropic
node server.js --login openai   # 仅 OpenAI

# 3. 启动代理（本地不设置 PROXY_API_KEY 则无需鉴权）
node server.js

# 4. 验证
curl http://localhost:3456/health
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"Hi"}]}'
```

---

## API 端点

所有端点基础地址：`https://<your-domain>`（本地：`http://localhost:3456`）

### 健康检查

```
GET /health
GET /
```

返回两个 provider 的状态及 token 有效期。**不需要 API Key。**

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

`status` 字段：至少一个 provider 有效时为 `"ok"`，全部不可用时为 `"degraded"`。

---

### 查询可用模型

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
    { "id": "claude-opus-4-6",      "object": "model", "owned_by": "anthropic" },
    { "id": "claude-sonnet-4-6",    "object": "model", "owned_by": "anthropic" },
    { "id": "claude-opus-4-5",      "object": "model", "owned_by": "anthropic" },
    { "id": "claude-sonnet-4-5",    "object": "model", "owned_by": "anthropic" },
    { "id": "claude-haiku-4-5",     "object": "model", "owned_by": "anthropic" },
    { "id": "codex-mini-latest",    "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.3-codex",        "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.3-codex-spark",  "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.2-codex",        "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.2",              "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.1-codex-max",    "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.1-codex",        "object": "model", "owned_by": "openai" },
    { "id": "gpt-5.1-codex-mini",   "object": "model", "owned_by": "openai" },
    { "id": "gpt-5-codex",          "object": "model", "owned_by": "openai" },
    { "id": "o3-pro",               "object": "model", "owned_by": "openai" }
  ]
}
```

---

### 对话补全

```
POST /v1/chat/completions
Authorization: Bearer <PROXY_API_KEY>
Content-Type: application/json
```

完全兼容 OpenAI Chat Completions API，支持流式输出、系统提示词和工具调用。

**路由规则**（根据模型名前缀自动判断）：

| 模型前缀 | 路由目标 |
|---|---|
| `gpt-`、`o1`、`o3`、`o4`、`codex-` | OpenAI（ChatGPT Backend）|
| 其他所有模型 | Anthropic（Claude API）|

#### 非流式请求

```bash
curl https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": false
  }'
```

#### 流式请求

```bash
curl -N https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "从 1 数到 5。"}],
    "stream": true
  }'
```

#### OpenAI 模型请求

> **注意：** ChatGPT Backend 要求请求中必须包含 `system` message，否则会报错 `{"detail":"Instructions are required"}`。

> **注意：** ChatGPT Backend **不支持** `temperature`、`top_p` 和 `max_tokens` 参数。代理会自动丢弃这些字段，不会报错。如需控制输出质量，请改用 `reasoning_effort`。

```bash
curl https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "o3-pro",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "解释量子纠缠。"}
    ],
    "stream": false
  }'
```

#### Prompt 缓存

代理会自动为两个 provider 启用 prompt 缓存：

**Anthropic（Claude）：** 自动在 system prompt 和最后一条用户消息上添加 `cache_control: {type: "ephemeral"}` 标记，遵循 [Anthropic 的 prompt caching 协议](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)。缓存前缀需至少 1024 tokens，TTL 为 5 分钟。

**OpenAI（ChatGPT Backend）：** 根据 system prompt 内容生成确定性的 session ID，同时作为 `prompt_cache_key`（请求体）和 `session_id`（请求头）发送，与 Codex CLI 的缓存协议一致。相同 system prompt 的请求共享同一个缓存 key，后端可复用已计算的前缀 tokens。

缓存命中统计会透传到响应的 `usage` 对象中：

```json
"usage": {
    "prompt_tokens": 1475,
    "completion_tokens": 42,
    "total_tokens": 1517,
    "prompt_tokens_details": {
        "cached_tokens": 1280
    },
    "completion_tokens_details": {
        "reasoning_tokens": 0
    }
}
```

> **注意：** OpenAI prompt 缓存要求至少 1024 prompt tokens，更短的 prompt 不会被缓存。对于共享 system prompt 的批量任务（如 PDFMathTranslate 批量翻译）效果尤为显著。

---

#### 模型别名（Anthropic）

| 别名 | 实际模型 |
|---|---|
| `opus` | `claude-opus-4-5-20251101` |
| `sonnet` | `claude-sonnet-4-5-20250929` |
| `haiku` | `claude-3-5-haiku-20241022` |
| `claude-opus-4` | `claude-opus-4-5-20251101` |
| `claude-sonnet-4` | `claude-sonnet-4-5-20250929` |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

---

## 接入现有客户端

任何 OpenAI 兼容客户端均可直接接入，只需修改：

- **Base URL**：`https://your-proxy.example.com/v1`
- **API Key**：你的 `PROXY_API_KEY`

### Python（openai SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-proxy.example.com/v1",
    api_key="your-proxy-api-key",
)

response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "你好！"}],
)
print(response.choices[0].message.content)
```

### Cursor / VS Code Copilot / 其他编辑器

将 OpenAI API Base URL 设置为 `https://your-proxy.example.com/v1`，API Key 设置为 `PROXY_API_KEY` 的值。

### Opencode

[Opencode](https://opencode.ai) 是一款终端 AI 编程助手，支持 OpenAI 兼容的 provider。在 `~/.config/opencode/config.json` 中添加以下配置，即可将其接入本代理：

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
        "codex-mini-latest",
        "gpt-5.3-codex",
        "gpt-5.2",
        "o3-pro"
      ],
      "apiKey": "<你的 PROXY_API_KEY>",
      "baseURL": "https://your-proxy.example.com/v1"
    }
  }
}
```

将 `<你的 PROXY_API_KEY>` 和 `https://your-proxy.example.com/v1` 替换为你的实际值。

保存配置后，在 Opencode 中选择该 provider：

```bash
opencode
# 按 'p' 打开 provider 选择菜单，选择 "Unified Proxy"
```

`models` 列表中的模型名称会原样传递给本代理，由代理自动路由到对应的上游服务（Anthropic 或 OpenAI）。

---

## 配置项

环境变量（服务器端写在 `/opt/unified-proxy/.env`，本地可直接设置或省略）：

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3456` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PROXY_API_KEY` | _（空）_ | API Key 鉴权。**不设置则不启用鉴权**（适合本地开发）。 |
| `PROXY_AUTH_FILE` | `~/.unified-proxy/auth.json` | OAuth Token 存储路径 |
| `CLAUDE_ACCESS_TOKEN` | _（空）_ | Anthropic 兜底 access token。在 `auth.json` 和系统 Keychain 均未找到 token 时使用。 |
| `OPENAI_ACCESS_TOKEN` | _（空）_ | OpenAI 兜底 access token。在 `auth.json` 未找到 token 时使用，需配合 `OPENAI_ACCOUNT_ID`。 |
| `OPENAI_ACCOUNT_ID` | _（空）_ | ChatGPT account ID，使用 `OPENAI_ACCESS_TOKEN` 时必填。 |

---

## 认证登录（OAuth）

OAuth Token 只需在**有浏览器的机器**上登录一次。Token 会自动续期，仅在 refresh token 过期（约每 30 天）后需要重新登录。

### Anthropic（Claude Max）

```bash
node server.js --login
# 或
node server.js --login anthropic
```

会打开浏览器，在 claude.ai 授权后，将授权码粘贴回终端。

### OpenAI（ChatGPT Plus/Pro）

```bash
node server.js --login openai
```

打开浏览器并在本地 1455 端口启动回调服务器，授权后自动捕获 token。

### 同时登录两个 provider

```bash
node server.js --login all
```

Token 存储在 `~/.unified-proxy/auth.json`（或 `$PROXY_AUTH_FILE`），文件权限为 `0600`。

---

## 部署说明（OCI VM）

代理以 systemd 服务运行，Caddy 做 TLS 终结。

### 首次部署：将 auth.json 传到服务器

OCI VM 是无头服务器，无法直接运行 `--login`。需要在本地 Mac 完成授权，再将 token 文件复制到服务器：

> [!WARNING]
> 不要同时在本地和 OCI 服务器上运行代理并共用同一份 `auth.json`。两个 provider 均使用单次有效的滚动 refresh token——先刷新的一方会使另一方的 token 失效，导致 `invalid_grant` 错误。**登录完成后请立即关闭本地服务器，再上传文件。**

```bash
# 在本地 Mac 上登录
node server.js --login all

# 登录后立即关闭本地服务器（见上方警告）
pkill -f "node server.js" 2>/dev/null; true

# 将 token 文件上传到服务器
scp ~/.unified-proxy/auth.json ubuntu@<oci-ip>:/opt/unified-proxy/auth.json

# 确认服务器上的文件权限
ssh ubuntu@<oci-ip> "chmod 600 /opt/unified-proxy/auth.json"

# 重启服务使其加载新 token
ssh ubuntu@<oci-ip> "sudo systemctl restart unified-proxy"
```

> 服务器上 `PROXY_AUTH_FILE=/opt/unified-proxy/auth.json`（在 `.env` 中配置），与默认路径 `~/.unified-proxy/auth.json` 不同。

### Token 过期后重新登录

**正常情况下无需手动操作。** 代理会在后台自动续期 access token（每 30 分钟检查一次，提前 2 小时刷新）。Anthropic 和 OpenAI 均使用滚动刷新机制——每次刷新都会签发新的 refresh token，相当于自动重置过期时间。只要服务持续运行，token 实际上不会过期。

需要手动重新登录的情况：
- 服务器**连续离线超过 30 天**（refresh token 未滚动更新而过期），或
- Token 被**主动吊销**（例如在 claude.ai 或 ChatGPT 网页端退出了所有设备的登录）。

出现上述情况时，重复首次部署的步骤：

```bash
# 在本地 Mac 重新登录
node server.js --login all

# 上传新 token
scp ~/.unified-proxy/auth.json ubuntu@<oci-ip>:/opt/unified-proxy/auth.json
ssh ubuntu@<oci-ip> "chmod 600 /opt/unified-proxy/auth.json && sudo systemctl restart unified-proxy"
```

### 服务管理

```bash
# 查看状态
sudo systemctl status unified-proxy

# 重启
sudo systemctl restart unified-proxy

# 实时日志
sudo journalctl -u unified-proxy -f

# 最近 100 行日志
sudo journalctl -u unified-proxy -n 100
```

### 文件结构

```
/opt/unified-proxy/
├── server.js              # 代理主程序
├── package.json
├── auth.json              # OAuth Token（由 PROXY_AUTH_FILE 指定）
├── .env                   # PROXY_API_KEY、PORT、HOST、PROXY_AUTH_FILE
└── deploy/
    ├── unified-proxy.service  # systemd 单元文件
    └── Caddyfile              # 反向代理 + TLS 配置
```

---

## 持续部署（CD）

推送到 `main` 分支后，GitHub Actions 自动通过 SSH 将最新代码部署到 OCI VM 并重启服务。每次部署后自动运行冒烟测试（健康检查 + 模型列表查询）验证服务可用。

### Secret 管理

Secrets 存储在本地 `.env.secrets` 文件中（已 gitignore），通过脚本一键同步到 GitHub。

**首次配置：**

```bash
# 1. 复制模板
cp .env.secrets.example .env.secrets

# 2. 填入真实值
#    OCI_HOST、OCI_USER、OCI_SSH_KEY_FILE、PROXY_DOMAIN、PROXY_API_KEY

# 3. 同步到 GitHub（需要已安装 gh CLI 并已登录）
./scripts/push-secrets.sh
```

任何值发生变化时，重新执行 `./scripts/push-secrets.sh` 即可更新。

**所需 secrets：**

| Secret 名称 | 说明 |
|---|---|
| `OCI_HOST` | OCI VM 的 IP 地址或域名 |
| `OCI_USER` | SSH 用户名（通常为 `ubuntu`）|
| `OCI_SSH_KEY` | SSH 私钥完整内容 — 在 `.env.secrets` 中填写 `OCI_SSH_KEY_FILE`（私钥文件路径），脚本自动读取文件内容上传 |
| `PROXY_DOMAIN` | 代理的公开域名（如 `proxy.yourdomain.com`）|
| `PROXY_API_KEY` | 访问代理用的 API Key（与服务器 `.env` 中的值相同）|

### API Key 轮换

一条命令同步更新服务器、本地 `.env.secrets`、GitHub secret 三处：

```bash
./scripts/rotate-proxy-key.sh
```

轮换后记得更新所有使用旧 key 的客户端。

---

## 本地开发

```bash
# 无依赖项，直接运行（需要 Node.js >= 20）
node server.js

# 自动重载（开发模式）
npm run dev

# 单元 + 集成测试（无需真实 token，自动启动隔离的测试服务器）
npm test

# 集成测试（本地服务，无鉴权）
./test.sh

# 集成测试（本地服务，带鉴权）
PROXY_API_KEY=xxx ./test.sh

# 集成测试（远程服务器）
BASE_URL=https://proxy.example.com PROXY_API_KEY=xxx ./test.sh
```

本地开发时不需要设置 `PROXY_API_KEY`，服务会在无鉴权模式下运行。

### 线上冒烟测试（真实推理）

验证已部署的代理能够真正调通上游模型：

```bash
# 自动从 .env.secrets 读取 BASE_URL 和 PROXY_API_KEY
npm run smoke

# 或手动指定
BASE_URL=https://proxy.example.com PROXY_API_KEY=xxx npm run smoke
```

会分别向 `claude-sonnet-4-6` 和 `gpt-5.2` 发送真实请求，验证返回了非空内容。

---

## License

MIT
