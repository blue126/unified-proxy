#!/usr/bin/env bash
# Integration smoke test for unified-proxy
#
# Usage:
#   ./test.sh                          # local server (no auth)
#   PROXY_API_KEY=xxx ./test.sh        # local server with auth
#   BASE_URL=https://proxy.example.com PROXY_API_KEY=xxx ./test.sh  # remote server
#
# Exit codes: 0 = all checks passed, 1 = one or more checks failed

set -uo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3456}"
KEY="${PROXY_API_KEY:-}"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

# Return HTTP status code (never fails even on 4xx/5xx)
http_status() {
  if [ -n "$KEY" ]; then
    curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $KEY" "$@"
  else
    curl -s -o /dev/null -w "%{http_code}" "$@"
  fi
}

# Return response body (never fails)
http_body() {
  if [ -n "$KEY" ]; then
    curl -s -H "Authorization: Bearer $KEY" "$@" || echo "{}"
  else
    curl -s "$@" || echo "{}"
  fi
}

echo "=== Unified Proxy Integration Tests ==="
echo "  Target: ${BASE_URL}"
echo ""

# ── 1. Health check (public) ──────────────────────────────────────────────────
echo "1. Health check"
S=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health")
if [ "$S" = "200" ]; then pass "GET /health → 200"; else fail "GET /health → $S (want 200)"; fi

MODE=$(curl -s "${BASE_URL}/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('mode',''))" 2>/dev/null || echo "")
if [ "$MODE" = "unified-proxy" ]; then pass "mode=unified-proxy"; else fail "mode field: got '$MODE'"; fi

# ── 2. Auth (only when KEY is set) ───────────────────────────────────────────
if [ -n "$KEY" ]; then
  echo ""
  echo "2. Authentication"
  S=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/models")
  if [ "$S" = "401" ]; then pass "GET /v1/models no key → 401"; else fail "GET /v1/models no key → $S (want 401)"; fi

  S=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong-key" "${BASE_URL}/v1/models")
  if [ "$S" = "401" ]; then pass "GET /v1/models wrong key → 401"; else fail "GET /v1/models wrong key → $S (want 401)"; fi

  S=$(http_status "${BASE_URL}/v1/models")
  if [ "$S" = "200" ]; then pass "GET /v1/models correct key → 200"; else fail "GET /v1/models correct key → $S (want 200)"; fi
fi

# ── 3. Models list ────────────────────────────────────────────────────────────
echo ""
echo "3. Models list"
MODELS=$(http_body "${BASE_URL}/v1/models")
OBJECT=$(echo "$MODELS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('object',''))" 2>/dev/null || echo "")
if [ "$OBJECT" = "list" ]; then pass "object=list"; else fail "object field: got '$OBJECT'"; fi

HAS_CLAUDE=$(echo "$MODELS" | python3 -c "import sys,json; ids=[m['id'] for m in json.load(sys.stdin).get('data',[])]; print('yes' if any(i.startswith('claude-') for i in ids) else 'no')" 2>/dev/null || echo "no")
if [ "$HAS_CLAUDE" = "yes" ]; then pass "includes claude- models"; else fail "no claude- models found"; fi

HAS_OPENAI=$(echo "$MODELS" | python3 -c "import sys,json; ids=[m['id'] for m in json.load(sys.stdin).get('data',[])]; print('yes' if any(i.startswith('gpt-') or i.startswith('o3') or i.startswith('o4') for i in ids) else 'no')" 2>/dev/null || echo "no")
if [ "$HAS_OPENAI" = "yes" ]; then pass "includes gpt-/o3/o4 models"; else fail "no gpt-/o3/o4 models found"; fi

# ── 4. Chat completions ───────────────────────────────────────────────────────
echo ""
echo "4. Chat completions"

# Validation: missing messages → 400
S=$(http_status "${BASE_URL}/v1/chat/completions" -H "Content-Type: application/json" -d '{}')
if [ "$S" = "400" ]; then pass "missing messages → 400"; else fail "missing messages → $S (want 400)"; fi

# Routing: claude model (auth+validation pass, not 401/400)
S=$(http_status "${BASE_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"Reply with just: ok"}]}')
if [ "$S" = "401" ] || [ "$S" = "400" ]; then
  fail "claude-haiku-4-5 → $S (auth or validation failed)"
else
  pass "claude-haiku-4-5 routes to Anthropic (status $S)"
fi

# ── 5. 404 ────────────────────────────────────────────────────────────────────
echo ""
echo "5. 404"
S=$(http_status "${BASE_URL}/nonexistent")
if [ "$S" = "404" ]; then pass "unknown path → 404"; else fail "unknown path → $S (want 404)"; fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ]
