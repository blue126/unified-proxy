#!/usr/bin/env bash
# Install the supplemental WorkBuddy refresh timer; credentials stay private.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
test "$task_root" = /opt/unified-proxy \
  || { echo 'Install this timer only from /opt/unified-proxy.' >&2; exit 1; }
test -f "$task_root/.cli-proxy-active"
sudo install -o root -g root -m 644 "$task_root"/systemd/unified-proxy-workbuddy-refresh.service /etc/systemd/system/
sudo install -o root -g root -m 644 "$task_root"/systemd/unified-proxy-workbuddy-refresh.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unified-proxy-workbuddy-refresh.timer
sudo systemctl start unified-proxy-workbuddy-refresh.service
