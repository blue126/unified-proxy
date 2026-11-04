# Unified Proxy

一个兼容 OpenAI 和 Anthropic 格式的 HTTPS 入口，背后是订阅账号：ChatGPT/Codex、Claude、Google Antigravity（Gemini）和 CodeBuddy/WorkBuddy。服务运行在 OCI ARM64 虚拟机上，由 Caddy 转发到 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)。客户端只用一个 API key，各 provider 的 OAuth 凭据由网关保管。

本文是管理员操作指南。组件关系见 [架构文档](docs/architecture.md)，安装、恢复与旧服务下线见 [运维说明](docs/cli-subscriptions.md)。English: [README.md](README.md)。

## 常用操作

| 任务 | 方法 |
| --- | --- |
| 服务是否正常？ | 看 Bark 推送，或 **Actions → Monitor deployed proxy → Run workflow** |
| 查看已存凭据 | `./scripts/reauth.py status` |
| 重新认证（Mac） | `./scripts/reauth.py claude`（或 `codex`、`antigravity`、`workbuddy`） |
| 重新认证 Claude 或 Codex（手机） | [iPhone 快捷指令](docs/iphone-reauth-shortcut.md)，或 **Actions → Server maintenance**，先 `claude-login-start` 再 `claude-login-complete`（Codex：先 `codex-login-start` 再 `codex-login-complete`） |
| 端到端真实检查 | `npm run smoke`（消耗额度） |
| 部署 | 把审核过的 PR 合并到 `main` |
| 同步 secrets 到 GitHub | `./scripts/push-secrets.sh` |
| 单元测试 | `npm test`（Python 3.10+，无网络请求） |

## 客户端接入

- Base URL：`https://<PROXY_DOMAIN>/v1`
- 认证：`Authorization: Bearer <PROXY_API_KEY>`
- 接口：`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`（Anthropic 格式）

| Provider | 已测试模型 | 网关持有的账号 |
| --- | --- | --- |
| GPT / Codex | `gpt-6-luna` | ChatGPT OAuth |
| Claude | `claude-sonnet-5` | Claude OAuth |
| Google | `gemini-3-flash` | Antigravity OAuth |
| CodeBuddy / WorkBuddy | `glm-5.2`、`kimi-k2.7` | WorkBuddy 插件 OAuth（共享 Credits） |

完整模型名见 [README](README.md#connect-a-client)。模型目录约 50 项；出现在目录中不代表账号一定能调用，使用前请先测试。没有按 key 的限流，只受各订阅账号自身额度限制。

Claude Code：

```bash
export ANTHROPIC_BASE_URL="https://<PROXY_DOMAIN>"
export ANTHROPIC_AUTH_TOKEN="<PROXY_API_KEY>"
claude
```

## 配置

公开仓库：不要提交任何 secret 值、真实域名或主机地址。

- **本地 `.env.secrets`**（已 gitignore，模板 `.env.secrets.example`）：`OCI_HOST`、`OCI_USER`、`OCI_SSH_KEY_FILE`、`PROXY_DOMAIN`、`PROXY_API_KEY`、可选 `BARK_KEY`。含义见 [英文版](README.md#configuration)。
- **GitHub Actions secrets**：由 `./scripts/push-secrets.sh` 同步；`OCI_SSH_FINGERPRINT` 可选，手动设置，用于维护 workflow 固定主机密钥。
- **服务器私有目录** `/opt/unified-proxy/.cli-proxy-api/`（目录 700、文件 600）：`config.yaml`、`upstream-key`（客户端 key）、`management-key`（私有管理 API）、`auths/`（各 provider 凭据）、`plugins/`。

`PROXY_API_KEY` 在 `.env.secrets`、GitHub secret 和服务器 `upstream-key` 三处必须一致；provider token 刷新不会改变客户端 key。

## 监控与告警

[监控 workflow](.github/workflows/monitor.yml) 每六小时运行一次：通过 SSH 检查 WorkBuddy 刷新定时任务，再检查客户端认证、管理路由屏蔽、模型目录，以及每个 provider 的真实调用。各 provider 独立判断，失败时写明原因，例如 `claude: model absent: claude-sonnet-5`。

| 结果 | 日志 | Workflow | Bark 推送 |
| --- | --- | --- | --- |
| 全部正常 | `Providers OK: …` | 通过 | 无 |
| 部分失败 | 每个 provider 一条 warning | 通过 | 普通推送，标题 `Provider down: <名称>` |
| 全部失败或网关不可用 | error | 失败 | 时效性推送 `All providers down` |

WorkBuddy 刷新定时任务失败算作 CodeBuddy 故障。告警不记录状态：故障期间每次运行都会推送，恢复时不推送。公开的 `/health` 只反映网关进程，不反映各 provider。

## 重新认证

当某个 provider 的 refresh token 被撤销或过期（监控报 `model absent` 或认证错误，`status` 显示 `error`）时需要重新认证。

**在 Mac 上**（全部 provider），在带 `.env.secrets` 的 checkout 中：

```bash
./scripts/reauth.py status
./scripts/reauth.py claude
```

脚本通过 SSH 隧道连到私有管理 API 和对应回调端口，用浏览器打开登录页，等待凭据保存，最后对该 provider 做一次真实调用。在其他设备上授权时，按提示粘贴最终地址栏 URL。需要本机 8317 和回调端口（Codex 1455、Claude 54545、Antigravity 51121）空闲。换账号登录会新增一个凭据，旧的不再需要时可删除。

**手机上重新认证 Claude 或 Codex**：**Actions → Server maintenance** 运行 `claude-login-start` 或 `codex-login-start`，打开日志中的链接并授权，复制打不开的 `localhost` 地址，再运行对应的 `*-login-complete` 并填入 `callback`。详见 [运维说明](docs/cli-subscriptions.md#claude-or-codex-from-the-actions-tab-no-ssh-forwarding)。

## 部署

合并到 `main` 会运行 [部署 workflow](.github/workflows/deploy.yml)（纯文档改动跳过）：复制 Compose、脚本和 systemd 单元，校验 WorkBuddy 插件，更新容器，安装刷新定时任务，最后做公网检查。服务器必须有 `.cli-proxy-active` 标记；账号凭据和 key 不会被覆盖。

与监控一致：只要还有一个 provider 可用，部署就成功，失败的 provider 只记 warning。只有网关不可用、全部 provider 失败或部署自身步骤失败（插件校验、Compose、定时任务安装）才算失败。不要直接推送 `main`，流程见 [AGENTS.md](AGENTS.md)。

版本固定：CLIProxyAPI v8.0.52（镜像 digest，见 `compose.cli-proxy.yaml`），WorkBuddy v0.3.2（SHA-256，见 `scripts/cli-proxy-install-plugin.py`）。升级即修改固定版本的 PR。

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `<provider>: model absent: …` | 该账号凭据失效，模型从目录中消失 | `./scripts/reauth.py status`，然后重新认证 |
| 某 provider 报 `HTTP 401/403` | token 被撤销或账号失去权限 | 同上 |
| `HTTP 429` 或额度提示 | 订阅额度用尽 | 等待额度恢复 |
| `codebuddy: WorkBuddy refresh timer check failed` | 刷新任务失败 | 服务器上 `journalctl -u unified-proxy-workbuddy-refresh.service -n 20` |
| 全部失败且为 `gateway: …` | 容器、Caddy 或虚拟机故障 | 服务器 `/opt/unified-proxy` 下 `docker compose -f compose.cli-proxy.yaml ps` |
| 收不到 Bark 推送 | 缺少 `BARK_KEY` secret | 写入 `.env.secrets` 后运行 `./scripts/push-secrets.sh` |
