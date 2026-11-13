#!/usr/bin/env bash
# setup.sh — Cross-platform installer for Project Map MCP
# Works on macOS, Linux, and Windows (Git Bash / WSL / MSYS2).
#
# Usage:
#   ./setup.sh                                    # interactive
#   ./setup.sh --project /path/to/project         # auto-detect clients
#   ./setup.sh --client claude-desktop --project . # specific client
#   ./setup.sh --uninstall --client cursor         # remove config
#   ./setup.sh --check                             # verify setup

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput &>/dev/null; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  GREEN=$(tput setaf 2); RED=$(tput setaf 1); YELLOW=$(tput setaf 3); CYAN=$(tput setaf 6)
else
  BOLD="" DIM="" RESET="" GREEN="" RED="" YELLOW="" CYAN=""
fi

# ── Globals ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ENTRY="$SCRIPT_DIR/dist/index.js"
PROJECT_PATH=""
CLIENT=""
UNINSTALL=false
CHECK_ONLY=false

# ── Helpers ───────────────────────────────────────────────────────────
info()  { printf "%s[pmap]%s %s\n" "$CYAN" "$RESET" "$1"; }
ok()    { printf "%s[pmap]%s %s%s%s\n" "$GREEN" "$RESET" "$GREEN" "$1" "$RESET"; }
warn()  { printf "%s[pmap]%s %s%s%s\n" "$YELLOW" "$RESET" "$YELLOW" "$1" "$RESET"; }
err()   { printf "%s[pmap]%s %s%s%s\n" "$RED" "$RESET" "$RED" "$1" "$RESET" >&2; }
die()   { err "$1"; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "macos" ;;
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)        echo "unknown" ;;
  esac
}

# Convert WSL path to Windows path when needed
to_native_path() {
  local p="$1"
  local os="$2"
  if [ "$os" = "wsl" ] && command -v wslpath &>/dev/null; then
    wslpath -w "$p"
  else
    echo "$p"
  fi
}

# Ensure directory exists for a file path
ensure_dir() {
  local dir
  dir="$(dirname "$1")"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    info "Created directory: $dir"
  fi
}

# ── Config file locations per client per OS ───────────────────────────
get_config_path() {
  local client="$1"
  local os="$2"

  case "$client" in
    claude-desktop)
      case "$os" in
        macos)   echo "$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
        linux)   echo "$HOME/.config/Claude/claude_desktop_config.json" ;;
        wsl)     echo "$(wslpath "$(cmd.exe /C 'echo %APPDATA%' 2>/dev/null | tr -d '\r')")/Claude/claude_desktop_config.json" ;;
        windows) echo "$APPDATA/Claude/claude_desktop_config.json" ;;
      esac
      ;;
    claude-code)
      echo "$HOME/.claude/settings.json"
      ;;
    cursor)
      case "$os" in
        macos)   echo "$HOME/.cursor/mcp.json" ;;
        linux)   echo "$HOME/.cursor/mcp.json" ;;
        wsl)     echo "$HOME/.cursor/mcp.json" ;;
        windows) echo "$APPDATA/../.cursor/mcp.json" ;;
      esac
      ;;
    windsurf)
      case "$os" in
        macos)   echo "$HOME/.codeium/windsurf/mcp_config.json" ;;
        linux)   echo "$HOME/.codeium/windsurf/mcp_config.json" ;;
        wsl)     echo "$HOME/.codeium/windsurf/mcp_config.json" ;;
        windows) echo "$APPDATA/../.codeium/windsurf/mcp_config.json" ;;
      esac
      ;;
    *)
      echo ""
      ;;
  esac
}

# ── Check if a client is likely installed ─────────────────────────────
is_client_installed() {
  local client="$1"
  local os="$2"
  local config_path
  config_path="$(get_config_path "$client" "$os")"

  case "$client" in
    claude-desktop)
      case "$os" in
        macos)   [ -d "/Applications/Claude.app" ] && return 0 ;;
        linux)   command -v claude-desktop &>/dev/null && return 0 ;;
        wsl|windows) [ -n "$config_path" ] && [ -f "$config_path" ] && return 0 ;;
      esac
      # Config dir exists even without app
      [ -n "$config_path" ] && [ -d "$(dirname "$config_path")" ] && return 0
      ;;
    claude-code)
      command -v claude &>/dev/null && return 0
      [ -d "$HOME/.claude" ] && return 0
      ;;
    cursor)
      case "$os" in
        macos)   [ -d "/Applications/Cursor.app" ] && return 0 ;;
        *)       command -v cursor &>/dev/null && return 0 ;;
      esac
      [ -d "$HOME/.cursor" ] && return 0
      ;;
    windsurf)
      case "$os" in
        macos)   [ -d "/Applications/Windsurf.app" ] && return 0 ;;
        *)       command -v windsurf &>/dev/null && return 0 ;;
      esac
      [ -d "$HOME/.codeium/windsurf" ] && return 0
      ;;
  esac
  return 1
}

# ── JSON merge (pure bash + node fallback) ────────────────────────────
# Merges the pmap MCP server config into an existing JSON config file.
# If the file doesn't exist, creates it. If it exists, merges mcpServers.
write_mcp_config() {
  local config_path="$1"
  local server_path="$2"
  local project_root="$3"

  ensure_dir "$config_path"

  # Use Node.js for reliable JSON manipulation
  node -e "
    const fs = require('fs');
    const configPath = process.argv[1];
    const serverPath = process.argv[2];
    const projectRoot = process.argv[3];

    let config = {};
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8').trim();
        if (raw) config = JSON.parse(raw);
      }
    } catch (e) {
      // If parse fails, back up and start fresh
      if (fs.existsSync(configPath)) {
        const backup = configPath + '.backup.' + Date.now();
        fs.copyFileSync(configPath, backup);
        console.error('Backed up malformed config to: ' + backup);
      }
      config = {};
    }

    if (!config.mcpServers) config.mcpServers = {};

    config.mcpServers['project-map-mcp'] = {
      command: 'node',
      args: [serverPath],
      env: {
        PROJECT_MAP_PROJECT_ROOT: projectRoot
      }
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  " "$config_path" "$server_path" "$project_root"
}

# ── Remove pmap config from a client ──────────────────────────────────
remove_mcp_config() {
  local config_path="$1"

  if [ ! -f "$config_path" ]; then
    warn "Config file not found: $config_path"
    return 0
  fi

  node -e "
    const fs = require('fs');
    const configPath = process.argv[1];

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.mcpServers && config.mcpServers['project-map-mcp']) {
        delete config.mcpServers['project-map-mcp'];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        console.log('Removed project-map-mcp from ' + configPath);
      } else {
        console.log('project-map-mcp not found in ' + configPath);
      }
    } catch (e) {
      console.error('Failed to parse: ' + configPath);
      process.exit(1);
    }
  " "$config_path"
}

# ── Verify setup ──────────────────────────────────────────────────────
verify_setup() {
  local os
  os="$(detect_os)"
  local found=0
  local clients=("claude-desktop" "claude-code" "cursor" "windsurf")

  info "Checking Project Map MCP installation..."
  echo ""

  # Check server binary
  if [ -f "$SERVER_ENTRY" ]; then
    ok "  Server binary: $SERVER_ENTRY"
  else
    err "  Server binary not found: $SERVER_ENTRY"
    err "  Run 'npm run build' first."
  fi

  # Check node
  if command -v node &>/dev/null; then
    ok "  Node.js: $(node --version)"
  else
    err "  Node.js not found!"
  fi

  echo ""
  info "Client configurations:"

  for client in "${clients[@]}"; do
    local config_path
    config_path="$(get_config_path "$client" "$os")"
    if [ -z "$config_path" ]; then
      continue
    fi

    if [ -f "$config_path" ]; then
      if node -e "
        const fs = require('fs');
        const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
        process.exit(c.mcpServers && c.mcpServers['project-map-mcp'] ? 0 : 1);
      " "$config_path" 2>/dev/null; then
        ok "  $client: configured"
        found=$((found + 1))
      else
        warn "  $client: config exists but pmap not configured"
      fi
    else
      if is_client_installed "$client" "$os"; then
        warn "  $client: installed but not configured"
      else
        printf "  %s%s: not detected%s\n" "$DIM" "$client" "$RESET"
      fi
    fi
  done

  echo ""
  if [ "$found" -gt 0 ]; then
    ok "Project Map MCP is configured in $found client(s)."
  else
    warn "Project Map MCP is not configured in any client."
    info "Run './setup.sh --project /path/to/project' to configure."
  fi
}

# ── Interactive client selection ──────────────────────────────────────
select_clients_interactive() {
  local os="$1"
  local available=()
  local clients=("claude-desktop" "claude-code" "cursor" "windsurf")

  info "Detecting installed MCP clients..."
  echo ""

  for client in "${clients[@]}"; do
    if is_client_installed "$client" "$os"; then
      available+=("$client")
      ok "  Found: $client"
    fi
  done

  if [ ${#available[@]} -eq 0 ]; then
    warn "No MCP clients detected."
    info "Available clients: claude-desktop, claude-code, cursor, windsurf"
    printf "\n"
    read -rp "Enter client name(s) separated by spaces: " -a available
  else
    echo ""
    read -rp "Configure all detected clients? [Y/n] " confirm
    if [[ "${confirm,,}" == "n" ]]; then
      printf "Enter client name(s): "
      read -ra available
    fi
  fi

  echo "${available[@]}"
}

# ── Parse arguments ───────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p)
      PROJECT_PATH="$(cd "$2" 2>/dev/null && pwd || echo "$2")"
      shift 2 ;;
    --client|-c)
      CLIENT="$2"
      shift 2 ;;
    --uninstall|-u)
      UNINSTALL=true
      shift ;;
    --check)
      CHECK_ONLY=true
      shift ;;
    --help|-h)
      cat <<EOF
${BOLD}Project Map MCP — Setup Script${RESET}

Usage:
  ./setup.sh [options]

Options:
  --project, -p PATH    Target project path to analyze
  --client, -c NAME     Configure specific client (claude-desktop|claude-code|cursor|windsurf)
  --uninstall, -u       Remove pmap configuration from client(s)
  --check               Verify current installation
  --help, -h            Show this help

Examples:
  ./setup.sh                                     # Interactive setup
  ./setup.sh -p /path/to/project                 # Auto-detect and configure all clients
  ./setup.sh -c claude-desktop -p .              # Configure Claude Desktop only
  ./setup.sh --uninstall -c cursor               # Remove from Cursor
  ./setup.sh --check                             # Check installation status
EOF
      exit 0 ;;
    *)
      die "Unknown option: $1 (use --help for usage)" ;;
  esac
done

# ── Main ──────────────────────────────────────────────────────────────
OS="$(detect_os)"

printf "\n%s%s Project Map MCP Setup %s\n" "$BOLD" "$CYAN" "$RESET"
printf "  OS: %s\n\n" "$OS"

# Check mode
if $CHECK_ONLY; then
  verify_setup
  exit 0
fi

# Uninstall mode
if $UNINSTALL; then
  if [ -z "$CLIENT" ]; then
    die "Specify --client to uninstall from (or use --check to see current config)"
  fi
  config_path="$(get_config_path "$CLIENT" "$OS")"
  if [ -z "$config_path" ]; then
    die "Unknown client: $CLIENT"
  fi
  remove_mcp_config "$config_path"
  ok "Done."
  exit 0
fi

# Verify prerequisites
if ! command -v node &>/dev/null; then
  die "Node.js is required. Install from https://nodejs.org/"
fi

if [ ! -f "$SERVER_ENTRY" ]; then
  warn "Server binary not found. Building..."
  (cd "$SCRIPT_DIR" && npm run build) || die "Build failed. Run 'npm install && npm run build' manually."
fi

# Get project path
if [ -z "$PROJECT_PATH" ]; then
  read -rp "$(printf '%s[pmap]%s Enter project path to analyze: ' "$CYAN" "$RESET")" PROJECT_PATH
  PROJECT_PATH="$(cd "$PROJECT_PATH" 2>/dev/null && pwd || echo "$PROJECT_PATH")"
fi

if [ ! -d "$PROJECT_PATH" ]; then
  die "Project directory not found: $PROJECT_PATH"
fi

info "Server: $SERVER_ENTRY"
info "Project: $PROJECT_PATH"
echo ""

# Resolve absolute paths for config
SERVER_ABS="$(to_native_path "$SERVER_ENTRY" "$OS")"
PROJECT_ABS="$(to_native_path "$PROJECT_PATH" "$OS")"

# Determine which clients to configure
if [ -n "$CLIENT" ]; then
  CLIENTS=("$CLIENT")
else
  read -ra CLIENTS <<< "$(select_clients_interactive "$OS")"
fi

if [ ${#CLIENTS[@]} -eq 0 ]; then
  die "No clients selected."
fi

echo ""

# Configure each client
for client in "${CLIENTS[@]}"; do
  config_path="$(get_config_path "$client" "$OS")"
  if [ -z "$config_path" ]; then
    warn "Unknown client: $client (skipping)"
    continue
  fi

  info "Configuring $client..."
  write_mcp_config "$config_path" "$SERVER_ABS" "$PROJECT_ABS"
  ok "  Written: $config_path"
done

echo ""
ok "Setup complete!"
echo ""
info "Next steps:"
echo "  1. Restart your IDE/client for changes to take effect"
echo "  2. The MCP server will start automatically when the client connects"
echo "  3. Use 'pmap init' and 'pmap sync --full' for initial indexing"
echo ""
info "Run './setup.sh --check' to verify the configuration"
