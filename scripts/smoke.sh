#!/usr/bin/env bash
# Live smoke test — verifies the deployed proxy can actually call upstream models.
#
# Usage:
#   ./scripts/smoke.sh                        # reads BASE_URL + KEY from .env.secrets
#   BASE_URL=https://... PROXY_API_KEY=... ./scripts/smoke.sh   # override via env
#
# Exit codes: 0 = all pass, 1 = one or more failed

set -uo pipefail

SECRETS_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.secrets"

# ── Resolve BASE_URL and KEY ──────────────────────────────────────────────────

get_secret() {
  grep "^${1}=" "$SECRETS_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/#.*//' | sed 's/[[:space:]]*$//'
}

BASE_URL="${BASE_URL:-}"
KEY="${PROXY_API_KEY:-}"

if [ -z "$BASE_URL" ] && [ -f "$SECRETS_FILE" ]; then
  DOMAIN=$(get_secret PROXY_DOMAIN)
  [ -n "$DOMAIN" ] && BASE_URL="https://${DOMAIN}"
fi

if [ -z "$KEY" ] && [ -f "$SECRETS_FILE" ]; then
  KEY=$(get_secret PROXY_API_KEY)
fi

if [ -z "$BASE_URL" ] || [ -z "$KEY" ]; then
  echo "Error: BASE_URL and PROXY_API_KEY are required."
  echo "Either set them as env vars or fill in .env.secrets."
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

api_post() {
  curl -s \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "$2" \
    "${BASE_URL}$1"
}

# ── Tests ─────────────────────────────────────────────────────────────────────

echo "=== Unified Proxy Smoke Test ==="
echo "  Target: ${BASE_URL}"
echo ""

# 1. Health
echo "1. Health"
HEALTH=$(curl -s "${BASE_URL}/health")
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
[ "$STATUS" = "ok" ] && pass "GET /health → ok" || fail "GET /health → status='$STATUS' (want ok)"

ANTHROPIC_H=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['providers']['anthropic']['status'])" 2>/dev/null || echo "")
[ "$ANTHROPIC_H" = "valid" ] && pass "anthropic token valid" || fail "anthropic token: '$ANTHROPIC_H' (want valid)"

OPENAI_H=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['providers']['openai']['status'])" 2>/dev/null || echo "")
[ "$OPENAI_H" = "valid" ] && pass "openai token valid" || fail "openai token: '$OPENAI_H' (want valid)"

# 2. Anthropic — real inference
echo ""
echo "2. Anthropic (claude-sonnet-4-6)"
CLAUDE_RESP=$(api_post "/v1/chat/completions" '{
  "model": "claude-sonnet-4-6",
  "messages": [{"role": "user", "content": "Reply with exactly the word: pong"}],
  "max_tokens": 10
}')
CLAUDE_CONTENT=$(echo "$CLAUDE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "")
if [ -n "$CLAUDE_CONTENT" ]; then
  pass "claude-sonnet-4-6 → \"$CLAUDE_CONTENT\""
else
  ERROR=$(echo "$CLAUDE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',{}).get('message','unknown'))" 2>/dev/null || echo "parse error")
  fail "claude-sonnet-4-6 → error: $ERROR"
fi

# 3. OpenAI — real inference
echo ""
echo "3. OpenAI (gpt-5.2)"
OPENAI_RESP=$(api_post "/v1/chat/completions" '{
  "model": "gpt-5.2",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Reply with exactly the word: pong"}
  ]
}')
OPENAI_CONTENT=$(echo "$OPENAI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "")
if [ -n "$OPENAI_CONTENT" ]; then
  pass "gpt-5.2 → \"$OPENAI_CONTENT\""
else
  ERROR=$(echo "$OPENAI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',{}).get('message','unknown'))" 2>/dev/null || echo "parse error")
  fail "gpt-5.2 → error: $ERROR"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ]
