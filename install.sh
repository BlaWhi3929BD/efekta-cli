#!/usr/bin/env bash
# Efekta CLI & MCP Server Installer (Linux & macOS)
# One-command installer for beginners: bash install.sh
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}     Efekta CLI & MCP Server — Universal Installer    ${NC}"
echo -e "${BLUE}======================================================${NC}"

# 1. Detect OS & Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    GOARCH="amd64"
    ;;
  aarch64|arm64)
    GOARCH="arm64"
    ;;
  *)
    echo -e "${RED}Unsupported CPU architecture: $ARCH${NC}"
    exit 1
    ;;
esac

case "$OS" in
  linux)
    GOOS="linux"
    ;;
  darwin)
    GOOS="darwin"
    ;;
  *)
    echo -e "${RED}Unsupported operating system: $OS. Please use Windows PowerShell install.ps1 on Windows.${NC}"
    exit 1
    ;;
esac

echo -e "✓ Detected platform: ${GREEN}${GOOS}/${GOARCH}${NC}"

# 2. Check for Go compiler
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_NAME="efekta"
TARGET_DIR="$HOME/.local/bin"

if ! command -v go >/dev/null 2>&1; then
  echo -e "\n${YELLOW}Go compiler is not installed on this system.${NC}"
  echo -e "You can install Go in 1 minute using your package manager:"
  if [ "$GOOS" = "darwin" ]; then
    echo -e "  ${GREEN}brew install go${NC}"
  elif command -v apt-get >/dev/null 2>&1; then
    echo -e "  ${GREEN}sudo apt update && sudo apt install -y golang-go${NC}"
  elif command -v dnf >/dev/null 2>&1; then
    echo -e "  ${GREEN}sudo dnf install -y golang${NC}"
  elif command -v pacman >/dev/null 2>&1; then
    echo -e "  ${GREEN}sudo pacman -S go${NC}"
  elif command -v zypper >/dev/null 2>&1; then
    echo -e "  ${GREEN}sudo zypper install go${NC}"
  fi
  echo -e "Or download the official Go installer from: https://go.dev/dl/\n"
  exit 1
fi

echo -e "✓ Found Go compiler: ${GREEN}$(go version)${NC}"

# 3. Build static binary
echo -e "\nBuilding static ${BIN_NAME} binary..."
mkdir -p "$SCRIPT_DIR/bin"
(
  cd "$SCRIPT_DIR"
  CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "bin/$BIN_NAME" ./cmd/efekta
)
echo -e "✓ Built ${GREEN}$SCRIPT_DIR/bin/$BIN_NAME${NC}"

# 4. Install into ~/.local/bin
mkdir -p "$TARGET_DIR"
rm -f "$TARGET_DIR/$BIN_NAME"
cp -f "$SCRIPT_DIR/bin/$BIN_NAME" "$TARGET_DIR/$BIN_NAME"
chmod +x "$TARGET_DIR/$BIN_NAME"
echo -e "✓ Installed executable to ${GREEN}$TARGET_DIR/$BIN_NAME${NC}"

# 5. Check PATH and suggest/add export if missing
CURRENT_PATH=":$PATH:"
if [[ "$CURRENT_PATH" != *":$TARGET_DIR:"* ]]; then
  echo -e "\n${YELLOW}Notice:${NC} $TARGET_DIR is not currently in your system PATH."

  SHELL_RC=""
  if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  elif [ -f "$HOME/.profile" ]; then
    SHELL_RC="$HOME/.profile"
  fi

  if [ -n "$SHELL_RC" ]; then
    PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
    if ! grep -qs 'HOME/.local/bin' "$SHELL_RC"; then
      echo "$PATH_LINE" >> "$SHELL_RC"
      echo -e "✓ Automatically added $TARGET_DIR to ${GREEN}$SHELL_RC${NC}"
      echo -e "  Run: ${GREEN}source $SHELL_RC${NC} (or open a new terminal) to refresh PATH."
    fi
  else
    echo -e "Add this line to your ~/.bashrc or ~/.zshrc:"
    echo -e "  ${GREEN}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
  fi
fi

# 6. Verify run
echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}     Installation Complete!                           ${NC}"
echo -e "${GREEN}======================================================${NC}"
echo -e "Version check:"
"$TARGET_DIR/$BIN_NAME" daemon status || true

echo -e "\n${BLUE}Next 2 Steps to Start:${NC}"
echo -e "1. Open your browser's extension page:"
echo -e "   • Chrome / Brave / Edge: ${GREEN}chrome://extensions${NC} -> Enable 'Developer mode' -> 'Load unpacked' -> Select:"
echo -e "     ${GREEN}$SCRIPT_DIR/extension${NC}"
echo -e "   • Firefox / Zen: ${GREEN}about:debugging#/runtime/this-firefox${NC} -> 'Load Temporary Add-on...' -> Select:"
echo -e "     ${GREEN}$SCRIPT_DIR/extension/manifest.json${NC}"
echo -e "2. Open ${GREEN}https://learn.better.efekta.com${NC} and run:"
echo -e "   ${GREEN}efekta status${NC}"
echo -e "   ${GREEN}efekta auto${NC}"
