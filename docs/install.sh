#!/usr/bin/env bash
set -euo pipefail

REF_URL="https://api.github.com/repos/ganakailabs/cloudeval-cli/git/ref/heads/main"
COMMIT_SHA="$(
  curl -fsSL "$REF_URL" \
    | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' \
    | head -n 1
)"

if [ -z "$COMMIT_SHA" ]; then
  echo "Unable to resolve the latest Cloudeval installer version." >&2
  exit 1
fi

INSTALLER_URL="https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/${COMMIT_SHA}/scripts/install.sh"
tmp="$(mktemp)"

cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

curl -fsSL "$INSTALLER_URL" -o "$tmp"
bash "$tmp" "$@"
