#!/usr/bin/env bash
# Live smoke test for the currently deployed runtime.
#
# Usage:
#   ./scripts/smoke.sh                        # reads BASE_URL + KEY from .env.secrets
#   BASE_URL=https://... PROXY_API_KEY=... ./scripts/smoke.sh   # override via env
#
# LiteLLM verifies ChatGPT subscription inference. The Node path keeps its
# two-provider behavior until the one-time cutover.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_FILE="$(cd "${SCRIPT_DIR}/.." && pwd)/.env.secrets"

# ── Resolve BASE_URL and KEY ──────────────────────────────────────────────────

get_secret() {
  grep "^${1}=" "$SECRETS_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/#.*//' | sed 's/[[:space:]]*$//'
}

BASE_URL="${BASE_URL:-}"
PROXY_API_KEY="${PROXY_API_KEY:-}"

if [ -z "$BASE_URL" ] && [ -f "$SECRETS_FILE" ]; then
  DOMAIN=$(get_secret PROXY_DOMAIN)
  [ -n "$DOMAIN" ] && BASE_URL="https://${DOMAIN}"
fi

if [ -z "$PROXY_API_KEY" ] && [ -f "$SECRETS_FILE" ]; then
  PROXY_API_KEY="$(get_secret PROXY_API_KEY)"
fi

export BASE_URL PROXY_API_KEY
if curl --fail --silent --max-time 10 "${BASE_URL%/}/health/readiness" >/dev/null 2>&1; then
  exec python3 "${SCRIPT_DIR}/litellm-smoke.py"
fi
exec python3 "${SCRIPT_DIR}/smoke.py"
