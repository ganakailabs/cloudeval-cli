#!/usr/bin/env bash
set -euo pipefail

INSTALLER_URL="https://github.com/ganakailabs/cloudeval-cli/raw/main/scripts/install.sh?cacheBust=$(date +%s)"
tmp="$(mktemp)"

cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

curl -fsSL "$INSTALLER_URL" -o "$tmp"
bash "$tmp" "$@"
