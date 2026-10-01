#!/usr/bin/env bash
# Sent over SSH by server-maintenance.yml. Never print .env or auth.json.
set -euo pipefail

export PROXY_AUTH_FILE=/opt/unified-proxy/auth.json
export CLAUDE_LOGIN_STATE_FILE=/opt/unified-proxy/.maintenance/claude-login.json
AUTH_SCRIPT=/opt/unified-proxy/.maintenance/claude-headless-auth.mjs

case "${1:-}" in
  diagnose)
    sudo systemctl is-active unified-proxy || true
    curl --fail --silent --show-error --max-time 15 http://127.0.0.1:3456/health
    ;;
  claude-login-start)
    node "$AUTH_SCRIPT" start
    ;;
  claude-login-complete)
    # Stop the refresh writer briefly, and restore service even if exchange fails.
    # Do not stop a service that was inactive before this operation.
    sudo systemctl is-active --quiet unified-proxy
    trap 'sudo systemctl start unified-proxy' EXIT
    sudo systemctl stop unified-proxy
    node "$AUTH_SCRIPT" complete
    sudo systemctl start unified-proxy
    trap - EXIT
    for attempt in {1..15}; do
      if curl --fail --silent --max-time 3 http://127.0.0.1:3456/health; then
        exit 0
      fi
      sleep 1
    done
    echo 'Service did not become ready after restart.' >&2
    exit 1
    ;;
  *) echo 'Unknown maintenance operation.' >&2; exit 1 ;;
esac
