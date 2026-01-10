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
  
  if [ "$default" = "y" ]; then
    read -p "$(echo -e "${BLUE}${prompt} [Y/n]: ${NC}")" response
    response="${response:-y}"
  else
    read -p "$(echo -e "${BLUE}${prompt} [y/N]: ${NC}")" response
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

REPO="ganakailabs/cloudeval-cli"
VERSION="${1:-latest}"
BIN_NAME="cloudeval"

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Cloudeval CLI Installation Script   ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

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

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${BIN}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${BIN}"
fi

DEST_DIR="${HOME}/.local/bin"
DEST="${DEST_DIR}/${BIN_NAME}${EXT}"
YOGA_DEST="${DEST_DIR}/yoga.wasm"

echo -e "${BLUE}Installation Details:${NC}"
echo -e "  OS: ${GREEN}${OS}${NC}"
echo -e "  Architecture: ${GREEN}${ARCH}${NC}"
echo -e "  Version: ${GREEN}${VERSION}${NC}"
echo -e "  Install Directory: ${GREEN}${DEST_DIR}${NC}"
echo ""

if ! ask_yes_no "Do you want to proceed with the installation?" "y"; then
  echo -e "${YELLOW}Installation cancelled.${NC}"
  exit 0
fi

echo ""
echo -e "${BLUE}Downloading ${BIN_NAME} binary...${NC}"
mkdir -p "$DEST_DIR"

if ! curl -fsSL "$URL" -o "$DEST"; then
  echo -e "${RED}✗ Failed to download ${URL}${NC}"
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
chmod +x "$DEST"
echo -e "${GREEN}✓ Downloaded ${BIN_NAME} binary${NC}"

echo ""
echo -e "${BLUE}Downloading yoga.wasm...${NC}"
if [ "$VERSION" = "latest" ]; then
  YOGA_URL="https://github.com/${REPO}/releases/latest/download/yoga.wasm"
else
  YOGA_URL="https://github.com/${REPO}/releases/download/${VERSION}/yoga.wasm"
fi

if ! curl -fsSL "$YOGA_URL" -o "$YOGA_DEST"; then
  echo -e "${YELLOW}⚠ Failed to download ${YOGA_URL}${NC}"
  echo -e "${YELLOW}The CLI requires yoga.wasm, but it's not critical for basic functionality.${NC}"
  echo -e "${YELLOW}If you encounter issues, you may need to build from source.${NC}"
  # Don't exit - allow installation to continue without yoga.wasm
  # Some functionality might work without it
else
  echo -e "${GREEN}✓ Downloaded yoga.wasm${NC}"
fi

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
