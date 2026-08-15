#!/usr/bin/env bash
# Live smoke test — verifies both deployed upstream providers end to end.
#
# Usage:
#   ./scripts/smoke.sh                        # reads BASE_URL + KEY from .env.secrets
#   BASE_URL=https://... PROXY_API_KEY=... ./scripts/smoke.sh   # override via env
#
# Exit codes:
#   0 = both providers pass, or exactly one provider is degraded (warning)
#   1 = both providers fail, or the test itself is misconfigured

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
exec python3 "${SCRIPT_DIR}/smoke.py"
