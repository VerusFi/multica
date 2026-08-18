#!/bin/sh
# Tests for relay.sh's pre-flight checks, using PATH fakes only — no real
# python3, curl, or network is ever touched.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
relay_sh="$here/../relay.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fakebin="$work/bin"
mkdir -p "$fakebin"
fails=0

run_relay_sh() {
  set +e
  out="$(HOME="$work" MULTICA_RELAY_URL_BASE="http://url-base.invalid" \
        PATH="$fakebin" /bin/sh "$relay_sh" 2>&1)"
  status=$?
  set -e
}

expect_failure_with() { # name, expected substring
  if [ "$status" -eq 0 ]; then
    echo "FAIL $1: expected a non-zero exit"; fails=$((fails + 1)); return
  fi
  case "$out" in
    *"$2"*) echo "PASS $1" ;;
    *) echo "FAIL $1: output did not contain '$2':"; echo "$out"; fails=$((fails + 1)) ;;
  esac
}

write_stub() { # path, body
  printf '#!/bin/sh\n%s\n' "$2" > "$1"
  chmod +x "$1"
}

# --- 1. Linux without python3 ------------------------------------------------
write_stub "$fakebin/uname" 'echo Linux'
run_relay_sh
expect_failure_with "linux-no-python3" "python3 not found"

# --- 2. macOS without python3 points at the Command Line Tools ---------------
write_stub "$fakebin/uname" 'echo Darwin'
run_relay_sh
expect_failure_with "macos-no-python3" "xcode-select --install"

# --- 3. macOS with python3 but no Command Line Tools -------------------------
write_stub "$fakebin/python3" 'exit 0'
run_relay_sh
expect_failure_with "macos-no-clt" "xcode-select --install"

# --- 4. python3 too old ------------------------------------------------------
write_stub "$fakebin/uname" 'echo Linux'
write_stub "$fakebin/python3" 'if [ "${1:-}" = "-V" ]; then echo "Python 3.8.10"; exit 0; fi; exit 1'
run_relay_sh
expect_failure_with "python3-too-old" "Python 3.9 or newer"

# --- 5. download failure cleans up the partial file --------------------------
write_stub "$fakebin/python3" 'exit 0'
write_stub "$fakebin/curl" 'while [ "$#" -gt 1 ]; do shift; done; echo partial > "$1"; exit 22'
for tool in mkdir rm; do ln -sf "$(command -v $tool)" "$fakebin/$tool"; done
run_relay_sh
expect_failure_with "download-failure" "Failed to download relay.py"
if [ -e "$work/.multica/relay.py" ]; then
  echo "FAIL download-failure-cleanup: partial relay.py left behind"; fails=$((fails + 1))
else
  echo "PASS download-failure-cleanup"
fi

# --- 6. happy path: downloads, prints the address, execs python3 -------------
write_stub "$fakebin/curl" 'while [ "$#" -gt 1 ]; do shift; done; echo fake-relay > "$1"'
write_stub "$fakebin/python3" 'echo "RELAY_STARTED $*"'
run_relay_sh_happy() {
  set +e
  out="$(HOME="$work" MULTICA_RELAY_URL_BASE="http://url-base.invalid" \
        MULTICA_RELAY_ORIGIN="https://owner.github.io" \
        PATH="$fakebin" /bin/sh "$relay_sh" -listen 127.0.0.1:9000 2>&1)"
  status=$?
  set -e
}
run_relay_sh_happy
if [ "$status" -ne 0 ]; then
  echo "FAIL happy-path: exit $status:"; echo "$out"; fails=$((fails + 1))
else
  case "$out" in
    *"wisp://localhost:8086"*) : ;;
    *) echo "FAIL happy-path: missing wisp:// line:"; echo "$out"; fails=$((fails + 1)) ;;
  esac
  case "$out" in
    *"RELAY_STARTED"*"-origin https://owner.github.io"*"-listen 127.0.0.1:9000"*)
      echo "PASS happy-path" ;;
    *) echo "FAIL happy-path: python3 not exec'd with forwarded args:"; echo "$out"; fails=$((fails + 1)) ;;
  esac
fi
[ -e "$work/.multica/relay.py" ] || { echo "FAIL happy-path-download: relay.py missing"; fails=$((fails + 1)); }

exit "$fails"
