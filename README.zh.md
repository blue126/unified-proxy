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
| `gpt-`、`o1`、`o3`、`o4` | OpenAI（ChatGPT Backend）|
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

```bash
curl https://your-proxy.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "o3-pro",
    "messages": [{"role": "user", "content": "解释量子纠缠。"}],
    "stream": false
  }'
```

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

---

## 配置项

环境变量（服务器端写在 `/opt/unified-proxy/.env`，本地可直接设置或省略）：

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3456` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PROXY_API_KEY` | _（空）_ | API Key 鉴权。**不设置则不启用鉴权**（适合本地开发）。 |
| `PROXY_AUTH_FILE` | `~/.unified-proxy/auth.json` | OAuth Token 存储路径 |

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

```bash
# 在本地 Mac 上登录
node server.js --login all

# 将 token 文件上传到服务器
scp ~/.unified-proxy/auth.json ubuntu@<oci-ip>:/opt/unified-proxy/auth.json

# 确认服务器上的文件权限
ssh ubuntu@<oci-ip> "chmod 600 /opt/unified-proxy/auth.json"

# 重启服务使其加载新 token
ssh ubuntu@<oci-ip> "sudo systemctl restart unified-proxy"
```

> 服务器上 `PROXY_AUTH_FILE=/opt/unified-proxy/auth.json`（在 `.env` 中配置），与默认路径 `~/.unified-proxy/auth.json` 不同。

### Token 过期后重新登录

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

# 运行测试（需本地服务已启动）
./test.sh
```

本地开发时不需要设置 `PROXY_API_KEY`，服务会在无鉴权模式下运行。

---

## License

MIT
