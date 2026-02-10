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
TOTAL_STEPS=8
next_step() { STEP=$((STEP + 1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

printf "${BOLD}psibot setup${NC}\n"
printf "Project: %s\n\n" "$PROJECT_ROOT"

# --- 1. Preflight ---
next_step
info "Preflight checks"

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "macOS required (detected: $(uname -s))"
fi

if ! xcode-select -p &>/dev/null; then
  fail "Xcode Command Line Tools not installed. Run: xcode-select --install"
fi

printf "  macOS %s, Xcode CLT installed\n" "$(sw_vers -productVersion)"

# --- 2. Homebrew ---
next_step
if command -v brew &>/dev/null; then
  skip "Homebrew already installed"
else
  info "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# --- 3. Homebrew packages ---
next_step
info "Installing Homebrew packages"

BREW_PACKAGES=(bun sqlite yt-dlp)
INSTALLED_FORMULAE=$(brew list --formula 2>/dev/null || true)

for pkg in "${BREW_PACKAGES[@]}"; do
  if echo "$INSTALLED_FORMULAE" | grep -qx "$pkg"; then
    printf "  ${YELLOW}%s${NC} already installed\n" "$pkg"
  else
    printf "  Installing %s...\n" "$pkg"
    brew install "$pkg"
  fi
done

# --- 4. uv ---
next_step
if command -v uv &>/dev/null; then
  skip "uv already installed"
else
  info "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# --- 5. Node packages ---
next_step
info "Installing node packages"
cd "$PROJECT_ROOT"
bun install

# --- 6. Configure .env ---
next_step
info "Configuring .env"

if [[ -f "$PROJECT_ROOT/.env" ]]; then
  printf "  ${YELLOW}.env already exists${NC}, skipping\n"
else
  cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
  printf "  Copied .env.example -> .env\n"

  # Prompt for required values
  printf "\n"
  read -rp "  Telegram bot token: " BOT_TOKEN
  if [[ -n "$BOT_TOKEN" ]]; then
    sed -i '' "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$BOT_TOKEN|" "$PROJECT_ROOT/.env"
  fi

  read -rp "  Allowed Telegram user IDs (comma-separated): " USER_IDS
  if [[ -n "$USER_IDS" ]]; then
    sed -i '' "s|^ALLOWED_TELEGRAM_USER_IDS=.*|ALLOWED_TELEGRAM_USER_IDS=$USER_IDS|" "$PROJECT_ROOT/.env"
  fi

  printf "  ${GREEN}.env configured${NC}\n"
fi

# --- 7. Link CLI + install daemon ---
next_step
info "Linking CLI and installing daemon"

cd "$PROJECT_ROOT"
bun link
printf "  psibot CLI linked\n"

psibot install
printf "  ${GREEN}Daemon installed${NC}\n"

# --- 8. Optional dependencies ---
next_step
info "Optional dependencies"
printf "\n"

OPTIONAL_INSTALLED=()

if ask "Install edge-tts (text-to-speech)?"; then
  pip install edge-tts
  OPTIONAL_INSTALLED+=("edge-tts")
fi

if [[ "$(uname -m)" == "arm64" ]]; then
  if ask "Install mlx-audio (speech-to-text, Apple Silicon)?"; then
    uv tool install mlx-audio
    OPTIONAL_INSTALLED+=("mlx-audio")
  fi
fi

if ! command -v tailscale &>/dev/null; then
  if ask "Install Tailscale (for webhook mode)?"; then
    brew install tailscale
    OPTIONAL_INSTALLED+=("tailscale")
  fi
fi

# --- Summary ---
printf "\n${BOLD}${GREEN}Setup complete${NC}\n\n"

printf "Installed:\n"
printf "  bun, sqlite, yt-dlp, uv\n"
printf "  node_modules (%s packages)\n" "$(ls "$PROJECT_ROOT/node_modules" | wc -l | tr -d ' ')"
printf "  psibot CLI + LaunchAgent daemon\n"
if [[ ${#OPTIONAL_INSTALLED[@]} -gt 0 ]]; then
  printf "  optional: %s\n" "$(IFS=', '; echo "${OPTIONAL_INSTALLED[*]}")"
fi

printf "\n${BOLD}Important:${NC}\n"
printf "  1. Grant Full Disk Access to bun: System Settings > Privacy > Full Disk Access\n"
printf "     Path: $(which bun)\n"
printf "  2. Ensure 'claude' CLI is in PATH (needed for Agent SDK OAuth)\n"
printf "  3. Run ${BOLD}psibot start${NC} to begin\n"
