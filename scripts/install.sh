#!/usr/bin/env bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BANNER_TOP='\033[1;38;5;220m'
BANNER_UPPER='\033[1;38;5;214m'
BANNER_MIDDLE='\033[1;38;5;208m'
BANNER_LOWER='\033[0;38;5;172m'
BANNER_BASE='\033[0;38;5;130m'
BANNER_BOTTOM='\033[0;38;5;94m'
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

can_prompt_on_tty() {
  [ "${CI:-}" != "true" ] && [ -r /dev/tty ]
}

ask_agent_setup_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local response

  if ! can_prompt_on_tty; then
    [ "$default" = "y" ]
    return $?
  fi

  if [ "${CLOUDEVAL_ASSUME_YES:-}" = "1" ] && [ "${CLOUDEVAL_INSTALL_AGENT_SETUP_PROMPT:-0}" != "1" ]; then
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

curl_download_args() {
  printf '%s\n' \
    "--fail" \
    "--location" \
    "--show-error" \
    "--connect-timeout" "${CLOUDEVAL_CURL_CONNECT_TIMEOUT:-15}" \
    "--max-time" "${CLOUDEVAL_CURL_MAX_TIME:-900}" \
    "--speed-time" "${CLOUDEVAL_CURL_SPEED_TIME:-30}" \
    "--speed-limit" "${CLOUDEVAL_CURL_SPEED_LIMIT:-1024}"
}

curl_should_show_progress() {
  [ "${CLOUDEVAL_DOWNLOAD_PROGRESS:-1}" != "0" ] \
    && [ "${CI:-}" != "true" ] \
    && [ -r /dev/tty ]
}

curl_download_file() {
  local url="$1"
  local dest="$2"
  local label="$3"
  local optional="${4:-0}"
  local attempts="${CLOUDEVAL_CURL_RETRIES:-2}"
  local attempt=1
  local curl_args=()
  local arg

  while IFS= read -r arg; do
    curl_args+=("$arg")
  done < <(curl_download_args)

  if curl_should_show_progress; then
    curl_args+=("--progress-bar")
  else
    curl_args+=("--silent")
  fi

  while [ "$attempt" -le "$attempts" ]; do
    if [ "$attempts" -gt 1 ]; then
      echo -e "${BLUE}${label} download attempt ${attempt}/${attempts}${NC}" >&2
    fi

    if curl "${curl_args[@]}" "$url" -o "$dest"; then
      return 0
    fi

    if [ "$attempt" -lt "$attempts" ]; then
      echo -e "${YELLOW}⚠ Download attempt ${attempt} failed for ${label}; retrying...${NC}" >&2
      sleep "${CLOUDEVAL_CURL_RETRY_DELAY:-2}"
    fi
    attempt=$((attempt + 1))
  done

  if [ "$optional" != "1" ]; then
    echo -e "${RED}✗ Failed to download ${url}${NC}" >&2
    echo -e "${YELLOW}If the transfer stalls, retry or increase CLOUDEVAL_CURL_MAX_TIME for slower networks.${NC}" >&2
  fi
  return 1
}

asset_exists() {
  local url="$1"
  curl \
    --fail \
    --location \
    --silent \
    --head \
    --connect-timeout "${CLOUDEVAL_CURL_CONNECT_TIMEOUT:-15}" \
    --max-time "${CLOUDEVAL_CURL_HEAD_MAX_TIME:-30}" \
    "$url" >/dev/null 2>&1
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

  if ! curl_download_file "$(asset_url "${asset}.sha256")" "$checksum_file" "${asset}.sha256" "0"; then
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
  local compressed_tmp="${tmp}.gz"

  local compressed_url
  compressed_url="$(asset_url "${asset}.gz")"

  if [ "${CLOUDEVAL_DISABLE_COMPRESSED_ASSETS:-0}" != "1" ] && command -v gzip >/dev/null 2>&1; then
    if asset_exists "$compressed_url" && curl_download_file "$compressed_url" "$compressed_tmp" "${asset}.gz" "0"; then
      echo -e "${GREEN}✓ Downloaded compressed ${asset}.gz${NC}"
      if ! gzip -dc "$compressed_tmp" > "$tmp"; then
        rm -f "$tmp" "$compressed_tmp"
        echo -e "${RED}✗ Failed to unpack ${asset}.gz${NC}" >&2
        return 1
      fi
      rm -f "$compressed_tmp"

      if ! verify_asset_checksum "$asset" "$tmp"; then
        rm -f "$tmp"
        return 1
      fi

      mv "$tmp" "$dest"
      chmod "$mode" "$dest"
      return 0
    fi
    rm -f "$compressed_tmp"
    echo -e "${YELLOW}Compressed asset unavailable; downloading ${asset}.${NC}"
  fi

  if ! curl_download_file "$(asset_url "$asset")" "$tmp" "$asset" "0"; then
    rm -f "$tmp"
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
  printf "%b\n" "${BANNER_TOP} ██████╗  ██╗       ██████╗  ██╗   ██╗ ██████╗  ███████╗ ██╗   ██╗  █████╗  ██╗     ${NC}"
  printf "%b\n" "${BANNER_UPPER}██╔════╝  ██║      ██╔═══██╗ ██║   ██║ ██╔══██╗ ██╔════╝ ██║   ██║ ██╔══██╗ ██║     ${NC}"
  printf "%b\n" "${BANNER_MIDDLE}██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ █████╗   ██║   ██║ ███████║ ██║     ${NC}"
  printf "%b\n" "${BANNER_LOWER}██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ ██╔══╝   ╚██╗ ██╔╝ ██╔══██║ ██║     ${NC}"
  printf "%b\n" "${BANNER_BASE}╚██████╗  ███████╗ ╚██████╔╝ ╚██████╔╝ ██████╔╝ ███████╗  ╚████╔╝  ██║  ██║ ███████╗${NC}"
  printf "%b\n" "${BANNER_BOTTOM} ╚═════╝  ╚══════╝  ╚═════╝   ╚═════╝  ╚═════╝  ╚══════╝   ╚═══╝   ╚═╝  ╚═╝ ╚══════╝${NC}"
  printf "%b\n" "${GREEN}                                                                           Installer${NC}"
  echo ""
}

append_unique_client() {
  local clients="$1"
  local client="$2"
  case " $clients " in
    *" $client "*) printf '%s\n' "$clients" ;;
    *) printf '%s\n' "${clients:+$clients }$client" ;;
  esac
}

detect_mcp_clients() {
  local clients=""

  if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
    clients="$(append_unique_client "$clients" "codex")"
  fi
  if command -v cursor >/dev/null 2>&1 || [ -d "$HOME/.cursor" ] || [ -d "/Applications/Cursor.app" ]; then
    clients="$(append_unique_client "$clients" "cursor")"
  fi
  if [ -d "$HOME/Library/Application Support/Claude" ] || [ -d "$HOME/.config/Claude" ] || [ -d "/Applications/Claude.app" ]; then
    clients="$(append_unique_client "$clients" "claude")"
  fi
  if command -v code >/dev/null 2>&1 || [ -d "$HOME/.vscode" ] || [ -d "/Applications/Visual Studio Code.app" ]; then
    clients="$(append_unique_client "$clients" "vscode")"
  fi

  printf '%s\n' "$clients"
}

supported_mcp_clients() {
  printf '%s\n' "codex claude cursor vscode"
}

normalize_mcp_client_selection() {
  local selected="$1"
  local detected="$2"
  local normalized=""
  local token

  selected="$(printf '%s\n' "$selected" | tr '[:upper:]' '[:lower:]' | tr ',;' '  ')"

  for token in $selected; do
    case "$token" in
      skip|none|no)
        normalized=""
        ;;
      detected|default)
        normalized="$detected"
        ;;
      all)
        normalized="$(supported_mcp_clients)"
        ;;
      codex|claude|cursor|vscode)
        normalized="$(append_unique_client "$normalized" "$token")"
        ;;
      "")
        ;;
      *)
        normalized="$(append_unique_client "$normalized" "$token")"
        ;;
    esac
  done

  printf '%s\n' "$normalized"
}

print_credentials_next_steps() {
  echo -e "${BLUE}Credentials for automation${NC}"
  echo -e "  The installer does not create access keys or write secrets into MCP client config."
  echo -e "  For local MCP, use ${GREEN}${BIN_NAME} login${NC}. For CI and hosted agents, create a project-scoped credential after login:"
  echo -e "  ${GREEN}${BIN_NAME} projects list${NC}"
  echo -e "  ${GREEN}${BIN_NAME} credentials templates${NC}"
  echo -e "  ${GREEN}${BIN_NAME} credentials create --template ci --name agent-automation --project <project-id> --expires 90d --format github-actions${NC}"
  echo -e "  The raw access key is printed once. Store it as ${GREEN}CLOUDEVAL_ACCESS_KEY${NC} or pipe it with ${GREEN}--access-key-stdin${NC}."
}

print_agent_setup_next_steps() {
  echo -e "${BLUE}Agent and IDE setup${NC}"
  echo -e "  ${GREEN}${BIN_NAME} login${NC}"
  echo -e "  ${GREEN}${BIN_NAME} mcp setup codex --dry-run --toolset readonly${NC}"
  echo -e "  ${GREEN}${BIN_NAME} mcp setup claude --dry-run --toolset readonly${NC}"
  echo -e "  ${GREEN}${BIN_NAME} mcp setup cursor --dry-run --toolset readonly${NC}"
  echo -e "  ${GREEN}${BIN_NAME} mcp setup vscode --dry-run --toolset readonly${NC}"
  echo ""
  print_credentials_next_steps
}

setup_codex_mcp() {
  if command -v codex >/dev/null 2>&1; then
    codex mcp add cloudeval -- "$DEST" mcp serve --toolset readonly
    return $?
  fi
  "$DEST" mcp setup codex --command "$DEST" --toolset readonly
}

setup_vscode_mcp() {
  if command -v code >/dev/null 2>&1; then
    code --add-mcp "{\"name\":\"cloudeval\",\"type\":\"stdio\",\"command\":\"$DEST\",\"args\":[\"mcp\",\"serve\",\"--toolset\",\"readonly\"]}"
    return $?
  fi
  echo -e "${YELLOW}⚠ VS Code command 'code' was not found on PATH. Showing workspace config instead.${NC}"
  "$DEST" mcp setup vscode --dry-run --command "$DEST" --toolset readonly
}

setup_mcp_client() {
  local client="$1"
  case "$client" in
    codex)
      setup_codex_mcp
      ;;
    claude|cursor)
      "$DEST" mcp setup "$client" --command "$DEST" --toolset readonly
      ;;
    vscode)
      setup_vscode_mcp
      ;;
    "")
      return 0
      ;;
    *)
      echo -e "${YELLOW}⚠ Skipping unknown MCP client: ${client}${NC}" >&2
      return 0
      ;;
  esac
}

run_optional_agent_setup() {
  if [ "${CLOUDEVAL_INSTALL_AGENT_SETUP:-1}" = "0" ]; then
    return 0
  fi

  echo ""
  echo -e "${BLUE}CloudEval for agents${NC}"
  echo -e "  MCP exposes CloudEval tools, recipes, and prompts for Codex, Claude, Cursor, VS Code, and other clients."
  echo -e "  Skills available: ${GREEN}cost-review, waf-triage, architecture-review, template-project-review, report-summary, billing-review, diagram-export, mcp-setup${NC}"

  local detected
  detected="$(detect_mcp_clients)"
  if [ -n "$detected" ]; then
    echo -e "  Detected clients: ${GREEN}${detected}${NC}"
  else
    echo -e "  Detected clients: ${YELLOW}none${NC}"
  fi

  if ! can_prompt_on_tty; then
    print_agent_setup_next_steps
    return 0
  fi

  if [ -z "${CLOUDEVAL_INSTALL_MCP_CLIENTS:-}" ] && ! ask_agent_setup_yes_no "Set up CloudEval MCP for agents and IDEs now?" "n"; then
    print_agent_setup_next_steps
    return 0
  fi

  if ask_agent_setup_yes_no "Run ${BIN_NAME} login now first?" "n"; then
    if "$DEST" login; then
      echo -e "${GREEN}✓ Login completed${NC}"
    else
      echo -e "${YELLOW}⚠ Login did not complete. You can rerun: ${BIN_NAME} login${NC}"
    fi
  fi

  local selected="${CLOUDEVAL_INSTALL_MCP_CLIENTS:-}"
  if [ -z "$selected" ]; then
    if [ -n "$detected" ]; then
      read -r -p "$(echo -e "${BLUE}Set up MCP for which clients? Use 'detected', 'all', comma-separated names, or 'skip' [detected]: ${NC}")" selected < /dev/tty || selected=""
      selected="${selected:-detected}"
    else
      read -r -p "$(echo -e "${BLUE}Set up MCP for which clients? Use 'all', codex,claude,cursor,vscode, or 'skip' [skip]: ${NC}")" selected < /dev/tty || selected=""
      selected="${selected:-skip}"
    fi
  fi

  local normalized
  normalized="$(normalize_mcp_client_selection "$selected" "$detected")"
  if [ -z "$normalized" ]; then
    echo -e "${YELLOW}Skipped MCP setup.${NC}"
  fi

  local client
  for client in $normalized; do
    echo ""
    echo -e "${BLUE}Setting up MCP for ${client}...${NC}"
    if setup_mcp_client "$client"; then
      echo -e "${GREEN}✓ MCP setup step completed for ${client}${NC}"
    else
      echo -e "${YELLOW}⚠ MCP setup failed for ${client}. Run: ${BIN_NAME} mcp setup ${client} --dry-run --toolset readonly${NC}"
    fi
  done

  echo ""
  print_credentials_next_steps
}

REPO="ganakailabs/cloudeval-cli"
VERSION="${1:-latest}"
BIN_NAME="cloudeval"

if [ "${1:-}" = "--self-test-agent-detection" ]; then
  detect_mcp_clients
  exit 0
fi

if [ "${1:-}" = "--self-test-agent-selection" ]; then
  normalize_mcp_client_selection "${2:-}" "${3:-}"
  exit 0
fi

if [ "${1:-}" = "--self-test-banner" ]; then
  print_banner
  exit 0
fi

if [ "${1:-}" = "--self-test-download-options" ]; then
  curl_download_args | tr '\n' ' '
  printf '\n'
  exit 0
fi

if [ "${1:-}" = "--self-test-download-plan" ]; then
  VERSION="${CLOUDEVAL_SELF_TEST_VERSION:-latest}"
  asset="${2:-cloudeval-macos-arm64}"
  printf '%s\n' "$(asset_url "${asset}.gz")"
  printf '%s\n' "$(asset_url "$asset")"
  exit 0
fi

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
  echo -e "${YELLOW}Could not install the pre-built release.${NC}"
  echo -e "  This can happen when the network/CDN stalls, a proxy blocks GitHub release"
  echo -e "  assets, or the requested release does not provide ${OS}-${ARCH}."
  echo ""
  echo -e "  Retry on a slower network with:"
  echo -e "     ${GREEN}curl -fsSL https://cli.cloudeval.ai/install.sh | CLOUDEVAL_CURL_MAX_TIME=1800 bash${NC}"
  echo ""
  echo -e "${YELLOW}Other options:${NC}"
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

if [ "${CLOUDEVAL_INSTALL_COMPLETION:-1}" != "0" ] && [ "$OS" != "win" ]; then
  shell_name="$(basename "$SHELL" 2>/dev/null || echo bash)"
  echo -e "${BLUE}Shell tab completions${NC}"
  if ask_yes_no "Install tab completions for ${shell_name} (detected from \$SHELL)?" "y"; then
    case "$shell_name" in
      zsh|bash|fish)
        if "$DEST" completion install --shell "$shell_name"; then
          echo -e "${GREEN}✓ Installed ${shell_name} completions. Open a new terminal or reload your shell.${NC}"
        else
          echo -e "${YELLOW}⚠ Could not install completions automatically. Run: ${BIN_NAME} completion install --shell ${shell_name}${NC}"
        fi
        ;;
      *)
        echo -e "${YELLOW}⚠ Automatic install supports bash, zsh, and fish. Run:${NC}"
        echo -e "  ${BLUE}${BIN_NAME} completion install --shell powershell${NC} ${YELLOW}(PowerShell)${NC}"
        ;;
    esac
  fi
  echo ""
fi

run_optional_agent_setup
