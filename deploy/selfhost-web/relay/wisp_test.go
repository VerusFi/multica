package main

import (
	"bytes"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	f := Frame{Type: TypeData, StreamID: 7, Payload: []byte("hello")}
	got, err := DecodeFrame(f.Encode())
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != TypeData || got.StreamID != 7 || !bytes.Equal(got.Payload, []byte("hello")) {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestDecodeFrameShortBuffer(t *testing.T) {
	if _, err := DecodeFrame([]byte{0x01, 0x00}); err == nil {
		t.Fatal("want error on short buffer")
	}
}

func TestParseConnect(t *testing.T) {
	// stream_type=1 (TCP), port=443 LE, host "example.com"
	payload := append([]byte{0x01, 0xBB, 0x01}, []byte("example.com")...)
	c, err := ParseConnect(payload)
	if err != nil {
		t.Fatal(err)
	}
	if c.StreamType != 1 || c.Port != 443 || c.Host != "example.com" {
		t.Fatalf("bad connect: %+v", c)
	}
}

func TestContinuePayload(t *testing.T) {
	if got := ContinuePayload(128); !bytes.Equal(got, []byte{0x80, 0, 0, 0}) {
		t.Fatalf("bad continue payload: %v", got)
	}
}
