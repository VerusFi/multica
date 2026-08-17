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
import asyncio
import base64
import fnmatch
import hashlib
import logging
import re
import struct

log = logging.getLogger("multica-relay")

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


# --- WebSocket server (RFC 6455, hand-rolled: the stdlib has none) ----------

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Cap on one reassembled WebSocket message so a client cannot make the relay
# allocate without bound. Far above the ~32 KiB DATA frames WISP uses.
MAX_MESSAGE = 4 * 1024 * 1024

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WSClosed(Exception):
    """The peer closed the WebSocket (close frame, EOF, or protocol error)."""


def ws_accept_key(key):
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def apply_mask(payload, mask):
    """XOR payload with the repeating 4-byte mask (RFC 6455 §5.3).
    Done as one big-int XOR instead of a per-byte loop: guest traffic goes
    through here, and CPython arithmetic on bytes objects is fast."""
    if not payload:
        return b""
    n = len(payload)
    repeated = (mask * ((n + 3) // 4))[:n]
    return (int.from_bytes(payload, "little")
            ^ int.from_bytes(repeated, "little")).to_bytes(n, "little")


def encode_ws_frame(opcode, payload):
    """Server-to-client frame: FIN set, never masked (RFC 6455 §5.1)."""
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    return bytes(header) + payload


async def read_http_request(reader):
    """Read one HTTP request head. Returns (request_line, headers) with
    lower-cased header names."""
    head = await reader.readuntil(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    headers = {}
    for line in lines[1:]:
        if not line:
            continue
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return lines[0], headers


async def perform_handshake(reader, writer, patterns):
    """Validate the upgrade request and its Origin, then complete the
    RFC 6455 handshake. Returns True when the socket is now a WebSocket."""
    try:
        _, headers = await read_http_request(reader)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
        return False
    origin = headers.get("origin", "")
    if not origin_allowed(origin, patterns):
        # Logged (not silently dropped) because a rejected Origin is the one
        # failure a legitimate user can hit — a page deployed somewhere the
        # relay wasn't told about shows up in the browser only as "could not
        # connect to relay". See -origin.
        log.info("websocket accept rejected (origin %r): origin not allowed", origin)
        writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
        await writer.drain()
        return False
    key = headers.get("sec-websocket-key", "")
    if ("websocket" not in headers.get("upgrade", "").lower()
            or "upgrade" not in headers.get("connection", "").lower()
            or not key):
        writer.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
        await writer.drain()
        return False
    writer.write(("HTTP/1.1 101 Switching Protocols\r\n"
                  "Upgrade: websocket\r\n"
                  "Connection: Upgrade\r\n"
                  "Sec-WebSocket-Accept: " + ws_accept_key(key) + "\r\n"
                  "\r\n").encode("ascii"))
    await writer.drain()
    return True


class WSConn:
    """Minimal server-side WebSocket connection: binary messages in/out,
    fragmentation reassembly, PING answered with PONG."""

    def __init__(self, reader, writer):
        self._reader = reader
        self._writer = writer
        self._send_lock = asyncio.Lock()

    async def _read(self, n):
        try:
            return await self._reader.readexactly(n)
        except (asyncio.IncompleteReadError, ConnectionError) as exc:
            raise WSClosed("eof") from exc

    async def _send(self, opcode, payload):
        async with self._send_lock:
            self._writer.write(encode_ws_frame(opcode, payload))
            await self._writer.drain()

    async def send_message(self, payload):
        await self._send(OP_BINARY, payload)

    async def recv_message(self):
        """Return the next complete data-message payload.
        Raises WSClosed when the peer goes away or breaks protocol."""
        message = bytearray()
        in_fragments = False
        while True:
            first2 = await self._read(2)
            fin = bool(first2[0] & 0x80)
            opcode = first2[0] & 0x0F
            masked = bool(first2[1] & 0x80)
            length = first2[1] & 0x7F
            if length == 126:
                (length,) = struct.unpack(">H", await self._read(2))
            elif length == 127:
                (length,) = struct.unpack(">Q", await self._read(8))
            if length + len(message) > MAX_MESSAGE:
                raise WSClosed("message too large")
            if not masked:
                # RFC 6455 §5.1: client frames MUST be masked.
                raise WSClosed("unmasked client frame")
            mask = await self._read(4)
            payload = apply_mask(await self._read(length), mask) if length else b""
            if opcode == OP_CLOSE:
                raise WSClosed("close frame")
            if opcode == OP_PING:
                await self._send(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CONT:
                if not in_fragments:
                    raise WSClosed("unexpected continuation frame")
                message += payload
            elif opcode in (OP_TEXT, OP_BINARY):
                if in_fragments:
                    raise WSClosed("new message inside a fragmented message")
                message += payload
            else:
                raise WSClosed("unknown opcode")
            if fin:
                return bytes(message)
            in_fragments = True
