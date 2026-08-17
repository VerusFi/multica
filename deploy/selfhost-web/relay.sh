#!/bin/sh
set -eu

# relay.sh — one-liner bootstrap for multica-relay
#
# The relay itself is a single stdlib-only Python file (relay.py, served as
# a static asset next to this script — no compiled binary, no GitHub
# Releases). This wrapper does the parts python can't do for itself: check
# that a usable python3 exists (with a clear message when it doesn't),
# download relay.py, and run it in the foreground.

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

OS="$(uname -s)"

# python3 present? On a fresh macOS, /usr/bin/python3 is an Apple stub that
# opens an "install the Command Line Developer Tools?" dialog when run;
# xcode-select -p says whether the real tools are installed, so we can
# explain instead of letting a GUI dialog interrupt a piped script.
if ! command -v python3 >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    fail "python3 not found. Install Apple's Command Line Tools first: xcode-select --install"
  fi
  fail "python3 not found. Install it with your distribution's package manager (e.g. apt install python3, dnf install python3)."
fi
if [ "$OS" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  fail "python3 on this Mac is Apple's placeholder: running it would open the Command Line Tools install dialog. Run 'xcode-select --install', then re-run this command."
fi

# Version floor: relay.py is written for Python >= 3.9.
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
  fail "python3 is too old ($(python3 -V 2>&1)). multica-relay needs Python 3.9 or newer."
fi

# Where relay.py comes from: the same static site that served this script.
# The page's one-liner passes its own base URL via MULTICA_RELAY_URL_BASE so
# a fork's Pages deployment downloads from itself; the default is the
# canonical fork's Pages site.
URL_BASE="${MULTICA_RELAY_URL_BASE:-https://verusfi.github.io/multica}"
DOWNLOAD_URL="${URL_BASE%/}/relay.py"

TARGET_DIR="$HOME/.multica"
TARGET_FILE="$TARGET_DIR/relay.py"
mkdir -p "$TARGET_DIR"

echo "Downloading relay.py from $DOWNLOAD_URL..."
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TARGET_FILE"; then
  rm -f "$TARGET_FILE"
  fail "Failed to download relay.py"
fi

# Print the address and run in foreground.
#
# The relay accepts WebSockets only from localhost origins by default (it
# is an unauthenticated outbound proxy — see relay.py's own preamble), so a
# page served from a real deployment (GitHub Pages) must be allowed
# explicitly. The page's own "Run a relay" one-liner sets
# MULTICA_RELAY_ORIGIN to its own origin for exactly this; any extra
# arguments are forwarded to the relay too
# (e.g. `curl -fsSL … | sh -s -- -listen 127.0.0.1:9000`).
echo "wisp://localhost:8086"
if [ -n "${MULTICA_RELAY_ORIGIN:-}" ]; then
  exec python3 "$TARGET_FILE" -origin "$MULTICA_RELAY_ORIGIN" "$@"
fi
exec python3 "$TARGET_FILE" "$@"
