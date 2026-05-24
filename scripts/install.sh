#!/usr/bin/env bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MUTED='\033[0;90m'
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
    && { [ "${CLOUDEVAL_FORCE_DOWNLOAD_PROGRESS:-0}" = "1" ] || { [ "${CI:-}" != "true" ] && [ -r /dev/tty ]; }; }
}

repeat_char() {
  local count="$1"
  local char="$2"
  local output=""

  while [ "$count" -gt 0 ]; do
    output="${output}${char}"
    count=$((count - 1))
  done
  printf '%s' "$output"
}

curl_progress_payload() {
  local raw="$1"
  [[ "$raw" == *"#"* || "$raw" == *"%"* ]]
}

curl_progress_percent() {
  local raw="$1"
  local hashes=""
  local hash_count=0
  local curl_columns="${CLOUDEVAL_CURL_PROGRESS_COLUMNS:-72}"
  local percent=""

  if [[ "$raw" =~ ([0-9][0-9]?[0-9]?)(\.[0-9]+)?% ]]; then
    percent="${BASH_REMATCH[1]}"
  else
    hashes="${raw//[^#]/}"
    hash_count="${#hashes}"
    percent=$((hash_count * 100 / curl_columns))
  fi

  if [ "$percent" -lt 0 ]; then
    percent=0
  elif [ "$percent" -gt 100 ]; then
    percent=100
  fi

  printf '%s\n' "$percent"
}

render_download_progress_snapshot() {
  local label="$1"
  local raw="$2"
  local width="${3:-${CLOUDEVAL_PROGRESS_WIDTH:-34}}"
  local percent
  local filled=0
  local empty=0
  local filled_bar=""
  local empty_bar=""

  percent="$(curl_progress_percent "$raw")"

  filled=$((percent * width / 100))
  empty=$((width - filled))
  filled_bar="$(repeat_char "$filled" "=")"
  empty_bar="$(repeat_char "$empty" ".")"

  printf '\r\033[2K  %b%-30s%b [%b%s%b%s%b] %3d%%' \
    "$BLUE" "$label" "$NC" \
    "$GREEN" "$filled_bar" "$MUTED" "$empty_bar" "$NC" \
    "$percent" >&2
}

format_curl_progress() {
  local label="$1"
  local char=""
  local raw=""
  local rendered=0
  local percent=""
  local last_percent="-1"

  maybe_render_download_progress() {
    if curl_progress_payload "$raw"; then
      percent="$(curl_progress_percent "$raw")"
      if [ "$percent" != "$last_percent" ]; then
        render_download_progress_snapshot "$label" "$raw"
        rendered=1
        last_percent="$percent"
      fi
      return 0
    fi
    return 1
  }

  while IFS= read -r -n 1 char; do
    case "$char" in
      $'\r'|$'\n')
        if [ -n "$raw" ]; then
          if maybe_render_download_progress; then
            :
          else
            [ "$rendered" = "1" ] && printf '\r\033[2K' >&2
            printf '%s\n' "$raw" >&2
            rendered=0
          fi
        fi
        raw=""
        ;;
      *)
        raw="${raw}${char}"
        maybe_render_download_progress || true
        ;;
    esac
  done

  if [ -n "$raw" ]; then
    if maybe_render_download_progress; then
      :
    else
      [ "$rendered" = "1" ] && printf '\r\033[2K' >&2
      printf '%s\n' "$raw" >&2
      rendered=0
    fi
  fi

  [ "$rendered" = "1" ] && printf '\n' >&2
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
      echo -e "${BLUE}${label}${NC} ${MUTED}(attempt ${attempt}/${attempts})${NC}" >&2
    fi

    if curl_should_show_progress; then
      local progress_fifo
      local progress_pid
      local curl_status
      progress_fifo="$(mktemp "${TMPDIR:-/tmp}/cloudeval-curl-progress.XXXXXX")"
      rm -f "$progress_fifo"
      mkfifo "$progress_fifo"
      format_curl_progress "$label" < "$progress_fifo" &
      progress_pid=$!

      if curl "${curl_args[@]}" "$url" -o "$dest" 2> "$progress_fifo"; then
        curl_status=0
      else
        curl_status=$?
      fi

      wait "$progress_pid" || true
      rm -f "$progress_fifo"

      if [ "$curl_status" -eq 0 ]; then
        return 0
      fi
    elif curl "${curl_args[@]}" "$url" -o "$dest"; then
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

download_optional_notice_asset() {
  local asset="$1"
  local dest="$2"

  if download_verified_asset "$asset" "$dest" "0644"; then
    echo -e "${GREEN}✓ Downloaded ${asset}${NC}"
    return 0
  fi

  rm -f "$dest"
  echo -e "${YELLOW}⚠ Could not download ${asset}; continuing install. Check the release page for license notices.${NC}" >&2
  return 0
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

client_list_contains() {
  local clients="$1"
  local client="$2"
  case " $clients " in
    *" $client "*) return 0 ;;
    *) return 1 ;;
  esac
}

file_has_cloudeval_mcp_server() {
  local file_path="$1"
  [ -f "$file_path" ] || return 1

  grep -Eq '^\[mcp_servers\.("?cloudeval"?)\]' "$file_path" 2>/dev/null && return 0
  grep -Eq '"cloudeval"[[:space:]]*:' "$file_path" 2>/dev/null && return 0
  return 1
}

codex_mcp_is_configured() {
  if command -v codex >/dev/null 2>&1 && codex mcp get cloudeval >/dev/null 2>&1; then
    return 0
  fi
  file_has_cloudeval_mcp_server "$HOME/.codex/config.toml"
}

cursor_mcp_is_configured() {
  file_has_cloudeval_mcp_server "$HOME/.cursor/mcp.json"
}

claude_mcp_is_configured() {
  file_has_cloudeval_mcp_server "$HOME/Library/Application Support/Claude/claude_desktop_config.json" && return 0
  file_has_cloudeval_mcp_server "$HOME/.config/Claude/claude_desktop_config.json"
}

vscode_mcp_is_configured() {
  local appdata_dir="${APPDATA:-$HOME/AppData/Roaming}"

  file_has_cloudeval_mcp_server "$HOME/Library/Application Support/Code/User/mcp.json" && return 0
  file_has_cloudeval_mcp_server "$HOME/Library/Application Support/Code - Insiders/User/mcp.json" && return 0
  file_has_cloudeval_mcp_server "$HOME/.config/Code/User/mcp.json" && return 0
  file_has_cloudeval_mcp_server "$HOME/.config/Code - Insiders/User/mcp.json" && return 0
  file_has_cloudeval_mcp_server "$appdata_dir/Code/User/mcp.json" && return 0
  file_has_cloudeval_mcp_server "$PWD/.vscode/mcp.json"
}

mcp_client_is_configured() {
  local client="$1"
  case "$client" in
    codex)
      codex_mcp_is_configured
      ;;
    cursor)
      cursor_mcp_is_configured
      ;;
    claude)
      claude_mcp_is_configured
      ;;
    vscode)
      vscode_mcp_is_configured
      ;;
    *)
      return 1
      ;;
  esac
}

detect_configured_mcp_clients() {
  local configured=""
  local client

  for client in $(supported_mcp_clients); do
    if mcp_client_is_configured "$client"; then
      configured="$(append_unique_client "$configured" "$client")"
    fi
  done

  printf '%s\n' "$configured"
}

filter_unconfigured_mcp_clients() {
  local clients="$1"
  local configured="$2"
  local candidates=""
  local client

  for client in $clients; do
    if ! client_list_contains "$configured" "$client"; then
      candidates="$(append_unique_client "$candidates" "$client")"
    fi
  done

  printf '%s\n' "$candidates"
}

mcp_client_can_auto_setup() {
  local client="$1"
  case "$client" in
    codex)
      command -v codex >/dev/null 2>&1
      ;;
    cursor|claude)
      return 0
      ;;
    vscode)
      command -v code >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

filter_auto_setup_mcp_clients() {
  local clients="$1"
  local candidates=""
  local client

  for client in $clients; do
    if mcp_client_can_auto_setup "$client"; then
      candidates="$(append_unique_client "$candidates" "$client")"
    fi
  done

  printf '%s\n' "$candidates"
}

filter_manual_setup_mcp_clients() {
  local clients="$1"
  local candidates=""
  local client

  for client in $clients; do
    if ! mcp_client_can_auto_setup "$client"; then
      candidates="$(append_unique_client "$candidates" "$client")"
    fi
  done

  printf '%s\n' "$candidates"
}

join_words() {
  local separator="$1"
  shift || true
  local output=""
  local item
  for item in "$@"; do
    [ -n "$item" ] || continue
    output="${output:+${output}${separator}}${item}"
  done
  printf '%s\n' "$output"
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
      detected|default|missing)
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
  echo -e "  Local agents use ${GREEN}${BIN_NAME} login${NC}; CI uses scoped ${GREEN}CLOUDEVAL_ACCESS_KEY${NC} credentials."
  echo -e "  Create later: ${GREEN}${BIN_NAME} credentials create --template ci --project <project-id> --expires 90d${NC}"
}

print_agent_setup_next_steps() {
  echo -e "${BLUE}Agent setup later${NC}"
  echo -e "  ${GREEN}${BIN_NAME} login${NC}"
  echo -e "  ${GREEN}${BIN_NAME} mcp setup <codex|claude|cursor|vscode> --toolset readonly${NC}"
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

print_mcp_restart_notice() {
  echo -e "  ${YELLOW}Restart or reload configured MCP clients when you are ready to load new CloudEval tools.${NC}"
  echo -e "  ${MUTED}CloudEval does not restart those apps for you.${NC}"
}

print_mcp_setup_summary() {
  local configured="$1"
  local manual="$2"
  local failed="$3"
  local selected="$4"

  echo ""
  echo -e "${BLUE}MCP setup summary${NC}"
  if [ -n "$configured" ]; then
    echo -e "  ${GREEN}Configured:${NC} $(join_words ', ' $configured)"
  fi
  if [ -n "$manual" ]; then
    echo -e "  ${YELLOW}Manual:${NC} $(join_words ', ' $manual)"
  fi
  if [ -n "$failed" ]; then
    echo -e "  ${YELLOW}Failed:${NC} $(join_words ', ' $failed)"
  fi
  if [ -z "$configured$manual$failed" ]; then
    echo -e "  ${YELLOW}No MCP clients configured.${NC}"
  else
    echo -e "  Toolset: ${GREEN}readonly${NC}"
    print_mcp_restart_notice
  fi
  if [ -n "$manual$failed" ]; then
    echo -e "  Retry: ${GREEN}${BIN_NAME} mcp setup <client> --toolset readonly${NC}"
  fi
  if [ -z "$selected" ]; then
    echo -e "  Later: ${GREEN}${BIN_NAME} mcp setup <codex|claude|cursor|vscode> --toolset readonly${NC}"
  fi
}

telemetry_env_disables() {
  case "${CLOUDEVAL_TELEMETRY_DISABLED:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
  esac
  case "${CLOUDEVAL_TELEMETRY:-}" in
    0|false|FALSE|no|NO|off|OFF)
      return 0
      ;;
  esac
  return 1
}

write_telemetry_opt_out() {
  if "$DEST" config set telemetry.enabled false --format json >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Telemetry disabled in CloudEval CLI config.${NC}"
    return 0
  fi

  echo -e "${YELLOW}⚠ Could not write telemetry preference automatically. Run:${NC}" >&2
  echo -e "  ${BLUE}${BIN_NAME} config set telemetry.enabled false${NC}" >&2
  return 1
}

print_telemetry_notice() {
  echo -e "${BLUE}Telemetry${NC}"
  echo -e "  CloudEval sends limited CLI usage events to Azure Application Insights to improve reliability."
  echo -e "  It does not send prompts, command output, tokens, local paths, project/resource/account/session/tenant IDs, stack traces, or cloud resource names."
  echo -e "  It may include CLI/runtime versions and signed-in email/name after login."
}

configure_telemetry_preference() {
  echo ""
  print_telemetry_notice

  if telemetry_env_disables; then
    write_telemetry_opt_out || true
    return 0
  fi

  if [ -n "${CLOUDEVAL_SELF_TEST_TELEMETRY_ANSWER:-}" ]; then
    case "$CLOUDEVAL_SELF_TEST_TELEMETRY_ANSWER" in
      y|Y|yes|YES|true|TRUE|1)
        echo -e "${GREEN}✓ Telemetry enabled. Disable later with: ${BIN_NAME} config set telemetry.enabled false${NC}"
        return 0
        ;;
      *)
        write_telemetry_opt_out || true
        return 0
        ;;
    esac
  fi

  if can_prompt_on_tty; then
    if ask_yes_no "Share limited CLI telemetry?" "y"; then
      echo -e "${GREEN}✓ Telemetry enabled. Disable later with: ${BIN_NAME} config set telemetry.enabled false${NC}"
    else
      write_telemetry_opt_out || true
    fi
    return 0
  fi

  echo -e "${GREEN}✓ Telemetry enabled by default.${NC}"
  echo -e "  Disable with ${GREEN}CLOUDEVAL_TELEMETRY=0${NC} or ${GREEN}${BIN_NAME} config set telemetry.enabled false${NC}."
}

track_install_telemetry() {
  "$DEST" __telemetry install \
    --installer-type shell \
    --requested-version "$VERSION" \
    --resolved-version "$RESOLVED_VERSION" \
    --platform "${OS}-${ARCH}" \
    --aliases "${INSTALL_ALIASES:-unknown}" \
    --completions "${INSTALL_COMPLETIONS:-unknown}" \
    --mcp-setup "${INSTALL_MCP_SETUP:-unknown}" \
    --result success >/dev/null 2>&1 || true
}

run_optional_agent_setup() {
  if [ "${CLOUDEVAL_INSTALL_AGENT_SETUP:-1}" = "0" ]; then
    INSTALL_MCP_SETUP="disabled"
    return 0
  fi

  echo ""
  echo -e "${BLUE}CloudEval for agents${NC}"
  echo -e "  MCP adds CloudEval tools, recipes, and prompts to Codex, Claude, Cursor, and VS Code."

  local detected
  local configured_existing
  local setup_candidates
  local auto_setup_candidates
  local manual_setup_candidates
  detected="$(detect_mcp_clients)"
  configured_existing="$(detect_configured_mcp_clients)"
  setup_candidates="$(filter_unconfigured_mcp_clients "$detected" "$configured_existing")"
  auto_setup_candidates="$(filter_auto_setup_mcp_clients "$setup_candidates")"
  manual_setup_candidates="$(filter_manual_setup_mcp_clients "$setup_candidates")"

  if [ -n "$detected" ]; then
    echo -e "  Detected: ${GREEN}${detected}${NC}"
  else
    echo -e "  Detected: ${YELLOW}none${NC}"
  fi
  if [ -n "$configured_existing" ]; then
    echo -e "  Already configured: ${GREEN}${configured_existing}${NC}"
  fi
  if [ -n "$auto_setup_candidates" ]; then
    echo -e "  Setup available for: ${GREEN}${auto_setup_candidates}${NC}"
  fi
  if [ -n "$manual_setup_candidates" ]; then
    echo -e "  Manual setup available for: ${YELLOW}${manual_setup_candidates}${NC}"
  fi
  if [ -z "$auto_setup_candidates" ] && [ -n "$manual_setup_candidates" ] && [ -z "${CLOUDEVAL_INSTALL_MCP_CLIENTS:-}" ]; then
    echo -e "  ${YELLOW}Skipping automatic MCP setup prompt because only manual-only clients are missing.${NC}"
    echo -e "  Later: ${GREEN}${BIN_NAME} mcp setup <client> --toolset readonly${NC}"
    if [ -n "$configured_existing" ]; then
      print_mcp_restart_notice
    fi
    INSTALL_MCP_SETUP="manual_only"
    return 0
  elif [ -n "$detected" ] && [ -z "${CLOUDEVAL_INSTALL_MCP_CLIENTS:-}" ]; then
    echo -e "  ${GREEN}✓ MCP already configured for detected clients; skipping setup prompt.${NC}"
    if [ -n "$configured_existing" ]; then
      print_mcp_restart_notice
    fi
    INSTALL_MCP_SETUP="already_configured"
    return 0
  fi

  if ! can_prompt_on_tty; then
    print_agent_setup_next_steps
    INSTALL_MCP_SETUP="skipped"
    return 0
  fi

  if [ -z "${CLOUDEVAL_INSTALL_MCP_CLIENTS:-}" ] && ! ask_agent_setup_yes_no "Set up CloudEval MCP for missing agents and IDEs now?" "n"; then
    print_agent_setup_next_steps
    INSTALL_MCP_SETUP="declined"
    return 0
  fi

  local selected="${CLOUDEVAL_INSTALL_MCP_CLIENTS:-}"
  if [ -z "$selected" ]; then
    if [ -n "$auto_setup_candidates" ]; then
      read -r -p "$(echo -e "${BLUE}MCP clients? missing/all/codex,cursor/skip [missing]: ${NC}")" selected < /dev/tty || selected=""
      selected="${selected:-missing}"
    else
      read -r -p "$(echo -e "${BLUE}MCP clients? all/codex,cursor/skip [skip]: ${NC}")" selected < /dev/tty || selected=""
      selected="${selected:-skip}"
    fi
  fi

  local normalized
  normalized="$(normalize_mcp_client_selection "$selected" "$auto_setup_candidates")"
  normalized="$(filter_unconfigured_mcp_clients "$normalized" "$configured_existing")"
  if [ -z "$normalized" ]; then
    if [ -n "$configured_existing" ]; then
      echo -e "${GREEN}✓ Selected MCP clients are already configured. No MCP setup changes needed.${NC}"
      print_mcp_restart_notice
      INSTALL_MCP_SETUP="already_configured"
    else
      echo -e "${YELLOW}Skipped MCP setup.${NC}"
      INSTALL_MCP_SETUP="skipped"
    fi
  fi

  if [ -n "$normalized" ] && ask_agent_setup_yes_no "Run ${BIN_NAME} login now first?" "n"; then
    if "$DEST" login; then
      echo -e "${GREEN}✓ Login completed${NC}"
    else
      echo -e "${YELLOW}⚠ Login did not complete. You can rerun: ${BIN_NAME} login${NC}"
    fi
  fi

  local client
  local configured=""
  local manual=""
  local failed=""
  local log_file
  local log_dir
  log_dir="$(mktemp -d "${TMPDIR:-/tmp}/cloudeval-mcp-setup.XXXXXX")"
  for client in $normalized; do
    if [ "$client" = "vscode" ] && ! command -v code >/dev/null 2>&1; then
      echo -e "  ${YELLOW}• vscode${NC} ${MUTED}manual; VS Code 'code' command not found${NC}"
      manual="$(append_unique_client "$manual" "$client")"
      continue
    fi

    log_file="$log_dir/${client}.log"
    if setup_mcp_client "$client" >"$log_file" 2>&1; then
      echo -e "  ${GREEN}✓ ${client}${NC}"
      configured="$(append_unique_client "$configured" "$client")"
    else
      echo -e "  ${YELLOW}⚠ ${client}${NC} ${MUTED}setup failed${NC}"
      failed="$(append_unique_client "$failed" "$client")"
    fi
  done
  rm -rf "$log_dir"

  print_credentials_next_steps
  print_mcp_setup_summary "$configured" "$manual" "$failed" "$normalized"
  if [ -n "$failed" ]; then
    INSTALL_MCP_SETUP="partial"
  elif [ -n "$configured$manual" ]; then
    INSTALL_MCP_SETUP="configured"
  else
    INSTALL_MCP_SETUP="${INSTALL_MCP_SETUP:-skipped}"
  fi
}

REPO="ganakailabs/cloudeval-cli"
VERSION="${1:-latest}"
BIN_NAME="cloudeval"

if [ "${1:-}" = "--self-test-agent-detection" ]; then
  detect_mcp_clients
  exit 0
fi

if [ "${1:-}" = "--self-test-agent-configured" ]; then
  detect_configured_mcp_clients
  exit 0
fi

if [ "${1:-}" = "--self-test-agent-candidates" ]; then
  filter_unconfigured_mcp_clients "${2:-}" "${3:-}"
  exit 0
fi

if [ "${1:-}" = "--self-test-agent-auto-candidates" ]; then
  filter_auto_setup_mcp_clients "${2:-}"
  exit 0
fi

if [ "${1:-}" = "--self-test-agent-manual-candidates" ]; then
  filter_manual_setup_mcp_clients "${2:-}"
  exit 0
fi

if [ "${1:-}" = "--self-test-agent-selection" ]; then
  normalize_mcp_client_selection "${2:-}" "${3:-}"
  exit 0
fi

if [ "${1:-}" = "--self-test-agent-next-steps" ]; then
  print_agent_setup_next_steps
  exit 0
fi

if [ "${1:-}" = "--self-test-mcp-summary" ]; then
  print_mcp_setup_summary "${2:-}" "${3:-}" "${4:-}" "${5:-}"
  exit 0
fi

if [ "${1:-}" = "--self-test-telemetry-env" ]; then
  if telemetry_env_disables; then
    printf 'disabled\n'
  else
    printf 'enabled\n'
  fi
  exit 0
fi

if [ "${1:-}" = "--self-test-telemetry-configure" ]; then
  DEST="${2:?missing fake cloudeval path}"
  configure_telemetry_preference
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

if [ "${1:-}" = "--self-test-progress-line" ]; then
  render_download_progress_snapshot "${2:-cloudeval-macos-arm64.gz}" "${3:-######################################################################## 100.0%}" 2>&1
  printf '\n'
  exit 0
fi

if [ "${1:-}" = "--self-test-progress-sync" ]; then
  tmp="$(mktemp)"
  CLOUDEVAL_FORCE_DOWNLOAD_PROGRESS=1 curl_download_file "${2:-https://example.invalid/cloudeval-test}" "$tmp" "${3:-cloudeval-test}" "0" 2>&1
  printf 'after download\n'
  rm -f "$tmp"
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
LICENSE_DIR="${HOME}/.local/share/cloudeval/licenses"
RESOLVED_VERSION="$(resolve_release_version)"
INSTALL_ALIASES="not_applicable"
INSTALL_COMPLETIONS="not_applicable"
INSTALL_MCP_SETUP="not_run"

echo -e "${BLUE}Installation Details:${NC}"
echo -e "  Requested Version: ${GREEN}${VERSION}${NC}"
echo -e "  Resolved Release: ${GREEN}${RESOLVED_VERSION}${NC}"
echo -e "  Platform: ${GREEN}${OS}-${ARCH}${NC}"
echo -e "  Binary Asset: ${GREEN}${BIN}${NC}"
echo -e "  Install Directory: ${GREEN}${DEST_DIR}${NC}"
echo -e "  Executable: ${GREEN}${DEST}${NC}"
echo -e "  Yoga Runtime: ${GREEN}${YOGA_DEST}${NC}"
echo -e "  License Notices: ${GREEN}${LICENSE_DIR}${NC}"
if [ "$OS" != "win" ]; then
  echo -e "  Aliases: ${GREEN}${DEST_DIR}/eva -> ${DEST}${NC}, ${GREEN}${DEST_DIR}/cloud -> ${DEST}${NC}"
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
  echo -e "     ${GREEN}pnpm --filter @ganakailabs/cloudeval-cli build:executable:current${NC}"
  echo -e "  5. Copy to your PATH:"
  echo -e "     ${GREEN}cp packages/cli/dist/bin/cloudeval ${DEST_DIR}/${BIN_NAME}${NC}"
  echo -e "     ${GREEN}cp packages/cli/dist/bin/yoga.wasm ${DEST_DIR}/yoga.wasm${NC}"
  echo -e "     ${GREEN}ln -sf ${DEST_DIR}/${BIN_NAME} ${DEST_DIR}/eva${NC}"
  echo -e "     ${GREEN}ln -sf ${DEST_DIR}/${BIN_NAME} ${DEST_DIR}/cloud${NC}"
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

echo ""
echo -e "${BLUE}Downloading license notices...${NC}"
mkdir -p "$LICENSE_DIR"
download_optional_notice_asset "LICENSE" "${LICENSE_DIR}/LICENSE"
download_optional_notice_asset "NOTICE" "${LICENSE_DIR}/NOTICE"
download_optional_notice_asset "THIRD_PARTY_NOTICES.md" "${LICENSE_DIR}/THIRD_PARTY_NOTICES.md"
download_optional_notice_asset "sbom.spdx.json" "${LICENSE_DIR}/sbom.spdx.json"

if [ "$OS" != "win" ]; then
  echo ""
  if ask_yes_no "Create 'eva' and 'cloud' alias symlinks?" "y"; then
    ln -sf "$DEST" "${DEST_DIR}/eva"
    ln -sf "$DEST" "${DEST_DIR}/cloud"
    INSTALL_ALIASES="created"
    echo -e "${GREEN}✓ Created 'eva' and 'cloud' aliases${NC}"
  else
    INSTALL_ALIASES="declined"
  fi
fi

echo ""
echo -e "${GREEN}✓ Installation complete!${NC}"
echo -e "  Binary installed to: ${GREEN}${DEST}${NC}"
echo ""

configure_telemetry_preference

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
if [ "$OS" != "win" ] && [ -L "${DEST_DIR}/eva" ] && [ -L "${DEST_DIR}/cloud" ]; then
  echo -e "${GREEN}Or use an alias: eva --help or cloud --help${NC}"
elif [ "$OS" != "win" ] && [ -L "${DEST_DIR}/eva" ]; then
  echo -e "${GREEN}Or use the alias: eva --help${NC}"
elif [ "$OS" != "win" ] && [ -L "${DEST_DIR}/cloud" ]; then
  echo -e "${GREEN}Or use the alias: cloud --help${NC}"
fi
echo ""

if [ "${CLOUDEVAL_INSTALL_COMPLETION:-1}" != "0" ] && [ "$OS" != "win" ]; then
  shell_name="$(basename "$SHELL" 2>/dev/null || echo bash)"
  echo -e "${BLUE}Shell tab completions${NC}"
  if ask_yes_no "Install tab completions for ${shell_name} (detected from \$SHELL)?" "y"; then
    case "$shell_name" in
      zsh|bash|fish)
        if "$DEST" completion install --shell "$shell_name"; then
          INSTALL_COMPLETIONS="installed"
          echo -e "${GREEN}✓ Installed ${shell_name} completions. Open a new terminal or reload your shell.${NC}"
        else
          INSTALL_COMPLETIONS="failed"
          echo -e "${YELLOW}⚠ Could not install completions automatically. Run: ${BIN_NAME} completion install --shell ${shell_name}${NC}"
        fi
        ;;
      *)
        INSTALL_COMPLETIONS="unsupported"
        echo -e "${YELLOW}⚠ Automatic install supports bash, zsh, and fish. Run:${NC}"
        echo -e "  ${BLUE}${BIN_NAME} completion install --shell powershell${NC} ${YELLOW}(PowerShell)${NC}"
        ;;
    esac
  else
    INSTALL_COMPLETIONS="declined"
  fi
  echo ""
elif [ "${CLOUDEVAL_INSTALL_COMPLETION:-1}" = "0" ]; then
  INSTALL_COMPLETIONS="disabled"
fi

run_optional_agent_setup
track_install_telemetry
