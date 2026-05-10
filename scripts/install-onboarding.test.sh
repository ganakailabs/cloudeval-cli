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

for workflow in "$ROOT_DIR/.github/workflows/semantic-release.yml" "$ROOT_DIR/.github/workflows/release.yml"; do
  if ! grep -q "Create compressed assets" "$workflow"; then
    echo "release workflow is missing compressed asset generation: $workflow" >&2
    exit 1
  fi
done

echo "ok - release workflows publish compressed assets"
