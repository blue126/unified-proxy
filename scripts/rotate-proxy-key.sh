#!/usr/bin/env bash
# 轮换 PROXY_API_KEY：同步更新服务器 .env、本地 .env.secrets、GitHub secret
# 用法：./scripts/rotate-proxy-key.sh

set -euo pipefail

SECRETS_FILE="$(dirname "$0")/../.env.secrets"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Error: .env.secrets not found. Run cp .env.secrets.example .env.secrets first."
  exit 1
fi

# Load current values from .env.secrets
set -o allexport
# shellcheck disable=SC1090
source <(grep -v '^\s*#' "$SECRETS_FILE" | grep -v '^\s*$' | sed 's/ *#.*//')
set +o allexport

for var in OCI_HOST OCI_USER OCI_SSH_KEY_FILE; do
  [ -n "${!var:-}" ] || { echo "Error: $var is not set in .env.secrets"; exit 1; }
done

SSH_KEY_FILE="${OCI_SSH_KEY_FILE/#\~/$HOME}"
[ -f "$SSH_KEY_FILE" ] || { echo "Error: SSH key file not found: $SSH_KEY_FILE"; exit 1; }

# Generate new key
NEW_KEY=$(openssl rand -hex 32)
echo "Generated new PROXY_API_KEY: ${NEW_KEY:0:8}...${NEW_KEY: -4} (truncated for display)"

# --- 1. Update server ---
echo ""
echo "[1/3] Updating server /opt/unified-proxy/.env and restarting service..."
ssh -i "$SSH_KEY_FILE" -o StrictHostKeyChecking=no "${OCI_USER}@${OCI_HOST}" bash <<EOF
  set -e
  sudo sed -i "s/^PROXY_API_KEY=.*/PROXY_API_KEY=${NEW_KEY}/" /opt/unified-proxy/.env
  sudo systemctl restart unified-proxy
  sleep 2
  sudo systemctl is-active --quiet unified-proxy && echo "Service restarted OK" || { echo "ERROR: service failed"; sudo journalctl -u unified-proxy -n 20 --no-pager; exit 1; }
  sudo grep -q "PROXY_API_KEY=${NEW_KEY}" /opt/unified-proxy/.env && echo "Key verified in .env" || { echo "ERROR: key not updated in .env"; exit 1; }
EOF

# --- 2. Update local .env.secrets ---
echo ""
echo "[2/3] Updating local .env.secrets..."
# Replace or append PROXY_API_KEY line
if grep -q "^PROXY_API_KEY=" "$SECRETS_FILE"; then
  sed -i.bak "s/^PROXY_API_KEY=.*/PROXY_API_KEY=${NEW_KEY}/" "$SECRETS_FILE"
  rm -f "${SECRETS_FILE}.bak"
else
  echo "PROXY_API_KEY=${NEW_KEY}" >> "$SECRETS_FILE"
fi
echo "Local .env.secrets updated"

# --- 3. Update GitHub secret ---
echo ""
echo "[3/3] Pushing new PROXY_API_KEY to GitHub secret..."
gh secret set PROXY_API_KEY --body "$NEW_KEY"
echo "GitHub secret updated"

echo ""
echo "Rotation complete. All three locations are in sync:"
echo "  - Server:          /opt/unified-proxy/.env"
echo "  - Local:           .env.secrets"
echo "  - GitHub secret:   PROXY_API_KEY"
echo ""
echo "Update any clients using the old key."
