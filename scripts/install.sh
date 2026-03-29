#!/usr/bin/env bash
set -euo pipefail

# Vibe install script
# macOS:  curl -fsSL https://raw.githubusercontent.com/groothipp/vibe/main/scripts/install.sh | bash
# Linux:  curl -fsSL https://raw.githubusercontent.com/groothipp/vibe/main/scripts/install.sh | bash

REPO="groothipp/vibe"
API_URL="https://api.github.com/repos/$REPO/releases/latest"

echo "Installing Vibe..."

OS="$(uname -s)"
ARCH="$(uname -m)"

# Get latest release info (fetch once)
RELEASE_JSON=$(curl -fsSL "$API_URL")
TAG=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | cut -d'"' -f4)

if [ -z "$TAG" ]; then
  echo "Error: could not find latest release"
  exit 1
fi

echo "  Version: $TAG"
echo "  OS:      $OS"
echo "  Arch:    $ARCH"

find_asset() {
  echo "$RELEASE_JSON" | grep "browser_download_url.*$1" | head -1 | cut -d'"' -f4
}

install_macos() {
  case "$ARCH" in
    arm64|aarch64) ASSET_URL=$(find_asset "_aarch64\.dmg") ;;
    x86_64)        ASSET_URL=$(find_asset "_x64\.dmg") ;;
    *) echo "Error: unsupported architecture $ARCH"; exit 1 ;;
  esac

  if [ -z "$ASSET_URL" ]; then
    echo "Error: could not find .dmg download"
    exit 1
  fi

  TMPDIR=$(mktemp -d)
  echo "  Downloading..."
  curl -fsSL "$ASSET_URL" -o "$TMPDIR/vibe.dmg"

  echo "  Installing to /Applications..."
  MOUNT=$(hdiutil attach "$TMPDIR/vibe.dmg" -nobrowse -noverify 2>/dev/null | grep '/Volumes' | awk -F'\t' '{print $NF}')
  APP=$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)

  if [ -z "$APP" ]; then
    hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
    echo "Error: no .app found in DMG"
    exit 1
  fi

  sudo rm -rf "/Applications/Vibe Editor.app"
  sudo cp -R "$APP" /Applications/
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  sudo xattr -cr "/Applications/Vibe Editor.app"
  rm -rf "$TMPDIR"

  # Install CLI
  APP_BIN="/Applications/Vibe Editor.app/Contents/MacOS/Vibe Editor"
  install_cli_wrapper "$APP_BIN"

  echo ""
  echo "Vibe installed successfully."
  echo "  App: /Applications/Vibe Editor.app"
  echo "  CLI: /usr/local/bin/vibe"
}

install_linux() {
  # Prefer .deb on Debian/Ubuntu, .rpm on Fedora/RHEL, fall back to AppImage
  if command -v dpkg >/dev/null 2>&1; then
    ASSET_URL=$(find_asset "_amd64\.deb")
    if [ -n "$ASSET_URL" ]; then
      TMPDIR=$(mktemp -d)
      echo "  Downloading .deb..."
      curl -fsSL "$ASSET_URL" -o "$TMPDIR/vibe.deb"
      echo "  Installing..."
      sudo dpkg -i "$TMPDIR/vibe.deb" || sudo apt-get install -f -y
      rm -rf "$TMPDIR"
      install_cli_wrapper "/usr/bin/vibe-editor"
      echo ""
      echo "Vibe installed successfully."
      echo "  CLI: /usr/local/bin/vibe"
      return
    fi
  fi

  if command -v rpm >/dev/null 2>&1; then
    ASSET_URL=$(find_asset "\.x86_64\.rpm")
    if [ -n "$ASSET_URL" ]; then
      TMPDIR=$(mktemp -d)
      echo "  Downloading .rpm..."
      curl -fsSL "$ASSET_URL" -o "$TMPDIR/vibe.rpm"
      echo "  Installing..."
      sudo rpm -i "$TMPDIR/vibe.rpm" || sudo dnf install -y "$TMPDIR/vibe.rpm" 2>/dev/null || true
      rm -rf "$TMPDIR"
      install_cli_wrapper "/usr/bin/vibe-editor"
      echo ""
      echo "Vibe installed successfully."
      echo "  CLI: /usr/local/bin/vibe"
      return
    fi
  fi

  # Fallback: AppImage
  ASSET_URL=$(find_asset "_amd64\.AppImage")
  if [ -z "$ASSET_URL" ]; then
    echo "Error: could not find a compatible download (.deb, .rpm, or .AppImage)"
    exit 1
  fi

  echo "  Downloading AppImage..."
  sudo mkdir -p /opt/vibe
  sudo curl -fsSL "$ASSET_URL" -o /opt/vibe/vibe-editor.AppImage
  sudo chmod +x /opt/vibe/vibe-editor.AppImage
  install_cli_wrapper "/opt/vibe/vibe-editor.AppImage"

  echo ""
  echo "Vibe installed successfully."
  echo "  App: /opt/vibe/vibe-editor.AppImage"
  echo "  CLI: /usr/local/bin/vibe"
}

install_cli_wrapper() {
  local APP_BIN="$1"
  local CLI_PATH="/usr/local/bin/vibe"

  echo "  Installing CLI to $CLI_PATH..."
  cat > /tmp/vibe-cli << WRAPPER
#!/bin/sh
# vibe-cli-wrapper
TARGET="\${1:-.}"
if [ ! -d "\$TARGET" ]; then echo "vibe: '\$TARGET' is not a directory" >&2; exit 1; fi
TARGET="\$(cd "\$TARGET" && pwd)"
cd "\$TARGET" || exit 1
nohup "$APP_BIN" >/dev/null 2>&1 &
WRAPPER

  sudo install -m 755 /tmp/vibe-cli "$CLI_PATH"
  rm -f /tmp/vibe-cli
}

case "$OS" in
  Darwin) install_macos ;;
  Linux)  install_linux ;;
  *)
    echo "Error: unsupported OS '$OS'"
    echo "On Windows, download the installer from:"
    echo "  https://github.com/$REPO/releases/latest"
    exit 1
    ;;
esac

echo ""
echo "Run 'vibe' from any directory to start."
