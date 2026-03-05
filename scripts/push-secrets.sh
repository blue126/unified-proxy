#!/usr/bin/env bash
# Sync .env.secrets to GitHub Actions secrets
# Usage: ./scripts/push-secrets.sh

set -euo pipefail

SECRETS_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.secrets"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Error: .env.secrets not found."
  echo "Copy .env.secrets.example to .env.secrets and fill in the values first."
  exit 1
fi

# Read a value from .env.secrets by key name
get_val() {
  grep "^${1}=" "$SECRETS_FILE" | head -1 | cut -d= -f2- | sed 's/#.*//' | sed 's/[[:space:]]*$//'
}

OCI_HOST=$(get_val OCI_HOST)
OCI_USER=$(get_val OCI_USER)
OCI_SSH_KEY_FILE=$(get_val OCI_SSH_KEY_FILE)
PROXY_DOMAIN=$(get_val PROXY_DOMAIN)
PROXY_API_KEY=$(get_val PROXY_API_KEY)

for var in OCI_HOST OCI_USER OCI_SSH_KEY_FILE PROXY_DOMAIN PROXY_API_KEY; do
  [ -n "${!var}" ] || { echo "Error: $var is not set in .env.secrets"; exit 1; }
done

# Expand leading tilde in the key file path
SSH_KEY_FILE="${OCI_SSH_KEY_FILE/#\~/$HOME}"
if [ ! -f "$SSH_KEY_FILE" ]; then
  echo "Error: SSH key file not found: $SSH_KEY_FILE"
  exit 1
fi

echo "Pushing secrets to GitHub..."

gh secret set OCI_HOST      --body "$OCI_HOST"
gh secret set OCI_USER      --body "$OCI_USER"
gh secret set OCI_SSH_KEY   < "$SSH_KEY_FILE"
gh secret set PROXY_DOMAIN  --body "$PROXY_DOMAIN"
gh secret set PROXY_API_KEY --body "$PROXY_API_KEY"

echo "Done. All 5 secrets pushed to GitHub."
echo ""
echo "Verify at: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/settings/secrets/actions"
