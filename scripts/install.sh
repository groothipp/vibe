#!/usr/bin/env bash
set -euo pipefail

# Vibe install script
# Usage: curl -fsSL https://raw.githubusercontent.com/groothipp/vibe/main/scripts/install.sh | bash

REPO="groothipp/vibe"
INSTALL_DIR="/Applications"

echo "Installing Vibe..."

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) LABEL="macos-arm64" ;;
  x86_64)        LABEL="macos-x64" ;;
  *)
    echo "Error: unsupported architecture $ARCH"
    exit 1
    ;;
esac

# Get latest release tag
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)
if [ -z "$TAG" ]; then
  echo "Error: could not find latest release"
  exit 1
fi

echo "  Version: $TAG"
echo "  Arch:    $LABEL"

# Find the .dmg URL
DMG_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep "browser_download_url.*${LABEL}.*\.dmg" \
  | head -1 | cut -d'"' -f4)

if [ -z "$DMG_URL" ]; then
  echo "Error: could not find .dmg for $LABEL"
  exit 1
fi

# Download
TMPDIR=$(mktemp -d)
DMG_PATH="$TMPDIR/vibe.dmg"
echo "  Downloading..."
curl -fsSL "$DMG_URL" -o "$DMG_PATH"

# Mount, copy, unmount
echo "  Installing to /Applications..."
MOUNT=$(hdiutil attach "$DMG_PATH" -nobrowse -noverify 2>/dev/null | grep '/Volumes' | awk -F'\t' '{print $NF}')
APP=$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)

if [ -z "$APP" ]; then
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  echo "Error: no .app found in DMG"
  exit 1
fi

sudo rm -rf "$INSTALL_DIR/Vibe Editor.app"
sudo cp -R "$APP" "$INSTALL_DIR/"
hdiutil detach "$MOUNT" -quiet 2>/dev/null || true

# Clear quarantine
sudo xattr -cr "$INSTALL_DIR/Vibe Editor.app"

# Install CLI
CLI_PATH="/usr/local/bin/vibe"
APP_BIN="$INSTALL_DIR/Vibe Editor.app/Contents/MacOS/Vibe Editor"

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

# Clean up
rm -rf "$TMPDIR"

echo ""
echo "Vibe installed successfully."
echo "  App: /Applications/Vibe Editor.app"
echo "  CLI: $CLI_PATH"
echo ""
echo "Run 'vibe' from any directory to start."
