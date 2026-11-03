# Unified Proxy

当前公网入口为 Caddy 后的 CLIProxyAPI，已接入 ChatGPT/Codex、Claude、Google Antigravity 和 CodeBuddy/WorkBuddy 共享 Credits。原有 API 地址和 `PROXY_API_KEY` 继续使用，客户端无需修改配置。

## 客户端接入

- Base URL：`https://<你的域名>/v1`
- 认证：`Authorization: Bearer <PROXY_API_KEY>`
- 模型目录：`GET /v1/models`
- 对话：`POST /v1/chat/completions`
- Responses：`POST /v1/responses`
- Claude 接口：`POST /v1/messages`

当前模型目录共 50 项。GPT、Claude、Gemini、CodeBuddy 的真实调用均已通过；目录中的其他模型仍需根据账号权限逐个确认。已测试模型及准确名称见 [README](README.md#connect-a-client)。

## 运行与维护

使用 `compose.cli-proxy.yaml` 部署。账号凭据保存在服务器私有目录 `.cli-proxy-api/`；部署不会覆盖凭据或轮换 key。`npm test` 运行无外部请求的 Python 测试，`npm run smoke` 会真实调用模型并消耗额度。

规则与 `/health` 一致：只要还有一个 provider 可用，部署和 `npm run smoke` 就通过，每个失败的 provider 记一条 warning；只有网关不可用或四家全部失败才算失败。部署时 WorkBuddy 插件、模型目录或刷新定时任务的问题也只记 warning。

## 监控与告警

[监控 workflow](.github/workflows/monitor.yml) 每六小时运行一次，分别检查 GPT、Claude、Gemini、CodeBuddy 的真实调用，日志中写明失败的 provider 和原因（HTTP 状态码或上游错误）。

- 部分 provider 失败：日志 warning，并发送普通 Bark 推送，标题列出失败的 provider。
- 全部失败：日志 error，workflow 失败，并发送时效性（time-sensitive）Bark 推送。
- 推送可点开对应运行日志。不记录状态，故障期间每次运行都会再推送一次。
- 需要 GitHub secret `BARK_KEY`（Bark App 首页 `https://api.day.app/<key>/` 中的 key）。在 `.env.secrets` 中填写后运行 `./scripts/push-secrets.sh` 同步。

## Claude 重新认证

无需 SSH 转发，可在手机上完成：

1. **Actions → Server maintenance → Run workflow**，选择 `claude-login-start`，日志中会打印登录链接。
2. 打开链接，用 Claude 订阅账号登录并授权。浏览器随后无法打开 `localhost:54545` 页面，属正常现象；复制地址栏中的完整地址（若页面显示 `code#state` 则复制它）。
3. 再次运行，选择 `claude-login-complete`，将复制内容填入 `callback`（日志中会被遮蔽）。最后会做一次 Claude 真实调用验证。

`diagnose` 查看已保存的 Claude 凭据状态。登录链接会出现在公开仓库的运行日志中，没有账号授权则无效；中途失败请重新开始。其他 provider 及手动步骤见 [部署说明](docs/cli-subscriptions.md)。

ChatGPT、Claude、Antigravity 由 CLIProxyAPI 内置刷新。CodeBuddy 使用本机定时任务，每五分钟检查一次，在 token 到期前十分钟调用插件刷新接口并核对新凭据已保存。监控检查定时任务是否运行、最近一次任务是否成功及 token 是否有效。刷新凭据被撤销或失效时仍需重新登录，客户端 API key 不随订阅 token 更新。

旧 Node 服务已屏蔽，LiteLLM/Postgres 的容器、数据库卷及旧安装文件已归档后移除。旧代码和操作说明保存在 [迁移前的历史版本](https://github.com/blue126/unified-proxy/tree/ef54ad375b8840746fb9203a9bada88c80abfb78)，恢复数据保存在服务器 `.retired-proxy/` 私有目录。完整操作与恢复步骤见 [部署说明](docs/cli-subscriptions.md)。
