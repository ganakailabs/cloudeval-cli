#!/usr/bin/env bash
set -euo pipefail

GITLEAKS_VERSION="${GITLEAKS_VERSION:-8.30.1}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cloudeval-security-scan.XXXXXX")"
GITLEAKS_BIN="${GITLEAKS_BIN:-}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

redact_findings() {
  sed -E \
    -e 's/(sk-or-v1-)[A-Za-z0-9_-]+/\1[REDACTED]/g' \
    -e 's/(sk-proj-)[A-Za-z0-9_-]+/\1[REDACTED]/g' \
    -e 's/(sk-)[A-Za-z0-9_-]{16,}/\1[REDACTED]/g' \
    -e 's/(gh[pousr]_[A-Za-z0-9_]{4})[A-Za-z0-9_]+/\1[REDACTED]/g' \
    -e 's/(api:\/\/)[0-9a-fA-F-]{36}/\1[REDACTED-UUID]/g' \
    -e 's#(login\.microsoftonline\.com/)[0-9a-fA-F-]{36}#\1[REDACTED-UUID]#g'
}

download_gitleaks() {
  command -v curl >/dev/null 2>&1 || fail "curl is required to download gitleaks"
  command -v tar >/dev/null 2>&1 || fail "tar is required to unpack gitleaks"

  local os arch asset url
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin) os="darwin" ;;
    linux) os="linux" ;;
    *) fail "unsupported OS for automatic gitleaks download: $os" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) fail "unsupported architecture for automatic gitleaks download: $arch" ;;
  esac

  asset="gitleaks_${GITLEAKS_VERSION}_${os}_${arch}.tar.gz"
  url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${asset}"
  log "Downloading temporary gitleaks ${GITLEAKS_VERSION}"
  curl -fsSL "$url" -o "$TMP_DIR/gitleaks.tar.gz"
  tar -xzf "$TMP_DIR/gitleaks.tar.gz" -C "$TMP_DIR" gitleaks
  chmod +x "$TMP_DIR/gitleaks"
  GITLEAKS_BIN="$TMP_DIR/gitleaks"
}

resolve_gitleaks() {
  if [ -n "$GITLEAKS_BIN" ]; then
    [ -x "$GITLEAKS_BIN" ] || fail "GITLEAKS_BIN is not executable: $GITLEAKS_BIN"
    return
  fi
  if command -v gitleaks >/dev/null 2>&1; then
    GITLEAKS_BIN="$(command -v gitleaks)"
    return
  fi
  download_gitleaks
}

copy_candidate_tree() {
  local destination="$1"
  mkdir -p "$destination"
  git ls-files --cached --modified --others --exclude-standard -z | while IFS= read -r -d '' file; do
    [ -f "$file" ] || continue
    mkdir -p "$destination/$(dirname "$file")"
    cp "$file" "$destination/$file"
  done
}

run_targeted_current_scan() {
  local source_dir="$1"
  local output="$TMP_DIR/targeted-current.txt"
  local pattern
  pattern='(sk-or-v1-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|api://[0-9a-fA-F-]{36}/(access_as_user|\.default)|login\.microsoftonline\.com/[0-9a-fA-F-]{36}|CLOUDEVAL_BACKEND_(CLIENT|TENANT)_ID|AZURE_(CLIENT|TENANT)_ID|DEFAULT_BACKEND_(CLIENT|TENANT)_ID)'

  set +e
  grep -R -n -I -E "$pattern" "$source_dir" >"$output"
  local exit_code=$?
  set -e
  if [ "$exit_code" -eq 0 ]; then
    redact_findings <"$output" >&2
    fail "targeted current-tree scan found sensitive patterns"
  fi
  [ "$exit_code" -eq 1 ] || fail "targeted current-tree scan failed"
}

run_targeted_history_scan() {
  local output="$TMP_DIR/targeted-history.txt"
  local pattern
  pattern='(sk-or-v1-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|api://[0-9a-fA-F-]{36}/(access_as_user|\.default)|login\.microsoftonline\.com/[0-9a-fA-F-]{36})'
  : >"$output"

  while IFS= read -r rev; do
    git grep -n -I -E "$pattern" "$rev" -- . >>"$output" || true
  done < <(git rev-list --all)

  if [ -s "$output" ]; then
    redact_findings <"$output" >&2
    fail "targeted full-history scan found sensitive patterns"
  fi
}

resolve_gitleaks
"$GITLEAKS_BIN" version

log "Gitleaks full-history scan"
"$GITLEAKS_BIN" git --redact=100 --no-banner --no-color --log-opts="--all"

TRACKED_TREE="$TMP_DIR/current-tree"
copy_candidate_tree "$TRACKED_TREE"
log "Gitleaks current tracked/untracked candidate scan"
"$GITLEAKS_BIN" dir --redact=100 --no-banner --no-color "$TRACKED_TREE"

log "Targeted current-tree regex scan"
run_targeted_current_scan "$TRACKED_TREE"

log "Targeted full-history regex scan"
run_targeted_history_scan

log "Security scan completed"
