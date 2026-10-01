# Git and Pull Request Workflow

- After this migration, `origin/main` is the source of truth for the project.
- Never develop, commit, or push directly on `main` or `master`.
- Start every task from the latest remote default branch in a unique branch and worktree. Do not switch or modify the user's existing checkout.
- Before editing, inspect the current branch, dirty state, upstream, and existing worktrees. Preserve all user changes; do not stash, reset, clean, overwrite, or commit them.
- Complete work in this order: validate, commit, push the task branch, then open a Draft PR.
- Explicit user instructions in the current session take precedence over these workflow defaults.
- Agents may merge a PR only when the user explicitly authorizes that merge in the current session and validation for the current PR head has passed. Marking an authorized Draft PR ready for merge is allowed. Without explicit merge authorization, leave the PR as a Draft.
- When the user explicitly requests cleanup, agents may delete this task's local and remote branches and its worktree after confirming that the PR is merged, every task commit is integrated into the remote default branch, and the worktree has no uncommitted, untracked, or needed ignored files. Do not force removal or delete another task's branch, worktree, or the user's primary checkout.
- An explicit request such as "merge, clean up, and finish" authorizes both the merge and this task's post-merge branch/worktree cleanup; do not ask again for those actions once the checks above pass.
- Agents must never close PRs without merging, force-push, or rewrite history.
- Before merging, inspect and report any production effects of existing merge-triggered workflows. An explicitly authorized merge may trigger those existing workflows, including automatic deployment. Additional manual deployment, publishing, releases, image pushes, production configuration changes, or production-secret access still require a separate explicit user request.

## Environment Variables and Connection Info

This is a public repository. Never commit secret values, and never commit the real
deployment domain or host — use placeholders in tracked files.

**Where values live**

| Location | Holds | Notes |
|---|---|---|
| `.env.secrets` (repo root) | Local/deploy credentials: `OCI_HOST`, `OCI_USER`, `OCI_SSH_KEY_FILE`, `PROXY_DOMAIN`, `PROXY_API_KEY` | Gitignored. This is the local source of truth. |
| `.env.secrets.example` | Same keys, no values | Committed template. Copy to `.env.secrets` and fill in. |
| `/opt/unified-proxy/.env` on the server | Runtime config the proxy actually reads: `PROXY_API_KEY`, `PORT`, `HOST`, `PROXY_AUTH_FILE`, and the rest | Not in this repo. Server-side source of truth. |
| GitHub Actions secrets | `OCI_HOST`, `OCI_USER`, `OCI_SSH_KEY_FILE`, `PROXY_DOMAIN`, `PROXY_API_KEY` | Synced from `.env.secrets` by `./scripts/push-secrets.sh`. |

`PROXY_API_KEY` must match in `.env.secrets`, `/opt/unified-proxy/.env`, and the GitHub
secret. `./scripts/rotate-proxy-key.sh` rotates all three together — use it instead of
editing one by hand.

**Client connection info**

- Base URL: `https://$PROXY_DOMAIN/v1` (OpenAI-compatible)
- API key: the `PROXY_API_KEY` value

Client config examples (Python `openai` SDK, Cursor/VS Code, Opencode) are in
`README.md` → "Using with AI Clients". The concrete domain is only in `.env.secrets`.

**Variables that matter**

Server runtime (`server.js`), full table in `README.md` → "Configuration":

| Variable | Default | Purpose |
|---|---|---|
| `PROXY_API_KEY` | _(none)_ | Auth for all non-health endpoints. **If unset, auth is disabled.** |
| `PORT` | `3456` | Listen port. |
| `HOST` | `127.0.0.1` | Listen address. |
| `PROXY_AUTH_FILE` | `~/.unified-proxy/auth.json` | OAuth token storage. |
| `CLAUDE_ACCESS_TOKEN` / `OPENAI_ACCESS_TOKEN` | _(none)_ | Fallback upstream tokens when `auth.json` has none. |
| `OPENAI_ACCOUNT_ID` | _(none)_ | ChatGPT account ID; optional. |
| `LOG_ALL_REQUESTS` | _(unset)_ | `1` logs every request, not just failures. |
| `ALERT_WEBHOOK_URL` | _(none)_ | POSTs token-refresh failure/recovery alerts. |
| `CODEX_CLI_VERSION` | `0.150.0` | Version reported to the ChatGPT backend; gates served models. |

Local test overrides: `BASE_URL` and `PROXY_API_KEY`. `./scripts/smoke.sh` reads both
from `.env.secrets` automatically, so `npm run smoke` needs no extra env.

**Auth behavior**

`PROXY_API_KEY` is compared against the `Authorization: Bearer <key>` header. Auth is
skipped for `/health` and `/`, and is entirely disabled when `PROXY_API_KEY` is unset
(which is why local development needs no key).

## Validation

- Run `npm test` for the repository's side-effect-free unit test suite.
- `npm run test:integration` starts an integration server and can exercise configured provider credentials; use it only when the task requires integration coverage.
- `npm run smoke` performs live inference against configured upstream services and is not routine PR validation.
- `.github/workflows/deploy.yml` deploys on pushes to `main`; agents must not trigger it by pushing directly to `main`.
