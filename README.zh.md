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

使用 `compose.cli-proxy.yaml` 部署。账号凭据保存在服务器私有目录 `.cli-proxy-api/`；部署不会覆盖凭据或轮换 key。六小时一次的监控覆盖四家服务。`npm test` 运行无外部请求的 Python 测试，`npm run smoke` 会真实调用模型并消耗额度。

ChatGPT、Claude、Antigravity 由 CLIProxyAPI 内置刷新。CodeBuddy 使用本机定时任务，每五分钟检查一次，在 token 到期前十分钟调用插件刷新接口并核对新凭据已保存。监控检查定时任务是否运行、最近一次任务是否成功及 token 是否有效。刷新凭据被撤销或失效时仍需重新登录，客户端 API key 不随订阅 token 更新。

旧 Node 服务已屏蔽，LiteLLM/Postgres 的容器、数据库卷及旧安装文件已归档后移除。旧代码和操作说明保存在 [迁移前的历史版本](https://github.com/blue126/unified-proxy/tree/ef54ad375b8840746fb9203a9bada88c80abfb78)，恢复数据保存在服务器 `.retired-proxy/` 私有目录。完整操作与恢复步骤见 [部署说明](docs/cli-subscriptions.md)。
