package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"

	"github.com/coder/websocket"
)

const initialBuffer = 128

// This relay is an unauthenticated outbound TCP/UDP proxy: anything that can
// open a WebSocket to it can make this machine dial arbitrary hosts and
// ports (that is its whole job — it is what gives a v86 guest, which cannot
// open raw sockets from a browser tab, real internet access). There is no
// authentication in the WISP protocol and none bolted on here, so the only
// two things standing between "the guest in your own tab" and "anyone else"
// are the listen address and the WebSocket origin check below. Both default
// to the tightest setting that still lets the shipped page work.

// defaultListen binds loopback only, NOT ":8086" (all interfaces). A relay on
// all interfaces is reachable by every other host on the user's LAN — a
// coffee-shop/hotel/office network — as an open proxy. Loopback costs the
// intended flow nothing: the relay dials *outward* from this machine
// regardless of what it binds, and the only client that ever needs to reach
// it is a browser on this same machine.
const defaultListen = "127.0.0.1:8086"

// defaultOriginPatterns is the WebSocket Origin allowlist. It used to be
// {"*"}, i.e. any website open in any other tab could silently connect to
// the relay and use it as a proxy attributed to this machine. Patterns are
// matched (case-insensitively, with filepath.Match globbing) against the
// Origin header's host[:port] by coder/websocket's Accept.
//
// Localhost is allowed by default so a page served from a local static
// server (README, "Local usage without Pages") works out of the box. A page
// served from a real deployment (GitHub Pages) has that site's origin, which
// must be allowed explicitly with -origin — the page's own "Run a relay"
// one-liner passes its origin through MULTICA_RELAY_ORIGIN for exactly this
// reason.
var defaultOriginPatterns = []string{
	"localhost", "localhost:*",
	"127.0.0.1", "127.0.0.1:*",
	"[::1]", "[::1]:*",
}

// Effective allowlist, set by main() from the flags. Package-level so tests
// can drive handleWS's accept path directly.
var originPatterns = defaultOriginPatterns

var schemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*://`)

// normalizeOriginPattern turns what a user (or the page's one-liner)
// naturally passes — a full origin like "https://owner.github.io" — into what
// coder/websocket matches on: the bare host[:port]. Already-bare patterns
// ("*.example.com:*") pass through unchanged.
func normalizeOriginPattern(s string) string {
	s = strings.TrimSpace(s)
	s = schemeRe.ReplaceAllString(s, "")
	return strings.TrimSuffix(s, "/")
}

// originList collects -origin, which is both repeatable and
// comma-separated ("-origin a,b -origin c").
type originList []string

func (o *originList) String() string { return strings.Join(*o, ",") }

func (o *originList) Set(v string) error {
	for _, part := range strings.Split(v, ",") {
		if p := normalizeOriginPattern(part); p != "" {
			*o = append(*o, p)
		}
	}
	return nil
}

type session struct {
	mu      sync.Mutex
	ws      *websocket.Conn
	streams map[uint32]net.Conn
}

func (s *session) send(ctx context.Context, f Frame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.ws.Write(ctx, websocket.MessageBinary, f.Encode())
}

func (s *session) closeStream(ctx context.Context, id uint32, reason byte) {
	s.mu.Lock()
	c := s.streams[id]
	delete(s.streams, id)
	s.mu.Unlock()
	if c != nil {
		c.Close()
	}
	s.send(ctx, Frame{Type: TypeClose, StreamID: id, Payload: []byte{reason}})
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: originPatterns})
	if err != nil {
		// Logged (not silently dropped) because a rejected Origin is the one
		// failure a legitimate user can hit — a page deployed somewhere the
		// relay wasn't told about shows up in the browser only as "could not
		// connect to relay". See -origin.
		log.Printf("websocket accept rejected (origin %q): %v", r.Header.Get("Origin"), err)
		return
	}
	ctx := r.Context()
	s := &session{ws: ws, streams: map[uint32]net.Conn{}}
	defer func() {
		for _, c := range s.streams {
			c.Close()
		}
		ws.Close(websocket.StatusNormalClosure, "")
	}()

	s.send(ctx, Frame{Type: TypeContinue, StreamID: 0, Payload: ContinuePayload(initialBuffer)})

	for {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			return
		}
		f, err := DecodeFrame(msg)
		if err != nil {
			continue
		}
		switch f.Type {
		case TypeConnect:
			cp, err := ParseConnect(f.Payload)
			if err != nil {
				s.closeStream(ctx, f.StreamID, 0x41)
				continue
			}
			network := "tcp"
			if cp.StreamType == 2 {
				network = "udp"
			}
			conn, err := net.Dial(network, net.JoinHostPort(cp.Host, fmt.Sprintf("%d", cp.Port)))
			if err != nil {
				s.closeStream(ctx, f.StreamID, 0x42)
				continue
			}
			s.mu.Lock()
			s.streams[f.StreamID] = conn
			s.mu.Unlock()
			go func(id uint32, conn net.Conn) {
				buf := make([]byte, 32*1024)
				for {
					n, err := conn.Read(buf)
					if n > 0 {
						payload := make([]byte, n)
						copy(payload, buf[:n])
						s.send(ctx, Frame{Type: TypeData, StreamID: id, Payload: payload})
					}
					if err != nil {
						s.closeStream(ctx, id, 0x02)
						return
					}
				}
			}(f.StreamID, conn)
		case TypeData:
			s.mu.Lock()
			conn := s.streams[f.StreamID]
			s.mu.Unlock()
			if conn != nil {
				if _, err := conn.Write(f.Payload); err != nil {
					s.closeStream(ctx, f.StreamID, 0x02)
				} else {
					s.send(ctx, Frame{Type: TypeContinue, StreamID: f.StreamID, Payload: ContinuePayload(initialBuffer)})
				}
			}
		case TypeClose:
			s.closeStream(ctx, f.StreamID, 0x02)
		}
	}
}

func main() {
	listen := flag.String("listen", defaultListen,
		"listen address (defaults to loopback: this is an unauthenticated proxy, binding all interfaces exposes it to your whole LAN)")
	var origins originList
	flag.Var(&origins, "origin",
		"additional allowed browser origin, host[:port] or full URL; repeatable and comma-separated (e.g. -origin https://owner.github.io)")
	allowAnyOrigin := flag.Bool("allow-any-origin", false,
		"accept WebSockets from ANY origin — any website open in another tab can then use this relay as a proxy; last resort only")
	flag.Parse()

	if *allowAnyOrigin {
		originPatterns = []string{"*"}
		log.Print("WARNING: -allow-any-origin is set: any website in any tab can use this relay as an unauthenticated proxy from this machine")
	} else {
		originPatterns = append(append([]string{}, defaultOriginPatterns...), origins...)
	}
	log.Printf("multica-relay (WISP v1) listening on %s (allowed origins: %s)", *listen, strings.Join(originPatterns, " "))
	log.Fatal(http.ListenAndServe(*listen, http.HandlerFunc(handleWS)))
}
