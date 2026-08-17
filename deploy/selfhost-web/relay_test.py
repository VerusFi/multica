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
