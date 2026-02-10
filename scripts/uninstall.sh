#!/usr/bin/env bash
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# --- Helpers ---
info()  { printf "${GREEN}[%s/%s]${NC} %s\n" "$STEP" "$TOTAL_STEPS" "$1"; }
skip()  { printf "${YELLOW}[%s/%s]${NC} %s (skipped)\n" "$STEP" "$TOTAL_STEPS" "$1"; }
warn()  { printf "${YELLOW}warning:${NC} %s\n" "$1"; }
fail()  { printf "${RED}error:${NC} %s\n" "$1" >&2; exit 1; }
ask()   {
  local prompt="$1" default="${2:-N}"
  if [[ "$default" == "Y" ]]; then
    printf "${BLUE}?${NC} %s [Y/n] " "$prompt"
  else
    printf "${BLUE}?${NC} %s [y/N] " "$prompt"
  fi
  read -r ans
  ans="${ans:-$default}"
  [[ "$ans" =~ ^[Yy] ]]
}

STEP=0
TOTAL_STEPS=4
next_step() { STEP=$((STEP + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PSIBOT_DIR="$HOME/.psibot"

printf "${BOLD}psibot uninstall${NC}\n"
printf "Project: %s\n\n" "$PROJECT_ROOT"

REMOVED=()

# --- 1. Stop and uninstall daemon ---
next_step

if command -v psibot &>/dev/null; then
  info "Stopping and uninstalling daemon"

  psibot stop 2>/dev/null || true
  psibot uninstall 2>/dev/null || true
  REMOVED+=("LaunchAgent daemon")
else
  # Fallback: try direct launchctl if psibot CLI is gone
  PLIST_PATH="$HOME/Library/LaunchAgents/com.psibot.daemon.plist"
  if [[ -f "$PLIST_PATH" ]]; then
    info "Stopping and uninstalling daemon (direct)"
    UID_NUM=$(id -u)
    launchctl bootout "gui/$UID_NUM/com.psibot.daemon" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    REMOVED+=("LaunchAgent daemon")
  else
    skip "Daemon not installed"
  fi
fi

# --- 2. Unlink CLI ---
next_step

if command -v psibot &>/dev/null; then
  info "Unlinking CLI"
  cd "$PROJECT_ROOT"
  bun unlink 2>/dev/null || true
  # Also remove from bun bin directly in case unlink doesn't catch it
  rm -f "$HOME/.bun/bin/psibot"
  REMOVED+=("psibot CLI")
else
  skip "psibot CLI not linked"
fi

# --- 3. Optional cleanup ---
next_step
info "Optional cleanup"
printf "\n"

if [[ -d "$PSIBOT_DIR" ]]; then
  if ask "Remove ~/.psibot directory (logs, PID, launcher)?"; then
    rm -rf "$PSIBOT_DIR"
    REMOVED+=("~/.psibot")
  fi
fi

if [[ -d "$PROJECT_ROOT/data" ]]; then
  if ask "Remove data directory (database, media, audio)?"; then
    rm -rf "$PROJECT_ROOT/data"
    REMOVED+=("data/")
  fi
fi

if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
  if ask "Remove node_modules?"; then
    rm -rf "$PROJECT_ROOT/node_modules"
    REMOVED+=("node_modules/")
  fi
fi

if command -v pip &>/dev/null && pip show edge-tts &>/dev/null 2>&1; then
  if ask "Uninstall edge-tts?"; then
    pip uninstall -y edge-tts
    REMOVED+=("edge-tts")
  fi
fi

if command -v uv &>/dev/null && uv tool list 2>/dev/null | grep -q "mlx-audio"; then
  if ask "Uninstall mlx-audio?"; then
    uv tool uninstall mlx-audio
    REMOVED+=("mlx-audio")
  fi
fi

# --- 4. Summary ---
next_step
printf "\n${BOLD}${GREEN}Uninstall complete${NC}\n\n"

if [[ ${#REMOVED[@]} -gt 0 ]]; then
  printf "Removed:\n"
  for item in "${REMOVED[@]}"; do
    printf "  - %s\n" "$item"
  done
else
  printf "Nothing was removed.\n"
fi

printf "\n${BOLD}Note:${NC} Homebrew, bun, sqlite, uv, and yt-dlp were not removed (shared system tools).\n"
printf "To remove them manually: brew uninstall bun sqlite yt-dlp && rm -rf ~/.local/bin/uv\n"
