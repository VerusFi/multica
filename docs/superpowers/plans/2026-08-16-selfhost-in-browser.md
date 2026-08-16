# Self-hosting multica in a browser tab (v86) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `selfhost.html` in the fork: a static page that provisions and runs a complete multica instance (Alpine x86 32-bit, LUKS+btrfs, Postgres+pgvector, Go backend, Next.js frontend) inside a v86 VM in the visitor's browser, persisted in IndexedDB, with a no-Docker WebSocket relay and GitHub Pages deployment.

**Architecture:** The page ships only boot artifacts (kernel + custom initramfs) and vendored JS (v86, xterm.js). On first boot the guest provisions itself onto a single LUKS→btrfs disk (Alpine from CDN through the relay, multica from a fork GitHub Release built for 386). Resume uses v86 full-state snapshots (RAM included) stored in IndexedDB. Egress networking goes through `multica-relay`, a static WISP v1 server binary users start with a curl one-liner.

**Tech Stack:** v86 (WebAssembly PC emulator), Alpine Linux 3.23 x86 (32-bit), OpenRC, LUKS (cryptsetup) + btrfs, PostgreSQL 17 + pgvector, Node.js (ia32), Go (`GOARCH=386` backend; relay), vanilla JS + WebCrypto + IndexedDB + Service Worker, xterm.js, Playwright (browser tests), GitHub Actions + Pages.

**Spec:** `docs/superpowers/specs/2026-08-16-selfhost-in-browser-design.md`

## Global Constraints

- Everything written to files (code, comments, docs, commit messages) is in **English**.
- Branch: `feature/selfhost-in-browser`. Commit after every task (conventional commits).
- Alpine pinned to **3.23** x86 (32-bit, `i586`); kernel package decided by Task 4 (virt vs lts).
- **No CDN dependencies** in the page: v86, xterm.js, BIOS files are vendored into `deploy/selfhost-web/vendor/`.
- Page code is **vanilla JS (ES modules)** — no framework, no bundler, no new monorepo dependencies. Page tests run via a standalone Playwright runner local to `deploy/selfhost-web/`, not via the monorepo's configs.
- Relay protocol: **WISP v1** (https://github.com/MercuryWorkshop/wisp-protocol). Default relay address `wisp://localhost:8086`.
- Required creation fields: instance name, vault PIN, disk size (GB), relay address, disk passphrase (+ confirmation).
- Serial progress markers emitted by the guest on `ttyS0` use the exact format `@@SH:phase:<name>@@` with names: `network`, `download`, `luks`, `install`, `initdb`, `services`, `ready`, and `@@SH:err:<message>@@` on failure.
- The disk passphrase travels only over `ttyS1` (v86 UART1), never on `ttyS0`, cmdline, or storage.
- Build commands that need Linux/Docker run against the existing Lima VM docker context (`docker context use multica` is already the session default).

## File Structure

```
deploy/selfhost-web/
  selfhost.html               # launcher page: creation flow, instance list, console
  index.html                  # static landing replica with Selfhost button
  relay.sh                    # macOS/Linux relay bootstrap one-liner target
  relay.ps1                   # Windows relay bootstrap one-liner target
  js/
    vault.js                  # PIN vault: KDF + AES-GCM seal/open
    instance-manager.js       # IndexedDB schema, instance CRUD, block store, snapshots
    vm-controller.js          # v86 lifecycle, ttyS1 passphrase, markers, save/restore
    console.js                # xterm.js <-> serial0 wiring
    ui.js                     # creation form, validation, relay pre-flight, list, buttons
  sw.js                       # Service Worker: routes /instance/<id>/app/* into the guest
  vendor/                     # libv86.js, v86.wasm, seabios.bin, vgabios.bin, xterm.{js,css}
  boot/                       # vmlinuz + initramfs.img (built, committed)
  guest/
    init-selfhost             # initramfs /init hook (stage dispatch)
    provision.sh              # stage1 (LUKS/btrfs), stage2 (Alpine install), stage3 (multica)
  build-boot.sh               # builds boot/ inside a linux/386 Alpine container
  build-selfhost-tarball.sh   # builds multica-selfhost-386.tar.gz (backend/frontend/migrations)
  relay/                      # Go module "multica-relay" (WISP v1 server)
    go.mod  wisp.go  wisp_test.go  main.go  main_test.go
  dev/                        # throwaway-quality harness for boot verification
    harness.html  setup-harness.sh  verify-net.mjs  NOTES.md
  tests/
    run-tests.mjs             # standalone Playwright runner for page unit tests
    vault.spec.mjs  instance-manager.spec.mjs  ui.spec.mjs
  README.md                   # deploy + relay + manual E2E checklist
.github/workflows/
  selfhost-release.yml        # 386 tarball + relay binaries + boot artifacts -> Release
  selfhost-pages.yml          # publishes deploy/selfhost-web/ to GitHub Pages
apps/web/features/landing/components/landing-header.tsx   # + Selfhost button
apps/web/features/landing/i18n/{en,zh,ja,ko}.ts           # + selfhost strings
```

Task order front-loads the two spec risks: relay/DNS behavior (Tasks 1–3) and kernel modules (Task 4). UI tasks depend only on interfaces defined here, so review can reject an implementation without invalidating neighbors.

---

### Task 1: multica-relay — WISP v1 frame codec

**Files:**
- Create: `deploy/selfhost-web/relay/go.mod`
- Create: `deploy/selfhost-web/relay/wisp.go`
- Test: `deploy/selfhost-web/relay/wisp_test.go`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `type Frame struct { Type byte; StreamID uint32; Payload []byte }`, constants `TypeConnect=0x01, TypeData=0x02, TypeContinue=0x03, TypeClose=0x04`, `DecodeFrame([]byte) (Frame, error)`, `(Frame) Encode() []byte`, `type ConnectPayload struct { StreamType byte; Port uint16; Host string }` (`StreamType`: 1=TCP, 2=UDP), `ParseConnect([]byte) (ConnectPayload, error)`, `ContinuePayload(remaining uint32) []byte`. Task 2 builds the server on these exact names.

- [ ] **Step 1: Create the module**

```bash
cd deploy/selfhost-web/relay
cat > go.mod <<'EOF'
module multica-relay

go 1.26
EOF
```

- [ ] **Step 2: Write the failing tests**

`wisp_test.go`:

```go
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
```

- [ ] **Step 3: Run tests, verify they fail to compile** — `cd deploy/selfhost-web/relay && go test ./...` → expected: `undefined: Frame` etc.

- [ ] **Step 4: Implement `wisp.go`**

WISP v1 wire format (verify against the spec in the Global Constraints link while implementing): every WebSocket binary message is one packet `[u8 type][u32le stream_id][payload]`; `CONNECT` payload is `[u8 stream_type][u16le port][hostname bytes]`; `CONTINUE` payload is `[u32le buffer_remaining]`; `CLOSE` payload is `[u8 reason]`.

```go
package main

import (
	"encoding/binary"
	"errors"
)

const (
	TypeConnect  byte = 0x01
	TypeData     byte = 0x02
	TypeContinue byte = 0x03
	TypeClose    byte = 0x04
)

type Frame struct {
	Type     byte
	StreamID uint32
	Payload  []byte
}

func (f Frame) Encode() []byte {
	out := make([]byte, 5+len(f.Payload))
	out[0] = f.Type
	binary.LittleEndian.PutUint32(out[1:5], f.StreamID)
	copy(out[5:], f.Payload)
	return out
}

func DecodeFrame(b []byte) (Frame, error) {
	if len(b) < 5 {
		return Frame{}, errors.New("wisp: frame shorter than header")
	}
	return Frame{Type: b[0], StreamID: binary.LittleEndian.Uint32(b[1:5]), Payload: b[5:]}, nil
}

type ConnectPayload struct {
	StreamType byte
	Port       uint16
	Host       string
}

func ParseConnect(b []byte) (ConnectPayload, error) {
	if len(b) < 4 {
		return ConnectPayload{}, errors.New("wisp: connect payload too short")
	}
	return ConnectPayload{StreamType: b[0], Port: binary.LittleEndian.Uint16(b[1:3]), Host: string(b[3:])}, nil
}

func ContinuePayload(remaining uint32) []byte {
	out := make([]byte, 4)
	binary.LittleEndian.PutUint32(out, remaining)
	return out
}
```

- [ ] **Step 5: Run tests, verify pass** — `go test ./...` → PASS.
- [ ] **Step 6: Commit** — `git add deploy/selfhost-web/relay && git commit -m "feat(selfhost): add WISP v1 frame codec for multica-relay"`

---

### Task 2: multica-relay — WebSocket server with TCP/UDP streams

**Files:**
- Create: `deploy/selfhost-web/relay/main.go`
- Test: `deploy/selfhost-web/relay/main_test.go`
- Modify: `deploy/selfhost-web/relay/go.mod` (add `github.com/coder/websocket`)

**Interfaces:**
- Consumes: Task 1 codec (`Frame`, `DecodeFrame`, `ParseConnect`, `ContinuePayload`, type constants).
- Produces: binary `multica-relay` with flag `-listen` (default `:8086`); WS endpoint at `/` speaking WISP v1: on open sends `CONTINUE` (stream 0, buffer 128); `CONNECT` with a hostname performs **server-side DNS** via `net.Dial`; TCP and UDP stream types both supported. Task 3 boots a guest through this binary; Task 16's scripts download it from Releases.

- [ ] **Step 1: Write the failing integration test**

`main_test.go` — starts the relay on a random port, connects with a WS client, opens a TCP stream to a local echo server, sends DATA, expects the same DATA back:

```go
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

func TestTCPStreamEcho(t *testing.T) {
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
```

- [ ] **Step 2: Run, verify failure** — `go get github.com/coder/websocket && go test ./...` → expected: `undefined: handleWS`.

- [ ] **Step 3: Implement `main.go`**

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

const initialBuffer = 128

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
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
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
			conn, err := net.Dial(network, fmt.Sprintf("%s:%d", cp.Host, cp.Port))
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
						reason := byte(0x02)
						if err == io.EOF {
							reason = 0x02
						}
						s.closeStream(ctx, id, reason)
						return
					}
				}
			}(f.StreamID, conn)
		case TypeData:
			s.mu.Lock()
			conn := s.streams[f.StreamID]
			s.mu.Unlock()
			if conn != nil {
				conn.Write(f.Payload)
				s.send(ctx, Frame{Type: TypeContinue, StreamID: f.StreamID, Payload: ContinuePayload(initialBuffer)})
			}
		case TypeClose:
			s.closeStream(ctx, f.StreamID, 0x02)
		}
	}
}

func main() {
	listen := flag.String("listen", ":8086", "listen address")
	flag.Parse()
	log.Printf("multica-relay (WISP v1) listening on %s", *listen)
	log.Fatal(http.ListenAndServe(*listen, http.HandlerFunc(handleWS)))
}
```

- [ ] **Step 4: Run tests, verify pass** — `go test ./...` → PASS. Also `go vet ./...` clean.
- [ ] **Step 5: Smoke the binary** — `go build -o /tmp/multica-relay . && /tmp/multica-relay -listen :8086 &`; `curl -s -o /dev/null -w '%{http_code}' http://localhost:8086/` → expected `426` (upgrade required); kill it.
- [ ] **Step 6: Commit** — `git add deploy/selfhost-web/relay && git commit -m "feat(selfhost): multica-relay WISP v1 server with TCP/UDP streams"`

---

### Task 3: Verification — guest networking through multica-relay (DECISION GATE)

**Files:**
- Create: `deploy/selfhost-web/dev/setup-harness.sh`
- Create: `deploy/selfhost-web/dev/harness.html`
- Create: `deploy/selfhost-web/dev/verify-net.mjs`
- Create: `deploy/selfhost-web/dev/NOTES.md`

**Interfaces:**
- Consumes: `multica-relay` binary (Task 2).
- Produces: a written verdict in `dev/NOTES.md` on: (a) does the guest get an address with v86's `wisp://` backend (v86 handles DHCP internally for WISP — confirm); (b) does DNS resolve (WISP does server-side DNS on CONNECT by hostname; confirm the guest's resolver path works, e.g. via v86's internal DNS handling); (c) does `apk update` over HTTPS succeed. **If any of these fail:** the documented fallback per spec is wsnic; record what failed and adjust Task 6+ kernel cmdline/config accordingly. Later tasks assume `wisp://` works; this gate is where that assumption is validated.

- [ ] **Step 1: Write `setup-harness.sh`** — downloads Alpine virt x86 ISO 3.23.5 + extracts kernel/initramfs (same technique proven in the conversation spike), vendors v86 + BIOS:

```bash
#!/bin/sh
# Throwaway verification harness. NOT part of the shipped page.
set -eux
cd "$(dirname "$0")"
ISO=alpine-virt-3.23.5-x86.iso
[ -f "$ISO" ] || curl -sO "https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86/$ISO"
[ -d iso ] || { mkdir iso && bsdtar -xf "$ISO" -C iso; }
[ -d node_modules/v86 ] || npm install v86@latest
mkdir -p bios
[ -f bios/seabios.bin ] || curl -sL -o bios/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
[ -f bios/vgabios.bin ] || curl -sL -o bios/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
[ -d node_modules/playwright ] || npm install playwright
echo "harness ready"
```

- [ ] **Step 2: Write `harness.html`** — copy of the spike page structure: v86 with `bzimage: iso/boot/vmlinuz-virt`, `initrd: iso/boot/initramfs-virt`, `cmdline: "modules=loop,squashfs,sd-mod,usb-storage console=ttyS0,115200"`, `cdrom: {url: "alpine-virt-3.23.5-x86.iso"}`, and `net_device: { type: "virtio", relay_url: "wisp://localhost:8086/" }`. Expose `window.serialLog`, `window.bootMarks`, `window.sendCmd(cmd)` and auto-login on `login:` exactly as the spike page did. Strip ANSI with `/\x1b(\[[0-9;?]*[A-Za-z]|[78])/g`.

- [ ] **Step 3: Write `verify-net.mjs`** — headless Playwright driver:

```js
// Boots the harness and asserts: shell ready, address configured, DNS + HTTPS work.
import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { execSync, spawn } from "child_process";

const relay = spawn("go", ["run", "../relay"], { cwd: new URL(".", import.meta.url).pathname, stdio: "inherit" });
// static file server on :8123 serving this directory
const srv = createServer((req, res) => {
  const path = "." + (req.url === "/" ? "/harness.html" : req.url.split("?")[0]);
  try { res.end(readFileSync(path)); } catch { res.statusCode = 404; res.end(); }
}).listen(8123);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:8123/");

async function waitSerial(pattern, timeoutMs) {
  await page.waitForFunction(
    (p) => new RegExp(p).test(window.serialLog),
    pattern, { timeout: timeoutMs, polling: 1000 },
  );
}

await waitSerial("localhost:~#", 240_000);                       // shell ready
await page.evaluate(() => sendCmd("ifconfig eth0 up; udhcpc -i eth0 -t 10 && echo NET_UP"));
await waitSerial("NET_UP|no lease", 90_000);
await page.evaluate(() => sendCmd(
  'printf "https://dl-cdn.alpinelinux.org/alpine/v3.23/main\\n" > /etc/apk/repositories && apk update && echo APK_NET_OK'));
await waitSerial("APK_NET_OK|ERROR|WARNING", 180_000);

const log = await page.evaluate(() => window.serialLog);
console.log(log.slice(-2000));
console.log(/APK_NET_OK/.test(log) ? "VERDICT: WISP OK" : "VERDICT: WISP FAILED — record failure mode in NOTES.md");
await browser.close(); srv.close(); relay.kill();
```

- [ ] **Step 4: Run it** — `cd deploy/selfhost-web/dev && sh setup-harness.sh && node verify-net.mjs`. Expected: `VERDICT: WISP OK`. If FAILED: capture the failure (no DHCP lease vs. DNS failure vs. TLS failure) in `NOTES.md`, then re-test after adjusting (e.g., static IP + v86 DNS handling, or fall back to `ws://` + wsnic and record the decision).
- [ ] **Step 5: Write `NOTES.md`** with the verdict, exact numbers (time to shell, time for apk), and the decision for Task 6's kernel cmdline / network bring-up commands.
- [ ] **Step 6: Commit** — `git add deploy/selfhost-web/dev && git commit -m "test(selfhost): guest networking verification harness and verdict (wisp)"`

---

### Task 4: Boot artifacts — kernel decision + `build-boot.sh` (DECISION GATE)

**Files:**
- Create: `deploy/selfhost-web/build-boot.sh`
- Create: `deploy/selfhost-web/guest/init-selfhost` (skeleton only in this task; filled by Tasks 6–8)
- Output (committed): `deploy/selfhost-web/boot/vmlinuz`, `deploy/selfhost-web/boot/initramfs.img`

**Interfaces:**
- Consumes: Lima VM docker context; Task 3 harness (to boot-test the artifacts).
- Produces: `boot/vmlinuz` + `boot/initramfs.img` where the initramfs contains busybox, `cryptsetup`, btrfs userland, virtio/ata/btrfs/dm-crypt kernel modules, `apk.static` (x86), and `/init` = `init-selfhost`. Also produces the **kernel decision** (virt vs lts) recorded in `dev/NOTES.md`. Tasks 6–8 write the real init logic; Task 11 points v86 at these paths.

- [ ] **Step 1: Enable 386 emulation in the Lima VM docker (one-time)**

```bash
docker run --privileged --rm tonistiigi/binfmt --install 386
docker run --rm --platform linux/386 alpine:3.23 uname -m   # expect: i686 (or i586)
```

- [ ] **Step 2: Write the module check + decide the kernel**

```bash
docker run --rm --platform linux/386 alpine:3.23 sh -c '
  apk add --no-cache linux-virt >/dev/null 2>&1
  ls /lib/modules/*/kernel/drivers/md/dm-crypt.ko* /lib/modules/*/kernel/fs/btrfs/btrfs.ko* 2>/dev/null && echo VIRT_OK || echo VIRT_MISSING'
```

If `VIRT_MISSING`, repeat with `linux-lts`; use whichever kernel has both modules. Record the decision in `dev/NOTES.md` and use the winning package name in `build-boot.sh` (`KERNEL_PKG` variable below).

- [ ] **Step 3: Write `build-boot.sh`**

```bash
#!/bin/sh
# Builds boot/vmlinuz + boot/initramfs.img inside a linux/386 Alpine container.
# The initramfs carries our /init (guest/init-selfhost), provision.sh, cryptsetup,
# btrfs tools, apk.static and the kernel modules needed to reach the encrypted root.
set -eux
cd "$(dirname "$0")"
KERNEL_PKG="${KERNEL_PKG:-linux-virt}"   # decided by the module check (Task 4, Step 2)

docker run --rm --platform linux/386 \
  -v "$PWD/guest:/guest:ro" -v "$PWD/boot:/out" alpine:3.23 sh -eux <<'EOF'
apk add --no-cache "$KERNEL_PKG" mkinitfs cryptsetup btrfs-progs apk-tools-static
KVER="$(basename /lib/modules/*)"
# Extra content shipped inside the initramfs:
mkdir -p /etc/mkinitfs/files.d
cat > /etc/mkinitfs/files.d/selfhost <<'LIST'
/sbin/apk.static
/guest/provision.sh
LIST
cp /guest/init-selfhost /usr/share/mkinitfs/initramfs-init  # replace stock init
echo 'features="base virtio ata ext4 btrfs cryptsetup network dhcp"' > /etc/mkinitfs/mkinitfs.conf
mkinitfs -o /out/initramfs.img "$KVER"
cp /boot/vmlinuz-* /out/vmlinuz
EOF
ls -la boot/
```

(The `KERNEL_PKG` env passes through `docker run` via `-e KERNEL_PKG` — add `-e KERNEL_PKG` to the command when the decision is `linux-lts`.)

- [ ] **Step 4: Create the `init-selfhost` skeleton** — a minimal `/init` that mounts `/proc`,`/sys`,`/dev`, prints `@@SH:phase:network@@` and drops to a busybox shell. Its only purpose in this task is proving the initramfs boots; Tasks 6–8 replace the body.

```sh
#!/bin/sh
# initramfs /init — selfhost boot entry (skeleton; stages arrive in later tasks)
mount -t proc none /proc
mount -t sysfs none /sys
mount -t devtmpfs none /dev
echo "@@SH:phase:network@@" > /dev/console
exec /bin/sh
```

- [ ] **Step 5: Build and boot-test** — `sh build-boot.sh`; then point the Task 3 harness at the new artifacts (`bzimage: ../boot/vmlinuz`, `initrd: ../boot/initramfs.img`, no cdrom) and verify via a variant of `verify-net.mjs` that `@@SH:phase:network@@` appears on serial. Expected within 120 s.
- [ ] **Step 6: Commit** — `git add deploy/selfhost-web/build-boot.sh deploy/selfhost-web/guest deploy/selfhost-web/boot && git commit -m "feat(selfhost): boot artifact builder and initramfs skeleton"`

---

### Task 5: `build-selfhost-tarball.sh` — multica for 386

**Files:**
- Create: `deploy/selfhost-web/build-selfhost-tarball.sh`

**Interfaces:**
- Consumes: repo sources (`server/`, `apps/web/`).
- Produces: `multica-selfhost-386.tar.gz` with layout `backend/server`, `backend/migrate`, `backend/migrations/`, `frontend/` (Next standalone output incl. `server.js`), `VERSION`. Task 8's provisioning downloads and unpacks exactly this layout; Task 17's workflow runs exactly this script.

- [ ] **Step 1: Write the script**

```bash
#!/bin/sh
# Builds the 386 payload the guest downloads on first boot.
# Backend: trivial Go cross-compile. Frontend: `next build` output is
# arch-neutral JS; we build on the host and then VERIFY no native .node
# binaries slipped into the standalone output (spec §7 risk).
set -eux
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$PWD/multica-selfhost-386.tar.gz}"
STAGE="$(mktemp -d)"

# Backend (GOARCH=386, static)
cd "$REPO_ROOT/server"
CGO_ENABLED=0 GOOS=linux GOARCH=386 go build -ldflags "-s -w" -o "$STAGE/backend/server" ./cmd/server
CGO_ENABLED=0 GOOS=linux GOARCH=386 go build -ldflags "-s -w" -o "$STAGE/backend/migrate" ./cmd/migrate
cp -r migrations "$STAGE/backend/migrations"

# Frontend (standalone)
cd "$REPO_ROOT"
pnpm install --frozen-lockfile
STANDALONE=true pnpm --filter web build
cp -r apps/web/.next/standalone "$STAGE/frontend"
cp -r apps/web/.next/static "$STAGE/frontend/apps/web/.next/static"
cp -r apps/web/public "$STAGE/frontend/apps/web/public" 2>/dev/null || true

# Native-module guard: fail loudly if any .node binary is present
if find "$STAGE/frontend" -name '*.node' | grep -q .; then
  echo "ERROR: native modules found in standalone output; rebuild them for linux/386:" >&2
  find "$STAGE/frontend" -name '*.node' >&2
  exit 1
fi

git -C "$REPO_ROOT" rev-parse --short HEAD > "$STAGE/VERSION"
tar -czf "$OUT" -C "$STAGE" .
ls -lh "$OUT"
```

- [ ] **Step 2: Run it** — `sh deploy/selfhost-web/build-selfhost-tarball.sh /tmp/multica-selfhost-386.tar.gz`. Expected: tarball produced; note its size in `dev/NOTES.md`. If the native-module guard trips, resolve per spec §7 (rebuild those packages in a `linux/386` container and overlay them) before proceeding.
- [ ] **Step 3: Verify the backend binary runs on 386** — `docker run --rm --platform linux/386 -v /tmp:/t alpine:3.23 sh -c 'apk add --no-cache libc6-compat >/dev/null; tar -xzf /t/multica-selfhost-386.tar.gz backend/server -O > /tmp/s; chmod +x /tmp/s; /tmp/s --help || true'` — expected: the binary executes (prints usage or an env-var error, not `exec format error`).
- [ ] **Step 4: Commit** — `git add deploy/selfhost-web/build-selfhost-tarball.sh && git commit -m "feat(selfhost): 386 payload build script with native-module guard"`

---

### Task 6: Guest provisioning stage 1 — passphrase, LUKS, btrfs

**Files:**
- Create: `deploy/selfhost-web/guest/provision.sh`
- Modify: `deploy/selfhost-web/guest/init-selfhost` (replace skeleton body)

**Interfaces:**
- Consumes: initramfs contents from Task 4 (`cryptsetup`, btrfs tools, `apk.static`, modules); disk at `/dev/vda`; passphrase written by the page to `ttyS1` (`/dev/ttyS1`), newline-terminated.
- Produces: marker protocol on `/dev/console` (`@@SH:phase:*@@`, `@@SH:err:*@@` — exact names from Global Constraints); an opened LUKS mapping `/dev/mapper/shroot` with btrfs mounted at `/mnt`; `provision.sh` functions `stage1_disk`, `stage2_install`, `stage3_multica`, `coldboot_mount` used by `init-selfhost`.

- [ ] **Step 1: Write `init-selfhost` (final form)**

```sh
#!/bin/sh
# initramfs /init for selfhost instances.
# Boot contract: passphrase arrives on /dev/ttyS1 (newline-terminated);
# progress markers go to /dev/console (ttyS0) as @@SH:phase:<name>@@.
mount -t proc none /proc
mount -t sysfs none /sys
mount -t devtmpfs none /dev

mark() { echo "@@SH:phase:$1@@" > /dev/console; }
fail() { echo "@@SH:err:$1@@" > /dev/console; exec /bin/sh; }

. /guest/provision.sh

for m in virtio_blk virtio_net dm-crypt btrfs; do modprobe "$m" 2>/dev/null || true; done

mark network
ip link set lo up
ip link set eth0 up
udhcpc -i eth0 -t 12 -n || fail "dhcp-failed"

PASS="$(head -n1 /dev/ttyS1)" || fail "no-passphrase"
[ -n "$PASS" ] || fail "empty-passphrase"

if cryptsetup isLuks /dev/vda; then
  coldboot_mount "$PASS" || fail "luks-open-failed"
else
  stage1_disk "$PASS"    || fail "disk-setup-failed"
  stage2_install         || fail "install-failed"
  stage3_multica         || fail "multica-failed"
fi

mark services
umount /proc /sys
exec switch_root /mnt /sbin/init
```

- [ ] **Step 2: Write `provision.sh` stage 1 + cold-boot**

```sh
#!/bin/sh
# Provisioning stages for the selfhost guest. Sourced by init-selfhost.
REPO_MAIN="https://dl-cdn.alpinelinux.org/alpine/v3.23/main"
REPO_COMMUNITY="https://dl-cdn.alpinelinux.org/alpine/v3.23/community"

stage1_disk() {  # $1 = passphrase; formats /dev/vda as LUKS->btrfs
  echo "@@SH:phase:luks@@" > /dev/console
  printf '%s' "$1" | cryptsetup luksFormat --type luks2 --batch-mode /dev/vda - || return 1
  printf '%s' "$1" | cryptsetup open /dev/vda shroot - || return 1
  mkfs.btrfs -f -L shroot /dev/mapper/shroot || return 1
  mkdir -p /mnt && mount -o compress=zstd /dev/mapper/shroot /mnt
}

coldboot_mount() {  # $1 = passphrase; opens existing disk
  echo "@@SH:phase:luks@@" > /dev/console
  printf '%s' "$1" | cryptsetup open /dev/vda shroot - || return 1
  mkdir -p /mnt && mount -o compress=zstd /dev/mapper/shroot /mnt
}
```

- [ ] **Step 3: Boot-test stage 1 in the harness** — extend `dev/harness.html` with an empty 2 GiB v86 disk (`hda: { buffer: new ArrayBuffer(2 * 1024 ** 3) }` is too large for RAM — use v86's sparse/`async` empty image option; consult vendored `v86.d.ts` for the supported empty-disk config and record the chosen form in `dev/NOTES.md`), plus `uart1: true` in the V86 options and `emulator.serial_send_bytes(1, ...)` (confirm exact name in `v86.d.ts`; adjust here and in Task 11 together). Drive with a `verify-luks.mjs` copy of `verify-net.mjs` asserting the marker sequence `network` → `luks` and that `btrfs` appears in `/proc/mounts` (`sendCmd("grep btrfs /proc/mounts")` once dropped to the shell with `exec /bin/sh` temporarily appended after stage1 for the test run).
- [ ] **Step 4: Commit** — `git add deploy/selfhost-web/guest && git commit -m "feat(selfhost): guest init with LUKS+btrfs stage and cold-boot path"`

---

### Task 7: Guest provisioning stage 2 — Alpine install onto the encrypted disk

**Files:**
- Modify: `deploy/selfhost-web/guest/provision.sh` (add `stage2_install`)

**Interfaces:**
- Consumes: mounted `/mnt` from stage 1; network from init; `apk.static` in initramfs; `KERNEL_PKG` decision from Task 4 (hardcode the winner here).
- Produces: a bootable-by-our-initramfs Alpine system in `/mnt` with OpenRC, PostgreSQL 17 + pgvector, Node.js, and users/dirs multica needs. Stage 3 chroots into it.

- [ ] **Step 1: Implement `stage2_install`**

```sh
stage2_install() {
  echo "@@SH:phase:install@@" > /dev/console
  /sbin/apk.static --arch x86 --root /mnt --initdb --no-cache \
    --repository "$REPO_MAIN" --repository "$REPO_COMMUNITY" \
    --allow-untrusted add \
    alpine-base openrc busybox-openrc linux-virt \
    postgresql17 postgresql17-contrib postgresql-pgvector \
    nodejs curl ca-certificates cryptsetup btrfs-progs || return 1

  printf '%s\n%s\n' "$REPO_MAIN" "$REPO_COMMUNITY" > /mnt/etc/apk/repositories
  echo "multica-selfhost" > /mnt/etc/hostname
  # loopback up on every boot (spike lesson: PostgreSQL refuses to start without it)
  printf 'auto lo\niface lo inet loopback\nauto eth0\niface eth0 inet dhcp\n' > /mnt/etc/network/interfaces
  for svc in networking syslog; do chroot /mnt rc-update add "$svc" default || true; done
  chroot /mnt rc-update add postgresql default || true
  echo "@@SH:phase:download@@" > /dev/console
}
```

(Note: `--allow-untrusted` only if key verification inside initramfs proves impractical; try without it first and keep it only with a written justification in `dev/NOTES.md`.)

- [ ] **Step 2: Boot-test** — harness run asserting marker sequence reaches `install` and that `chroot /mnt /usr/bin/psql --version` prints `psql (PostgreSQL) 17.x` (drive via `sendCmd` in a debug shell). Budget up to 20 minutes of emulated time; capture durations in `dev/NOTES.md`.
- [ ] **Step 3: Commit** — `git add deploy/selfhost-web/guest/provision.sh && git commit -m "feat(selfhost): stage 2 installs Alpine + Postgres + Node onto the encrypted disk"`

---

### Task 8: Guest provisioning stage 3 — multica install, initdb, services

**Files:**
- Modify: `deploy/selfhost-web/guest/provision.sh` (add `stage3_multica`)
- Create: `deploy/selfhost-web/guest/multica-backend.initd` (OpenRC service)
- Create: `deploy/selfhost-web/guest/multica-web.initd` (OpenRC service)

**Interfaces:**
- Consumes: stage-2 system in `/mnt`; the release tarball layout from Task 5 (`backend/server`, `backend/migrate`, `backend/migrations/`, `frontend/…/server.js`); kernel cmdline parameter `sh_release_url=<URL>` set by the page (Task 11) pointing at the fork release asset.
- Produces: running services after `switch_root`: postgres on 5432, backend on 8080, frontend on 3000; markers `initdb` → `services` → `ready` (the final `ready` is emitted by an OpenRC `local.d` script once the frontend answers on TCP 3000).

- [ ] **Step 1: Write the OpenRC service files** (installed into `/mnt/etc/init.d/` by stage 3; both marked `need postgresql` / `need multica-backend` respectively; `command_background=yes`, pidfiles under `/run`). Backend env: `DATABASE_URL=postgres://multica:multica@127.0.0.1:5432/multica?sslmode=disable`, `PORT=8080`, `JWT_SECRET` generated once into `/opt/multica/env` by stage 3 (`head -c32 /dev/urandom | base64`), `APP_ENV=production`, `MULTICA_APP_URL=http://localhost:3000`. Frontend env: `REMOTE_API_URL=http://127.0.0.1:8080`, `HOSTNAME=0.0.0.0`, `PORT=3000`; command `node /opt/multica/frontend/apps/web/server.js`.

- [ ] **Step 2: Implement `stage3_multica`**

```sh
stage3_multica() {
  echo "@@SH:phase:download@@" > /dev/console
  REL="$(sed -n 's/.*sh_release_url=\([^ ]*\).*/\1/p' /proc/cmdline)"
  [ -n "$REL" ] || return 1
  mkdir -p /mnt/opt/multica
  chroot /mnt curl -fL --retry 3 -o /opt/multica/payload.tar.gz "$REL" || return 1
  tar -xzf /mnt/opt/multica/payload.tar.gz -C /mnt/opt/multica && rm /mnt/opt/multica/payload.tar.gz

  echo "@@SH:phase:initdb@@" > /dev/console
  chroot /mnt sh -c '
    mkdir -p /run/postgresql /var/lib/postgresql/data /opt/multica &&
    chown -R postgres /run/postgresql /var/lib/postgresql &&
    su postgres -c "initdb -D /var/lib/postgresql/data" &&
    su postgres -c "pg_ctl -D /var/lib/postgresql/data -w start" &&
    su postgres -c "psql -c \"create user multica password '"'"'multica'"'"'; create database multica owner multica;\"" &&
    su postgres -c "psql -d multica -c \"create extension if not exists vector;\"" &&
    JWT="$(head -c32 /dev/urandom | base64)" && printf "JWT_SECRET=%s\n" "$JWT" > /opt/multica/env &&
    DATABASE_URL="postgres://multica:multica@127.0.0.1:5432/multica?sslmode=disable" /opt/multica/backend/migrate &&
    su postgres -c "pg_ctl -D /var/lib/postgresql/data -w stop"' || return 1

  cp /guest/multica-backend.initd /mnt/etc/init.d/multica-backend
  cp /guest/multica-web.initd /mnt/etc/init.d/multica-web
  chmod +x /mnt/etc/init.d/multica-backend /mnt/etc/init.d/multica-web
  chroot /mnt rc-update add multica-backend default
  chroot /mnt rc-update add multica-web default
  # 'ready' marker: emitted after boot once the frontend answers
  mkdir -p /mnt/etc/local.d
  cat > /mnt/etc/local.d/ready-marker.start <<'RM'
#!/bin/sh
( while ! nc -z 127.0.0.1 3000; do sleep 5; done
  echo "@@SH:phase:ready@@" > /dev/console ) &
RM
  chmod +x /mnt/etc/local.d/ready-marker.start
  chroot /mnt rc-update add local default
}
```

(If `migrate` flags differ — check `server/cmd/migrate` usage in-repo before running — adjust the invocation accordingly; also copy the initd files into the initramfs list in `build-boot.sh` `files.d/selfhost`.)

- [ ] **Step 3: Full first-boot test in the harness** — `verify-firstboot.mjs` (copy of the Task 3 driver): serve a locally built tarball (Task 5 output) from the harness HTTP server, set `cmdline` to include `sh_release_url=http://192.168.86.1:8123/multica-selfhost-386.tar.gz` (host address as seen from the guest — confirm from Task 3's NOTES; with WISP the JS-side `fetch` interception address may differ, record what works), assert the full marker sequence through `ready`, then `curl -s localhost:3000` inside the guest returns HTML. Budget: up to 45 minutes. Record all timings in `dev/NOTES.md`.
- [ ] **Step 4: Cold-boot test** — restart the same VM (no state restore), assert `luks` → `services` → `ready` without `install` (nothing re-downloaded).
- [ ] **Step 5: Commit** — `git add deploy/selfhost-web/guest deploy/selfhost-web/build-boot.sh && git commit -m "feat(selfhost): stage 3 installs multica, initializes Postgres, wires OpenRC services"`

---

### Task 9: Page test runner + `vault.js`

**Files:**
- Create: `deploy/selfhost-web/tests/run-tests.mjs`
- Create: `deploy/selfhost-web/tests/vault.spec.mjs`
- Create: `deploy/selfhost-web/js/vault.js`

**Interfaces:**
- Consumes: nothing from other tasks (WebCrypto + IndexedDB are browser built-ins).
- Produces: ES module `vault.js` exporting `sealVault(pin, dataObj) -> Promise<SealedBlob>` (`{v:1, salt:b64, iv:b64, ct:b64, iter:600000}`), `openVault(pin, sealedBlob) -> Promise<object>` (throws `WrongPinError`), `class WrongPinError extends Error`. Also the test runner contract used by Tasks 10 and 13: `node tests/run-tests.mjs [spec-file...]` serves `deploy/selfhost-web/` on a random port, opens headless Chromium, loads each `*.spec.mjs` as a module in the page, runs its exported `run()` which throws on failure, prints PASS/FAIL per spec, exits non-zero on failure.

- [ ] **Step 1: Write `run-tests.mjs`**

```js
// Standalone browser test runner (no monorepo deps): serves the page dir,
// loads each spec module in Chromium, executes its exported run().
import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, statSync } from "fs";
import { extname, join } from "path";

const root = new URL("..", import.meta.url).pathname;
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".css": "text/css", ".wasm": "application/wasm" };
const srv = createServer((req, res) => {
  const p = join(root, req.url.split("?")[0]);
  try {
    statSync(p);
    res.setHeader("content-type", mime[extname(p)] ?? "application/octet-stream");
    res.end(readFileSync(p));
  } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const port = srv.address().port;

const specs = process.argv.slice(2).length ? process.argv.slice(2) : ["tests/vault.spec.mjs", "tests/instance-manager.spec.mjs", "tests/ui.spec.mjs"];
const browser = await chromium.launch();
let failed = 0;
for (const spec of specs) {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => m.type() === "error" && console.error(`[${spec}]`, m.text()));
  await page.goto(`http://localhost:${port}/selfhost.html`);
  try {
    await page.evaluate(async (s) => (await import(`/${s}`)).run(), spec);
    console.log(`PASS ${spec}`);
  } catch (e) { failed++; console.error(`FAIL ${spec}\n${e}`); }
}
await browser.close(); srv.close();
process.exit(failed ? 1 : 0);
```

(Requires `selfhost.html` to exist; create an empty placeholder page in this task: `<!doctype html><html><head><meta charset="utf-8"><title>multica selfhost</title></head><body></body></html>` — Task 13 replaces it.)

- [ ] **Step 2: Write the failing spec** — `tests/vault.spec.mjs`:

```js
import { sealVault, openVault, WrongPinError } from "/js/vault.js";

export async function run() {
  const data = { instances: [{ id: "a1", passphrase: "hunter2" }] };
  const sealed = await sealVault("1234-long-pin", data);
  if (typeof sealed.salt !== "string" || sealed.v !== 1) throw new Error("sealed blob shape");
  const back = await openVault("1234-long-pin", sealed);
  if (back.instances[0].passphrase !== "hunter2") throw new Error("round trip");
  let threw = false;
  try { await openVault("wrong-pin", sealed); } catch (e) {
    threw = true;
    if (!(e instanceof WrongPinError)) throw new Error("wrong error type");
  }
  if (!threw) throw new Error("wrong PIN must throw");
}
```

- [ ] **Step 3: Run, verify failure** — `cd deploy/selfhost-web && npm init -y >/dev/null && npm i playwright && node tests/run-tests.mjs tests/vault.spec.mjs` → FAIL (module not found). Add `deploy/selfhost-web/node_modules` and `package-lock.json` to `.gitignore` (create/extend the repo-root entry).

- [ ] **Step 4: Implement `js/vault.js`**

```js
// PIN vault: PBKDF2(SHA-256, 600k iterations) -> AES-GCM over the config JSON.
// A wrong PIN fails GCM authentication, surfaced as WrongPinError.
export class WrongPinError extends Error {
  constructor() { super("wrong PIN"); this.name = "WrongPinError"; }
}

const ITER = 600000;
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pin, salt) {
  const raw = await crypto.subtle.importKey("raw", te.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
    raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealVault(pin, dataObj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(dataObj)));
  return { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function openVault(pin, sealed) {
  const key = await deriveKey(pin, unb64(sealed.salt));
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
    return JSON.parse(td.decode(pt));
  } catch { throw new WrongPinError(); }
}
```

- [ ] **Step 5: Run, verify pass** — `node tests/run-tests.mjs tests/vault.spec.mjs` → PASS.
- [ ] **Step 6: Commit** — `git add deploy/selfhost-web && git commit -m "feat(selfhost): PIN vault (PBKDF2 + AES-GCM) with browser test runner"`

---

### Task 10: `instance-manager.js` — IndexedDB schema, CRUD, blocks, snapshots

**Files:**
- Create: `deploy/selfhost-web/js/instance-manager.js`
- Test: `deploy/selfhost-web/tests/instance-manager.spec.mjs`

**Interfaces:**
- Consumes: `vault.js` (stores the sealed blob it is given; never sees the PIN).
- Produces (exact exports Tasks 11/13/14 use):
  - `openDb() -> Promise<IDBDatabase>` — DB `multica-selfhost` v1, stores: `meta` (key `"vault"` → SealedBlob), `instances` (keyPath `id` → `{id, name, diskSizeGB, relayUrl, createdAt, provisioned:boolean}` — public metadata only; passphrase lives ONLY inside the vault blob), `blocks` (key `[instanceId, index]`), `snapshots` (key `[instanceId, seq]`).
  - `getVaultBlob() / putVaultBlob(blob)`
  - `listInstances() -> Promise<InstanceMeta[]>`, `putInstance(meta)`, `deleteInstance(id)` (also deletes its blocks + snapshots)
  - `class BlockStore { constructor(instanceId, blockSize=1<<20); read(index)->Promise<ArrayBuffer|null>; write(index, buf)->Promise<void>; }`
  - `saveSnapshot(instanceId, arrayBuffer)` (chunked 8 MiB), `loadSnapshot(instanceId) -> Promise<ArrayBuffer|null>`, `deleteSnapshot(instanceId)`
- [ ] **Step 1: Write the failing spec** — round-trip instance CRUD; block write/read at index 0 and 4097; snapshot save/load of a 20 MiB buffer byte-identical; `deleteInstance` leaves no blocks/snapshots behind (count via store `getAllKeys` bounded by `IDBKeyRange.bound([id,0],[id,Infinity])`).
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement** — plain `indexedDB` (no wrapper lib); every function returns Promises via a small `req(tx)` helper; snapshots stored as `{seq, total, chunk}` records.
- [ ] **Step 4: Run, verify pass** — `node tests/run-tests.mjs tests/instance-manager.spec.mjs`.
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): IndexedDB instance manager (metadata, blocks, snapshots)"`

---

### Task 11: `vm-controller.js` — v86 lifecycle

**Files:**
- Create: `deploy/selfhost-web/js/vm-controller.js`
- Create: `deploy/selfhost-web/vendor/` (vendor libv86.js, v86.wasm, seabios.bin, vgabios.bin from the npm package + v86 repo — same files the harness uses)

**Interfaces:**
- Consumes: `BlockStore`, `saveSnapshot`, `loadSnapshot` (Task 10); `boot/vmlinuz` + `boot/initramfs.img` (Task 4); marker protocol (Global Constraints).
- Produces: `class VmController` with:
  - `constructor({instance, passphrase, onPhase(name), onError(msg), onSerial(chunk), onStateChange(state)})` — `state ∈ "stopped"|"starting"|"running"|"paused"`
  - `async start()` — if a snapshot exists: restore it; else cold boot: `new V86({ wasm_path:"vendor/v86.wasm", memory_size: 512*1024*1024, bios/vga_bios from vendor, bzimage:"boot/vmlinuz", initrd:"boot/initramfs.img", cmdline: "console=ttyS0,115200 sh_release_url=" + RELEASE_URL, net_device:{type:"virtio", relay_url: instance.relayUrl}, uart1:true, hda: <BlockStore-backed custom disk of instance.diskSizeGB>, autostart:true })`. The BlockStore-backed disk and the exact `uart1`/`serial_send_bytes` API names were pinned down in Task 6's harness work — copy the working forms from `dev/NOTES.md`. On the first serial output after boot, write `passphrase + "\n"` to UART1.
  - `async pause()` — `emulator.stop()`, then `save_state()` → `saveSnapshot`; state `paused`.
  - `async resume()` — restore from snapshot (`restore_state`) and continue; state `running`.
  - `async stop()` — save snapshot, destroy emulator; state `stopped`.
  - `sendToConsole(text)` — `serial0_send`.
  - Parses `@@SH:phase:(\w+)@@` / `@@SH:err:(.+?)@@` out of the serial stream into `onPhase`/`onError`.
  - `RELEASE_URL` is a module-level constant `const RELEASE_URL = window.SELFHOST_RELEASE_URL ?? "https://github.com/VerusFi/multica/releases/latest/download/multica-selfhost-386.tar.gz";`
- [ ] **Step 1: Vendor the assets** (copy from `dev/node_modules/v86/build/` + `dev/bios/`; add xterm.js files in Task 12).
- [ ] **Step 2: Implement `vm-controller.js`** per the interface above; autosave timer (5 min) calling `save_state` → `saveSnapshot` while `running`.
- [ ] **Step 3: Manual harness check** — temporary page `dev/vm-controller-check.html` instantiating VmController against the real boot artifacts with a real relay; verify `onPhase("network")` fires and pause→resume round-trips (drive with a `verify-vmc.mjs` Playwright script asserting the phases). This is the integration test; unit-testing the emulator adds no value.
- [ ] **Step 4: Commit** — `git commit -m "feat(selfhost): vm-controller wrapping v86 lifecycle, markers and snapshots"`

---

### Task 12: `console.js` — xterm.js console

**Files:**
- Create: `deploy/selfhost-web/js/console.js`
- Modify: `deploy/selfhost-web/vendor/` (add `xterm.js`, `xterm.css` from the `@xterm/xterm` npm package dist)

**Interfaces:**
- Consumes: `VmController.onSerial` + `sendToConsole` (Task 11).
- Produces: `attachConsole(containerEl, vmController) -> { dispose() }` — creates a `Terminal`, pipes serial chunks to `term.write`, pipes `term.onData` to `vmController.sendToConsole`.
- [ ] **Step 1: Implement** (thin glue, ~30 lines).
- [ ] **Step 2: Verify in the Task 11 check page** — typing `ls` in the terminal executes in the guest.
- [ ] **Step 3: Commit** — `git commit -m "feat(selfhost): interactive xterm console bound to guest serial"`

---

### Task 13: `ui.js` + `selfhost.html` — creation flow, validation, relay pre-flight

**Files:**
- Create: `deploy/selfhost-web/js/ui.js`
- Modify: `deploy/selfhost-web/selfhost.html` (replace the Task 9 placeholder with the real page)
- Test: `deploy/selfhost-web/tests/ui.spec.mjs`

**Interfaces:**
- Consumes: `vault.js`, `instance-manager.js`, `vm-controller.js`, `console.js`.
- Produces: the page per spec §4. Key exported (for tests) functions from `ui.js`: `validateCreationForm(values) -> {ok:true} | {ok:false, errors:{field:msg}}` (required: `name`, `pin`, `diskSizeGB` (positive integer), `relayUrl` (must parse as `wisp://`, `ws://` or `wss://`), `passphrase` + `passphrase2` equal and non-empty); `preflightRelay(relayUrl, timeoutMs=5000) -> Promise<void>` (opens `new WebSocket(url.replace(/^wisp/, "ws"))`, resolves on `open`, rejects on `error`/timeout — rejection message shown in the UI with a link to the relay instructions section).
- Page behavior: with zero instances, only the **"Create a self host instance"** button is shown; clicking expands the form; **"Create instance"** runs `validateCreationForm` → `preflightRelay` → creates the instance (vault update + `putInstance`) → shows the list. Relay instructions render as three tabs (macOS / Linux / Windows) with copy buttons:
  - macOS/Linux: `curl -fsSL https://<pages-url>/relay.sh | sh`
  - Windows: `irm https://<pages-url>/relay.ps1 | iex`
  (The literal `<pages-url>` is computed at runtime from `location.origin + location.pathname`.)
- [ ] **Step 1: Write the failing spec** — `tests/ui.spec.mjs`: `validateCreationForm` rejects each missing/invalid field with a message; accepts a fully valid set; `preflightRelay("ws://localhost:1", 500)` rejects (nothing listens); a `run()` DOM check: with an empty DB the page shows exactly one button labeled `Create a self host instance`, and after `Create instance` with an unreachable relay an element with `data-testid="relay-error"` becomes visible and no instance is stored.
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement `ui.js` + the real `selfhost.html`** (semantic HTML, single CSS block, dark-friendly; no framework).
- [ ] **Step 4: Run, verify pass** — full `node tests/run-tests.mjs`.
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): creation flow with required-field validation and relay pre-flight"`

---

### Task 14: Instance list, PIN unlock, play/pause/stop wiring

**Files:**
- Modify: `deploy/selfhost-web/js/ui.js`, `deploy/selfhost-web/selfhost.html`
- Test: extend `deploy/selfhost-web/tests/ui.spec.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: on load with a non-empty DB, a PIN prompt; wrong PIN → visible error, nothing listed; correct PIN → instance cards showing name, config summary (`diskSizeGB`, `relayUrl`, `createdAt`), state badge, and buttons: **play** (start/resume via VmController), **pause**, **stop** (rendered only while `running`), **View Console** (opens the xterm drawer), **Open Dashboard** (enabled from phase `ready`; wired fully in Task 15). Phase progress bar driven by `onPhase` during provisioning.
- [ ] **Step 1: Extend the spec** — seeded DB → PIN gate behavior (wrong PIN keeps list hidden; right PIN lists 2 seeded instances); button visibility matrix per state (`stopped`: play only; `running`: pause+stop; `paused`: play+stop).
- [ ] **Step 2: Run, verify failure.** **Step 3: Implement.** **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): PIN-gated instance list with lifecycle controls"`

---

### Task 15: `sw.js` — Service Worker bridge + Open Dashboard

**Files:**
- Create: `deploy/selfhost-web/sw.js`
- Modify: `deploy/selfhost-web/js/vm-controller.js` (guest TCP plumbing), `deploy/selfhost-web/js/ui.js` (Open Dashboard button)

**Interfaces:**
- Consumes: v86's JS-side guest TCP access (the `fetch`-backend guest-listener API referenced in v86's networking docs and `examples/tcp_terminal.html` — study the vendored v86 source for the exact adapter API before implementing; record findings in `dev/NOTES.md`).
- Produces: fetches to `./instance/<id>/app/<path>` are answered by an HTTP request forwarded into the guest's port 3000; "Open Dashboard" opens `./instance/<id>/app/` in a new tab. **Fallback (spec §2):** if the API cannot forward into a `wisp://`-networked guest, implement dashboard access as a second `net_device` is not possible — instead document and wire the alternate mode: VmController exposes `httpRequest(path)` via serial-driven `curl` only for a health check, and Open Dashboard shows the documented relay port-forward instructions. Decide at implementation time, record the decision, and keep the button working in whichever mode.
- [ ] **Step 1: Spike the v86 API in the harness** (30–60 min timebox), record verdict in `dev/NOTES.md`.
- [ ] **Step 2: Implement the winning mode end-to-end.**
- [ ] **Step 3: Manual verification** — after `ready`, Open Dashboard renders the multica login page in the new tab (primary mode) or shows the instructions panel (fallback mode).
- [ ] **Step 4: Commit** — `git commit -m "feat(selfhost): dashboard access bridge (service worker or documented fallback)"`

---

### Task 16: `relay.sh` + `relay.ps1`

**Files:**
- Create: `deploy/selfhost-web/relay.sh`, `deploy/selfhost-web/relay.ps1`

**Interfaces:**
- Consumes: release assets named `multica-relay-darwin-arm64`, `multica-relay-darwin-amd64`, `multica-relay-linux-amd64`, `multica-relay-linux-arm64`, `multica-relay-windows-amd64.exe` (Task 17 must publish exactly these names).
- Produces: `curl -fsSL <pages>/relay.sh | sh` → detects `uname -s`/`uname -m`, downloads the right asset from `https://github.com/VerusFi/multica/releases/latest/download/<asset>` to `~/.multica/multica-relay`, `chmod +x`, prints the address (`wisp://localhost:8086`) and runs it in the foreground. `relay.ps1` equivalent for Windows (`$env:USERPROFILE\.multica\multica-relay.exe`).
- [ ] **Step 1: Write both scripts** (POSIX sh only — no bashisms; `set -eu`).
- [ ] **Step 2: Test `relay.sh` on the Mac** — run with `MULTICA_RELAY_URL_BASE` overridden to a local file server carrying a locally built binary; verify it starts and `curl -s -o /dev/null -w '%{http_code}' http://localhost:8086/` prints 426. `shellcheck relay.sh` clean (via `docker run --rm -v "$PWD:/m" koalaman/shellcheck /m/relay.sh`).
- [ ] **Step 3: Commit** — `git commit -m "feat(selfhost): relay bootstrap one-liners for macOS/Linux/Windows"`

---

### Task 17: GitHub Actions — `selfhost-release.yml` + `selfhost-pages.yml`

**Files:**
- Create: `.github/workflows/selfhost-release.yml`, `.github/workflows/selfhost-pages.yml`

**Interfaces:**
- Consumes: `build-selfhost-tarball.sh` (Task 5), `relay/` (Task 2), `build-boot.sh` (Task 4), `deploy/selfhost-web/` (page).
- Produces: on tag `selfhost-v*`: a Release with `multica-selfhost-386.tar.gz` + the five `multica-relay-*` binaries (`GOOS`/`GOARCH` matrix, `CGO_ENABLED=0`). On push to the branch touching `deploy/selfhost-web/**`: Pages deployment of that directory (`actions/upload-pages-artifact` + `actions/deploy-pages`; page assets only — `dev/`, `tests/`, `relay/`, `node_modules/` excluded via an rsync step into the artifact dir).
- [ ] **Step 1: Write both workflows.** Release job steps: checkout → setup-go → setup-node+pnpm → run `build-selfhost-tarball.sh` → cross-compile relay matrix → `softprops/action-gh-release` with all assets. Pages job: checkout → stage `deploy/selfhost-web` minus dev/tests/relay/node_modules → upload → deploy.
- [ ] **Step 2: Validate syntax** — `docker run --rm -v "$PWD:/repo" rhysd/actionlint:latest -color /repo/.github/workflows/selfhost-*.yml` clean.
- [ ] **Step 3: Commit** — `git commit -m "ci(selfhost): release (386 payload + relay binaries) and Pages workflows"`

---

### Task 18: Landing replica + Selfhost button on the real landing

**Files:**
- Create: `deploy/selfhost-web/index.html`
- Modify: `apps/web/features/landing/components/landing-header.tsx`
- Modify: `apps/web/features/landing/i18n/en.ts`, `zh.ts`, `ja.ts`, `ko.ts` (+ `types.ts` if the header dict type is closed)

**Interfaces:**
- Consumes: real header structure (`navLinks` array at `landing-header.tsx:25-31`, dict `header` block at `en.ts:5-16`).
- Produces: replica `index.html` — static, self-contained, multica visual identity (wordmark text, dark hero), top-right actions **Download** (→ `https://github.com/VerusFi/multica/releases`), **Dashboard** (→ `href="#"` placeholder with `data-configure-me` comment), **Selfhost** (→ `./selfhost.html`). Real landing: a `Selfhost` nav link appended to `navLinks` using new dict key `header.selfhost` (EN: `"Selfhost"`; translate the four locales), href from new env-driven const `SELFHOST_URL = process.env.NEXT_PUBLIC_SELFHOST_URL ?? "/selfhost"` placed in `landing-header.tsx`.
- [ ] **Step 1: Replica page** (pure HTML/CSS, no JS beyond the copy buttons).
- [ ] **Step 2: Real landing edit + i18n keys**; run the web app's existing checks: `pnpm --filter web lint && pnpm --filter web test` (scope: only tests related to landing header/i18n must pass — run the full suite, expect no new failures vs. `main`).
- [ ] **Step 3: Commit** — `git commit -m "feat(selfhost): landing replica for Pages and Selfhost link on the real landing"`

---

### Task 19: README, manual E2E checklist, slow smoke script

**Files:**
- Create: `deploy/selfhost-web/README.md`
- Create: `deploy/selfhost-web/tests/smoke-firstboot.mjs`

**Interfaces:**
- Consumes: everything.
- Produces: README covering (per spec §6): enabling Pages on a fork, the relay one-liners per OS (+ `wss://` note, + wsnic advanced alternative), local usage without Pages, security stance of the PIN vault, and the **manual E2E checklist**: create instance → first boot to `ready` → Open Dashboard → pause → close tab → reopen → PIN → resume → data intact → cold restart with passphrase. `smoke-firstboot.mjs`: Playwright script (same runner infra) that creates an instance against a real local relay and asserts phases through `ready` (marked SLOW; run on demand, not in CI).
- [ ] **Step 1: Write README.** **Step 2: Write smoke script; run it once end-to-end.** 
- [ ] **Step 3: Full test sweep** — `go test ./...` (relay), `node tests/run-tests.mjs` (page), `pnpm --filter web lint` (landing edit).
- [ ] **Step 4: Commit** — `git commit -m "docs(selfhost): deploy guide, manual E2E checklist and slow first-boot smoke"`

---

## Plan Self-Review Notes

- **Spec coverage:** §2 components → Tasks 11/15 (page+bridge), 2/16 (relay), 4/6–8 (guest), 10 (persistence); §3 provisioning/no-image → 4–8; §4 UI/creation/pre-flight/PIN → 13/14/9; §5 modules → 9–13; §6 layout/CI/landing/docs → 5/16/17/18/19; §7 risks → decision gates in 3/4/5/15; §8 testing → 9/10/13/14/19.
- **Known deliberate deferrals recorded here, not hidden:** exact v86 empty-disk/`uart1`/guest-TCP API names are pinned during Tasks 6/11/15 against the vendored `v86.d.ts` and recorded in `dev/NOTES.md` — the plan names the intended calls and requires the executor to confirm them, because inventing unverified emulator API signatures in the plan would be worse.
- **Type consistency check:** `BlockStore`/`saveSnapshot`/`loadSnapshot` names match between Tasks 10 and 11; marker names match Global Constraints across Tasks 6–8, 11, 14; release asset names match between Tasks 16 and 17; tarball layout matches between Tasks 5 and 8.


