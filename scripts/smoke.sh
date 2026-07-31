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

# 2. Resolve models to test from the live catalog.
#    Never hardcode slugs here: OpenAI retires them without notice, and a stale
#    slug makes this script fail in a way that looks like a broken deploy.
#    Override with SMOKE_ANTHROPIC_MODEL / SMOKE_OPENAI_MODEL to pin one.
MODELS_JSON=$(curl -s -H "Authorization: Bearer $KEY" "${BASE_URL}/v1/models")

pick_model() {  # $1 = owned_by
  echo "$MODELS_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)['data']
except Exception:
    sys.exit(0)
# codex-auto-review is an internal review model, not a chat model.
ids = [m['id'] for m in data
       if m.get('owned_by') == '$1' and m['id'] != 'codex-auto-review']
print(ids[0] if ids else '')
" 2>/dev/null || echo ""
}

ANTHROPIC_MODEL="${SMOKE_ANTHROPIC_MODEL:-$(pick_model anthropic)}"
OPENAI_MODEL="${SMOKE_OPENAI_MODEL:-$(pick_model openai)}"

if [ -z "$ANTHROPIC_MODEL" ] || [ -z "$OPENAI_MODEL" ]; then
  echo ""
  fail "could not resolve models from /v1/models (anthropic='$ANTHROPIC_MODEL', openai='$OPENAI_MODEL')"
  echo ""
  echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
  exit 1
fi

# 3. Anthropic — real inference
echo ""
echo "2. Anthropic (${ANTHROPIC_MODEL})"
CLAUDE_RESP=$(api_post "/v1/chat/completions" "{
  \"model\": \"${ANTHROPIC_MODEL}\",
  \"messages\": [{\"role\": \"user\", \"content\": \"Reply with exactly the word: pong\"}],
  \"max_tokens\": 10
}")
CLAUDE_CONTENT=$(echo "$CLAUDE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "")
if [ -n "$CLAUDE_CONTENT" ]; then
  pass "${ANTHROPIC_MODEL} → \"$CLAUDE_CONTENT\""
else
  ERROR=$(echo "$CLAUDE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',{}).get('message','unknown'))" 2>/dev/null || echo "parse error")
  fail "${ANTHROPIC_MODEL} → error: $ERROR"
fi

# 4. OpenAI — real inference
echo ""
echo "3. OpenAI (${OPENAI_MODEL})"
OPENAI_RESP=$(api_post "/v1/chat/completions" "{
  \"model\": \"${OPENAI_MODEL}\",
  \"messages\": [
    {\"role\": \"system\", \"content\": \"You are a helpful assistant.\"},
    {\"role\": \"user\", \"content\": \"Reply with exactly the word: pong\"}
  ]
}")
OPENAI_CONTENT=$(echo "$OPENAI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "")
if [ -n "$OPENAI_CONTENT" ]; then
  pass "${OPENAI_MODEL} → \"$OPENAI_CONTENT\""
else
  ERROR=$(echo "$OPENAI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',{}).get('message','unknown'))" 2>/dev/null || echo "parse error")
  fail "${OPENAI_MODEL} → error: $ERROR"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ]
