# Script-only selfhost relay (no compiled binaries) — Design

**Date:** 2026-08-17
**Status:** Approved by Rodrigo (sections 1/2/3 reviewed in conversation)
**Parent:** `2026-08-16-selfhost-in-browser-design.md` (§6 "Running a self-hosted relay")

## 1. Goal

Replace the Go `multica-relay` (a cross-compiled static binary distributed through the
fork's GitHub Releases) with implementations that are 100% script: running the relay
requires only what the operating system already ships — or nearly so (`python3` on
macOS/Linux). GitHub Releases stops being a dependency of the relay entirely: everything
the relay needs is served as static files by the Pages deployment itself.

### Deliverables

1. **`relay.py`** — the relay itself: a single file, Python ≥ 3.9, **stdlib only**
   (asyncio + socket + hashlib/base64 for a hand-written RFC 6455 WebSocket server —
   the stdlib has none). Implements WISP v1 (TCP and UDP) with the same contract as the
   current Go relay.
2. **`relay.sh`** — no longer downloads a binary; becomes a thin wrapper: validates
   `python3` (presence + minimum version, with a dedicated message for macOS's Command
   Line Tools stub), downloads `relay.py` from Pages into `~/.multica/`, and runs it in
   the foreground, forwarding `MULTICA_RELAY_ORIGIN` and extra arguments as today.
3. **`relay.ps1`** — rewritten as a **complete, self-contained** relay in PowerShell
   (HttpListener + .NET WebSockets that Windows 10+ already ships, compatible with
   Windows PowerShell 5.1). `irm … | iex` remains the one-liner; there is no second
   download.

### Removals

- `deploy/selfhost-web/relay/` (the Go implementation) — the whole directory.
- The relay cross-compile step and the five `multica-relay-*` assets in
  `.github/workflows/selfhost-release.yml` (the workflow itself stays, for the guest's
  386 payload tarball). The fail-closed asset guard shrinks accordingly.
- `.relay-bin` build outputs and their `.gitignore` entries.

Per repository policy, the replaced path is removed, not preserved.

### What does not change

- The one-liners shown on the page keep exactly the same shape
  (`curl …/relay.sh | MULTICA_RELAY_ORIGIN=… sh` and
  `$env:MULTICA_RELAY_ORIGIN='…'; irm …/relay.ps1 | iex`) — `js/ui.js` stays untouched
  or nearly so.
- The security posture: still an unauthenticated outbound proxy, loopback bind by
  default, Origin allowlist, with the same honest disclosure in the README.

### Non-goals

- Persistent installation, background services, or OS service registration.
- New authentication in the protocol.
- Changes to the page's instance flow.

## 2. Relay behavior contract

Identical to the current Go relay, across implementations:

- **Default bind `127.0.0.1:8086`** — loopback, never all interfaces. `-listen` accepts
  the same forms Go does, including `:18086` (empty host = all interfaces), which the
  smoke test uses today.
- **Origin allowlist** with the same defaults (`localhost`, `127.0.0.1`, `[::1]`, with
  and without port), the same pattern normalization (accepts a full URL such as
  `https://owner.github.io`, strips the scheme and trailing `/`), `-origin` repeatable
  and comma-separable, and `-allow-any-origin` with the same loud warning in the log.
  A rejected Origin is **logged** — it is the one failure a legitimate user can hit.
- **WISP v1**: CONNECT/DATA/CONTINUE/CLOSE frames, TCP and UDP streams, initial buffer
  128, same close reasons (0x41 invalid payload, 0x42 connection failure, 0x02 closed).
  A malformed payload is ignored; it does not kill the session.
- **CLI compatible with the Go form**: `relay.py` accepts `-listen` / `-origin` /
  `-allow-any-origin` with a single dash (argparse registers those literal option
  strings), so arguments forwarded by `relay.sh` and documented commands remain valid
  without translation.

## 3. Components

### `relay.py`

asyncio; one coroutine per WebSocket connection and one per stream. Minimal but correct
RFC 6455 handshake: validates `Upgrade` / `Sec-WebSocket-Key`, answers
`Sec-WebSocket-Accept` (SHA-1 + base64), and applies the Origin check **before**
accepting. Binary framing with mandatory unmasking of client frames, support for
fragmentation/continuation, PING answered with PONG, and a frame-size cap so a client
cannot make the relay allocate without bound. UDP uses one connected socket per stream,
mirroring Go's `net.Dial("udp")`.

### `relay.sh`

Keeps the current structure (same `~/.multica/` target, same printed
`wisp://localhost:8086` line, same forwarding of `MULTICA_RELAY_ORIGIN` and `"$@"`),
swapping the middle: instead of detecting OS/arch and downloading a binary from
Releases, it:

1. verifies `python3` on PATH — on macOS, distinguishes Apple's stub without Command
   Line Tools (via `xcode-select -p`) and explains the popup before it appears;
2. verifies version ≥ 3.9;
3. downloads `relay.py` from the **same Pages base the script itself was served from**
   (env override kept for dev, today `MULTICA_RELAY_URL_BASE`), with the same
   partial-download cleanup;
4. `exec python3 ~/.multica/relay.py …`.

### `relay.ps1`

Self-contained Windows relay: HttpListener on `http://127.0.0.1:8086/` (loopback does
not require elevation in http.sys) + `AcceptWebSocketAsync` — both in the .NET
Framework Windows 10+ ships, running on stock Windows PowerShell 5.1. Same Origin check
(the header is available on the request before accepting), same WISP frames, same flag
contract via PowerShell parameters (`-Listen`, `-Origin`, `-AllowAnyOrigin`) plus
`$env:MULTICA_RELAY_ORIGIN`. Concurrency via .NET Tasks with a PowerShell pump loop —
the highest-risk piece of this design; see the risk table.

### Error handling (new cases, all with clear messages)

- No `python3` → per-OS instruction (macOS: Command Line Tools; Linux: the distro's
  package manager).
- Python too old → states the minimum version.
- Port already in use → says which port and suggests `-listen`.
- Windows: HttpListener denied → suggests an alternative port.
- Inherited cases (download failure with cleanup, rejected origin logging) keep their
  current behavior.

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `relay.ps1` on PS 5.1: juggling async .NET Tasks in PowerShell is painful and deadlock-prone | Keep the design as synchronous as possible (a pump loop polling Tasks); if PS 5.1 proves unworkable during implementation, the fallback is `relay.ps1` detecting Python on Windows and using it, making Python a Windows prerequisite — that decision returns to Rodrigo before being applied |
| `AcceptWebSocketAsync` / `HttpListener` outside Windows (testing under `pwsh` on Linux) may not work | `relay.ps1` tests run on a **Windows** GitHub Actions runner (real PS 5.1), not `pwsh`/Linux — test the environment users actually have |
| Hand-written RFC 6455 handshake/framing has traps (masking, fragmentation, control frames) | Dedicated protocol test suite plus the first-boot smoke test with real v86 as the client |
| Behavior drift between `relay.py` and `relay.ps1` (double parity) | A **shared conformance suite** (§5) executed against both implementations, instead of per-implementation tests |
| macOS CLT `python3` may be older than expected | Conservative minimum (3.9; current CLT ships ≥ 3.9); the wrapper checks and explains |

## 5. Testing

1. **WISP conformance suite** — the replacement for the current Go tests
   (`main_test.go` / `wisp_test.go`): a Node runner (`tests/relay-conformance.spec.mjs`,
   alongside the existing specs) that spawns a relay as a subprocess and exercises it
   over a real WebSocket: handshake, Origin accepted/rejected/normalized, TCP echo, UDP
   stream, CONTINUE/flow, close codes, malformed payload, fragmented frames, PING/PONG.
   Parameterized by the relay command: locally it runs against `python3 relay.py`; on
   the CI Windows runner it runs against `powershell -File relay.ps1`. One suite, two
   implementations — this is what guarantees parity.
2. **Python unit tests** (`relay_test.py`, stdlib `unittest`): frame codec, origin
   normalization, handshake parsing — what is cheapest to test from inside.
3. **Adaptations**: `tests/smoke-firstboot.mjs` and the `dev/` verify scripts replace
   `go build` + binary spawn with spawning `python3 relay.py`.
4. **Wrapper**: a simple shell test for `relay.sh` (no `python3` on PATH → right
   message; old version → right message), using PATH fakes per the repository's
   agent-CLI test rule.

## 6. CI, deploy, and docs

- `selfhost-release.yml` loses the relay cross-compile step and its five assets; the
  fail-closed publishing guard shrinks to the remaining payload assets.
- The Pages workflow serves `relay.py` automatically (it lives in
  `deploy/selfhost-web/` like `relay.sh` already does).
- A lightweight CI job (in the existing PR workflow or the Pages workflow) runs the
  conformance suite on `ubuntu` (Python) and `windows` (PowerShell 5.1).
- `deploy/selfhost-web/README.md`: "Running a relay" rewritten — no Releases, no
  binaries; prerequisite `python3` on macOS/Linux, nothing on Windows; troubleshooting
  entries for the new errors; the "unauthenticated proxy" disclosure stays intact.
- `dev/NOTES.md`: updated where it ties the relay to the `selfhost-latest` release
  channel.
