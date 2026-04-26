#!/usr/bin/env bash
set -euo pipefail

INSTALLER_URL="https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/main/scripts/install.sh?ref=$(date +%s)"
tmp="$(mktemp)"

cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

curl -fsSL "$INSTALLER_URL" -o "$tmp"
bash "$tmp" "$@"
