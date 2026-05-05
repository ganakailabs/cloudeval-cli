#!/usr/bin/env bash
set -euo pipefail

REPO="${CLOUDEVAL_SMOKE_REPO:-ganakailabs/cloudeval-cli}"
VERSION="${1:-${CLOUDEVAL_SMOKE_VERSION:-latest}}"
BASE_URL="${CLOUDEVAL_SMOKE_BASE_URL:-https://cloudeval.ai/api/proxy/v1}"
HEALTH_URL="${CLOUDEVAL_SMOKE_HEALTH_URL:-https://cloudeval.ai/api/proxy/v1/health}"
INSTALLER_URL="${CLOUDEVAL_SMOKE_INSTALLER_URL:-https://cli.cloudeval.ai/install.sh}"
KEEP_DIR="${CLOUDEVAL_SMOKE_KEEP_DIR:-0}"

TMP_DIR="$(mktemp -d)"
INSTALL_HOME="$TMP_DIR/home"
CLI_BIN=""

cleanup() {
  if [ "$KEEP_DIR" != "1" ]; then
    rm -rf "$TMP_DIR"
  else
    echo "Keeping smoke directory: $TMP_DIR"
  fi
}
trap cleanup EXIT

log() {
  printf '\n==> %s\n' "$*"
}

pass() {
  printf 'ok - %s\n' "$*"
}

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

json_query() {
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'PY'
import json
import sys

path, expr = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

value = data
for part in expr.split("."):
    if part == "":
        continue
    if part == "length":
        value = len(value)
    elif isinstance(value, list):
        value = value[int(part)]
    else:
        value = value[part]

if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

assert_json_value() {
  local file="$1"
  local expr="$2"
  local expected="$3"
  local actual
  actual="$(json_query "$file" "$expr")"
  if [ "$actual" != "$expected" ]; then
    fail "$file expected $expr=$expected, got $actual"
  fi
}

assert_json_number_ge() {
  local file="$1"
  local expr="$2"
  local minimum="$3"
  local actual
  actual="$(json_query "$file" "$expr")"
  python3 - "$actual" "$minimum" <<'PY' || fail "$file expected $expr >= $minimum, got $actual"
import sys
actual = float(sys.argv[1])
minimum = float(sys.argv[2])
raise SystemExit(0 if actual >= minimum else 1)
PY
}

resolve_release_version() {
  if [ "$VERSION" != "latest" ]; then
    printf '%s\n' "$VERSION"
    return 0
  fi

  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"])'
}

run_json_ok() {
  local name="$1"
  shift
  local output="$TMP_DIR/${name}.json"
  "$CLI_BIN" "$@" --format json >"$output"
  python3 -m json.tool "$output" >/dev/null
  assert_json_value "$output" "ok" "true"
  pass "$name returned JSON success"
}

run_json_expected_error() {
  local name="$1"
  shift
  local output="$TMP_DIR/${name}.json"
  local exit_code

  set +e
  "$CLI_BIN" "$@" --format json >"$output" 2>"$TMP_DIR/${name}.stderr"
  exit_code=$?
  set -e

  if [ "$exit_code" -eq 0 ]; then
    fail "$name was expected to fail but exited 0"
  fi
  if [ -s "$TMP_DIR/${name}.stderr" ]; then
    fail "$name wrote to stderr despite JSON output: $(cat "$TMP_DIR/${name}.stderr")"
  fi

  python3 -m json.tool "$output" >/dev/null
  assert_json_value "$output" "ok" "false"
  pass "$name returned JSON error envelope"
}

need curl
need python3
need awk

RESOLVED_VERSION="$(resolve_release_version)"

log "Installing CloudEval CLI through the public installer"
printf 'repo=%s\nrequested_version=%s\nresolved_version=%s\ninstaller_url=%s\ninstall_home=%s\nbase_url=%s\n' \
  "$REPO" "$VERSION" "$RESOLVED_VERSION" "$INSTALLER_URL" "$INSTALL_HOME" "$BASE_URL"

mkdir -p "$INSTALL_HOME"
curl -fsSL "$INSTALLER_URL" \
  | env \
      HOME="$INSTALL_HOME" \
      CI=true \
      CLOUDEVAL_ASSUME_YES=1 \
      bash -s -- "$VERSION" \
  2>&1 | tee "$TMP_DIR/install.log"

CLI_BIN="$INSTALL_HOME/.local/bin/cloudeval"
YOGA_WASM="$INSTALL_HOME/.local/bin/yoga.wasm"

[ -x "$CLI_BIN" ] || fail "installer did not create executable $CLI_BIN"
[ -r "$YOGA_WASM" ] || fail "installer did not install $YOGA_WASM"
pass "installer created cloudeval executable and yoga.wasm"

SMOKE_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$SMOKE_OS" in
  msys*|mingw*|cygwin*) ;;
  *)
    [ -e "$INSTALL_HOME/.local/bin/eva" ] || fail "installer did not create eva alias"
    pass "installer created eva alias"
    ;;
esac

PATH="$INSTALL_HOME/.local/bin:$PATH"
if [ "$(command -v cloudeval)" != "$CLI_BIN" ]; then
  fail "installed cloudeval is not first on PATH"
fi
pass "installed cloudeval resolves from PATH"

log "Running installed CLI smoke checks"
VERSION_OUTPUT="$("$CLI_BIN" --version)"
EXPECTED_VERSION="${RESOLVED_VERSION#v}"
if [ "$VERSION_OUTPUT" != "$EXPECTED_VERSION" ]; then
  fail "version mismatch: expected $EXPECTED_VERSION, got $VERSION_OUTPUT"
fi
pass "version is $VERSION_OUTPUT"

"$CLI_BIN" --help >"$TMP_DIR/help.txt"
grep -q "Commands:" "$TMP_DIR/help.txt" || fail "help output missing command list"
pass "help renders"

run_json_ok "status" status --base-url "$BASE_URL"
run_json_ok "capabilities" capabilities
run_json_ok "models-list" models list --base-url "$BASE_URL"
assert_json_number_ge "$TMP_DIR/models-list.json" "data.models.length" "1"

run_json_expected_error "billing-plans-unauthenticated" \
  billing plans --base-url "$BASE_URL" --non-interactive

if [ -n "$HEALTH_URL" ]; then
  log "Checking backend FQDN reachability"
  HEALTH_STATUS="$(curl -sS -w '%{http_code}' -o "$TMP_DIR/health.json" "$HEALTH_URL")"
  python3 -m json.tool "$TMP_DIR/health.json" >/dev/null
  if [ "$HEALTH_STATUS" = "200" ]; then
    assert_json_value "$TMP_DIR/health.json" "status" "ok"
    pass "backend health is ok through FQDN"
  elif [ "$HEALTH_STATUS" = "401" ]; then
    HEALTH_CODE="$(json_query "$TMP_DIR/health.json" "code")"
    case "$HEALTH_CODE" in
      AUTH_REQUIRED|AUTH_REQUIRED_PUBLIC)
        pass "FQDN backend route is reachable and protected as expected"
        ;;
      *)
        fail "unexpected FQDN health auth code: $HEALTH_CODE"
        ;;
    esac
  else
    fail "unexpected FQDN health HTTP status: $HEALTH_STATUS"
  fi
fi

if [ -n "${CLOUDEVAL_SMOKE_API_KEY:-}" ]; then
  log "Running optional authenticated smoke checks"
  printf '%s' "$CLOUDEVAL_SMOKE_API_KEY" \
    | "$CLI_BIN" credits --base-url "$BASE_URL" --api-key-stdin --non-interactive --format json \
    >"$TMP_DIR/credits-authenticated.json"
  python3 -m json.tool "$TMP_DIR/credits-authenticated.json" >/dev/null
  assert_json_value "$TMP_DIR/credits-authenticated.json" "ok" "true"
  pass "authenticated credits returned JSON success"
fi

log "Smoke test completed"
printf 'release=%s\nbinary=%s\ninstall_home=%s\nartifacts=%s\n' "$RESOLVED_VERSION" "$CLI_BIN" "$INSTALL_HOME" "$TMP_DIR"
