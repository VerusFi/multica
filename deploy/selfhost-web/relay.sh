#!/bin/sh
set -eu

# relay.sh — one-liner bootstrap for multica-relay
# Downloads and runs the relay binary for the current platform

# Detect OS and architecture
OS=$(uname -s)
ARCH=$(uname -m)

# Map to asset names
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)
        ASSET="multica-relay-darwin-arm64"
        ;;
      x86_64)
        ASSET="multica-relay-darwin-amd64"
        ;;
      *)
        echo "ERROR: Unsupported macOS architecture: $ARCH" >&2
        exit 1
        ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64)
        ASSET="multica-relay-linux-amd64"
        ;;
      aarch64)
        ASSET="multica-relay-linux-arm64"
        ;;
      *)
        echo "ERROR: Unsupported Linux architecture: $ARCH" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "ERROR: Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# Default URL base (can be overridden via MULTICA_RELAY_URL_BASE env var).
# Pinned to the rolling `selfhost-latest` release tag, not
# `releases/latest/download` — this repo's GitHub "latest release" is
# claimed by the ordinary vX.Y.Z app releases (release.yml), which ship no
# relay binaries at all; a plain "latest" URL here would 404. See
# deploy/selfhost-web/dev/NOTES.md ("rolling selfhost-latest release
# channel").
URL_BASE="${MULTICA_RELAY_URL_BASE:-https://github.com/VerusFi/multica/releases/download/selfhost-latest}"
DOWNLOAD_URL="$URL_BASE/$ASSET"

# Target directory and file
TARGET_DIR="$HOME/.multica"
TARGET_FILE="$TARGET_DIR/multica-relay"

# Create target directory if it doesn't exist
mkdir -p "$TARGET_DIR"

# Download the binary
echo "Downloading $ASSET from $DOWNLOAD_URL..."
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TARGET_FILE"; then
  rm -f "$TARGET_FILE"
  echo "ERROR: Failed to download $ASSET" >&2
  exit 1
fi

# Make it executable
chmod +x "$TARGET_FILE"

# Print the address and run in foreground.
#
# The relay accepts WebSockets only from localhost origins by default (it is
# an unauthenticated outbound proxy — see relay/main.go), so a page served
# from a real deployment (GitHub Pages) must be allowed explicitly. The
# page's own "Run a relay" one-liner sets MULTICA_RELAY_ORIGIN to its own
# origin for exactly that; any extra arguments are forwarded to the relay too
# (e.g. `curl -fsSL … | sh -s -- -listen 127.0.0.1:9000`).
echo "wisp://localhost:8086"
if [ -n "${MULTICA_RELAY_ORIGIN:-}" ]; then
  exec "$TARGET_FILE" -origin "$MULTICA_RELAY_ORIGIN" "$@"
fi
exec "$TARGET_FILE" "$@"
