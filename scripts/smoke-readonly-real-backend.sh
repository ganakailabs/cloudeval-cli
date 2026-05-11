#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CLOUDEVAL_SMOKE_BASE_URL:-https://cloudeval.ai/api/proxy/v1}"
FRONTEND_URL="${CLOUDEVAL_SMOKE_FRONTEND_URL:-https://cloudeval.ai}"
CLI_BIN="${CLOUDEVAL_SMOKE_CLI_BIN:-}"
CLI_SOURCE="${CLOUDEVAL_SMOKE_CLI_SOURCE:-auto}"
RUN_ASK="${CLOUDEVAL_SMOKE_RUN_ASK:-0}"
RUN_AGENT="${CLOUDEVAL_SMOKE_RUN_AGENT:-0}"
REQUIRE_AUTH="${CLOUDEVAL_SMOKE_REQUIRE_AUTH:-0}"
STRICT_REPORTS="${CLOUDEVAL_SMOKE_STRICT_REPORTS:-0}"
SHOW_RESULTS="${CLOUDEVAL_SMOKE_SHOW_RESULTS:-1}"
RESULT_LINES="${CLOUDEVAL_SMOKE_RESULT_LINES:-6}"
COLOR_MODE="${CLOUDEVAL_SMOKE_COLOR:-auto}"
ARTIFACT_ROOT="${CLOUDEVAL_SMOKE_ARTIFACT_ROOT:-${TMPDIR:-/tmp}}"
ARTIFACT_DIR="${CLOUDEVAL_SMOKE_ARTIFACT_DIR:-}"
KEEP_DIR="${CLOUDEVAL_SMOKE_KEEP_DIR:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -n "$ARTIFACT_DIR" ]; then
  TMP_DIR="$ARTIFACT_DIR"
  mkdir -p "$TMP_DIR"
else
  TMP_DIR="$(mktemp -d "${ARTIFACT_ROOT%/}/cloudeval-readonly-smoke.XXXXXX")"
fi

PASS_COUNT=0
SKIP_COUNT=0
FAIL_COUNT=0
SUMMARY_PRINTED=0
declare -a PASSED_CHECKS=()
declare -a SKIPPED_CHECKS=()
declare -a FAILED_CHECKS=()

GREEN=""
YELLOW=""
RED=""
BOLD=""
RESET=""

cleanup() {
  if [ "$KEEP_DIR" != "1" ] && [ -z "$ARTIFACT_DIR" ]; then
    rm -rf "$TMP_DIR"
  else
    printf 'Keeping smoke directory: %s\n' "$TMP_DIR"
  fi
}
trap cleanup EXIT

init_colors() {
  case "$COLOR_MODE" in
    always)
      ;;
    never)
      return
      ;;
    auto)
      if [ -n "${NO_COLOR:-}" ]; then
        return
      fi
      [ -t 1 ] || return
      ;;
    *)
      printf 'unknown CLOUDEVAL_SMOKE_COLOR value: %s\n' "$COLOR_MODE" >&2
      exit 1
      ;;
  esac

  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  RED=$'\033[31m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
}

init_colors

log() {
  printf '\n%b=== %s ===%b\n' "$BOLD" "$*" "$RESET"
}

status_label() {
  case "$1" in
    PASS) printf '%b[PASS]%b' "$GREEN" "$RESET" ;;
    SKIP) printf '%b[SKIP]%b' "$YELLOW" "$RESET" ;;
    FAIL) printf '%b[FAIL]%b' "$RED" "$RESET" ;;
    *) printf '[%s]' "$1" ;;
  esac
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  PASSED_CHECKS+=("$*")
  status_label PASS
  printf ' %s\n' "$*"
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  SKIPPED_CHECKS+=("$*")
  status_label SKIP
  printf ' %s\n' "$*"
}

result() {
  local payload="${1:-}"
  if [ "$SHOW_RESULTS" != "1" ]; then
    return
  fi
  printf '  output:\n'
  if [ -z "$payload" ]; then
    printf '    <empty>\n'
    return
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    printf '    %s\n' "${line:-<empty>}"
  done <<<"$payload"
}

shell_quote() {
  printf '%q' "$1"
}

show_cli_command() {
  printf '  cli:\n    '
  shell_quote "$CLI"
  local arg
  for arg in "$@"; do
    printf ' \\\n      '
    shell_quote "$arg"
  done
  printf '\n'
}

print_list() {
  local title="$1"
  shift
  [ "$#" -gt 0 ] || return
  printf '  %s:\n' "$title"
  local item
  for item in "$@"; do
    printf '    - %s\n' "$item"
  done
}

print_summary() {
  [ "$SUMMARY_PRINTED" -eq 0 ] || return
  SUMMARY_PRINTED=1

  local total=$((PASS_COUNT + SKIP_COUNT + FAIL_COUNT))
  log "Final summary"
  if [ "$FAIL_COUNT" -eq 0 ]; then
    status_label PASS
    printf ' overall: passed\n'
  else
    status_label FAIL
    printf ' overall: failed\n'
  fi
  printf '  passed: %s\n' "$PASS_COUNT"
  printf '  failed: %s\n' "$FAIL_COUNT"
  printf '  skipped: %s\n' "$SKIP_COUNT"
  printf '  total: %s\n' "$total"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    print_list "failures" "${FAILED_CHECKS[@]}"
  fi
  if [ "$SKIP_COUNT" -gt 0 ]; then
    print_list "skipped" "${SKIPPED_CHECKS[@]}"
  fi
}

finish_success() {
  print_summary
  exit 0
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_CHECKS+=("$*")
  status_label FAIL
  printf ' %s\n' "$*"
  print_summary
  exit 1
}

fail_check() {
  local name="$1"
  local reason="$2"
  shift 2
  local summary_reason="${reason//$'\n'/ | }"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_CHECKS+=("$name: $summary_reason")
  status_label FAIL
  printf ' %s\n' "$name"
  if [ "$#" -gt 0 ]; then
    show_cli_command "$@"
  fi
  printf '  reason:\n'
  while IFS= read -r line || [ -n "$line" ]; do
    printf '    %s\n' "${line:-<empty>}"
  done <<<"$reason"
  print_summary
  exit 1
}

clean_stderr() {
  local file="$1"
  tr '\n' ' ' <"$file" | sed 's/[[:space:]]*$//'
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

resolve_cli_bin() {
  if [ -n "$CLI_BIN" ]; then
    [ -x "$CLI_BIN" ] || fail "CLOUDEVAL_SMOKE_CLI_BIN is not executable: $CLI_BIN"
    printf '%s\n' "$CLI_BIN"
    return
  fi

  case "$CLI_SOURCE" in
    auto|local)
      if [ -f "$REPO_ROOT/packages/cli/src/cli.tsx" ] && command -v pnpm >/dev/null 2>&1; then
        local wrapper="$TMP_DIR/cloudeval-local"
        cat >"$wrapper" <<EOF
#!/usr/bin/env bash
cd "$REPO_ROOT/packages/cli"
exec pnpm exec tsx src/cli.tsx "\$@"
EOF
        chmod +x "$wrapper"
        printf '%s\n' "$wrapper"
        return
      fi
      if [ "$CLI_SOURCE" = "local" ]; then
        fail "CLOUDEVAL_SMOKE_CLI_SOURCE=local requires packages/cli/src/cli.tsx and pnpm. Set CLOUDEVAL_SMOKE_CLI_BIN to an executable CLI instead."
      fi
      ;;
    installed)
      ;;
    *)
      fail "unknown CLOUDEVAL_SMOKE_CLI_SOURCE value: $CLI_SOURCE (expected auto, local, or installed)"
      ;;
  esac

  if command -v cloudeval >/dev/null 2>&1; then
    command -v cloudeval
    return
  fi

  if [ -x "$HOME/.local/bin/cloudeval" ]; then
    printf '%s\n' "$HOME/.local/bin/cloudeval"
    return
  fi

  fail "cloudeval is not on PATH and $HOME/.local/bin/cloudeval was not found. Set CLOUDEVAL_SMOKE_CLI_BIN."
}

json_query() {
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'PY'
import json
import sys

path, expr = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    value = json.load(handle)

for part in [part for part in expr.split(".") if part]:
    if part == "length":
        value = len(value)
    elif isinstance(value, list):
        value = value[int(part)]
    elif isinstance(value, dict):
        value = value.get(part)
    else:
        value = None

if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

first_json_value() {
  local file="$1"
  local script="$2"
  python3 - "$file" "$script" <<'PY'
import json
import sys

path, script = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

safe_builtins = {"next": next, "str": str}
print(eval(script, {"__builtins__": safe_builtins}, {"data": data}) or "")
PY
}

assert_json_file() {
  local file="$1"
  python3 -m json.tool "$file" >/dev/null
}

assert_json_ok() {
  local file="$1"
  assert_json_file "$file" || return 1
  local ok
  ok="$(json_query "$file" "ok")" || return 1
  [ "$ok" = "true" ]
}

json_summary() {
  local file="$1"
  python3 - "$file" <<'PY'
import json
import sys
import textwrap

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    data = json.load(handle)

WIDTH = 112

def clean(value):
    if value is None:
        return "<unset>"
    if isinstance(value, bool):
        return str(value).lower()
    return str(value).replace("\n", " ")

def emit(line):
    if not line:
        return
    if line.startswith(("url: ", "frontendUrl: ")):
        print(line)
        return
    for wrapped in textwrap.wrap(line, width=WIDTH, break_long_words=False, break_on_hyphens=False):
        print(wrapped)

def summarize(value):
    if isinstance(value, list):
        emit(f"items: {len(value)}")
        return
    if isinstance(value, dict):
        keys = list(value.keys())
        emitted = False
        for key in ("models", "projects", "connections", "reports", "checks"):
            child = value.get(key)
            if isinstance(child, list):
                emit(f"{key}: {len(child)}")
                emitted = True
        for key in ("source", "defaultModel", "profile", "baseUrl", "configPath", "key", "value", "model"):
            if key in value and not isinstance(value[key], (dict, list)):
                emit(f"{key}: {clean(value[key])[:160]}")
                emitted = True
        if not emitted:
            emit(f"keys: {', '.join(keys[:8]) if keys else '<none>'}")
        return
    if value is None:
        emit("value: null")
        return
    emit(f"value: {clean(value)[:160]}")

if isinstance(data, dict) and "ok" in data:
    emit(f"command: {data.get('command', 'unknown')}")
    emit(f"ok: {str(data.get('ok')).lower()}")
    frontend = data.get("frontendUrl")
    if frontend:
        emit(f"frontendUrl: {frontend}")
    summarize(data.get("data"))
else:
    summarize(data)
PY
}

text_summary() {
  local name="$1"
  local file="$2"
  python3 - "$name" "$file" "$RESULT_LINES" <<'PY'
import sys
import textwrap

name, path, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
width = 112
lines = []
with open(path, "r", encoding="utf-8", errors="replace") as handle:
    for line in handle:
        stripped = line.rstrip()
        if stripped:
            lines.append(stripped)

def emit(line):
    if not line:
        return
    for wrapped in textwrap.wrap(line, width=width, break_long_words=False, break_on_hyphens=False):
        print(wrapped)

if name == "banner":
    emit(f"rendered banner ({len(lines)} non-empty lines)")
elif name.startswith("completion-"):
    shell = name.removeprefix("completion-")
    emit(f"rendered {shell} completion ({len(lines)} non-empty lines)")
else:
    for line in lines[:limit]:
        emit(line)
PY
}

print_text_result() {
  local name="$1"
  local file="$2"
  local summary
  summary="$(text_summary "$name" "$file")"
  result "${summary:-<empty>}"
}

print_json_result() {
  local file="$1"
  result "$(json_summary "$file")"
}

run_capture() {
  local name="$1"
  shift
  local output="$TMP_DIR/${name}.out"
  local stderr="$TMP_DIR/${name}.stderr"
  set +e
  "$CLI" "$@" >"$output" 2>"$stderr"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    fail_check "$name" "exit $exit_code: $(clean_stderr "$stderr")" "$@"
  fi
  pass "$name"
  show_cli_command "$@"
  print_text_result "$name" "$output"
}

run_recipes_list() {
  local name="recipes-list"
  local output="$TMP_DIR/${name}.out"
  local stderr="$TMP_DIR/${name}.stderr"
  set +e
  "$CLI" recipes list >"$output" 2>"$stderr"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    local reason
    reason="exit $exit_code: $(clean_stderr "$stderr")"
    if grep -qi "unknown command 'recipes'" "$stderr"; then
      reason="$reason"$'\n'"selected CLI does not include the recipes command."
      reason="$reason"$'\n'"binary: $CLI"
      reason="$reason"$'\n'"cli_source: $CLI_SOURCE"
      reason="$reason"$'\n'"next: for branch testing, leave CLOUDEVAL_SMOKE_CLI_SOURCE unset or set it to local. For installed-binary testing, install a release that contains recipes."
    fi
    fail_check "$name" "$reason" recipes list
  fi
  pass "$name"
  show_cli_command recipes list
  print_text_result "$name" "$output"
}

run_text_contains() {
  local name="$1"
  local expected="$2"
  shift 2
  local output="$TMP_DIR/${name}.txt"
  local stderr="$TMP_DIR/${name}.stderr"
  set +e
  "$CLI" "$@" >"$output" 2>"$stderr"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    fail_check "$name" "exit $exit_code: $(clean_stderr "$stderr")" "$@"
  fi
  grep -q "$expected" "$output" || fail_check "$name" "stdout missing expected text: $expected" "$@"
  pass "$name"
  show_cli_command "$@"
  print_text_result "$name" "$output"
}

run_json_envelope() {
  local name="$1"
  shift
  local output="$TMP_DIR/${name}.json"
  local stderr="$TMP_DIR/${name}.stderr"
  set +e
  "$CLI" "$@" >"$output" 2>"$stderr"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    fail_check "$name" "exit $exit_code: $(clean_stderr "$stderr")" "$@"
  fi
  assert_json_ok "$output" || fail_check "$name" "expected JSON envelope with ok=true" "$@"
  pass "$name"
  show_cli_command "$@"
  print_json_result "$output"
}

run_json_plain() {
  local name="$1"
  shift
  local output="$TMP_DIR/${name}.json"
  local stderr="$TMP_DIR/${name}.stderr"
  set +e
  "$CLI" "$@" >"$output" 2>"$stderr"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    fail_check "$name" "exit $exit_code: $(clean_stderr "$stderr")" "$@"
  fi
  assert_json_file "$output" || fail_check "$name" "expected parseable JSON output" "$@"
  pass "$name"
  show_cli_command "$@"
  print_json_result "$output"
}

run_optional_json_envelope() {
  local name="$1"
  shift
  local output="$TMP_DIR/${name}.json"
  local stderr="$TMP_DIR/${name}.stderr"
  set +e
  "$CLI" "$@" >"$output" 2>"$stderr"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    if [ "$STRICT_REPORTS" = "1" ]; then
      fail_check "$name" "exit $exit_code: $(clean_stderr "$stderr")" "$@"
    fi
    skip "$name ($(clean_stderr "$stderr"))"
    show_cli_command "$@"
    return
  fi
  assert_json_file "$output" || fail_check "$name" "expected parseable JSON output" "$@"
  local ok
  ok="$(json_query "$output" "ok")"
  if [ "$ok" = "true" ] || [ -z "$ok" ]; then
    pass "$name"
    show_cli_command "$@"
    print_json_result "$output"
    return
  fi
  fail_check "$name" "returned ok=$ok" "$@"
}

run_open_url() {
  local name="$1"
  shift
  local output="$TMP_DIR/${name}.url"
  local stderr="$TMP_DIR/${name}.stderr"
  set +e
  "$CLI" "$@" --frontend-url "$FRONTEND_URL" --print-url --no-open >"$output" 2>"$stderr"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    fail_check "$name" "exit $exit_code: $(clean_stderr "$stderr")" "$@" --frontend-url "$FRONTEND_URL" --print-url --no-open
  fi
  grep -q "^${FRONTEND_URL}" "$output" || fail_check "$name" "stdout did not start with frontend URL: $FRONTEND_URL" "$@" --frontend-url "$FRONTEND_URL" --print-url --no-open
  pass "$name"
  show_cli_command "$@" --frontend-url "$FRONTEND_URL" --print-url --no-open
  print_text_result "$name" "$output"
}

require_auth_preflight() {
  if [ "$REQUIRE_AUTH" != "1" ]; then
    return 0
  fi

  local output="$TMP_DIR/auth-status-preflight.json"
  local stderr="$TMP_DIR/auth-status-preflight.stderr"
  set +e
  "$CLI" auth status --base-url "$BASE_URL" --format json >"$output" 2>"$stderr"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    fail_check "auth preflight" "exit $exit_code: $(clean_stderr "$stderr")" auth status --base-url "$BASE_URL" --format json
  fi
  assert_json_ok "$output" || fail_check "auth preflight" "expected JSON envelope with ok=true" auth status --base-url "$BASE_URL" --format json

  local authenticated
  authenticated="$(json_query "$output" "data.authenticated")"
  if [ "$authenticated" != "true" ]; then
    local login_command="cloudeval login --base-url $BASE_URL"
    if [ "$CLI_SOURCE" = "auto" ] || [ "$CLI_SOURCE" = "local" ]; then
      login_command="pnpm -C packages/cli exec tsx src/cli.tsx login --base-url $BASE_URL"
    fi
    fail_check "auth preflight" \
      "CLOUDEVAL_SMOKE_REQUIRE_AUTH=1 was set, but the selected CLI has no usable CloudEval session."$'\n'"binary: $CLI"$'\n'"cli_source: $CLI_SOURCE"$'\n'"next: run $login_command, then rerun the smoke test. To run only public read-only checks, unset CLOUDEVAL_SMOKE_REQUIRE_AUTH." \
      auth status --base-url "$BASE_URL" --format json
  fi
}

run_mcp_readonly_smoke() {
  local name="mcp-serve-readonly"
  local summary
  set +e
  summary="$(python3 - "$CLI" "$BASE_URL" <<'PY'
import json
import subprocess
import sys

cli, base_url = sys.argv[1], sys.argv[2]
messages = [
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "cloudeval-readonly-smoke", "version": "1"},
        },
    },
    {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    {"jsonrpc": "2.0", "id": 3, "method": "resources/list", "params": {}},
    {"jsonrpc": "2.0", "id": 4, "method": "prompts/list", "params": {}},
]

def encode_frame(message):
    body = json.dumps(message, separators=(",", ":")).encode("utf-8")
    return b"Content-Length: %d\r\n\r\n" % len(body) + body

def decode_frames(payload):
    responses = []
    offset = 0
    while offset < len(payload):
        header_end = payload.find(b"\r\n\r\n", offset)
        if header_end == -1:
            trailing = payload[offset:].decode("utf-8", errors="replace").strip()
            if trailing:
                raise SystemExit(f"incomplete MCP stdout frame: {trailing!r}")
            break
        header = payload[offset:header_end].decode("ascii", errors="replace")
        content_length = None
        for line in header.splitlines():
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":", 1)[1].strip())
                break
        if content_length is None:
            raise SystemExit(f"missing MCP Content-Length header: {header!r}")
        body_start = header_end + 4
        body_end = body_start + content_length
        if len(payload) < body_end:
            raise SystemExit(f"incomplete MCP stdout body for header: {header!r}")
        responses.append(json.loads(payload[body_start:body_end].decode("utf-8")))
        offset = body_end
    return responses

payload = b"".join(encode_frame(message) for message in messages)
process = subprocess.Popen(
    [cli, "mcp", "serve", "--toolset", "readonly", "--base-url", base_url],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
try:
    stdout, stderr = process.communicate(payload, timeout=8)
except subprocess.TimeoutExpired:
    process.kill()
    stdout, stderr = process.communicate()

stderr_text = stderr.decode("utf-8", errors="replace")
responses = decode_frames(stdout)

by_id = {response.get("id"): response for response in responses if "id" in response}
for required_id in (1, 2, 3, 4):
    if required_id not in by_id or "error" in by_id[required_id]:
        raise SystemExit(f"missing/error MCP response {required_id}: {by_id.get(required_id)} stderr={stderr_text}")
tools = by_id[2].get("result", {}).get("tools", [])
if not tools:
    raise SystemExit(f"MCP tools/list returned no tools stderr={stderr_text}")
invalid_tools = [tool.get("name") for tool in tools if not str(tool.get("name", "")).replace("_", "").isalnum()]
if invalid_tools:
    raise SystemExit(f"MCP tools/list returned invalid tool names: {invalid_tools} stderr={stderr_text}")
print(f"tools={len(tools)} resources={len(by_id[3].get('result', {}).get('resources', []))} prompts={len(by_id[4].get('result', {}).get('prompts', []))}")
PY
)"
  local exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    fail_check "$name" "$summary" mcp serve --toolset readonly --base-url "$BASE_URL"
  fi
  pass "$name"
  show_cli_command mcp serve --toolset readonly --base-url "$BASE_URL"
  result "$summary"
}

need grep
need python3

CLI="$(resolve_cli_bin)"

log "CloudEval read-only CLI smoke"
printf 'binary=%s\ncli_source=%s\nbase_url=%s\nfrontend_url=%s\nartifacts=%s\nrun_ask=%s\nrun_agent=%s\nrequire_auth=%s\n' \
  "$CLI" "$CLI_SOURCE" "$BASE_URL" "$FRONTEND_URL" "$TMP_DIR" "$RUN_ASK" "$RUN_AGENT" "$REQUIRE_AUTH"

log "Public and local read-only commands"
run_text_contains "version" "." --version
run_text_contains "root-help" "Commands:" --help
run_text_contains "help-agents" "CloudEval CLI agent contract" help agents
run_json_envelope "capabilities-json" capabilities --format json
run_recipes_list
run_json_envelope "recipes-show-cloudeval-cloud-cost-review" recipes show cloudeval-cloud-cost-review --format json
run_json_envelope "status-json" status --base-url "$BASE_URL" --format json
run_json_envelope "doctor-json" doctor --base-url "$BASE_URL" --format json
run_json_envelope "doctor-deep-json" doctor --base-url "$BASE_URL" --deep --format json
run_capture "auth-status" auth status --base-url "$BASE_URL"
require_auth_preflight
run_capture "banner" banner
run_capture "completion-bash" completion bash
run_capture "completion-zsh" completion zsh
run_capture "completion-fish" completion fish
run_json_envelope "config-show" config show --format json
run_json_envelope "config-get-base-url" config get baseUrl --format json
run_capture "config-path" config path
run_json_envelope "config-profiles" config profiles --format json
run_json_envelope "models-list" models list --base-url "$BASE_URL" --non-interactive --format json
run_json_envelope "models-default-get" models default get --format json
run_json_envelope "sessions-list" sessions list --format json
run_json_envelope "sessions-export" sessions export --format json
run_mcp_readonly_smoke

log "Frontend deeplink commands"
run_open_url "open-overview" open overview
run_open_url "open-chat" open chat --thread smoke-thread
run_open_url "open-projects" open projects
run_open_url "open-projects-quick" open projects --quick --template-url https://example.com/template.json --name Smoke
run_open_url "open-project" open project smoke-project --view both --layout dependency --node vm1
run_open_url "open-connections" open connections
run_open_url "open-connection" open connection smoke-connection
run_open_url "open-reports" open reports --project smoke-project --tab overview --report-type all
run_open_url "open-billing" open billing --tab usage

log "Authenticated read-only probe"
projects_file="$TMP_DIR/projects-list.json"
set +e
"$CLI" projects list --base-url "$BASE_URL" --non-interactive --format json >"$projects_file" 2>"$TMP_DIR/projects-list.stderr"
projects_exit=$?
set -e

if [ "$projects_exit" -ne 0 ]; then
  reason="$(clean_stderr "$TMP_DIR/projects-list.stderr")"
  if [ "$REQUIRE_AUTH" = "1" ]; then
    fail_check "authenticated read-only commands" \
      "$reason"$'\n'"next: run cloudeval login and retry, or unset CLOUDEVAL_SMOKE_REQUIRE_AUTH to skip auth-gated checks." \
      projects list --base-url "$BASE_URL" --non-interactive --format json
  fi
  skip "authenticated read-only commands (no usable stored/API-key auth)"
  show_cli_command projects list --base-url "$BASE_URL" --non-interactive --format json
  result "reason: $reason"
  finish_success
fi

assert_json_ok "$projects_file" || fail_check "projects-list" "expected JSON envelope with ok=true" projects list --base-url "$BASE_URL" --non-interactive --format json
pass "projects-list"
show_cli_command projects list --base-url "$BASE_URL" --non-interactive --format json
print_json_result "$projects_file"

PROJECT_ID="${CLOUDEVAL_SMOKE_PROJECT_ID:-}"
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="$(first_json_value "$projects_file" "next((str(item.get('id')) for item in data.get('data', []) if item.get('id')), '')")"
fi

if [ -z "$PROJECT_ID" ]; then
  if [ "$REQUIRE_AUTH" = "1" ]; then
    fail_check "project-scoped read-only commands" "authenticated account has no project id to use for project-scoped read-only commands"
  fi
  skip "project-scoped read-only commands (no projects returned)"
  finish_success
fi

log "Authenticated project-scoped read-only commands"
printf 'project_id=%s\n' "$PROJECT_ID"
run_json_envelope "projects-get" projects get "$PROJECT_ID" --base-url "$BASE_URL" --non-interactive --format json
run_json_envelope "projects-open" projects open "$PROJECT_ID" --base-url "$BASE_URL" --non-interactive --format json --no-open
run_json_plain "reports-list" reports list --base-url "$BASE_URL" --project "$PROJECT_ID" --non-interactive --format json
run_optional_json_envelope "reports-download-cost" reports download --base-url "$BASE_URL" --project "$PROJECT_ID" --type cost --view formatted --non-interactive --format json
run_optional_json_envelope "reports-download-waf" reports download --base-url "$BASE_URL" --project "$PROJECT_ID" --type waf --view formatted --non-interactive --format json
run_optional_json_envelope "reports-cost" reports cost --base-url "$BASE_URL" --project "$PROJECT_ID" --non-interactive --format json
run_optional_json_envelope "reports-waf" reports waf --base-url "$BASE_URL" --project "$PROJECT_ID" --non-interactive --format json
run_optional_json_envelope "reports-rules" reports rules --base-url "$BASE_URL" --project "$PROJECT_ID" --non-interactive --format json

REPORT_ID="${CLOUDEVAL_SMOKE_REPORT_ID:-}"
if [ -z "$REPORT_ID" ]; then
  REPORT_ID="$(first_json_value "$TMP_DIR/reports-list.json" "next((str(item.get('id')) for item in data if item.get('id')), '')")"
fi
if [ -n "$REPORT_ID" ]; then
  run_optional_json_envelope "reports-show" reports show "$REPORT_ID" --base-url "$BASE_URL" --project "$PROJECT_ID" --non-interactive --format json
else
  skip "reports-show (no report id discovered)"
fi

connections_file="$TMP_DIR/connections-list.json"
set +e
"$CLI" connections list --base-url "$BASE_URL" --non-interactive --format json >"$connections_file" 2>"$TMP_DIR/connections-list.stderr"
connections_exit=$?
set -e
if [ "$connections_exit" -eq 0 ]; then
  assert_json_ok "$connections_file" || fail_check "connections-list" "expected JSON envelope with ok=true" connections list --base-url "$BASE_URL" --non-interactive --format json
  pass "connections-list"
  show_cli_command connections list --base-url "$BASE_URL" --non-interactive --format json
  print_json_result "$connections_file"
  CONNECTION_ID="${CLOUDEVAL_SMOKE_CONNECTION_ID:-}"
  if [ -z "$CONNECTION_ID" ]; then
    CONNECTION_ID="$(first_json_value "$connections_file" "next((str(item.get('id')) for item in data.get('data', []) if item.get('id')), '')")"
  fi
  if [ -n "$CONNECTION_ID" ]; then
    run_json_envelope "connections-get" connections get "$CONNECTION_ID" --base-url "$BASE_URL" --non-interactive --format json
    run_json_envelope "connections-open" connections open "$CONNECTION_ID" --base-url "$BASE_URL" --non-interactive --format json --no-open
  else
    skip "connections-get/open (no connection id discovered)"
  fi
else
  skip "connections-list ($(clean_stderr "$TMP_DIR/connections-list.stderr"))"
  show_cli_command connections list --base-url "$BASE_URL" --non-interactive --format json
fi

log "Authenticated billing read-only commands"
run_optional_json_envelope "credits" credits --base-url "$BASE_URL" --non-interactive --format json
run_optional_json_envelope "billing-summary" billing summary --base-url "$BASE_URL" --non-interactive --format json
run_optional_json_envelope "billing-plans" billing plans --base-url "$BASE_URL" --non-interactive --format json
run_optional_json_envelope "billing-usage" billing usage --base-url "$BASE_URL" --non-interactive --format json --range 7d
run_optional_json_envelope "billing-ledger" billing ledger --base-url "$BASE_URL" --non-interactive --format json --range 7d --limit 5
run_optional_json_envelope "billing-invoices" billing invoices --base-url "$BASE_URL" --non-interactive --format json --limit 5
run_optional_json_envelope "billing-notifications" billing notifications --base-url "$BASE_URL" --non-interactive --format json --limit 5
run_optional_json_envelope "billing-topups" billing topups --base-url "$BASE_URL" --non-interactive --format json

if [ "$RUN_ASK" = "1" ]; then
  log "Basic ask command"
  run_json_envelope "ask-basic" ask "Reply with exactly: cloudeval readonly smoke ok" \
    --base-url "$BASE_URL" \
    --project "$PROJECT_ID" \
    --non-interactive \
    --quiet \
    --progress none \
    --format json
  run_json_envelope "recipes-run-cloudeval-cloud-cost-review" recipes run cloudeval-cloud-cost-review \
    --base-url "$BASE_URL" \
    --project "$PROJECT_ID" \
    --non-interactive \
    --quiet \
    --progress none \
    --format json
else
  skip "ask-basic (CLOUDEVAL_SMOKE_RUN_ASK=0)"
  skip "recipes-run-cloudeval-cloud-cost-review (CLOUDEVAL_SMOKE_RUN_ASK=0)"
fi

if [ "$RUN_AGENT" = "1" ]; then
  log "Basic agent command"
  run_json_envelope "agent-basic" agent "Reply with exactly: cloudeval readonly agent ok" \
    --base-url "$BASE_URL" \
    --project "$PROJECT_ID" \
    --non-interactive \
    --quiet \
    --progress none \
    --format json
else
  skip "agent-basic (CLOUDEVAL_SMOKE_RUN_AGENT=0)"
fi

log "Read-only smoke completed"
finish_success
