#!/usr/bin/env bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper function to ask yes/no questions
ask_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local response

  if [ "${CLOUDEVAL_ASSUME_YES:-}" = "1" ] || [ "${CI:-}" = "true" ]; then
    [ "$default" = "y" ]
    return $?
  fi
  
  if [ ! -r /dev/tty ]; then
    [ "$default" = "y" ]
    return $?
  fi

  if [ "$default" = "y" ]; then
    read -r -p "$(echo -e "${BLUE}${prompt} [Y/n]: ${NC}")" response < /dev/tty || response=""
    response="${response:-y}"
  else
    read -r -p "$(echo -e "${BLUE}${prompt} [y/N]: ${NC}")" response < /dev/tty || response=""
    response="${response:-n}"
  fi
  
  case "$response" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# Detect shell and profile file
detect_shell_profile() {
  local shell_name
  shell_name="$(basename "$SHELL" 2>/dev/null || echo "bash")"
  
  case "$shell_name" in
    zsh)
      if [ -f "$HOME/.zshrc" ]; then
        echo "$HOME/.zshrc"
      elif [ -f "$HOME/.zprofile" ]; then
        echo "$HOME/.zprofile"
      else
        echo "$HOME/.zshrc"
      fi
      ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        echo "$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then
        echo "$HOME/.bash_profile"
      else
        echo "$HOME/.bashrc"
      fi
      ;;
    fish)
      if [ -d "$HOME/.config/fish" ]; then
        echo "$HOME/.config/fish/config.fish"
      else
        echo "$HOME/.config/fish/config.fish"
      fi
      ;;
    *)
      # Default to .profile for other shells
      echo "$HOME/.profile"
      ;;
  esac
}

# Add PATH to shell profile
add_to_path() {
  local profile_file="$1"
  local dest_dir="$2"
  local shell_name
  shell_name="$(basename "$SHELL" 2>/dev/null || echo "bash")"
  
  # Check if already in PATH
  if grep -q "export PATH.*${dest_dir}" "$profile_file" 2>/dev/null; then
    echo -e "${YELLOW}PATH entry already exists in ${profile_file}${NC}"
    return 0
  fi
  
  # Create profile file if it doesn't exist
  if [ ! -f "$profile_file" ]; then
    mkdir -p "$(dirname "$profile_file")"
    touch "$profile_file"
  fi
  
  # Add PATH entry based on shell
  case "$shell_name" in
    fish)
      echo "" >> "$profile_file"
      echo "# Cloudeval CLI" >> "$profile_file"
      echo "set -gx PATH \"${dest_dir}\" \$PATH" >> "$profile_file"
      ;;
    *)
      echo "" >> "$profile_file"
      echo "# Cloudeval CLI" >> "$profile_file"
      echo "export PATH=\"${dest_dir}:\$PATH\"" >> "$profile_file"
      ;;
  esac
  
  echo -e "${GREEN}✓ Added PATH entry to ${profile_file}${NC}"
  echo -e "${YELLOW}Note: You may need to restart your terminal or run: source ${profile_file}${NC}"
}

asset_url() {
  local asset="$1"
  if [ "$VERSION" = "latest" ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    echo "https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  fi
}

hash_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $2}'
    return 0
  fi
  echo -e "${RED}✗ No SHA-256 tool found. Install sha256sum, shasum, or openssl.${NC}" >&2
  return 1
}

verify_asset_checksum() {
  local asset="$1"
  local file="$2"
  local checksum_file
  checksum_file="$(mktemp)"

  if [ "${CLOUDEVAL_SKIP_CHECKSUM:-}" = "1" ]; then
    echo -e "${YELLOW}⚠ Skipping checksum verification because CLOUDEVAL_SKIP_CHECKSUM=1${NC}"
    rm -f "$checksum_file"
    return 0
  fi

  if ! curl -fsSL "$(asset_url "${asset}.sha256")" -o "$checksum_file"; then
    rm -f "$checksum_file"
    echo -e "${RED}✗ Missing checksum for ${asset}. Refusing to install unverified binary.${NC}" >&2
    echo -e "${YELLOW}Set CLOUDEVAL_SKIP_CHECKSUM=1 only if you trust this release source.${NC}" >&2
    return 1
  fi

  local expected
  local actual
  expected="$(awk '{print tolower($1)}' "$checksum_file" | head -n 1)"
  actual="$(hash_file "$file" | tr '[:upper:]' '[:lower:]')"
  rm -f "$checksum_file"

  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo -e "${RED}✗ Checksum verification failed for ${asset}.${NC}" >&2
    return 1
  fi

  echo -e "${GREEN}✓ Verified ${asset} checksum${NC}"
}

download_verified_asset() {
  local asset="$1"
  local dest="$2"
  local mode="${3:-0644}"
  local tmp
  tmp="$(mktemp)"

  if ! curl -fsSL "$(asset_url "$asset")" -o "$tmp"; then
    rm -f "$tmp"
    echo -e "${RED}✗ Failed to download $(asset_url "$asset")${NC}" >&2
    return 1
  fi

  if ! verify_asset_checksum "$asset" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi

  mv "$tmp" "$dest"
  chmod "$mode" "$dest"
}

resolve_release_version() {
  if [ "$VERSION" != "latest" ]; then
    echo "$VERSION"
    return 0
  fi

  local latest_url
  local tag
  latest_url="https://api.github.com/repos/${REPO}/releases/latest"
  tag="$(
    curl -fsSL "$latest_url" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1
  )"

  if [ -n "$tag" ]; then
    echo "$tag"
  else
    echo "latest"
  fi
}

print_banner() {
  printf "%b\n" "${GREEN}Welcome to${NC}"
  printf "%b\n" "${YELLOW} ██████╗  ██╗       ██████╗  ██╗   ██╗ ██████╗  ███████╗ ██╗   ██╗  █████╗  ██╗     ${NC}"
  printf "%b\n" "${YELLOW}██╔════╝  ██║      ██╔═══██╗ ██║   ██║ ██╔══██╗ ██╔════╝ ██║   ██║ ██╔══██╗ ██║     ${NC}"
  printf "%b\n" "${YELLOW}██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ █████╗   ██║   ██║ ███████║ ██║     ${NC}"
  printf "%b\n" "${YELLOW}██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ ██╔══╝   ╚██╗ ██╔╝ ██╔══██║ ██║     ${NC}"
  printf "%b\n" "${YELLOW}╚██████╗  ███████╗ ╚██████╔╝ ╚██████╔╝ ██████╔╝ ███████╗  ╚████╔╝  ██║  ██║ ███████╗${NC}"
  printf "%b\n" "${YELLOW} ╚═════╝  ╚══════╝  ╚═════╝   ╚═════╝  ╚═════╝  ╚══════╝   ╚═══╝   ╚═╝  ╚═╝ ╚══════╝${NC}"
  printf "%b\n" "${GREEN}                                                                           Installer${NC}"
  echo ""
}

REPO="ganakailabs/cloudeval-cli"
VERSION="${1:-latest}"
BIN_NAME="cloudeval"

print_banner

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) OS="macos" ;;
  linux) OS="linux" ;;
  msys*|mingw*|cygwin*) OS="win" ;;
  *) 
    echo -e "${RED}✗ Unsupported OS: $OS${NC}"
    exit 1 
    ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) 
    echo -e "${RED}✗ Unsupported architecture: $ARCH${NC}"
    exit 1 
    ;;
esac

EXT=""
[ "$OS" = "win" ] && EXT=".exe"

if [ "$OS" = "win" ]; then
  BIN="${BIN_NAME}-win-${ARCH}.exe"
else
  BIN="${BIN_NAME}-${OS}-${ARCH}"
fi

DEST_DIR="${HOME}/.local/bin"
DEST="${DEST_DIR}/${BIN_NAME}${EXT}"
YOGA_DEST="${DEST_DIR}/yoga.wasm"
RESOLVED_VERSION="$(resolve_release_version)"

echo -e "${BLUE}Installation Details:${NC}"
echo -e "  Requested Version: ${GREEN}${VERSION}${NC}"
echo -e "  Resolved Release: ${GREEN}${RESOLVED_VERSION}${NC}"
echo -e "  Platform: ${GREEN}${OS}-${ARCH}${NC}"
echo -e "  Binary Asset: ${GREEN}${BIN}${NC}"
echo -e "  Install Directory: ${GREEN}${DEST_DIR}${NC}"
echo -e "  Executable: ${GREEN}${DEST}${NC}"
echo -e "  Yoga Runtime: ${GREEN}${YOGA_DEST}${NC}"
if [ "$OS" != "win" ]; then
  echo -e "  Alias: ${GREEN}${DEST_DIR}/eva -> ${DEST}${NC}"
fi
echo -e "  Checksum Verification: ${GREEN}required${NC}"
echo ""

if ! ask_yes_no "Do you want to proceed with the installation?" "y"; then
  echo -e "${YELLOW}Installation cancelled.${NC}"
  exit 0
fi

echo ""
echo -e "${BLUE}Downloading ${BIN_NAME} binary...${NC}"
mkdir -p "$DEST_DIR"

if ! download_verified_asset "$BIN" "$DEST" "0755"; then
  echo ""
  echo -e "${YELLOW}No pre-built release found. You can:${NC}"
  echo ""
  echo -e "${BLUE}Option 1: Build from source${NC}"
  echo -e "  1. Clone the repository:"
  echo -e "     ${GREEN}git clone https://github.com/${REPO}.git${NC}"
  echo -e "  2. Navigate to the repo:"
  echo -e "     ${GREEN}cd cloudeval-cli${NC}"
  echo -e "  3. Install dependencies:"
  echo -e "     ${GREEN}pnpm install${NC}"
  echo -e "  4. Build executable:"
  echo -e "     ${GREEN}pnpm --filter cloudeval-cli build:executable:current${NC}"
  echo -e "  5. Copy to your PATH:"
  echo -e "     ${GREEN}cp packages/cli/dist/bin/cloudeval ${DEST_DIR}/${BIN_NAME}${NC}"
  echo -e "     ${GREEN}cp packages/cli/dist/bin/yoga.wasm ${DEST_DIR}/yoga.wasm${NC}"
  echo ""
  echo -e "${BLUE}Option 2: Wait for a release${NC}"
  echo -e "  Check https://github.com/${REPO}/releases for available releases"
  echo ""
  exit 1
fi
echo -e "${GREEN}✓ Downloaded ${BIN_NAME} binary${NC}"

echo ""
echo -e "${BLUE}Downloading yoga.wasm...${NC}"
if ! download_verified_asset "yoga.wasm" "$YOGA_DEST" "0644"; then
  echo -e "${RED}✗ The CLI requires yoga.wasm. Installation cannot continue safely.${NC}"
  rm -f "$DEST"
  exit 1
fi
echo -e "${GREEN}✓ Downloaded yoga.wasm${NC}"

if [ "$OS" != "win" ]; then
  echo ""
  if ask_yes_no "Create 'eva' alias symlink?" "y"; then
    ln -sf "$DEST" "${DEST_DIR}/eva"
    echo -e "${GREEN}✓ Created 'eva' alias${NC}"
  fi
fi

echo ""
echo -e "${GREEN}✓ Installation complete!${NC}"
echo -e "  Binary installed to: ${GREEN}${DEST}${NC}"
echo ""

# Check if PATH needs to be updated
case ":$PATH:" in
  *":${DEST_DIR}:"*)
    echo -e "${GREEN}✓ ${DEST_DIR} is already in your PATH${NC}"
    ;;
  *)
    echo -e "${YELLOW}⚠ ${DEST_DIR} is not in your PATH${NC}"
    PROFILE_FILE="$(detect_shell_profile)"
    echo ""
    if ask_yes_no "Would you like to add ${DEST_DIR} to your PATH automatically?" "y"; then
      add_to_path "$PROFILE_FILE" "$DEST_DIR"
    else
      echo ""
      echo -e "${YELLOW}To use ${BIN_NAME} from anywhere, add this to your shell profile:${NC}"
      if [[ "$PROFILE_FILE" == *".fish" ]]; then
        echo -e "  ${BLUE}set -gx PATH \"${DEST_DIR}\" \$PATH${NC}"
      else
        echo -e "  ${BLUE}export PATH=\"${DEST_DIR}:\$PATH\"${NC}"
      fi
      echo -e "  ${BLUE}Profile file: ${PROFILE_FILE}${NC}"
    fi
    ;;
esac

echo ""
echo -e "${GREEN}You can now run: ${BIN_NAME} --help${NC}"
if [ "$OS" != "win" ] && [ -L "${DEST_DIR}/eva" ]; then
  echo -e "${GREEN}Or use the alias: eva --help${NC}"
fi
echo ""
