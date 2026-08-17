#!/usr/bin/env python3
"""multica-relay — WISP v1 relay for the in-browser selfhost page.

Single file, Python 3.9+, standard library only: that is the whole point —
running the relay must not require a compiled binary, a package manager, or
anything beyond the python3 the OS already has. relay.sh downloads this
file from the Pages site and runs it; relay.ps1 is the Windows sibling
(a second, self-contained implementation of the same contract).

This relay is an unauthenticated outbound TCP/UDP proxy: anything that can
open a WebSocket to it can make this machine dial arbitrary hosts and
ports (that is its whole job — it is what gives a v86 guest, which cannot
open raw sockets from a browser tab, real internet access). There is no
authentication in the WISP protocol and none bolted on here, so the only
two things standing between "the guest in your own tab" and "anyone else"
are the listen address and the WebSocket Origin check below. Both default
to the tightest setting that still lets the shipped page work.
"""
import fnmatch
import re
import struct

# --- WISP v1 protocol -------------------------------------------------------

TYPE_CONNECT = 0x01
TYPE_DATA = 0x02
TYPE_CONTINUE = 0x03
TYPE_CLOSE = 0x04

# The flow-control window advertised on session open and after every DATA
# write, matching the Go relay this file replaced.
INITIAL_BUFFER = 128

CLOSE_INVALID_PAYLOAD = 0x41
CLOSE_CONNECT_FAILED = 0x42
CLOSE_GENERIC = 0x02


def encode_frame(frame_type, stream_id, payload):
    """One WISP frame: 1-byte type, little-endian uint32 stream id, payload."""
    return struct.pack("<BI", frame_type, stream_id) + payload


def decode_frame(data):
    """Split a WISP frame into (type, stream_id, payload). Raises ValueError."""
    if len(data) < 5:
        raise ValueError("wisp: frame shorter than header")
    frame_type, stream_id = struct.unpack_from("<BI", data)
    return frame_type, stream_id, bytes(data[5:])


def parse_connect(payload):
    """Split a CONNECT payload into (stream_type, port, host). Raises ValueError."""
    if len(payload) < 4:
        raise ValueError("wisp: connect payload too short")
    stream_type = payload[0]
    (port,) = struct.unpack_from("<H", payload, 1)
    try:
        host = bytes(payload[3:]).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("wisp: connect host is not valid UTF-8") from exc
    return stream_type, port, host


def continue_payload(remaining):
    return struct.pack("<I", remaining)


# --- Origin allowlist -------------------------------------------------------

# The WebSocket Origin allowlist. Localhost is allowed by default so a page
# served from a local static server (README, "Local usage without Pages")
# works out of the box. A page served from a real deployment (GitHub Pages)
# has that site's origin, which must be allowed explicitly with -origin —
# the page's own "Run a relay" one-liner passes its origin through
# MULTICA_RELAY_ORIGIN for exactly this reason.
#
# Note: the "[::1]" entries are inherited verbatim from the Go relay. In
# glob syntax "[" opens a character class, so they never actually matched an
# IPv6-loopback Origin — exactly as Go's filepath.Match behaved. They are
# kept for default-for-default parity; browsers use localhost/127.0.0.1 in
# practice.
DEFAULT_ORIGIN_PATTERNS = [
    "localhost", "localhost:*",
    "127.0.0.1", "127.0.0.1:*",
    "[::1]", "[::1]:*",
]

_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")


def normalize_origin_pattern(s):
    """Turn what a user (or the page's one-liner) naturally passes — a full
    origin like "https://owner.github.io" — into the bare host[:port] the
    allowlist matches on. Already-bare patterns pass through unchanged."""
    s = _SCHEME_RE.sub("", s.strip(), count=1)
    return s[:-1] if s.endswith("/") else s


def origin_allowed(origin, patterns):
    """Case-insensitive glob match of an Origin header against the
    allowlist. An absent Origin (a non-browser client) is allowed, matching
    the Go relay: this check exists to stop *other websites* in the same
    browser, and browsers always send Origin."""
    if not origin:
        return True
    host = normalize_origin_pattern(origin)
    return any(fnmatch.fnmatchcase(host.lower(), p.lower()) for p in patterns)


def parse_origin_flag(values):
    """-origin is repeatable and comma-separated; normalize every entry."""
    out = []
    for value in values:
        for part in value.split(","):
            normalized = normalize_origin_pattern(part)
            if normalized:
                out.append(normalized)
    return out
