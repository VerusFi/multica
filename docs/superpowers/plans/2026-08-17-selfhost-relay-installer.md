# Script-Only Selfhost Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compiled Go `multica-relay` binary with two script-only implementations — `relay.py` (Python 3.9+, stdlib only) for macOS/Linux and a self-contained `relay.ps1` (Windows PowerShell 5.1 + in-box .NET) for Windows — so running the relay needs no compiled artifact and no GitHub Releases download.

**Architecture:** `relay.py` is a single-file asyncio WISP v1 server with a hand-rolled RFC 6455 WebSocket layer (the Python stdlib has no WebSocket server). `relay.sh` becomes a thin pre-flight wrapper that checks `python3`, downloads `relay.py` from the same Pages site, and runs it. `relay.ps1` embeds a complete second implementation on HttpListener/.NET WebSockets, driven by a single-threaded Task-polling pump loop. A shared Node conformance suite is the parity gate between the two. The Go relay, its CI cross-compile, and its five release assets are removed.

**Tech Stack:** Python 3.9 stdlib (asyncio, struct, hashlib, base64, fnmatch, argparse), POSIX sh, Windows PowerShell 5.1 (.NET HttpListener, System.Net.WebSockets, TcpClient, UdpClient), Node 22 (net, dgram, crypto — no npm deps) for the conformance suite, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-17-selfhost-relay-installer-design.md`

## Global Constraints

- All code, comments, commit messages, and docs are English.
- `relay.py`: Python ≥ 3.9, **standard library only**, one single file. No pip, no vendoring.
- `relay.ps1`: must run on stock **Windows PowerShell 5.1** (no `pwsh`, no modules, no downloads); the whole relay lives in the one file.
- Behavior contract (all implementations): default bind `127.0.0.1:8086`; default Origin allowlist `localhost`, `localhost:*`, `127.0.0.1`, `127.0.0.1:*`, `[::1]`, `[::1]:*`; absent Origin header is allowed; WISP v1 frames CONNECT=0x01/DATA=0x02/CONTINUE=0x03/CLOSE=0x04 with little-endian stream ids; initial/refresh flow-control window 128; close reasons 0x41 (invalid payload), 0x42 (connect failed), 0x02 (generic); malformed WISP frames are ignored without killing the session; DATA to an unknown stream is ignored; every accepted client DATA write is answered with a CONTINUE(128).
- CLI contract: Go-style single-dash flags `-listen`, `-origin` (repeatable, comma-separable, full-URL or bare `host[:port]`), `-allow-any-origin` keep working verbatim (`relay.ps1` uses PowerShell params `-Listen`/`-Origin`/`-AllowAnyOrigin`, which bind the same spellings case-insensitively).
- Run all commands from `deploy/selfhost-web/` unless a step says otherwise.
- Commits are atomic with conventional prefixes; never commit a compiled binary.
- Existing suites must stay green: `node tests/run-tests.mjs` and (until the Go code is deleted in Task 8) `cd relay && go test ./...`.

## File Structure

| File | Responsibility |
| --- | --- |
| `deploy/selfhost-web/relay.py` | Create — the relay: WISP codec, origin allowlist, RFC 6455 layer, asyncio sessions, CLI |
| `deploy/selfhost-web/relay_test.py` | Create — stdlib `unittest` for the pure parts of relay.py |
| `deploy/selfhost-web/tests/relay-conformance.mjs` | Create — protocol conformance suite, runnable against any relay command |
| `deploy/selfhost-web/relay.sh` | Rewrite — python3 pre-flight + download relay.py + exec |
| `deploy/selfhost-web/tests/relay-sh.test.sh` | Create — PATH-fake tests for relay.sh pre-flight |
| `deploy/selfhost-web/relay.ps1` | Rewrite — complete self-contained PowerShell relay |
| `deploy/selfhost-web/js/ui.js` | Modify — one-liners pass `MULTICA_RELAY_URL_BASE`; comment updated |
| `deploy/selfhost-web/tests/smoke-firstboot.mjs`, `deploy/selfhost-web/dev/verify-{net,console,dashboard,firstboot,install}.mjs` | Modify — spawn `python3 relay.py` instead of `go build` |
| `deploy/selfhost-web/relay/` | Delete — whole Go implementation |
| `deploy/selfhost-web/.gitignore`, `deploy/selfhost-web/dev/.gitignore` | Modify — drop `.relay-bin` / `relay-binary` entries |
| `.github/workflows/selfhost-release.yml` | Modify — drop relay cross-compile and assets |
| `.github/workflows/selfhost-pages.yml` | Modify — stop excluding `relay/`, exclude `relay_test.py` |
| `.github/workflows/selfhost-relay-tests.yml` | Create — conformance CI on ubuntu + windows |
| `deploy/selfhost-web/README.md`, `deploy/selfhost-web/dev/NOTES.md` | Modify — script-only relay docs + public-relay note |
| `deploy/selfhost-web/js/ui.js` (again), `deploy/selfhost-web/selfhost.html`, `deploy/selfhost-web/tests/ui.spec.mjs` | Modify — "Test connection" button + WISP-greeting validation |

---

### Task 1: WISP codec and origin allowlist (`relay.py` part 1)

**Files:**
- Create: `deploy/selfhost-web/relay.py`
- Create: `deploy/selfhost-web/relay_test.py`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2–3 and by relay_test.py): module constants `TYPE_CONNECT`, `TYPE_DATA`, `TYPE_CONTINUE`, `TYPE_CLOSE`, `INITIAL_BUFFER`, `CLOSE_INVALID_PAYLOAD`, `CLOSE_CONNECT_FAILED`, `CLOSE_GENERIC`, `DEFAULT_ORIGIN_PATTERNS`; functions `encode_frame(frame_type, stream_id, payload) -> bytes`, `decode_frame(data) -> (int, int, bytes)` (raises `ValueError`), `parse_connect(payload) -> (int, int, str)` (raises `ValueError`), `continue_payload(remaining) -> bytes`, `normalize_origin_pattern(s) -> str`, `origin_allowed(origin, patterns) -> bool`, `parse_origin_flag(values) -> list[str]`.

- [ ] **Step 1: Write the failing tests**

Create `deploy/selfhost-web/relay_test.py`:

```python
"""Unit tests for the pure parts of relay.py (stdlib unittest only).

Protocol-level behavior (real WebSockets, real streams) is covered by
tests/relay-conformance.mjs, which runs against relay.py AND relay.ps1.
"""
import unittest

import relay


class NormalizeOriginPatternTest(unittest.TestCase):
    def test_table(self):
        # Mirror of the old Go relay's TestNormalizeOriginPattern.
        cases = {
            "https://owner.github.io": "owner.github.io",
            "http://localhost:8000/": "localhost:8000",
            " wss://relay.example:443": "relay.example:443",
            "*.example.com:*": "*.example.com:*",
            "localhost": "localhost",
        }
        for raw, want in cases.items():
            self.assertEqual(relay.normalize_origin_pattern(raw), want)


class OriginAllowedTest(unittest.TestCase):
    def test_foreign_origin_rejected_by_default(self):
        self.assertFalse(
            relay.origin_allowed("https://evil.example", relay.DEFAULT_ORIGIN_PATTERNS))

    def test_localhost_origins_allowed_by_default(self):
        for origin in ("http://localhost:8000", "http://127.0.0.1", "https://LOCALHOST:9443"):
            self.assertTrue(
                relay.origin_allowed(origin, relay.DEFAULT_ORIGIN_PATTERNS), origin)

    def test_absent_origin_allowed(self):
        # Non-browser clients send no Origin; the check exists to stop OTHER
        # websites in the same browser, which always send one.
        self.assertTrue(relay.origin_allowed("", relay.DEFAULT_ORIGIN_PATTERNS))
        self.assertTrue(relay.origin_allowed(None, relay.DEFAULT_ORIGIN_PATTERNS))

    def test_explicitly_allowed_origin(self):
        patterns = relay.DEFAULT_ORIGIN_PATTERNS + ["owner.github.io"]
        self.assertTrue(relay.origin_allowed("https://owner.github.io", patterns))

    def test_glob_pattern(self):
        self.assertTrue(relay.origin_allowed("https://a.example.com:8443", ["*.example.com:*"]))


class ParseOriginFlagTest(unittest.TestCase):
    def test_repeatable_and_comma_separated(self):
        # Mirror of the old Go relay's TestOriginListFlag.
        got = relay.parse_origin_flag(["https://a.example, b.example:8080", "c.example"])
        self.assertEqual(got, ["a.example", "b.example:8080", "c.example"])


class FrameCodecTest(unittest.TestCase):
    def test_encode_layout(self):
        self.assertEqual(
            relay.encode_frame(relay.TYPE_DATA, 7, b"ping"),
            b"\x02\x07\x00\x00\x00ping")

    def test_round_trip(self):
        frame_type, stream_id, payload = relay.decode_frame(
            relay.encode_frame(relay.TYPE_CONNECT, 123456, b"x"))
        self.assertEqual((frame_type, stream_id, payload), (relay.TYPE_CONNECT, 123456, b"x"))

    def test_short_frame_rejected(self):
        with self.assertRaises(ValueError):
            relay.decode_frame(b"\x02\x01\x00\x00")

    def test_parse_connect(self):
        payload = bytes([0x01, 0x39, 0x30]) + b"example.com"  # port 12345 little-endian
        self.assertEqual(relay.parse_connect(payload), (1, 12345, "example.com"))

    def test_parse_connect_too_short(self):
        with self.assertRaises(ValueError):
            relay.parse_connect(b"\x01\x00")

    def test_continue_payload_little_endian(self):
        self.assertEqual(relay.continue_payload(128), b"\x80\x00\x00\x00")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest relay_test -v`
Expected: FAIL/ERROR — `ModuleNotFoundError: No module named 'relay'`

- [ ] **Step 3: Write the implementation**

Create `deploy/selfhost-web/relay.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest relay_test -v`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add relay.py relay_test.py
git commit -m "feat(selfhost): WISP codec and origin allowlist for the Python relay"
```

---

### Task 2: RFC 6455 WebSocket server layer (`relay.py` part 2)

**Files:**
- Modify: `deploy/selfhost-web/relay.py` (append)
- Modify: `deploy/selfhost-web/relay_test.py` (append)

**Interfaces:**
- Consumes: Task 1's `origin_allowed`.
- Produces (used by Task 3 and the tests): `WS_GUID`, `MAX_MESSAGE`, opcodes `OP_CONT/OP_TEXT/OP_BINARY/OP_CLOSE/OP_PING/OP_PONG`, exception `WSClosed`, `ws_accept_key(key) -> str`, `apply_mask(payload, mask) -> bytes`, `encode_ws_frame(opcode, payload) -> bytes`, `read_http_request(reader) -> (str, dict)` (async), `perform_handshake(reader, writer, patterns) -> bool` (async), class `WSConn(reader, writer)` with async `send_message(payload)`, async `recv_message() -> bytes` (raises `WSClosed`).

- [ ] **Step 1: Write the failing tests**

Append to `deploy/selfhost-web/relay_test.py` (before the final `if __name__ == "__main__":` block):

```python
import asyncio


def client_frame(opcode, payload, fin=True, mask=b"\x01\x02\x03\x04"):
    """Build a masked client->server frame the way a browser would."""
    first = (0x80 if fin else 0x00) | opcode
    masked = relay.apply_mask(payload, mask)
    n = len(payload)
    if n < 126:
        header = bytes([first, 0x80 | n])
    elif n < 65536:
        header = bytes([first, 0x80 | 126]) + n.to_bytes(2, "big")
    else:
        header = bytes([first, 0x80 | 127]) + n.to_bytes(8, "big")
    return header + mask + masked


class FakeWriter:
    def __init__(self):
        self.data = bytearray()

    def write(self, data):
        self.data += data

    async def drain(self):
        pass


class WSHandshakeKeyTest(unittest.TestCase):
    def test_rfc6455_sample_vector(self):
        self.assertEqual(
            relay.ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")


class ApplyMaskTest(unittest.TestCase):
    def test_involution(self):
        payload = bytes(range(23))
        mask = b"\x01\x02\x03\x04"
        self.assertEqual(relay.apply_mask(relay.apply_mask(payload, mask), mask), payload)

    def test_known_vector(self):
        self.assertEqual(
            relay.apply_mask(b"\x00\x00\x00\x00\x00", b"\xaa\xbb\xcc\xdd"),
            b"\xaa\xbb\xcc\xdd\xaa")

    def test_empty(self):
        self.assertEqual(relay.apply_mask(b"", b"\x01\x02\x03\x04"), b"")


class EncodeWSFrameTest(unittest.TestCase):
    def test_small_frame(self):
        self.assertEqual(relay.encode_ws_frame(relay.OP_BINARY, b"hi"), b"\x82\x02hi")

    def test_medium_frame_uses_16bit_length(self):
        frame = relay.encode_ws_frame(relay.OP_BINARY, b"x" * 300)
        self.assertEqual(frame[:4], b"\x82\x7e\x01\x2c")

    def test_large_frame_uses_64bit_length(self):
        frame = relay.encode_ws_frame(relay.OP_BINARY, b"x" * 70000)
        self.assertEqual(frame[:2], b"\x82\x7f")
        self.assertEqual(int.from_bytes(frame[2:10], "big"), 70000)


class WSConnTest(unittest.TestCase):
    def _recv(self, wire):
        async def go():
            reader = asyncio.StreamReader()
            reader.feed_data(wire)
            reader.feed_eof()
            conn = relay.WSConn(reader, FakeWriter())
            return await conn.recv_message()
        return asyncio.run(go())

    def test_single_binary_message(self):
        self.assertEqual(self._recv(client_frame(relay.OP_BINARY, b"ping")), b"ping")

    def test_fragmented_message_reassembled(self):
        wire = (client_frame(relay.OP_BINARY, b"pi", fin=False)
                + client_frame(relay.OP_CONT, b"ng"))
        self.assertEqual(self._recv(wire), b"ping")

    def test_ping_between_fragments_answered_and_skipped(self):
        async def go():
            reader = asyncio.StreamReader()
            writer = FakeWriter()
            reader.feed_data(client_frame(relay.OP_BINARY, b"pi", fin=False)
                             + client_frame(relay.OP_PING, b"hello")
                             + client_frame(relay.OP_CONT, b"ng"))
            reader.feed_eof()
            conn = relay.WSConn(reader, writer)
            message = await conn.recv_message()
            return message, bytes(writer.data)
        message, sent = asyncio.run(go())
        self.assertEqual(message, b"ping")
        self.assertEqual(sent, relay.encode_ws_frame(relay.OP_PONG, b"hello"))

    def test_unmasked_client_frame_closes(self):
        # RFC 6455 §5.1: client frames MUST be masked.
        with self.assertRaises(relay.WSClosed):
            self._recv(b"\x82\x04ping")

    def test_close_frame_raises(self):
        with self.assertRaises(relay.WSClosed):
            self._recv(client_frame(relay.OP_CLOSE, b""))

    def test_eof_raises(self):
        with self.assertRaises(relay.WSClosed):
            self._recv(b"")


class PerformHandshakeTest(unittest.TestCase):
    REQUEST = (b"GET / HTTP/1.1\r\nHost: localhost\r\n"
               b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
               b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
               b"Sec-WebSocket-Version: 13\r\n"
               b"%s\r\n")

    def _handshake(self, origin_line):
        async def go():
            reader = asyncio.StreamReader()
            writer = FakeWriter()
            reader.feed_data(self.REQUEST % origin_line)
            reader.feed_eof()
            ok = await relay.perform_handshake(reader, writer, relay.DEFAULT_ORIGIN_PATTERNS)
            return ok, bytes(writer.data)
        return asyncio.run(go())

    def test_localhost_origin_upgrades(self):
        ok, response = self._handshake(b"Origin: http://localhost:8000\r\n")
        self.assertTrue(ok)
        self.assertIn(b"101 Switching Protocols", response)
        self.assertIn(b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", response)

    def test_foreign_origin_gets_403(self):
        ok, response = self._handshake(b"Origin: https://evil.example\r\n")
        self.assertFalse(ok)
        self.assertIn(b"403", response)

    def test_absent_origin_upgrades(self):
        ok, response = self._handshake(b"")
        self.assertTrue(ok)
        self.assertIn(b"101 Switching Protocols", response)
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `python3 -m unittest relay_test -v`
Expected: Task 1 tests PASS; new tests ERROR with `AttributeError: module 'relay' has no attribute 'apply_mask'` (and similar)

- [ ] **Step 3: Write the implementation**

In `deploy/selfhost-web/relay.py`, extend the import block to:

```python
import asyncio
import base64
import fnmatch
import hashlib
import logging
import re
import struct
```

Add below the import block:

```python
log = logging.getLogger("multica-relay")
```

Append at the end of the file:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest relay_test -v`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add relay.py relay_test.py
git commit -m "feat(selfhost): hand-rolled RFC 6455 server layer for relay.py"
```

---

### Task 3: asyncio WISP sessions and Go-style CLI (`relay.py` part 3)

**Files:**
- Modify: `deploy/selfhost-web/relay.py` (append)
- Modify: `deploy/selfhost-web/relay_test.py` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: `DEFAULT_LISTEN = "127.0.0.1:8086"`, `parse_listen(value) -> (host_or_None, port)` (raises `ValueError`), `build_arg_parser() -> argparse.ArgumentParser` (flags `-listen`/`-origin`/`-allow-any-origin`, dests `listen`/`origin`/`allow_any_origin`), async `handle_connection(reader, writer, patterns)`, async `run(args)`, `main(argv=None)`. Startup log line reports the **actual** bound address (so `-listen 127.0.0.1:0` is usable) in the form `multica-relay (WISP v1) listening on HOST:PORT (allowed origins: p1 p2 …)`.

- [ ] **Step 1: Write the failing tests**

Append to `deploy/selfhost-web/relay_test.py` (before `if __name__ == "__main__":`):

```python
class ParseListenTest(unittest.TestCase):
    def test_host_and_port(self):
        self.assertEqual(relay.parse_listen("127.0.0.1:8086"), ("127.0.0.1", 8086))

    def test_empty_host_means_all_interfaces(self):
        # The smoke test and dev harnesses pass ":18086", Go-style.
        self.assertEqual(relay.parse_listen(":18086"), (None, 18086))

    def test_bracketed_ipv6(self):
        self.assertEqual(relay.parse_listen("[::1]:8086"), ("::1", 8086))

    def test_missing_port_rejected(self):
        with self.assertRaises(ValueError):
            relay.parse_listen("8086")


class ArgParserTest(unittest.TestCase):
    def test_go_style_single_dash_flags(self):
        args = relay.build_arg_parser().parse_args(
            ["-listen", ":18086",
             "-origin", "https://a.example, b.example:8080",
             "-origin", "c.example"])
        self.assertEqual(args.listen, ":18086")
        self.assertEqual(relay.parse_origin_flag(args.origin),
                         ["a.example", "b.example:8080", "c.example"])
        self.assertFalse(args.allow_any_origin)

    def test_allow_any_origin_flag(self):
        args = relay.build_arg_parser().parse_args(["-allow-any-origin"])
        self.assertTrue(args.allow_any_origin)

    def test_defaults(self):
        args = relay.build_arg_parser().parse_args([])
        self.assertEqual(args.listen, relay.DEFAULT_LISTEN)
        self.assertEqual(args.origin, [])
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `python3 -m unittest relay_test -v`
Expected: new tests ERROR with `AttributeError: module 'relay' has no attribute 'parse_listen'`

- [ ] **Step 3: Write the implementation**

In `deploy/selfhost-web/relay.py`, add `import argparse` to the import block, then append at the end of the file:

```python
# --- WISP sessions ----------------------------------------------------------


class TCPStream:
    def __init__(self, writer):
        self._writer = writer

    async def write(self, data):
        self._writer.write(data)
        await self._writer.drain()

    def close(self):
        self._writer.close()


class UDPStream:
    def __init__(self, transport):
        self._transport = transport

    async def write(self, data):
        self._transport.sendto(data)

    def close(self):
        self._transport.close()


class Session:
    """One WebSocket client and its open streams."""

    def __init__(self, ws):
        self.ws = ws
        self.streams = {}  # stream id -> TCPStream | UDPStream
        self.tasks = set()

    def track(self, task):
        # asyncio holds only weak references to tasks; keep them alive.
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def send_frame(self, frame_type, stream_id, payload):
        try:
            await self.ws.send_message(encode_frame(frame_type, stream_id, payload))
        except (WSClosed, ConnectionError, OSError):
            pass

    async def close_stream(self, stream_id, reason):
        stream = self.streams.pop(stream_id, None)
        if stream is not None:
            stream.close()
        await self.send_frame(TYPE_CLOSE, stream_id, bytes([reason]))


async def pump_tcp(session, stream_id, reader):
    """Copy target->client until EOF/error, then CLOSE(0x02) the stream —
    the same lifecycle as the Go relay's per-stream read goroutine."""
    try:
        while True:
            data = await reader.read(32 * 1024)
            if not data:
                break
            await session.send_frame(TYPE_DATA, stream_id, data)
    except (ConnectionError, OSError):
        pass
    await session.close_stream(stream_id, CLOSE_GENERIC)


class UDPRelayProtocol(asyncio.DatagramProtocol):
    def __init__(self, session, stream_id, loop):
        self._session = session
        self._stream_id = stream_id
        self._loop = loop

    def datagram_received(self, data, addr):
        self._session.track(self._loop.create_task(
            self._session.send_frame(TYPE_DATA, self._stream_id, data)))

    def error_received(self, exc):
        self._session.track(self._loop.create_task(
            self._session.close_stream(self._stream_id, CLOSE_GENERIC)))


async def open_stream(session, stream_id, payload):
    try:
        stream_type, port, host = parse_connect(payload)
    except ValueError:
        await session.close_stream(stream_id, CLOSE_INVALID_PAYLOAD)
        return
    loop = asyncio.get_running_loop()
    try:
        if stream_type == 0x02:  # UDP
            transport, _ = await loop.create_datagram_endpoint(
                lambda: UDPRelayProtocol(session, stream_id, loop),
                remote_addr=(host, port))
            session.streams[stream_id] = UDPStream(transport)
        else:  # TCP. Hostnames resolve here, relay-side, like Go's net.Dial —
            # the guest's DNS-by-hostname CONNECTs depend on this.
            reader, writer = await asyncio.open_connection(host, port)
            session.streams[stream_id] = TCPStream(writer)
            session.track(loop.create_task(pump_tcp(session, stream_id, reader)))
    except OSError:
        await session.close_stream(stream_id, CLOSE_CONNECT_FAILED)


async def handle_connection(reader, writer, patterns):
    if not await perform_handshake(reader, writer, patterns):
        writer.close()
        return
    ws = WSConn(reader, writer)
    session = Session(ws)
    await session.send_frame(TYPE_CONTINUE, 0, continue_payload(INITIAL_BUFFER))
    try:
        while True:
            try:
                message = await ws.recv_message()
            except WSClosed:
                break
            try:
                frame_type, stream_id, payload = decode_frame(message)
            except ValueError:
                continue  # malformed frame: ignored, session stays up
            if frame_type == TYPE_CONNECT:
                await open_stream(session, stream_id, payload)
            elif frame_type == TYPE_DATA:
                stream = session.streams.get(stream_id)
                if stream is None:
                    continue
                try:
                    await stream.write(payload)
                except (ConnectionError, OSError):
                    await session.close_stream(stream_id, CLOSE_GENERIC)
                else:
                    await session.send_frame(
                        TYPE_CONTINUE, stream_id, continue_payload(INITIAL_BUFFER))
            elif frame_type == TYPE_CLOSE:
                await session.close_stream(stream_id, CLOSE_GENERIC)
    finally:
        for task in list(session.tasks):
            task.cancel()
        for stream in list(session.streams.values()):
            stream.close()
        session.streams.clear()
        writer.close()


# --- CLI --------------------------------------------------------------------

# Loopback, NOT ":8086" (all interfaces): a relay on all interfaces is an
# open proxy for every host on the user's LAN. Loopback costs the intended
# flow nothing — the relay dials *outward* regardless of what it binds, and
# the only client that needs to reach it is a browser on this machine.
DEFAULT_LISTEN = "127.0.0.1:8086"


def parse_listen(value):
    """Go-style listen addresses: "127.0.0.1:8086", ":18086" (all
    interfaces), "[::1]:8086". Returns (host_or_None, port)."""
    host, sep, port = value.rpartition(":")
    if not sep:
        raise ValueError("listen address must be host:port or :port")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return (host or None), int(port)


def build_arg_parser():
    parser = argparse.ArgumentParser(
        prog="multica-relay",
        description="WISP v1 relay for the multica in-browser selfhost page "
                    "(single file, stdlib only).")
    # Single-dash option strings on purpose: this file replaced a Go binary
    # whose flags were -listen / -origin / -allow-any-origin, and relay.sh,
    # the README, and shell history still pass them in that form.
    parser.add_argument(
        "-listen", "--listen", default=DEFAULT_LISTEN,
        help="listen address (defaults to loopback: this is an unauthenticated "
             "proxy, binding all interfaces exposes it to your whole LAN)")
    parser.add_argument(
        "-origin", "--origin", action="append", default=[],
        help="additional allowed browser origin, host[:port] or full URL; "
             "repeatable and comma-separated (e.g. -origin https://owner.github.io)")
    parser.add_argument(
        "-allow-any-origin", "--allow-any-origin", action="store_true",
        dest="allow_any_origin",
        help="accept WebSockets from ANY origin — any website open in another "
             "tab can then use this relay as a proxy; last resort only")
    return parser


async def run(args):
    if args.allow_any_origin:
        patterns = ["*"]
        log.warning("WARNING: -allow-any-origin is set: any website in any tab "
                    "can use this relay as an unauthenticated proxy from this machine")
    else:
        patterns = DEFAULT_ORIGIN_PATTERNS + parse_origin_flag(args.origin)
    host, port = parse_listen(args.listen)
    server = await asyncio.start_server(
        lambda r, w: handle_connection(r, w, patterns), host, port)
    bound = server.sockets[0].getsockname()
    # Log the *actual* bound address (not the flag) so `-listen 127.0.0.1:0`
    # is usable and the startup line is always truthful.
    log.info("multica-relay (WISP v1) listening on %s:%d (allowed origins: %s)",
             bound[0], bound[1], " ".join(patterns))
    async with server:
        await server.serve_forever()


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    args = build_arg_parser().parse_args(argv)
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except OSError as exc:
        # Most commonly: the port is already taken by another relay.
        raise SystemExit(
            "ERROR: could not listen on %s: %s. Is another relay already "
            "running? Try a different port, e.g. -listen 127.0.0.1:8087."
            % (args.listen, exc))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest relay_test -v`
Expected: all tests PASS

- [ ] **Step 5: Manual startup smoke**

Run: `python3 relay.py -listen 127.0.0.1:0 & sleep 1; kill %1`
Expected: one log line `… multica-relay (WISP v1) listening on 127.0.0.1:<real port> (allowed origins: localhost localhost:* 127.0.0.1 127.0.0.1:* [::1] [::1]:*)`

- [ ] **Step 6: Commit**

```bash
git add relay.py relay_test.py
git commit -m "feat(selfhost): asyncio WISP sessions and Go-style CLI for relay.py"
```

---

### Task 4: WISP conformance suite (parity gate)

**Files:**
- Create: `deploy/selfhost-web/tests/relay-conformance.mjs`

**Interfaces:**
- Consumes: a runnable relay command. Default `python3 relay.py`; any override via argv (Task 9 passes `powershell -NoProfile -ExecutionPolicy Bypass -File relay.ps1`). The suite always appends `-listen 127.0.0.1:<free port>` — `relay.ps1` binds `-listen` to its `-Listen` parameter case-insensitively, so one spelling serves both.
- Produces: exit code 0/1; `PASS`/`FAIL` lines per test. This suite is the replacement for the deleted Go tests' protocol coverage and the parity gate between relay.py and relay.ps1.

- [ ] **Step 1: Write the suite**

Create `deploy/selfhost-web/tests/relay-conformance.mjs`:

```js
#!/usr/bin/env node
// WISP relay conformance suite — the parity gate for the two script relays
// (and the replacement for the old Go relay's `go test` protocol coverage).
//
// Usage (from deploy/selfhost-web/):
//   node tests/relay-conformance.mjs
//   node tests/relay-conformance.mjs powershell -NoProfile -ExecutionPolicy Bypass -File relay.ps1
//
// The relay command is spawned with `-listen 127.0.0.1:<free port>`
// appended (PowerShell binds -listen to relay.ps1's -Listen parameter
// case-insensitively, so the same flag spelling works for both).
//
// The WebSocket client below is hand-rolled on purpose: it lets the suite
// set an arbitrary Origin header, observe non-101 handshake responses, and
// send byte-exact (even malformed) WISP frames — none of which the
// standard WebSocket API allows.
import { spawn } from "child_process";
import { createConnection, createServer } from "net";
import { createSocket } from "dgram";
import { createHash, randomBytes } from "crypto";

const root = new URL("..", import.meta.url).pathname;
const cmd = process.argv.length > 2 ? process.argv.slice(2) : ["python3", "relay.py"];

const TYPE_CONNECT = 0x01, TYPE_DATA = 0x02, TYPE_CONTINUE = 0x03, TYPE_CLOSE = 0x04;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, message) => { if (!cond) throw new Error(message ?? "assertion failed"); };

const freePort = () => new Promise((resolve) => {
  const srv = createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

async function startRelay(extraArgs = []) {
  const port = await freePort();
  const proc = spawn(cmd[0], [...cmd.slice(1), "-listen", `127.0.0.1:${port}`, ...extraArgs],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  const deadline = Date.now() + 60_000; // PowerShell startup on a CI runner is slow
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`relay exited early (code ${proc.exitCode})`);
    const up = await new Promise((resolve) => {
      const c = createConnection(port, "127.0.0.1");
      c.on("connect", () => { c.destroy(); resolve(true); });
      c.on("error", () => resolve(false));
    });
    if (up) break;
    if (Date.now() > deadline) { proc.kill(); throw new Error("relay never started listening"); }
    await sleep(200);
  }
  return { port, proc, stop: () => proc.kill() };
}

// --- minimal raw WebSocket client ------------------------------------------

class WSClient {
  constructor(socket, initial) {
    this.socket = socket;
    this.buffer = initial;
    this.queue = [];
    this.waiters = [];
    this.ended = false;
    socket.on("data", (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.#parse(); });
    socket.on("close", () => { this.ended = true; this.#flush(); });
    socket.on("error", () => {});
    this.#parse();
  }

  #parse() {
    // Server frames are never masked; the relay always sends FIN frames.
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2)); offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      this.queue.push({ opcode, payload: this.buffer.slice(offset, offset + length) });
      this.buffer = this.buffer.slice(offset + length);
      this.#flush();
    }
  }

  #flush() {
    while (this.waiters.length && (this.queue.length || this.ended)) {
      const waiter = this.waiters.shift();
      if (this.queue.length) waiter.resolve(this.queue.shift());
      else waiter.reject(new Error("websocket closed"));
    }
  }

  next(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push({
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#flush();
    });
  }

  send(opcode, payload) {
    const body = Buffer.from(payload);
    const mask = randomBytes(4);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    }
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  destroy() { this.socket.destroy(); }
}

function wsHandshake(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    socket.on("connect", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        (origin ? `Origin: ${origin}\r\n` : "") +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const response = head.slice(0, end).toString("latin1");
      const status = Number(response.split(" ")[1]);
      if (status !== 101) { socket.destroy(); resolve({ status }); return; }
      const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
      if (!response.includes(expected)) { socket.destroy(); reject(new Error("bad Sec-WebSocket-Accept")); return; }
      resolve({ status, ws: new WSClient(socket, head.slice(end + 4)) });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.setTimeout(10_000, () => { socket.destroy(); resolve({ status: 0 }); });
  });
}

// --- WISP helpers -----------------------------------------------------------

const wispFrame = (type, streamId, payload) => {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32LE(streamId, 1);
  return Buffer.concat([head, Buffer.from(payload)]);
};
const connectPayload = (streamType, port, host) => {
  const head = Buffer.alloc(3);
  head[0] = streamType;
  head.writeUInt16LE(port, 1);
  return Buffer.concat([head, Buffer.from(host)]);
};
const parseWisp = (buf) => ({ type: buf[0], streamId: buf.readUInt32LE(1), payload: buf.slice(5) });

async function nextWisp(ws, predicate) {
  for (;;) {
    const { opcode, payload } = await ws.next();
    if (opcode !== 0x2) continue;
    const frame = parseWisp(payload);
    if (predicate(frame)) return frame;
  }
}

async function openSession(port) {
  const { status, ws } = await wsHandshake(port, "http://localhost:8000");
  assert(status === 101, `handshake failed with status ${status}`);
  const first = parseWisp((await ws.next()).payload);
  assert(first.type === TYPE_CONTINUE && first.streamId === 0,
    "expected the initial CONTINUE on stream 0");
  assert(first.payload.readUInt32LE(0) === 128, "initial buffer must be 128");
  return ws;
}

// --- test runner ------------------------------------------------------------

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.error(`FAIL ${name}\n  ${(e && e.stack) || e}`); }
}

const relay = await startRelay();
try {
  await test("initial CONTINUE(128) on stream 0 after upgrade", async () => {
    const ws = await openSession(relay.port);
    ws.destroy();
  });

  await test("foreign Origin is rejected", async () => {
    const { status } = await wsHandshake(relay.port, "https://evil.example");
    assert(status !== 101, `expected a non-101 response, got ${status}`);
  });

  await test("absent Origin is accepted (non-browser client)", async () => {
    const { status, ws } = await wsHandshake(relay.port, null);
    assert(status === 101, `expected 101, got ${status}`);
    ws.destroy();
  });

  await test("TCP stream echoes and DATA is answered with CONTINUE", async () => {
    const echo = createServer((c) => c.pipe(c));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "127.0.0.1")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("ping")));
    const data = await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    assert(data.payload.toString() === "ping", `echo mismatch: ${data.payload}`);
    // The relay acknowledges every accepted client DATA with CONTINUE(128).
    // (It may arrive before or after the echo; a fresh session isolates it.)
    const ws2 = await openSession(relay.port);
    ws2.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "127.0.0.1")));
    ws2.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("x")));
    const cont = await nextWisp(ws2, (f) => f.type === TYPE_CONTINUE && f.streamId === 1);
    assert(cont.payload.readUInt32LE(0) === 128, "CONTINUE window must be 128");
    ws.destroy(); ws2.destroy(); echo.close();
  });

  await test("hostname CONNECT resolves relay-side", async () => {
    const echo = createServer((c) => c.pipe(c));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "localhost")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("ping")));
    const data = await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    assert(data.payload.toString() === "ping");
    ws.destroy(); echo.close();
  });

  await test("CONNECT to a closed port yields CLOSE(0x42)", async () => {
    const closedPort = await freePort(); // nothing listens here
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, closedPort, "127.0.0.1")));
    const close = await nextWisp(ws, (f) => f.type === TYPE_CLOSE && f.streamId === 1);
    assert(close.payload[0] === 0x42, `expected reason 0x42, got 0x${close.payload[0].toString(16)}`);
    ws.destroy();
  });

  await test("malformed CONNECT payload yields CLOSE(0x41)", async () => {
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, Buffer.from([0x01, 0x00]))); // < 4 bytes
    const close = await nextWisp(ws, (f) => f.type === TYPE_CLOSE && f.streamId === 1);
    assert(close.payload[0] === 0x41, `expected reason 0x41, got 0x${close.payload[0].toString(16)}`);
    ws.destroy();
  });

  await test("a short WISP frame is ignored and the session survives", async () => {
    const echo = createServer((c) => c.pipe(c));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, Buffer.from([0x02, 0x01, 0x00])); // 3 bytes: shorter than a WISP header
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "127.0.0.1")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("still-alive")));
    const data = await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    assert(data.payload.toString() === "still-alive");
    ws.destroy(); echo.close();
  });

  await test("UDP stream (type 2) echoes a datagram", async () => {
    const udp = createSocket("udp4");
    udp.on("message", (message, rinfo) => udp.send(message, rinfo.port, rinfo.address));
    await new Promise((r) => udp.bind(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x02, udp.address().port, "127.0.0.1")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("dgram")));
    const data = await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    assert(data.payload.toString() === "dgram", `udp echo mismatch: ${data.payload}`);
    ws.destroy(); udp.close();
  });

  await test("client CLOSE tears down the target connection", async () => {
    let targetClosed;
    const closed = new Promise((r) => (targetClosed = r));
    const echo = createServer((c) => { c.on("close", targetClosed); c.pipe(c); });
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "127.0.0.1")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("hello"))); // ensure established
    await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    ws.send(0x2, wispFrame(TYPE_CLOSE, 1, Buffer.from([0x02])));
    await Promise.race([closed, sleep(10_000).then(() => { throw new Error("target never closed"); })]);
    ws.destroy(); echo.close();
  });

  await test("WebSocket PING is answered with PONG", async () => {
    const ws = await openSession(relay.port);
    ws.send(0x9, Buffer.from("hello"));
    for (;;) {
      const { opcode, payload } = await ws.next();
      if (opcode === 0xA) { assert(payload.toString() === "hello", "PONG must echo the PING payload"); break; }
    }
    ws.destroy();
  });
} finally {
  relay.stop();
}

const relayAllowed = await startRelay(["-origin", "https://owner.github.io"]);
try {
  await test("explicitly allowed Origin is accepted (URL form normalized)", async () => {
    const { status, ws } = await wsHandshake(relayAllowed.port, "https://owner.github.io");
    assert(status === 101, `expected 101, got ${status}`);
    ws.destroy();
  });

  await test("other foreign Origins stay rejected on the -origin relay", async () => {
    const { status } = await wsHandshake(relayAllowed.port, "https://evil.example");
    assert(status !== 101, `expected a non-101 response, got ${status}`);
  });
} finally {
  relayAllowed.stop();
}

process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the suite against relay.py**

Run: `node tests/relay-conformance.mjs`
Expected: every line `PASS`, exit code 0. If a test fails, fix `relay.py` (the suite is the contract) before proceeding.

- [ ] **Step 3: Sanity-check the failure mode**

Run: `node tests/relay-conformance.mjs python3 -c "import time; time.sleep(2)"`
Expected: exits non-zero with `relay exited early` or `relay never started listening` — proving the suite cannot false-PASS against a dead relay.

- [ ] **Step 4: Commit**

```bash
git add tests/relay-conformance.mjs
git commit -m "test(selfhost): WISP conformance suite runnable against any relay command"
```

---

### Task 5: relay.sh wrapper rewrite and page one-liners

**Files:**
- Modify: `deploy/selfhost-web/relay.sh` (full rewrite)
- Create: `deploy/selfhost-web/tests/relay-sh.test.sh`
- Modify: `deploy/selfhost-web/js/ui.js` (lines ~367–381)

**Interfaces:**
- Consumes: `relay.py` (downloaded at run time from `$MULTICA_RELAY_URL_BASE`, default `https://verusfi.github.io/multica`).
- Produces: same wrapper contract as before — prints `wisp://localhost:8086`, forwards `MULTICA_RELAY_ORIGIN` as `-origin` and forwards `"$@"`, saves to `~/.multica/relay.py`. The page one-liner additionally exports `MULTICA_RELAY_URL_BASE=<page base>` so a fork's Pages deployment downloads relay.py from itself.

- [ ] **Step 1: Write the failing tests**

Create `deploy/selfhost-web/tests/relay-sh.test.sh`:

```sh
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
write_stub "$fakebin/curl" 'exit 22'
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
```

Note on stub 6 (`curl`): relay.sh calls `curl -fsSL <url> -o <file>`; the stub shifts to the last argument (the target file) and writes to it.
Note on test 3: with `PATH="$fakebin"` there is no `xcode-select` on PATH, which is exactly the no-CLT condition relay.sh must detect.

- [ ] **Step 2: Run tests to verify they fail against the current relay.sh**

Run: `sh tests/relay-sh.test.sh`
Expected: FAIL lines (current relay.sh knows nothing about python3), non-zero exit.

- [ ] **Step 3: Rewrite relay.sh**

Replace the entire contents of `deploy/selfhost-web/relay.sh` with:

```sh
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `sh tests/relay-sh.test.sh`
Expected: all `PASS`, exit 0.

- [ ] **Step 5: Update the page one-liners in js/ui.js**

In `deploy/selfhost-web/js/ui.js`, replace the comment above `relayCommands()` and the two POSIX commands (Windows stays):

```js
// The relay is an unauthenticated outbound proxy, so it accepts WebSockets
// only from localhost origins unless told otherwise (relay.py's -origin /
// DEFAULT_ORIGIN_PATTERNS). This page may be served from anywhere (a Pages
// site), so the one-liners hand the relay *this page's* origin via
// MULTICA_RELAY_ORIGIN — the only origin that legitimately needs access —
// instead of the relay having to trust every origin by default. The page's
// base URL rides along as MULTICA_RELAY_URL_BASE so relay.sh downloads
// relay.py from the same site that served it (fork-friendly).
function relayCommands() {
  const base = computePagesUrl();
  const origin = location.origin;
  return {
    macos: `curl -fsSL ${base}relay.sh | MULTICA_RELAY_ORIGIN=${origin} MULTICA_RELAY_URL_BASE=${base} sh`,
    linux: `curl -fsSL ${base}relay.sh | MULTICA_RELAY_ORIGIN=${origin} MULTICA_RELAY_URL_BASE=${base} sh`,
    windows: `$env:MULTICA_RELAY_ORIGIN='${origin}'; irm ${base}relay.ps1 | iex`,
  };
}
```

- [ ] **Step 6: Run the page suite**

Run: `node tests/run-tests.mjs`
Expected: all specs PASS (no spec asserts the literal command text; this catches syntax errors).

- [ ] **Step 7: Commit**

```bash
git add relay.sh tests/relay-sh.test.sh js/ui.js
git commit -m "feat(selfhost): relay.sh bootstraps the Python relay with pre-flight checks"
```

---

### Task 6: Self-contained PowerShell relay (`relay.ps1`)

**Files:**
- Modify: `deploy/selfhost-web/relay.ps1` (full rewrite)

**Interfaces:**
- Consumes: nothing at run time (fully self-contained).
- Produces: the same relay contract as relay.py, as PowerShell params `-Listen` (default `127.0.0.1:8086`), `-Origin` (string array; each entry may be comma-separated), `-AllowAnyOrigin`, plus `$env:MULTICA_RELAY_ORIGIN`. Verified by Task 4's conformance suite on the Task 9 Windows CI job (`-listen`/`-origin` bind these params case-insensitively).

**Known risk (from the spec):** async .NET Task juggling in PS 5.1. The implementation below stays single-threaded and polls `Task.IsCompleted` in a pump loop — no callbacks, no runspaces. If CI (Task 9) shows this approach cannot pass conformance on a real Windows PowerShell 5.1, STOP and report back: the agreed fallback (relay.ps1 requiring Python on Windows) is Rodrigo's decision, not the implementer's.

- [ ] **Step 1: Rewrite relay.ps1**

Replace the entire contents of `deploy/selfhost-web/relay.ps1` with:

```powershell
#Requires -Version 5.1
<#
relay.ps1 — multica-relay (WISP v1) for Windows, self-contained.

The complete relay lives in this one file: PowerShell plus the .NET
Framework Windows 10+ already ships (HttpListener, System.Net.WebSockets,
TcpClient, UdpClient). No compiled binary, no second download, no package
manager. relay.py is the macOS/Linux sibling implementing the same
contract; tests/relay-conformance.mjs is the parity gate between the two.

This relay is an unauthenticated outbound TCP/UDP proxy: anything that can
open a WebSocket to it can make this machine dial arbitrary hosts and
ports (that is its whole job — it is what gives a v86 guest, which cannot
open raw sockets from a browser tab, real internet access). The only two
things standing between "the guest in your own tab" and "anyone else" are
the listen address and the Origin check below; both default to the
tightest setting that still lets the shipped page work.

Run (what the page's one-liner does):
  $env:MULTICA_RELAY_ORIGIN='https://owner.github.io'; irm <pages-url>/relay.ps1 | iex
Or from a saved file:
  powershell -File relay.ps1 -Listen 127.0.0.1:8086 -Origin https://owner.github.io
#>
param(
    [string]$Listen = "127.0.0.1:8086",
    [string[]]$Origin = @(),
    [switch]$AllowAnyOrigin
)

$ErrorActionPreference = "Stop"

# --- WISP constants ---------------------------------------------------------
$TYPE_CONNECT = 1
$TYPE_DATA = 2
$TYPE_CONTINUE = 3
$TYPE_CLOSE = 4
$INITIAL_BUFFER = [uint32]128
$CLOSE_INVALID_PAYLOAD = [byte]0x41
$CLOSE_CONNECT_FAILED = [byte]0x42
$CLOSE_GENERIC = [byte]0x02

# --- Origin allowlist (parity with relay.py) --------------------------------
# The "[::1]" entries never match under wildcard syntax ("[" opens a
# character class) — inherited verbatim from the previous implementations
# for default-for-default parity.
$DefaultOriginPatterns = @(
    "localhost", "localhost:*",
    "127.0.0.1", "127.0.0.1:*",
    "[::1]", "[::1]:*"
)

function Get-NormalizedOriginPattern([string]$Pattern) {
    $s = $Pattern.Trim() -replace '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''
    return $s.TrimEnd('/')
}

function Test-OriginAllowed([string]$OriginHeader, [string[]]$Patterns) {
    # An absent Origin (a non-browser client) is allowed: this check exists
    # to stop OTHER websites in the same browser, and browsers always send
    # Origin. -like is a case-insensitive glob, matching relay.py's fnmatch.
    if ([string]::IsNullOrEmpty($OriginHeader)) { return $true }
    $bare = Get-NormalizedOriginPattern $OriginHeader
    foreach ($p in $Patterns) {
        if ($bare -like $p) { return $true }
    }
    return $false
}

$extraOrigins = @()
foreach ($o in $Origin) {
    foreach ($part in ($o -split ',')) {
        $n = Get-NormalizedOriginPattern $part
        if ($n) { $extraOrigins += $n }
    }
}
if ($env:MULTICA_RELAY_ORIGIN) {
    $n = Get-NormalizedOriginPattern $env:MULTICA_RELAY_ORIGIN
    if ($n) { $extraOrigins += $n }
}
if ($AllowAnyOrigin) {
    $OriginPatterns = @("*")
    Write-Warning "-AllowAnyOrigin is set: any website in any tab can use this relay as an unauthenticated proxy from this machine"
} else {
    $OriginPatterns = $DefaultOriginPatterns + $extraOrigins
}

# --- frame helpers ----------------------------------------------------------

function New-WispFrame([byte]$Type, [uint32]$StreamId, [byte[]]$Payload) {
    if ($null -eq $Payload) { $Payload = @() }
    $frame = New-Object byte[] (5 + $Payload.Length)
    $frame[0] = $Type
    [BitConverter]::GetBytes($StreamId).CopyTo($frame, 1)  # little-endian
    if ($Payload.Length) { [Array]::Copy($Payload, 0, $frame, 5, $Payload.Length) }
    return ,$frame
}

function Send-WsMessage($Session, [byte[]]$Bytes) {
    # Sends are serialized per session by waiting synchronously: keeps frame
    # order without a queue. Send errors mark the session dead.
    try {
        $segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$Bytes)
        $Session.WebSocket.SendAsync(
            $segment,
            [System.Net.WebSockets.WebSocketMessageType]::Binary,
            $true,
            [System.Threading.CancellationToken]::None
        ).GetAwaiter().GetResult() | Out-Null
    } catch {
        $Session.Dead = $true
    }
}

function Close-WispStream($Session, [uint32]$StreamId, [byte]$Reason) {
    $stream = $Session.Streams[$StreamId]
    if ($null -ne $stream) {
        $Session.Streams.Remove($StreamId)
        try { $stream.Client.Close() } catch {}
    }
    Send-WsMessage $Session (New-WispFrame $TYPE_CLOSE $StreamId @($Reason))
}

function Open-WispStream($Session, [uint32]$StreamId, [byte[]]$Payload) {
    if ($Payload.Length -lt 4) {
        Close-WispStream $Session $StreamId $CLOSE_INVALID_PAYLOAD
        return
    }
    $streamType = $Payload[0]
    $port = [BitConverter]::ToUInt16($Payload, 1)
    $targetHost = [System.Text.Encoding]::UTF8.GetString($Payload, 3, $Payload.Length - 3)
    try {
        if ($streamType -eq 2) {
            $udp = New-Object System.Net.Sockets.UdpClient
            $udp.Connect($targetHost, $port)  # resolves the hostname relay-side
            $Session.Streams[$StreamId] = [pscustomobject]@{
                Kind = 'udp'; Client = $udp; NetStream = $null
                ReadBuffer = $null; ReadTask = $udp.ReceiveAsync()
            }
        } else {
            # Connect synchronously (parity: the Go and Python relays also
            # dial inline in their receive loop). A slow dial briefly stalls
            # the pump; acceptable for a localhost POC relay.
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.ConnectAsync($targetHost, $port).GetAwaiter().GetResult() | Out-Null
            $buffer = New-Object byte[] 32768
            $netStream = $tcp.GetStream()
            $Session.Streams[$StreamId] = [pscustomobject]@{
                Kind = 'tcp'; Client = $tcp; NetStream = $netStream
                ReadBuffer = $buffer; ReadTask = $netStream.ReadAsync($buffer, 0, $buffer.Length)
            }
        }
    } catch {
        Close-WispStream $Session $StreamId $CLOSE_CONNECT_FAILED
    }
}

function Invoke-WispMessage($Session, [byte[]]$MessageBytes) {
    if ($MessageBytes.Length -lt 5) { return }  # malformed frame: ignored
    $type = $MessageBytes[0]
    $streamId = [BitConverter]::ToUInt32($MessageBytes, 1)
    $payload = New-Object byte[] ($MessageBytes.Length - 5)
    if ($payload.Length) { [Array]::Copy($MessageBytes, 5, $payload, 0, $payload.Length) }
    switch ([int]$type) {
        1 { Open-WispStream $Session $streamId $payload }
        2 {
            $stream = $Session.Streams[$streamId]
            if ($null -eq $stream) { return }  # unknown stream: ignored
            try {
                if ($stream.Kind -eq 'udp') {
                    $stream.Client.Send($payload, $payload.Length) | Out-Null
                } else {
                    $stream.NetStream.Write($payload, 0, $payload.Length)
                }
                Send-WsMessage $Session (New-WispFrame $TYPE_CONTINUE $streamId ([BitConverter]::GetBytes($INITIAL_BUFFER)))
            } catch {
                Close-WispStream $Session $streamId $CLOSE_GENERIC
            }
        }
        4 { Close-WispStream $Session $streamId $CLOSE_GENERIC }
    }
}

function New-RelaySession($WebSocket) {
    $recvBuffer = New-Object byte[] 65536
    $session = [pscustomobject]@{
        WebSocket  = $WebSocket
        Streams    = @{}
        RecvBuffer = $recvBuffer
        RecvTask   = $null
        Message    = New-Object System.IO.MemoryStream
        Dead       = $false
    }
    $session.RecvTask = $WebSocket.ReceiveAsync(
        (New-Object System.ArraySegment[byte] -ArgumentList @(,$recvBuffer)),
        [System.Threading.CancellationToken]::None)
    return $session
}

# --- listener ---------------------------------------------------------------

$sep = $Listen.LastIndexOf(':')
if ($sep -lt 0) { throw "listen address must be host:port or :port" }
$ListenHost = $Listen.Substring(0, $sep)
$ListenPort = [int]$Listen.Substring($sep + 1)

$listener = New-Object System.Net.HttpListener
if ($ListenHost -eq '' -or $ListenHost -eq '0.0.0.0' -or $ListenHost -eq '+') {
    # All interfaces: reachable by your whole LAN, and http.sys requires an
    # elevated prompt for this prefix. Deliberate friction.
    $prefixes = @("http://+:$ListenPort/")
} elseif ($ListenHost -eq '127.0.0.1' -or $ListenHost -eq 'localhost') {
    # Loopback. Register both spellings: http.sys routes by Host header
    # (unlike a plain socket bind), and the page may use either
    # wisp://localhost:8086 or wisp://127.0.0.1:8086.
    $prefixes = @("http://localhost:$ListenPort/", "http://127.0.0.1:$ListenPort/")
} else {
    $prefixes = @("http://${ListenHost}:$ListenPort/")
}
foreach ($prefix in $prefixes) { $listener.Prefixes.Add($prefix) }
try {
    $listener.Start()
} catch {
    throw ("could not listen on {0}: {1}`nIf this is an access-denied error, try another port (-Listen 127.0.0.1:8087) or an elevated prompt." -f $Listen, $_.Exception.Message)
}

Write-Host "wisp://localhost:$ListenPort"
Write-Host "multica-relay (WISP v1) listening on ${ListenHost}:$ListenPort (allowed origins: $($OriginPatterns -join ' '))"

# --- pump loop --------------------------------------------------------------
# Windows PowerShell 5.1 has no await and no clean async callbacks, so the
# whole relay is one thread polling .NET Tasks: the accept task, each
# session's WebSocket receive task, and each stream's read task. Nothing
# here blocks longer than one send.

$sessions = New-Object System.Collections.ArrayList
$acceptTask = $listener.GetContextAsync()

try {
    while ($true) {
        $idle = $true

        # New HTTP connections -> origin check -> WebSocket accept.
        if ($acceptTask.IsCompleted) {
            $idle = $false
            $ctx = $null
            try { $ctx = $acceptTask.GetAwaiter().GetResult() } catch {}
            $acceptTask = $listener.GetContextAsync()
            if ($null -ne $ctx) {
                $originHeader = $ctx.Request.Headers["Origin"]
                if (-not $ctx.Request.IsWebSocketRequest) {
                    $ctx.Response.StatusCode = 400
                    $ctx.Response.Close()
                } elseif (-not (Test-OriginAllowed $originHeader $OriginPatterns)) {
                    # Logged: a rejected Origin is the one failure a
                    # legitimate user can hit (page deployed somewhere this
                    # relay wasn't told about). See -Origin.
                    Write-Host "websocket accept rejected (origin '$originHeader'): origin not allowed"
                    $ctx.Response.StatusCode = 403
                    $ctx.Response.Close()
                } else {
                    try {
                        $wsCtx = $ctx.AcceptWebSocketAsync($null).GetAwaiter().GetResult()
                        $session = New-RelaySession $wsCtx.WebSocket
                        [void]$sessions.Add($session)
                        Send-WsMessage $session (New-WispFrame $TYPE_CONTINUE 0 ([BitConverter]::GetBytes($INITIAL_BUFFER)))
                    } catch {
                        try { $ctx.Response.StatusCode = 400; $ctx.Response.Close() } catch {}
                    }
                }
            }
        }

        foreach ($session in @($sessions)) {
            if ($session.Dead) { continue }

            # WebSocket receive progress (reassemble until EndOfMessage).
            if ($session.RecvTask.IsCompleted) {
                $idle = $false
                $result = $null
                try { $result = $session.RecvTask.GetAwaiter().GetResult() } catch { $session.Dead = $true }
                if (-not $session.Dead) {
                    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                        $session.Dead = $true
                    } else {
                        $session.Message.Write($session.RecvBuffer, 0, $result.Count)
                        if ($result.EndOfMessage) {
                            $bytes = $session.Message.ToArray()
                            $session.Message.SetLength(0)
                            Invoke-WispMessage $session $bytes
                        }
                        if (-not $session.Dead) {
                            $session.RecvTask = $session.WebSocket.ReceiveAsync(
                                (New-Object System.ArraySegment[byte] -ArgumentList @(,$session.RecvBuffer)),
                                [System.Threading.CancellationToken]::None)
                        }
                    }
                }
            }

            # Target -> client reads.
            foreach ($streamId in @($session.Streams.Keys)) {
                $stream = $session.Streams[$streamId]
                if ($null -eq $stream -or -not $stream.ReadTask.IsCompleted) { continue }
                $idle = $false
                try {
                    if ($stream.Kind -eq 'udp') {
                        $result = $stream.ReadTask.GetAwaiter().GetResult()
                        Send-WsMessage $session (New-WispFrame $TYPE_DATA $streamId $result.Buffer)
                        $stream.ReadTask = $stream.Client.ReceiveAsync()
                    } else {
                        $count = $stream.ReadTask.GetAwaiter().GetResult()
                        if ($count -le 0) {
                            Close-WispStream $session $streamId $CLOSE_GENERIC
                            continue
                        }
                        $chunk = New-Object byte[] $count
                        [Array]::Copy($stream.ReadBuffer, 0, $chunk, 0, $count)
                        Send-WsMessage $session (New-WispFrame $TYPE_DATA $streamId $chunk)
                        $stream.ReadTask = $stream.NetStream.ReadAsync($stream.ReadBuffer, 0, $stream.ReadBuffer.Length)
                    }
                } catch {
                    Close-WispStream $session $streamId $CLOSE_GENERIC
                }
            }
        }

        # Reap dead sessions and their streams.
        foreach ($session in @($sessions | Where-Object { $_.Dead })) {
            foreach ($streamId in @($session.Streams.Keys)) {
                try { $session.Streams[$streamId].Client.Close() } catch {}
            }
            $session.Streams.Clear()
            try { $session.WebSocket.Dispose() } catch {}
            $sessions.Remove($session)
        }

        if ($idle) { Start-Sleep -Milliseconds 10 }
    }
} finally {
    $listener.Stop()
}
```

- [ ] **Step 2: Best-effort local verification**

If `pwsh` exists locally (`command -v pwsh`), try `node tests/relay-conformance.mjs pwsh -NoProfile -File relay.ps1`. HttpListener WebSocket support outside Windows is not guaranteed — a failure here is NOT a task failure; the binding verification environment is the Task 9 Windows CI job. If `pwsh` is absent, state that in the report and rely on CI.

- [ ] **Step 3: Commit**

```bash
git add relay.ps1
git commit -m "feat(selfhost): self-contained PowerShell relay for Windows"
```

---

### Task 7: Point the smoke test and dev harnesses at relay.py

**Files:**
- Modify: `deploy/selfhost-web/tests/smoke-firstboot.mjs` (~lines 39–49 comment, 105–108 spawn)
- Modify: `deploy/selfhost-web/dev/verify-net.mjs`, `dev/verify-console.mjs`, `dev/verify-dashboard.mjs`, `dev/verify-firstboot.mjs`, `dev/verify-install.mjs` (identical 4-line block in each)
- Modify: `deploy/selfhost-web/.gitignore`, `deploy/selfhost-web/dev/.gitignore`

**Interfaces:**
- Consumes: `relay.py` CLI from Task 3 (`-listen :18086` must keep working).
- Produces: no `go build` anywhere under `deploy/selfhost-web/`.

- [ ] **Step 1: Replace the build-and-spawn block in all six files**

Each file contains this block (comment wording varies slightly; the code is identical):

```js
const relayDir = new URL("../relay", import.meta.url).pathname;
const relayBin = new URL(".", import.meta.url).pathname + ".relay-bin";
execSync("go build -o " + JSON.stringify(relayBin) + " .", { cwd: relayDir, stdio: "inherit" });
const relay = spawn(relayBin, ["-listen", ":18086"], { stdio: "inherit" });
```

Replace with:

```js
const relayPy = new URL("../relay.py", import.meta.url).pathname;
const relay = spawn("python3", [relayPy, "-listen", ":18086"], { stdio: "inherit" });
```

In each file, if `execSync` is no longer referenced anywhere (`grep -n execSync <file>`), remove it from the `child_process` import. In `tests/smoke-firstboot.mjs` also rewrite the header comment lines that explain the `go build`-then-spawn dance (~lines 39–49): the python process is spawned directly, so the "kill the compiled binary it forked" rationale no longer applies — say the relay is `relay.py` spawned with `python3` and that the suite still waits for the listen socket before navigating.

- [ ] **Step 2: Drop stale ignore entries**

- `deploy/selfhost-web/.gitignore`: delete the `relay/relay-binary` and `tests/.relay-bin` lines.
- `deploy/selfhost-web/dev/.gitignore`: delete the `.relay-bin` line.
- Delete leftover build outputs if present: `rm -f tests/.relay-bin dev/.relay-bin`.

- [ ] **Step 3: Verify**

Run: `node tests/run-tests.mjs`
Expected: all specs PASS.
Run: `grep -rn "go build\|\.relay-bin" tests/ dev/ --include='*.mjs'`
Expected: no matches (NOTES.md may still mention them historically — that is fine).

- [ ] **Step 4: Commit**

```bash
git add tests/smoke-firstboot.mjs dev/verify-net.mjs dev/verify-console.mjs dev/verify-dashboard.mjs dev/verify-firstboot.mjs dev/verify-install.mjs .gitignore dev/.gitignore
git commit -m "refactor(selfhost): spawn relay.py in smoke and dev harnesses"
```

---

### Task 8: Remove the Go relay and its release plumbing

**Files:**
- Delete: `deploy/selfhost-web/relay/` (entire directory)
- Modify: `.github/workflows/selfhost-release.yml`
- Modify: `.github/workflows/selfhost-pages.yml`

**Interfaces:**
- Consumes: Tasks 4 and 7 must be done (nothing may still reference the Go sources).
- Produces: `selfhost-release.yml` publishes exactly 3 assets (`multica-selfhost-386.tar.gz`, `deploy/selfhost-web/boot/vmlinuz`, `deploy/selfhost-web/boot/initramfs.img`); Pages ships `relay.py`/`relay.sh`/`relay.ps1` but not `relay_test.py`.

- [ ] **Step 1: Confirm nothing references the Go relay**

Run (from the repo root): `grep -rn "selfhost-web/relay/\|go build" deploy/selfhost-web --include='*.mjs' --include='*.js' --include='*.sh' --include='*.ps1'`
Expected: no matches.

- [ ] **Step 2: Delete the directory**

```bash
git rm -r deploy/selfhost-web/relay
rm -f deploy/selfhost-web/relay/relay-binary  # untracked build output, if still present
```

- [ ] **Step 3: Edit `.github/workflows/selfhost-release.yml`**

- Header comment (lines 3–7): drop "cross-compiled relay binaries (Task 2's wisp/TCP bridge)," from the asset description.
- `RELEASE_FILES` env: delete the five `dist/multica-relay-*` lines; in the comment above it, change "payload/relay assets" to "payload assets".
- Delete the entire "Cross-compile relay binaries" step (the comment block starting "Cross-task contract with relay.sh / relay.ps1 (Task 16)" through the `ls -la "$GITHUB_WORKSPACE/dist"` line).
- Keep the "Setup Go" step — `build-selfhost-tarball.sh` still cross-builds the Go backend.
- In the "Publish versioned release" comment: change "a missing asset (a glob matching nothing — e.g. the tarball build or one relay cross-compile silently produced no output)" to "a missing asset (a glob matching nothing — e.g. the tarball build silently produced no output)"; change "relay.sh / relay.ps1 / the in-browser page all resolve their download URLs" to "the in-browser page resolves its payload download URL".
- In the "Publish rolling selfhost-latest release" comment: change "clobbers all 8 assets" to "clobbers all 3 assets"; change "giving relay.sh / relay.ps1 / vm-controller.js's default download URLs" to "giving vm-controller.js's default download URL".

- [ ] **Step 4: Edit `.github/workflows/selfhost-pages.yml`**

In the "Stage page assets" step: remove `--exclude relay/` and add `--exclude relay_test.py`; update the comment to:

```yaml
      # Page assets only: dev harness, tests, the relay's unit tests and
      # node_modules never ship to Pages. relay.py / relay.sh / relay.ps1 DO
      # ship — the relay is served as static files from this site.
```

- [ ] **Step 5: Verify**

Run: `node tests/run-tests.mjs && python3 -m unittest relay_test && node tests/relay-conformance.mjs`
Expected: everything passes with the Go directory gone.
Run: `git grep -n "multica-relay-" -- .github deploy/selfhost-web ':!deploy/selfhost-web/dev/NOTES.md' ':!deploy/selfhost-web/README.md'`
Expected: no matches (docs are fixed in Task 10).

- [ ] **Step 6: Commit**

```bash
git add -A deploy/selfhost-web .github/workflows/selfhost-release.yml .github/workflows/selfhost-pages.yml
git commit -m "chore(selfhost): remove the Go relay and its release cross-compile"
```

---

### Task 9: Relay CI workflow (ubuntu + windows)

**Files:**
- Create: `.github/workflows/selfhost-relay-tests.yml`

**Interfaces:**
- Consumes: Task 1–6 test entry points: `python3 -m unittest relay_test`, `sh tests/relay-sh.test.sh`, `node tests/relay-conformance.mjs [cmd…]`.
- Produces: CI gate proving relay.py on ubuntu and relay.ps1 on real Windows PowerShell 5.1.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/selfhost-relay-tests.yml`:

```yaml
name: selfhost-relay-tests

# Conformance and unit tests for the script-only relay implementations:
# relay.py on ubuntu (the environment relay.sh targets) and relay.ps1 on a
# Windows runner — real Windows PowerShell 5.1, the environment users
# actually have, NOT pwsh (HttpListener WebSocket support differs off
# Windows). tests/relay-conformance.mjs is the shared parity gate.
on:
  push:
    branches: [main]
    paths: ["deploy/selfhost-web/**"]
  pull_request:
    paths: ["deploy/selfhost-web/**"]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  python-relay:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: deploy/selfhost-web
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Unit tests (stdlib unittest)
        run: python3 -m unittest relay_test -v
      - name: relay.sh pre-flight tests
        run: sh tests/relay-sh.test.sh
      - name: WISP conformance (relay.py)
        run: node tests/relay-conformance.mjs

  powershell-relay:
    runs-on: windows-latest
    defaults:
      run:
        working-directory: deploy/selfhost-web
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: WISP conformance (relay.ps1 on Windows PowerShell 5.1)
        run: node tests/relay-conformance.mjs powershell -NoProfile -ExecutionPolicy Bypass -File relay.ps1
```

- [ ] **Step 2: Re-run the ubuntu-job commands locally**

From `deploy/selfhost-web/`, run exactly what the workflow runs: `python3 -m unittest relay_test -v && sh tests/relay-sh.test.sh && node tests/relay-conformance.mjs`.
Expected: all pass — this validates the commands and working-directory assumptions the workflow encodes (the YAML itself is validated by GitHub on push).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/selfhost-relay-tests.yml
git commit -m "ci(selfhost): relay conformance workflow on ubuntu and windows"
```

- [ ] **Step 4: After push — watch the Windows job**

When this branch is pushed (or its PR opened), check the `powershell-relay` job. If it fails for pump-loop/HttpListener reasons that resist fixing, STOP: the fallback (Python required on Windows) is Rodrigo's call, per the spec's risk table.

---

### Task 10: Documentation

**Files:**
- Modify: `deploy/selfhost-web/README.md`
- Modify: `deploy/selfhost-web/dev/NOTES.md`

**Interfaces:**
- Consumes: final behavior from Tasks 1–9.
- Produces: user-facing docs with no reference to relay binaries or Releases-hosted relay assets.

- [ ] **Step 1: README — "How it fits together" bullet (lines ~22–29)**

Replace the "**The relay**" bullet with:

```markdown
- **The relay** (`relay.py`, and `relay.ps1` on Windows — plain scripts you
  can read before running, served as static files from this same site) is a
  tiny local process that speaks the
  [WISP protocol](https://github.com/MercuryWorkshop/wisp-protocol) on one
  side and plain outbound TCP/UDP on the other. The guest's virtual NIC has
  no other way to reach the internet — a browser tab cannot open raw TCP
  sockets, so v86's guest network traffic is tunneled to this relay over a
  WebSocket, and the relay does the actual dialing on your machine's
  behalf. It relays; it doesn't proxy your multica data anywhere.
```

- [ ] **Step 2: README — Pages staging note (line ~55)**

Change `dev/`, `tests/`, `relay/` (Go sources), and `node_modules/` are excluded` to `` `dev/`, `tests/`, `relay_test.py`, and `node_modules/` are excluded `` (matching Task 8's pages.yml).

- [ ] **Step 3: README — "Running a relay" intro (lines ~86–111)**

Replace everything from `The relay is a small Go binary…` down to `…see "Local usage without Pages").` (keeping the one-liner code blocks' surrounding structure) with:

````markdown
The relay needs no compiled binary and no GitHub Releases: on macOS/Linux
it is `relay.py`, a single Python (≥ 3.9, standard library only) file; on
Windows it is `relay.ps1`, a self-contained PowerShell script running on
the PowerShell 5.1 + .NET every Windows 10+ ships. The page's "Run a
relay" panel shows the right one-liner for the detected OS tab; the three
commands are:

```sh
# macOS / Linux
curl -fsSL <pages-url>/relay.sh | MULTICA_RELAY_ORIGIN=<page-origin> MULTICA_RELAY_URL_BASE=<pages-url> sh
```

```powershell
# Windows (PowerShell)
$env:MULTICA_RELAY_ORIGIN='<page-origin>'; irm <pages-url>/relay.ps1 | iex
```

`relay.sh` checks that a usable `python3` exists first — on macOS that
means Apple's Command Line Tools (`xcode-select --install`); on Linux,
your distribution's `python3` package — then downloads `relay.py` from
`MULTICA_RELAY_URL_BASE` (the page fills in its own base URL; default: the
canonical fork's Pages site) into `~/.multica/` and runs it in the
foreground, printing `wisp://localhost:8086` — the address the page's
"Relay address" field already defaults to. Extra arguments after `sh -s --`
are forwarded to the relay. `relay.ps1` is the whole relay in one file —
nothing else is downloaded.
````

The "Who can reach the relay" block that follows stays; in it, change "Equivalent flags on the binary:" to "Equivalent flags on the relay:".

- [ ] **Step 3b: README — public WISP relay option**

After the `wss://` constraint block (before "Local usage without Pages"), add:

```markdown
**Using a public relay instead of running your own.** The "Relay address"
field accepts any WISP v1 endpoint (`wisp://`, or `ws://` / `wss://`), not
just a relay on your own machine — a hosted WISP server works with no change
here, and the page's **Test connection** button confirms it before you
create an instance. The trade-off is real: a third-party relay dials every
outbound connection on your guest's behalf and therefore sees all of that
egress (which hosts, when). For anything sensitive, run your own relay
locally; treat a public relay as a convenience for throwaway trials.
```

- [ ] **Step 4: README — "Local usage without Pages" (lines ~175–177)**

Change `(or build one locally: `cd relay && go build -o multica-relay .`, matching what `relay.sh` downloads)` to `(or run it straight from the checkout: `python3 relay.py`)`.

- [ ] **Step 5: README — security stance, supply-chain bullet (lines ~252–261)**

In the "offline install payload…" bullet, replace `The tarball is built and published by this repo's own CI (`selfhost-release.yml`) and downloaded by the relay one-liners over HTTPS from GitHub Releases` with `The tarball is built and published by this repo's own CI (`selfhost-release.yml`) and downloaded by the guest over HTTPS from GitHub Releases; the relay itself is no longer a downloaded binary at all — it is script source (`relay.py` / `relay.ps1`) served from this site, readable before you run it`.

- [ ] **Step 6: NOTES.md — rolling channel addendum**

At the end of the `# Task 17 fix — rolling `selfhost-latest` release channel` section (search for that heading), append:

```markdown
**2026-08-17 update (script-only relay):** the five `multica-relay-*`
binaries no longer exist — the relay was rewritten as `relay.py` /
`relay.ps1`, served as static files by the Pages site itself. The
`selfhost-latest` channel now carries only the payload tarball and the two
boot artifacts, and `vm-controller.js` is its only in-repo consumer.
```

- [ ] **Step 7: Verify and commit**

Run: `git grep -n "multica-relay-\|go build -o multica-relay\|small Go binary" deploy/selfhost-web/README.md`
Expected: no matches.

```bash
git add deploy/selfhost-web/README.md deploy/selfhost-web/dev/NOTES.md
git commit -m "docs(selfhost): script-only relay docs"
```

---

### Task 11: "Test connection" button with WISP-greeting validation

**Files:**
- Modify: `deploy/selfhost-web/js/ui.js` (`preflightRelay`, ~lines 84–126; element collection ~line 391; a new wiring function)
- Modify: `deploy/selfhost-web/selfhost.html` (relay field, ~lines 190–195)
- Modify: `deploy/selfhost-web/tests/ui.spec.mjs`

**Interfaces:**
- Consumes: the WISP greeting contract — a compliant WISP v1 server sends `CONTINUE` (type `0x03`) on stream `0` immediately after the WebSocket opens (relay.py does this in `handle_connection`; so does any WISP v1 server and v86's own).
- Produces: `preflightRelay(relayUrl, timeoutMs)` now resolves only after that greeting (rejects a plain WebSocket that never sends it); a new `wireTestConnection(els, doc)` bound to a `#btn-test-connection` button that shows pending/success/failure inline.

- [ ] **Step 1: Write the failing test**

Add to `deploy/selfhost-web/tests/ui.spec.mjs` (inside the exported `run()`, alongside the other assertions; it uses a real in-page WebSocket server via a data: URL is not possible, so drive `preflightRelay` against a tiny mock by monkey-patching `WebSocket` in the page context):

```js
// --- preflightRelay requires a WISP CONTINUE greeting, not just an open socket ---
await page.evaluate(async () => {
  const { preflightRelay } = await import("../js/ui.js");
  const RealWS = window.WebSocket;

  // A fake WebSocket whose behavior is chosen by the URL query.
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.binaryType = "blob";
      this.onopen = this.onerror = this.onmessage = this.onclose = null;
      setTimeout(() => {
        this.onopen && this.onopen();
        if (url.includes("greet")) {
          // WISP CONTINUE on stream 0: [0x03][0,0,0,0][buffer uint32]
          const buf = new Uint8Array([0x03, 0, 0, 0, 0, 128, 0, 0, 0]);
          this.onmessage && this.onmessage({ data: buf.buffer });
        }
        // "nogreet": opens but never sends a frame -> must time out/reject.
      }, 0);
    }
    close() {}
  }
  window.WebSocket = FakeWS;
  try {
    let greeted = false;
    await preflightRelay("wisp://localhost/greet", 500).then(() => (greeted = true));
    if (!greeted) throw new Error("a WISP greeting should resolve preflightRelay");

    let rejected = false;
    await preflightRelay("wisp://localhost/nogreet", 300).catch(() => (rejected = true));
    if (!rejected) throw new Error("an open socket with no WISP greeting must reject");
  } finally {
    window.WebSocket = RealWS;
  }
});
```

- [ ] **Step 2: Run the page suite to see it fail**

Run: `node tests/run-tests.mjs tests/ui.spec.mjs`
Expected: FAIL — the current `preflightRelay` resolves on `open`, so the `nogreet` case resolves instead of rejecting.

- [ ] **Step 3: Upgrade `preflightRelay` in js/ui.js**

Replace the body from `ws.onopen = () => finish(true);` down to the `ws.onerror = …` line with:

```js
    ws.binaryType = "arraybuffer";
    // Resolve only once the relay proves it speaks WISP: a compliant WISP v1
    // server sends a CONTINUE frame (type 0x03) on stream 0 the moment the
    // socket opens. Resolving on `open` alone would call a plain WebSocket
    // echo server — or a page's own origin being silently 403'd after the
    // TCP connect — a "working relay". This also surfaces an Origin rejection
    // (the relay answering the upgrade with 403) as an `error`, i.e. a clear
    // failure, instead of a false success.
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data);
      // WISP frame: [type(1)][streamId(4, LE)][payload]. Greeting = CONTINUE
      // (0x03) on stream 0.
      if (bytes.length >= 5 && bytes[0] === 0x03 &&
          bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0 && bytes[4] === 0) {
        finish(true);
      } else {
        finish(false, new Error(`Relay at ${relayUrl} did not send a WISP greeting.`));
      }
    };
    ws.onerror = () => finish(false, new Error(`Could not connect to relay at ${relayUrl}.`));
```

Update the JSDoc above `preflightRelay` to say it resolves on the WISP `CONTINUE` greeting (not on `open`), and that a plain WebSocket server therefore fails the check.

- [ ] **Step 4: Run the page suite to see it pass**

Run: `node tests/run-tests.mjs tests/ui.spec.mjs`
Expected: PASS.

- [ ] **Step 5: Add the button to selfhost.html**

In `deploy/selfhost-web/selfhost.html`, change the relay field block (lines ~190–195) to add a button and a result line:

```html
      <div class="field">
        <label for="field-relay-url">Relay address</label>
        <input id="field-relay-url" name="relayUrl" type="text" value="wisp://localhost:8086">
        <button type="button" id="btn-test-connection">Test connection</button>
        <p id="test-connection-result" data-testid="test-connection-result" class="hint" hidden></p>
        <p class="field-error" data-error-for="relayUrl"></p>
        <p class="hint">No relay running yet? See the instructions below.</p>
      </div>
```

- [ ] **Step 6: Wire the button in js/ui.js**

In `collectElements` (~line 391), add `testConnectionBtn: byId("btn-test-connection"),` and `testConnectionResult: byId("test-connection-result"),`.

Add a wiring function (near the other `wire*` helpers) and call it wherever the creation form is wired (search for where `els.createBtn` / `preflightRelay` is wired in the DOM-init path and add the call there):

```js
export function wireTestConnection(els, doc = document) {
  if (!els.testConnectionBtn) return;
  els.testConnectionBtn.addEventListener("click", async () => {
    const relayUrl = els.fields.relayUrl.value.trim();
    const result = els.testConnectionResult;
    els.testConnectionBtn.disabled = true;
    if (result) {
      result.hidden = false;
      result.className = "hint";
      result.textContent = "Testing…";
    }
    try {
      await preflightRelay(relayUrl);
      if (result) { result.className = "hint"; result.textContent = "Relay reachable ✓"; }
    } catch (err) {
      if (result) {
        result.className = "field-error";
        result.textContent = err instanceof Error ? err.message : String(err);
      }
    } finally {
      els.testConnectionBtn.disabled = false;
    }
  });
}
```

- [ ] **Step 7: Run the full page suite**

Run: `node tests/run-tests.mjs`
Expected: all specs PASS (the subpath spec also verifies no absolute-rooted references crept in).

- [ ] **Step 8: Commit**

```bash
git add js/ui.js selfhost.html tests/ui.spec.mjs
git commit -m "feat(selfhost): Test connection button with WISP-greeting validation"
```

---

## Final verification (after all tasks)

From `deploy/selfhost-web/`:

1. `python3 -m unittest relay_test -v` — unit suite green.
2. `sh tests/relay-sh.test.sh` — wrapper pre-flight green.
3. `node tests/relay-conformance.mjs` — conformance green against relay.py.
4. `node tests/run-tests.mjs` — page suite green (includes the Task 11 "Test connection" spec).
5. Push the branch and confirm both jobs of `selfhost-relay-tests.yml` pass — the `powershell-relay` job is the only real validation of relay.ps1.
6. Optional (slow, real boot): `node tests/smoke-firstboot.mjs` — proves a v86 guest actually provisions through relay.py end to end.
