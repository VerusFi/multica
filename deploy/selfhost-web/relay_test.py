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


if __name__ == "__main__":
    unittest.main()
