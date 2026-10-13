# LiteLLM migration

The repository now has a LiteLLM 1.105.0 target stack. The current Node service
continues to serve production until a separate cutover is authorized and run.
The target keeps the existing HTTPS domain and `/v1` path, with new client
keys because LiteLLM virtual keys must start with `sk-`.

## What each credential does

| Traffic | Gateway key | Upstream credential | LiteLLM route |
| --- | --- | --- | --- |
| Codex / GPT | `PROXY_API_KEY` | One ChatGPT login in a shared writable `auth.json` | `chatgpt/` |
| Claude Code | `CLAUDE_CODE_PROXY_KEY` | Each user's OAuth token, forwarded per request | `anthropic/*` |
| Other Claude clients | A separately scoped key, if added | A separately billed Anthropic API key | `anthropic/` |

The ChatGPT login is shared by every virtual key allowed to call `chatgpt/` on
this proxy. LiteLLM records those requests as $0, so the GPT client key is
created with request and token rate limits instead of a dollar budget. The
two client keys have separate model allowlists: GPT clients cannot reach the
Claude route, and the Claude Code key cannot reach GPT. Claude Code refreshes
its own OAuth credential; LiteLLM does not store it. A generic client cannot
spend a Claude subscription through this gateway. An API-billed Claude route
would need `ANTHROPIC_API_KEY` and a separately scoped client key.

Sources: [ChatGPT subscription provider](https://docs.litellm.ai/docs/providers/chatgpt),
[Claude Code subscription routing](https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription),
[Anthropic's third-party access guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account).

## Prepare without touching the running service

1. Install Docker Engine and Docker Compose. The VM already has both. The
   `compose.yaml` file binds LiteLLM only to localhost, initially on port 4000;
   Postgres uses a persistent Docker volume and has no host port.
2. Run `python3 scripts/litellm-init-env.py` from the repository to create an
   owner-only `.env.litellm`. It generates separate admin, encryption, database,
   GPT-client, and Claude-Code credentials. Keep `LITELLM_SALT_KEY` and the database volume across
   restarts. The new `PROXY_API_KEY` in this file is an `sk-` virtual key; the
   old hex-only key is not accepted by LiteLLM 1.105.0. The separate
   `CLAUDE_CODE_PROXY_KEY` is used only by Claude Code. Both keys default to
   120 requests/minute and 1,000,000 tokens/minute; edit these before
   registration if needed.
3. Enable ChatGPT device-code login for the account if needed. Run this in an
   interactive terminal and finish the browser sign-in:

   ```bash
   docker run --rm -it --entrypoint python \
     -e CHATGPT_TOKEN_DIR=/tokens/chatgpt \
     -v "$PWD/.litellm/chatgpt:/tokens/chatgpt" \
     docker.litellm.ai/berriai/litellm:1.105.0 \
     -c 'from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()'
   ```

   This creates `.litellm/chatgpt/auth.json`. The file must stay writable: LiteLLM
   refreshes it and each refresh token works once. Run a single proxy instance
   against this one file. Do not copy the old Node proxy's auth file into it.
4. Transfer `.env.litellm` and `.litellm/chatgpt/auth.json` over SSH to the
   same paths under `/opt/unified-proxy` on the VM. Transfer `compose.yaml`,
   `litellm/config.yaml`, and the `scripts/litellm-*.py` helpers there too.
   Give the private files owner-only permissions. Keep them outside Git.

The LiteLLM image runs as root in this pinned release. Its bind-mounted
`auth.json` and host directory must be writable by that container. The default
target config exposes concrete model names in `/v1/models`; add new models to
`litellm/config.yaml` as they become available. The catalog is configured
statically and does not prove that the signed-in ChatGPT account can call
every listed model. Tag new GPT deployments with
`model_info.access_groups: ["chatgpt-subscription"]` so the existing GPT
client key inherits access to them. The `anthropic/*` entry
also routes new Claude Code model IDs before the concrete list is updated.

In a local run of LiteLLM 1.105.0 with a signed-in Codex account,
`gpt-6-luna` returned text through both `/v1/responses` and
`/v1/chat/completions`. The native Responses route returned SSE events
even when the request set `stream: false`; the migration smoke script
handles that event stream. Chat Completions returned a single JSON object
for `stream: false`.

## Cutover and rollback

The prepared `scripts/litellm-cutover.py` starts LiteLLM on localhost:4000,
registers the two client keys as scoped LLM-only virtual keys, checks the model list
and a real GPT-6 Luna response, then stops the Node service and moves LiteLLM
to localhost:3456. Caddy can continue using its current upstream port. On a
failed switch it restores the Node service. It leaves the old Node credentials
in place for rollback.

**The existing main-branch deployment workflow still restarts the Node
service. Do not run the cutover until that workflow is updated for the new
runtime and the production change is explicitly authorized.** Otherwise a
later merge can conflict with LiteLLM on port 3456. The new LiteLLM stack and
cutover helper are ready for review; the production workflow change is a
separate approval step. The helper checks
`LITELLM_DEPLOY_WORKFLOW_READY=1` before it touches either service; leave it
at the generated default of `0` until that workflow is updated.

Once the workflow is updated and the private files are in place, the operator
can run `sudo python3 /opt/unified-proxy/scripts/litellm-cutover.py`. Then
replace the client key in every client, in the local `.env.secrets`, and in
the GitHub `PROXY_API_KEY` secret. The old key stops working at cutover.
Check `/health/readiness` and run `scripts/litellm-smoke.py` with the
new key.

For a manual rollback, stop the LiteLLM container, restore
`LITELLM_HOST_PORT=4000` in `.env.litellm`, start the old
`unified-proxy` systemd unit, and remove `.litellm-active`. The legacy
service continues to use the old `PROXY_API_KEY`; clients and the GitHub
secret must be switched back for it.

## Client configuration after cutover

OpenAI-compatible GPT clients keep `https://<your-domain>/v1` as their base URL
and use the new `PROXY_API_KEY`. Use `/v1/responses` for GPT and Codex
models; LiteLLM also bridges supported models on `/v1/chat/completions`.
The visible model names include `gpt-6-luna` and `gpt-6.1-sol`.

Claude Code users sign in to their own Claude subscription, then set:

```bash
export ANTHROPIC_BASE_URL="https://<your-domain>"
export ANTHROPIC_CUSTOM_HEADERS="x-litellm-api-key: Bearer <claude-code-key>"
claude
```

Claude Code supplies its own OAuth `Authorization` header. Keep
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and `apiKeyHelper` unset
in that client session so its subscription login is used. If generic clients
need Claude, supply a separately billed Anthropic API key in
`.env.litellm` and issue a dedicated model-scoped gateway key; the
subscription token is never shared with them.
