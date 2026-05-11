#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cloudeval-install-onboarding-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
mkdir -p "$TMP_DIR/home/Library/Application Support/Claude"

for name in codex cursor code; do
  cat >"$TMP_DIR/bin/$name" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$TMP_DIR/bin/$name"
done

detected="$(
  HOME="$TMP_DIR/home" \
  PATH="$TMP_DIR/bin:/usr/bin:/bin" \
  bash "$ROOT_DIR/scripts/install.sh" --self-test-agent-detection
)"

for expected in codex cursor claude vscode; do
  case " $detected " in
    *" $expected "*) ;;
    *)
      echo "missing detected client: $expected" >&2
      echo "detected: $detected" >&2
      exit 1
      ;;
  esac
done

echo "ok - installer detects agent clients"

selection_detected="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-agent-selection detected "codex cursor"
)"
if [ "$selection_detected" != "codex cursor" ]; then
  echo "detected selection should reuse detected clients" >&2
  echo "selection: $selection_detected" >&2
  exit 1
fi

selection_group="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-agent-selection codex,cursor "claude vscode"
)"
if [ "$selection_group" != "codex cursor" ]; then
  echo "comma-separated client selection should normalize to a space-separated group" >&2
  echo "selection: $selection_group" >&2
  exit 1
fi

selection_all="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-agent-selection all "codex cursor"
)"
for expected in codex claude cursor vscode; do
  case " $selection_all " in
    *" $expected "*) ;;
    *)
      echo "all selection should include supported client: $expected" >&2
      echo "selection: $selection_all" >&2
      exit 1
      ;;
  esac
done

selection_skip="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-agent-selection skip "codex cursor"
)"
if [ -n "$selection_skip" ]; then
  echo "skip selection should not select clients" >&2
  echo "selection: $selection_skip" >&2
  exit 1
fi

echo "ok - installer normalizes agent setup selections"

agent_next_steps="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-agent-next-steps
)"
if [[ "$agent_next_steps" != *"cloudeval mcp setup <codex|claude|cursor|vscode> --toolset readonly"* ]]; then
  echo "agent next steps should use one concise MCP setup command" >&2
  echo "$agent_next_steps" >&2
  exit 1
fi
if [[ "$agent_next_steps" == *"mcp setup codex --dry-run"* || "$agent_next_steps" == *"mcp setup claude --dry-run"* ]]; then
  echo "agent next steps should not print every MCP client dry-run command" >&2
  echo "$agent_next_steps" >&2
  exit 1
fi

mcp_summary="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-mcp-summary "codex claude" "vscode" "cursor" "codex claude vscode cursor"
)"
for expected in "MCP setup summary" "Configured:" "codex, claude" "Manual:" "vscode" "Failed:" "cursor" "Retry:"; do
  case "$mcp_summary" in
    *"$expected"*) ;;
    *)
      echo "MCP summary missing expected text: $expected" >&2
      echo "$mcp_summary" >&2
      exit 1
      ;;
  esac
done
if [[ "$mcp_summary" == *"Field    Value"* || "$mcp_summary" == *"McpServers"* || "$mcp_summary" == *"instructions"* ]]; then
  echo "MCP summary should not expose verbose setup tables" >&2
  echo "$mcp_summary" >&2
  exit 1
fi

echo "ok - installer MCP onboarding uses concise next steps and summary"

banner_output="$(bash "$ROOT_DIR/scripts/install.sh" --self-test-banner)"

if [[ "$banner_output" != *$'\033[1;38;5;220m ██████╗'* ]]; then
  echo "installer banner should use a bright yellow top gradient band" >&2
  exit 1
fi

if [[ "$banner_output" != *$'\033[0;38;5;94m ╚═════╝'* ]]; then
  echo "installer banner should use a darker amber bottom gradient band" >&2
  exit 1
fi

echo "ok - installer banner uses warm gradient bands"

download_options="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-download-options
)"

for expected in "--connect-timeout" "--max-time" "--speed-time" "--speed-limit"; do
  case " $download_options " in
    *" $expected "*) ;;
    *)
      echo "missing download curl option: $expected" >&2
      echo "options: $download_options" >&2
      exit 1
      ;;
  esac
done

download_plan="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-download-plan cloudeval-macos-arm64
)"
case "$download_plan" in
  *"cloudeval-macos-arm64.gz"*"cloudeval-macos-arm64"*) ;;
  *)
    echo "download plan should prefer compressed assets before raw assets" >&2
    echo "plan: $download_plan" >&2
    exit 1
    ;;
esac

echo "ok - installer download path has timeouts and compressed asset preference"

progress_line="$(
  bash "$ROOT_DIR/scripts/install.sh" --self-test-progress-line cloudeval-macos-arm64.gz "######################################################################## 100.0%"
)"

if [[ "$progress_line" != *"cloudeval-macos-arm64.gz"* || "$progress_line" != *"=================================="* || "$progress_line" != *"] 100%"* ]]; then
  echo "installer progress line should render a compact labeled progress bar" >&2
  echo "progress: $progress_line" >&2
  exit 1
fi

if [[ "$progress_line" == *"########"* ]]; then
  echo "installer progress line should not expose curl's raw hash bar" >&2
  echo "progress: $progress_line" >&2
  exit 1
fi

echo "ok - installer download progress uses compact labeled bars"

cat >"$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf 'downloaded\n' >"$out"
for _ in 1 2 3 4 5 6 7 8; do
  printf '##########'
done >&2
printf ' 100.0%%\n' >&2
SH
chmod +x "$TMP_DIR/bin/curl"

progress_sync="$(
  PATH="$TMP_DIR/bin:/usr/bin:/bin" \
  CLOUDEVAL_FORCE_DOWNLOAD_PROGRESS=1 \
  CI=false \
  bash "$ROOT_DIR/scripts/install.sh" --self-test-progress-sync 2>&1
)"

case "$progress_sync" in
  *"] 100%"*$'\n'"after download"*) ;;
  *)
    echo "installer should wait for the rendered progress line before continuing" >&2
    echo "progress sync output:" >&2
    printf '%s\n' "$progress_sync" >&2
    exit 1
    ;;
esac

echo "ok - installer waits for progress renderer before continuing"

for workflow in "$ROOT_DIR/.github/workflows/semantic-release.yml" "$ROOT_DIR/.github/workflows/release.yml"; do
  if ! grep -q "Create compressed assets" "$workflow"; then
    echo "release workflow is missing compressed asset generation: $workflow" >&2
    exit 1
  fi
done

echo "ok - release workflows publish compressed assets"

package_aliases="$(
  node -e 'const pkg = require(process.argv[1]); console.log(Object.keys(pkg.bin || {}).sort().join(" "));' \
    "$ROOT_DIR/packages/cli/package.json"
)"
for expected in cloudeval cloud eva; do
  case " $package_aliases " in
    *" $expected "*) ;;
    *)
      echo "package bin aliases should include: $expected" >&2
      echo "aliases: $package_aliases" >&2
      exit 1
      ;;
  esac
done

echo "ok - package exposes CLI aliases"

alias_test_dir="$TMP_DIR/alias-executables"
mkdir -p "$alias_test_dir/packages/cli/dist/bin" "$alias_test_dir/packages/cli/scripts"
cp "$ROOT_DIR/packages/cli/scripts/alias-executables.js" "$alias_test_dir/packages/cli/scripts/alias-executables.js"
printf 'unix binary\n' >"$alias_test_dir/packages/cli/dist/bin/cloudeval-linux-x64"
printf 'windows binary\n' >"$alias_test_dir/packages/cli/dist/bin/cloudeval-win-x64.exe"

(
  cd "$alias_test_dir"
  node packages/cli/scripts/alias-executables.js
)

for expected in \
  eva-linux-x64 \
  eva-win-x64.exe \
  cloud-linux-x64 \
  cloud-win-x64.exe; do
  if [ ! -f "$alias_test_dir/packages/cli/dist/bin/$expected" ]; then
    echo "alias executable was not generated: $expected" >&2
    find "$alias_test_dir/packages/cli/dist/bin" -maxdepth 1 -type f -print >&2
    exit 1
  fi
done

echo "ok - release alias executables include eva and cloud"

if ! grep -q 'DEST_DIR}/cloud' "$ROOT_DIR/scripts/install.sh"; then
  echo "installer should create a cloud alias symlink" >&2
  exit 1
fi

if ! grep -q 'cloud --help' "$ROOT_DIR/scripts/install.sh"; then
  echo "installer should show cloud alias usage after install" >&2
  exit 1
fi

echo "ok - installer documents cloud alias symlink"
