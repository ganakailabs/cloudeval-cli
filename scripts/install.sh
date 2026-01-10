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

BIN="${BIN_NAME}-${OS}-${ARCH}${EXT}"

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${BIN}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${BIN}"
fi

DEST_DIR="${HOME}/.local/bin"
DEST="${DEST_DIR}/${BIN_NAME}${EXT}"

mkdir -p "$DEST_DIR"
curl -fsSL "$URL" -o "$DEST"
chmod +x "$DEST"

if [ "$OS" != "win" ]; then
  ln -sf "$DEST" "${DEST_DIR}/eva"
fi

echo "Installed ${BIN_NAME} to ${DEST}"
echo "Run: ${BIN_NAME} --help"
