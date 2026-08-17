package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// withOriginPatterns swaps the package-level allowlist for one test.
func withOriginPatterns(t *testing.T, patterns []string) {
	t.Helper()
	prev := originPatterns
	originPatterns = patterns
	t.Cleanup(func() { originPatterns = prev })
}

func TestNormalizeOriginPattern(t *testing.T) {
	cases := map[string]string{
		"https://owner.github.io":  "owner.github.io",
		"http://localhost:8000/":   "localhost:8000",
		" wss://relay.example:443": "relay.example:443",
		"*.example.com:*":          "*.example.com:*",
		"localhost":                "localhost",
	}
	for in, want := range cases {
		if got := normalizeOriginPattern(in); got != want {
			t.Errorf("normalizeOriginPattern(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOriginListFlag(t *testing.T) {
	var o originList
	if err := o.Set("https://a.example, b.example:8080"); err != nil {
		t.Fatal(err)
	}
	if err := o.Set("c.example"); err != nil {
		t.Fatal(err)
	}
	want := "a.example,b.example:8080,c.example"
	if o.String() != want {
		t.Fatalf("originList = %q, want %q", o.String(), want)
	}
}

// A browser-supplied Origin outside the allowlist must be refused before any
// stream can be opened — this is what stops any website in another tab from
// using the relay as an unauthenticated proxy.
func TestForeignOriginRejected(t *testing.T) {
	withOriginPatterns(t, defaultOriginPatterns)

	srv := httptest.NewServer(http.HandlerFunc(handleWS))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}},
	})
	if err == nil {
		t.Fatal("a foreign Origin must be rejected by the default allowlist")
	}
}

// ...while an origin the user explicitly allowed (what the page's own relay
// one-liner passes for a deployed Pages site) is accepted.
func TestAllowedOriginAccepted(t *testing.T) {
	withOriginPatterns(t, append(append([]string{}, defaultOriginPatterns...), normalizeOriginPattern("https://owner.github.io")))

	srv := httptest.NewServer(http.HandlerFunc(handleWS))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://owner.github.io"}},
	})
	if err != nil {
		t.Fatalf("an explicitly allowed Origin must be accepted: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	_, msg, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := DecodeFrame(msg)
	if f.Type != TypeContinue {
		t.Fatalf("want initial CONTINUE, got type 0x%02x", f.Type)
	}
}

// A page served from a local static server (README, "Local usage without
// Pages") works with no flags at all.
func TestLocalhostOriginAcceptedByDefault(t *testing.T) {
	withOriginPatterns(t, defaultOriginPatterns)

	srv := httptest.NewServer(http.HandlerFunc(handleWS))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"http://localhost:8000"}},
	})
	if err != nil {
		t.Fatalf("a localhost origin must be accepted by default: %v", err)
	}
	ws.Close(websocket.StatusNormalClosure, "")
}

func TestTCPStreamEcho(t *testing.T) {
	withOriginPatterns(t, defaultOriginPatterns)

	echo, _ := net.Listen("tcp", "127.0.0.1:0")
	defer echo.Close()
	go func() {
		c, err := echo.Accept()
		if err != nil {
			return
		}
		buf := make([]byte, 64)
		n, _ := c.Read(buf)
		c.Write(buf[:n])
	}()

	srv := httptest.NewServer(http.HandlerFunc(handleWS))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	// initial CONTINUE from server
	_, msg, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := DecodeFrame(msg)
	if f.Type != TypeContinue {
		t.Fatalf("want initial CONTINUE, got type 0x%02x", f.Type)
	}

	host, port := splitHostPort(t, echo.Addr().String())
	connect := Frame{Type: TypeConnect, StreamID: 1,
		Payload: append([]byte{0x01, byte(port), byte(port >> 8)}, []byte(host)...)}
	ws.Write(ctx, websocket.MessageBinary, connect.Encode())
	ws.Write(ctx, websocket.MessageBinary, Frame{Type: TypeData, StreamID: 1, Payload: []byte("ping")}.Encode())

	for {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		f, _ := DecodeFrame(msg)
		if f.Type == TypeData && f.StreamID == 1 {
			if string(f.Payload) != "ping" {
				t.Fatalf("echo mismatch: %q", f.Payload)
			}
			return
		}
	}
}

func splitHostPort(t *testing.T, addr string) (string, int) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	var port int
	for _, ch := range portStr {
		port = port*10 + int(ch-'0')
	}
	return host, port
}
