#!/usr/bin/env bash
set -euo pipefail

SSH_KEY="${CLOUDEVAL_SIGNALSTORY_RULES_SSH_KEY:-${SIGNALSTORY_RULES_SSH_KEY:-}}"
TOKEN="${CLOUDEVAL_SIGNALSTORY_RULES_TOKEN:-${SIGNALSTORY_RULES_TOKEN:-}}"

if [ -n "$SSH_KEY" ]; then
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  printf '%s\n' "$SSH_KEY" > "$HOME/.ssh/cloudeval_signalstory_rules"
  chmod 600 "$HOME/.ssh/cloudeval_signalstory_rules"
  ssh-keyscan github.com >> "$HOME/.ssh/known_hosts"
  git config --global core.sshCommand "ssh -i $HOME/.ssh/cloudeval_signalstory_rules -o IdentitiesOnly=yes"
  git config --global url."git@github.com:ganakailabs/".insteadOf "https://PrateekKumarSingh@github.com/ganakailabs/"
  git config --global url."git@github.com:ganakailabs/".insteadOf "https://github.com/ganakailabs/"
  exit 0
fi

if [ -n "$TOKEN" ]; then
  git config --global url."https://x-access-token:${TOKEN}@github.com/ganakailabs/".insteadOf "https://PrateekKumarSingh@github.com/ganakailabs/"
  git config --global url."https://x-access-token:${TOKEN}@github.com/ganakailabs/".insteadOf "https://github.com/ganakailabs/"
  exit 0
fi

echo "::error::Missing CLOUDEVAL_SIGNALSTORY_RULES_SSH_KEY, SIGNALSTORY_RULES_SSH_KEY, CLOUDEVAL_SIGNALSTORY_RULES_TOKEN, or SIGNALSTORY_RULES_TOKEN secret for private cloudeval-signalstory-rules access."
exit 1
