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
