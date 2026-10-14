#!/usr/bin/env bash
# Live smoke test for the currently deployed runtime.
#
# Usage:
#   ./scripts/smoke.sh                        # reads BASE_URL + KEY from .env.secrets
#   BASE_URL=https://... PROXY_API_KEY=... ./scripts/smoke.sh   # override via env
#
# CLIProxyAPI checks GPT, Claude, Gemini, and CodeBuddy.

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

[ -n "$BASE_URL" ] && [ -n "$PROXY_API_KEY" ] \
  || { echo 'BASE_URL and PROXY_API_KEY are required.' >&2; exit 1; }
export BASE_URL PROXY_API_KEY
exec python3 "${SCRIPT_DIR}/cli-proxy-public-smoke.py" --public
