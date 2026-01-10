#!/usr/bin/env bash
set -euo pipefail

REPO="ganakailabs/cloudeval-cli"
VERSION="${1:-latest}"
BIN_NAME="cloudeval"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) OS="macos" ;;
  linux) OS="linux" ;;
  msys*|mingw*|cygwin*) OS="win" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

EXT=""
[ "$OS" = "win" ] && EXT=".exe"

if [ "$OS" = "win" ]; then
  BIN="${BIN_NAME}-win-${ARCH}.exe"
else
  BIN="${BIN_NAME}-${OS}-${ARCH}"
fi

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${BIN}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${BIN}"
fi

DEST_DIR="${HOME}/.local/bin"
DEST="${DEST_DIR}/${BIN_NAME}${EXT}"
YOGA_DEST="${DEST_DIR}/yoga.wasm"

echo "Detected OS: ${OS}"
echo "Detected arch: ${ARCH}"
echo "Downloading: ${URL}"

mkdir -p "$DEST_DIR"
if ! curl -fsSL "$URL" -o "$DEST"; then
  echo "Failed to download ${URL}"
  echo "Check that a release exists and includes ${BIN}."
  exit 1
fi
chmod +x "$DEST"

YOGA_URL="https://github.com/${REPO}/releases/${VERSION}/download/yoga.wasm"
if [ "$VERSION" = "latest" ]; then
  YOGA_URL="https://github.com/${REPO}/releases/latest/download/yoga.wasm"
fi
if ! curl -fsSL "$YOGA_URL" -o "$YOGA_DEST"; then
  echo "Failed to download ${YOGA_URL}"
  echo "The CLI requires yoga.wasm in ${DEST_DIR}."
  exit 1
fi

if [ "$OS" != "win" ]; then
  ln -sf "$DEST" "${DEST_DIR}/eva"
fi

echo "Installed ${BIN_NAME} to ${DEST}"
echo "Run: ${BIN_NAME} --help"

case ":$PATH:" in
  *":${DEST_DIR}:"*) ;;
  *)
    echo "Warning: ${DEST_DIR} is not in PATH."
    echo "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo "  export PATH=\"${DEST_DIR}:\$PATH\""
    ;;
esac
