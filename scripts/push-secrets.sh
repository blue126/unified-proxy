#!/usr/bin/env bash
# 将 .env.secrets 中的值同步到 GitHub Actions secrets
# 用法：./scripts/push-secrets.sh

set -euo pipefail

SECRETS_FILE="$(dirname "$0")/../.env.secrets"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Error: .env.secrets not found."
  echo "Copy .env.secrets.example to .env.secrets and fill in the values first."
  exit 1
fi

# Load variables from .env.secrets (ignore comments and blank lines)
set -o allexport
# shellcheck disable=SC1090
source <(grep -v '^\s*#' "$SECRETS_FILE" | grep -v '^\s*$' | sed 's/ *#.*//')
set +o allexport

echo "Pushing secrets to GitHub..."

# OCI_SSH_KEY: read from file path, not the path itself
if [ -z "${OCI_SSH_KEY_FILE:-}" ]; then
  echo "Error: OCI_SSH_KEY_FILE is not set in .env.secrets"
  exit 1
fi
SSH_KEY_FILE="${OCI_SSH_KEY_FILE/#\~/$HOME}"
if [ ! -f "$SSH_KEY_FILE" ]; then
  echo "Error: SSH key file not found: $SSH_KEY_FILE"
  exit 1
fi

gh secret set OCI_HOST      --body "$OCI_HOST"
gh secret set OCI_USER      --body "$OCI_USER"
gh secret set OCI_SSH_KEY   < "$SSH_KEY_FILE"
gh secret set PROXY_DOMAIN  --body "$PROXY_DOMAIN"
gh secret set PROXY_API_KEY --body "$PROXY_API_KEY"

echo "Done. All 5 secrets pushed to GitHub."
echo ""
echo "Verify at: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/settings/secrets/actions"
