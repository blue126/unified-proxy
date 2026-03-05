# 计划：unified-proxy OCI VM 独立部署

## Context

unified-proxy 目前以 Docker 容器形式运行在本地开发环境，绑定 `127.0.0.1:3456`，依赖 localhost 做安全边界，没有 API key 鉴权。目标是将其部署到 OCI VM 作为独立可复用服务，供本项目、其他 VPS 和本地 MacBook 调用。

运行方式：裸机 Node.js + systemd（不用 Docker），Caddy 做 TLS 终结，域名绑定用户已有的子域名。

---

## 改动范围

### 1. 修改：`unified-proxy/server.js`（2 处，共 ~10 行新增）

**改动 A — 第 24 行后，添加 `PROXY_API_KEY` 常量：**

```javascript
// 在 const VERSION = '5.0.0'; 之后插入
const PROXY_API_KEY = process.env.PROXY_API_KEY || null;
```

**改动 B — 第 1098 行后（OPTIONS 块结束后），第 1099 行空行处，插入鉴权中间件：**

```javascript
  // API Key auth (skip for /health and /; backward-compatible: no-op if PROXY_API_KEY unset)
  if (PROXY_API_KEY && path !== '/health' && path !== '/') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== PROXY_API_KEY) {
      return sendJSON(res, 401, { error: { message: 'Unauthorized: invalid or missing API key', type: 'auth_error' } });
    }
  }
```

---

### 2. 新建：`unified-proxy/deploy/` 目录下 3 个文件

**`unified-proxy/deploy/unified-proxy.service`（systemd unit）：**

```ini
[Unit]
Description=Unified Proxy - Multi-Provider OAuth Proxy (Anthropic + OpenAI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/unified-proxy
ExecStart=/usr/bin/node /opt/unified-proxy/server.js
EnvironmentFile=/opt/unified-proxy/.env
Restart=always
RestartSec=5
StartLimitInterval=60s
StartLimitBurst=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/unified-proxy
LimitNOFILE=65536
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=unified-proxy

[Install]
WantedBy=multi-user.target
```

**`unified-proxy/deploy/Caddyfile`：**

```caddyfile
# 将 proxy.yourdomain.com 替换为实际子域名
proxy.yourdomain.com {
    reverse_proxy localhost:3456

    header {
        X-Frame-Options DENY
        X-Content-Type-Options nosniff
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }
}
```

**`unified-proxy/deploy/.env.example`：**

```bash
# OCI VM 环境变量模板 — 复制为 /opt/unified-proxy/.env 并填写实际值
HOST=127.0.0.1
PORT=3456
PROXY_AUTH_FILE=/opt/unified-proxy/auth.json
# 生成命令：openssl rand -hex 32
PROXY_API_KEY=your-random-secret-key-here
```

---

### 3. 部署后更新：`mentor-agent-service/providers.yaml`

将 `base_url` 和 `api_key` 同步更新（部署完成、key 确认后再改）：

```yaml
# 旧：base_url: "http://unified-proxy:3456/v1"  api_key: "sk-unused"
# 新：
base_url: "https://proxy.yourdomain.com/v1"
api_key: "${PROXY_API_KEY}"   # 或直接填入 key 值
```

`_normalize_model_for_litellm()` 无需改动，URL 不含 `api.anthropic.com` 则已自动加 `openai/` 前缀。

---

## 部署步骤

1. **OCI 控制台（手动）**：安全列表开放 TCP 80/443 入站
2. **OCI VM**：`iptables` 放行 80/443，`netfilter-persistent save` 持久化
3. **OCI VM**：安装 Node.js 20（NodeSource deb）和 Caddy（官方 apt）
4. **Mac → OCI VM**：`scp server.js package.json`（改动后）到 `/opt/unified-proxy/`
5. **Mac → OCI VM**：`scp ~/.unified-proxy/auth.json` 到 `/opt/unified-proxy/auth.json`，`chmod 600`
6. **OCI VM**：写 `/opt/unified-proxy/.env`，`openssl rand -hex 32` 生成 PROXY_API_KEY，`chmod 600`
7. **OCI VM**：`scp unified-proxy.service` → `/etc/systemd/system/`，`systemctl enable --now unified-proxy`
8. **OCI VM**：修改 Caddyfile 子域名，`scp Caddyfile` → `/etc/caddy/Caddyfile`，`systemctl restart caddy`
9. **本地**：更新 `providers.yaml` 的 `base_url` 和 `api_key`

---

## Token 刷新策略

现有 `setInterval(30min)` 后台刷新 + systemd `Restart=always` 已足够：
- 进程常驻，定时器天然有效
- 进程崩溃后 5 秒重启，启动时惰性检查 token 状态
- **无需额外 systemd timer**

Token 过期时的运维：ssh 进 OCI VM，执行 `node /opt/unified-proxy/server.js --login all`，重新生成 auth.json 后 scp 回 OCI VM。

---

## 验证方案

```bash
# 1. OCI VM 本地：健康检查（无需 key）
curl -s http://127.0.0.1:3456/health | python3 -m json.tool

# 2. OCI VM 本地：无 key 访问受保护端点 → 应 401
curl -s http://127.0.0.1:3456/v1/models

# 3. OCI VM 本地：带 key 访问
PROXY_API_KEY=$(grep PROXY_API_KEY /opt/unified-proxy/.env | cut -d= -f2)
curl -s http://127.0.0.1:3456/v1/models -H "Authorization: Bearer ${PROXY_API_KEY}"

# 4. Mac 远端：HTTPS 健康检查
curl -s https://proxy.yourdomain.com/health

# 5. Mac 远端：实际推理（Anthropic 路由）
curl -s https://proxy.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4","messages":[{"role":"user","content":"Reply: PROXY_OK"}],"stream":false}'

# 6. Mac 远端：实际推理（OpenAI 路由）
curl -s https://proxy.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"Reply: PROXY_OK"}],"stream":false}'

# 7. OCI VM：systemd 崩溃自恢复测试
sudo systemctl kill -s SIGKILL unified-proxy && sleep 6 && sudo systemctl status unified-proxy
```
