# multica self-host-in-a-browser-tab

A complete, private multica instance — LUKS-encrypted disk, Postgres,
backend, frontend — provisioned and run entirely inside one browser tab, via
[v86](https://github.com/copy/v86) (an x86 emulator compiled to
WebAssembly). No server, no container host, no install beyond a tiny local
network relay. This directory (`deploy/selfhost-web/`) is a static site: it
has no backend of its own and needs none to run the app it deploys.

This README covers deploying/running the page itself. For what the
in-browser instance actually *is* once it boots, see the top-level
[`SELF_HOSTING.md`](../../SELF_HOSTING.md); this is a different delivery
mechanism for the same product, optimized for "try it with zero install."

## How it fits together, briefly

- **The page** (`selfhost.html` + `js/*.js`) runs v86 in your tab, storing
  the guest's virtual disk and RAM snapshots in your browser's IndexedDB
  (`js/instance-manager.js`). Nothing about a running instance leaves your
  machine except outbound guest network traffic, which is tunneled through
  the relay below.
- **The relay** (`relay/`, shipped prebuilt via GitHub Releases, source
  small enough to read in five minutes) is a tiny local process that speaks
  the [WISP protocol](https://github.com/MercuryWorkshop/wisp-protocol) on
  one side and plain outbound TCP on the other. The guest's virtual NIC has
  no other way to reach the internet — a browser tab cannot open raw TCP
  sockets, so v86's guest network traffic is tunneled to this relay over a
  WebSocket, and the relay does the actual `net.Dial` on your machine's
  behalf. It relays; it doesn't proxy your multica data anywhere.
- **The guest** is a from-scratch Alpine Linux 386 image (kernel + initramfs
  in `boot/`, provisioning scripts in `guest/`) that partitions and
  LUKS-encrypts its own virtual disk on first boot, then installs and starts
  multica offline from a payload tarball fetched once over the relay.

## Quick start (using a deployed Pages site)

1. Open the deployed `selfhost.html` URL (see below for enabling this on
   your own fork).
2. Run the one-line relay bootstrap for your OS (shown on the page itself,
   under "Run a relay" — also reproduced below).
3. Click **Create a self host instance**, fill in a name, a PIN (protects a
   local vault, see "Security" below), a disk size, the relay address the
   page already prefilled (`wisp://localhost:8086`, matching the relay's
   default port), and a disk passphrase (twice, to confirm).
4. Click **Create instance**, then **Play**. First boot takes several
   minutes (LUKS format, package install, a ~100 MB payload download, a
   database migration) — see "Manual E2E checklist" below for the full
   walkthrough and what to expect at each stage.

## Enabling GitHub Pages on a fork

`.github/workflows/selfhost-pages.yml` (already in this repo) builds and
deploys this directory on every push to `main`/`feature/selfhost-in-browser`
that touches `deploy/selfhost-web/**`, plus manual `workflow_dispatch`. It
stages only page assets — `dev/`, `tests/`, `relay/` (Go sources), and
`node_modules/` are excluded via `rsync --exclude`; `vendor/` (the v86/xterm
runtime) and `boot/` (kernel + initramfs) *do* ship, since the page needs
both.

On a fork, GitHub Pages is not automatically wired up — you need to turn it
on once:

1. **Settings → Actions → General**: confirm Actions are enabled for the
   fork (forks sometimes disable them by default).
2. **Settings → Pages → Build and deployment → Source**: set this to
   **GitHub Actions** (not "Deploy from a branch" — the workflow uses
   `actions/deploy-pages`, which requires the Actions source mode).
3. Push a commit touching `deploy/selfhost-web/**` on `main` (or run the
   workflow manually via **Actions → selfhost-pages → Run workflow**).
4. If the deployment is rejected with a branch-protection-style error:
   **Settings → Environments → github-pages → Deployment branches and
   tags** may restrict which branches/refs can deploy to the `github-pages`
   environment (GitHub creates this environment automatically the first
   time a Pages deployment runs). Add the branch you're pushing from if it's
   not already allowed.
5. A **custom domain is optional** — Pages works fine at its default
   `https://<owner>.github.io/<repo>/` URL. If you want a custom domain,
   configure it under **Settings → Pages → Custom domain**; nothing in this
   directory hardcodes one (no committed `CNAME`).

Once deployed, the app is at `<pages-url>/selfhost.html`; the Pages site
root (`<pages-url>/`) serves `index.html`, a static replica of the main
marketing landing page with a **Selfhost** button pointing at
`./selfhost.html`.

## Running a relay

The relay is a small Go binary, cross-compiled for macOS/Linux/Windows by
`.github/workflows/selfhost-release.yml` and published to this repo's
rolling `selfhost-latest` release tag (deliberately *not* the plain "latest
release" slot, which the ordinary `vX.Y.Z` app releases already claim — see
`relay.sh`'s own comment). The page's "Run a relay" panel shows the right
one-liner for the detected OS tab; the three commands are:

```sh
# macOS / Linux
curl -fsSL <pages-url>/relay.sh | MULTICA_RELAY_ORIGIN=<page-origin> sh
```

```powershell
# Windows (PowerShell)
$env:MULTICA_RELAY_ORIGIN='<page-origin>'; irm <pages-url>/relay.ps1 | iex
```

Both scripts detect your OS/architecture, download the matching
`multica-relay-*` binary from the `selfhost-latest` release into
`~/.multica/` (`%USERPROFILE%\.multica` on Windows), and run it in the
foreground, printing `wisp://localhost:8086` — the address the page's
"Relay address" field already defaults to. `MULTICA_RELAY_URL_BASE` can
override the download source (e.g. to point at a local build — see "Local
usage without Pages").

**Who can reach the relay (and why the one-liner carries an origin).** The
relay is an *unauthenticated* outbound TCP/UDP proxy — that is its entire
job, since a browser tab cannot open raw sockets, and the WISP protocol has
no authentication to lean on. Two defaults keep that from being an open
proxy for other people:

- It binds **loopback only** (`127.0.0.1:8086`) instead of all interfaces, so
  nothing else on your LAN can reach it. This costs the guest nothing: the
  relay always dials *outward from your machine* regardless of what it binds,
  and the only client that ever needs to connect to it is a browser on the
  same machine. Override with `-listen` if you really mean to (e.g.
  `-listen 0.0.0.0:8086`), knowing what that opens.
- It accepts WebSockets only from **localhost origins** by default, so a
  random website open in another tab cannot silently use it as a proxy
  attributed to your machine. A page served from a *deployment* (any Pages
  site) has that site's origin, which must be allowed explicitly — hence
  `MULTICA_RELAY_ORIGIN` above, which the page's own "Run a relay" panel
  fills in with its own origin for you (the copy button gives you the
  complete command). Equivalent flags on the binary: `-origin
  https://owner.github.io` (repeatable, comma-separated, full URL or bare
  `host[:port]`), and `-allow-any-origin` as a documented last resort that
  restores the old trust-everything behavior — it logs a warning because with
  it set, any site in any tab can use your relay.

**The `wss://` constraint.** A page served over `https://` (which every
GitHub Pages deployment is) runs in a browser "secure context." A plain
`ws://` — and therefore a plain `wisp://` (v86's own scheme, unauthenticated
WebSocket underneath) — WebSocket connection from that page to
`localhost` is *mixed content* by the letter of the spec, though most
browsers special-case `localhost`/`127.0.0.1` as trustworthy and allow it in
practice. If your browser blocks it anyway (or you're relaying to a
non-localhost host), the WebSocket needs to be `wss://` (TLS) instead — this
build's relay does **not** terminate TLS itself. The practical workaround is
to keep the relay on `localhost` (where the mixed-content exception
generally applies) rather than trying to run it on a remote/LAN host behind
plain `ws://`; if you need TLS, put a local TLS-terminating proxy (e.g.
`stunnel`, `caddy`) in front of the relay and point the page's relay URL at
`wss://localhost:<port>/` through that proxy instead. This is a real,
disclosed limitation of the shipped relay, not a bug.

**`wsnic` (advanced, not needed by this build).** v86 also supports a raw
`ws://`-based network backend as an alternative to `wisp://`, and some v86
deployments bridge that to a real network interface via a companion helper
commonly called `wsnic`. This build's Task 3 decision gate tested `wisp://`
against `multica-relay` end to end (DHCP, DNS-by-hostname, HTTPS fetch) and
found it fully sufficient in every run — **`wsnic`/`ws://` was never needed
and is not wired up anywhere in this build.** It's mentioned here only so
that if a future deployment target hits trouble with `wisp://` specifically
(a different browser, a stricter network policy, etc.), you know an
alternative network backend exists upstream in v86 to investigate — treat it
as an unexplored escape hatch, not a supported path of this repo.

## Local usage without Pages

Nothing here requires GitHub Pages specifically — it's a static site, so any
local static file server works:

```sh
cd deploy/selfhost-web
python3 -m http.server 8000   # or: npx serve, caddy file-server, etc.
```

Then open `http://localhost:8000/selfhost.html` and run a relay as above
(or build one locally: `cd relay && go build -o multica-relay .`, matching
what `relay.sh` downloads). The default `wisp://localhost:8086` relay
address works unchanged since both the page and the relay are on
`localhost` — no `wss://` concern applies to a plain `http://localhost`
page.

## Security stance

**The PIN vault.** Instance metadata (name, disk size, relay URL) is stored
in the clear in IndexedDB, but each instance's LUKS disk passphrase never
is. Passphrases live only inside one encrypted blob per browser profile:
`PBKDF2(SHA-256, 600,000 iterations)` derives an AES-256-GCM key from your
PIN, which seals `{ passphrases: { instanceId: passphrase, ... } }`
(`js/vault.js`). The PIN itself is **never stored anywhere** — not in
IndexedDB, not in the blob, not in a cookie. A wrong PIN simply fails
AES-GCM authentication (surfaced as `WrongPinError`); there's no separate
password-check step that could leak whether a guessed PIN was "close."
Losing the PIN means losing access to every passphrase sealed under it —
there is no recovery path, by design (nothing to recover from — the PIN was
never escrowed anywhere).

**Disclosed POC limitations — read before relying on this for real data.**
This build deliberately traded some production-grade security for build/
boot-time budgets during development, and each trade-off is flagged in
`dev/NOTES.md` at the point it was made:

- **The guest's own LUKS key derivation is pinned to `pbkdf2` at 1,000
  iterations** (`cryptsetup luksFormat --pbkdf pbkdf2
  --pbkdf-force-iterations 1000`), not LUKS2's default `argon2id`. This is
  *far* too fast to resist offline brute-force of a weak disk passphrase —
  it was chosen to keep boot-test wall time tractable under WASM/386
  emulation during development, not because it's an acceptable production
  KDF. **Use a long, high-entropy disk passphrase**, and treat this as a
  must-fix before this path is used for anything beyond trying the product
  out.
- **The guest exposes a bare, unauthenticated root shell on the serial
  console (`ttyS0`)** once provisioning succeeds (and on any provisioning
  failure). Whoever holds the serial channel — which, in this build, means
  whoever has the tab open with a live `VmController`, since "View Console"
  wires straight to it — gets root in the guest with no further
  authentication. This is what makes the console/health-check features (and
  the dev harnesses' own verification) possible at all, but it is a real
  trust-boundary decision, not an oversight: it needs a generated one-time
  credential or removal before this path is exposed beyond a trusted local
  tab.
- **The resume snapshot defeats the guest's LUKS encryption at rest, and the
  PIN vault is the real barrier.** Pause/Stop and the 5-minute autosave write
  a v86 `save_state()` blob — a byte-for-byte image of the guest's RAM — into
  the *same* IndexedDB as the encrypted disk blocks, **in plaintext**. That
  RAM image necessarily contains the dm-crypt master key of the mounted LUKS
  volume, because a running guest must hold it to read its own disk. So
  anyone with filesystem access to your browser profile has both the
  ciphertext and the key, and needs neither your disk passphrase nor your
  PIN to read the data. LUKS here genuinely protects the disk blocks *only*
  in the no-snapshot case (a fully stopped instance whose snapshot has been
  deleted); the moment a snapshot exists, at-rest encryption of the guest
  disk is effectively bypassed. This is inherent to snapshot-based resume as
  built (resuming without a snapshot means a full cold boot and a LUKS
  re-unlock), not an oversight, and it is not fixed in this build: encrypting
  the snapshot under the vault key would be the fix. Practical consequence:
  **your browser profile is as sensitive as the instance data itself** — the
  PIN vault protects the passphrase (i.e. re-provisioning/cold-boot access
  and any reuse of that passphrase elsewhere), not the data at rest.
- **The relay is an unauthenticated proxy; its defaults limit *who* can use
  it, not *what* it will do.** Anything that can open a WebSocket to
  `multica-relay` can make your machine dial arbitrary hosts and ports, with
  no credential of any kind — the guest's internet access is exactly that
  capability. This build defaults to loopback-only binding and a
  localhost-plus-explicitly-allowed-origin WebSocket allowlist (see "Who can
  reach the relay" above), which closes the two exposures that matter in
  practice: other hosts on your LAN, and other websites open in your own
  browser. What remains, and is not fixed here: any *local* process or any
  origin you explicitly allow gets an unauthenticated proxy for as long as
  the relay runs, and `-allow-any-origin` (or `-listen 0.0.0.0:…`) hands that
  to anyone who can reach the port. Run the relay only while you're actually
  using the page, and don't widen those flags on an untrusted network.
- **The offline install payload is verified by architecture, not by
  cryptographic signature.** The build pipeline's own guard confirms every
  `.node` binary bundled into the frontend payload is genuinely `ELF
  32-bit, Intel 80386` (i.e., matches the guest's actual CPU target) —
  it does not verify a signature or checksum against a trusted source for
  the payload tarball as a whole. The tarball is built and published by this
  repo's own CI (`selfhost-release.yml`) and downloaded by the relay
  one-liners over HTTPS from GitHub Releases, so the practical exposure is
  "trust GitHub Releases over HTTPS," not "trust an arbitrary unauthenticated
  source" — but there is no independent signature check on top of that.

None of these are hidden — they're the same caveats recorded in
`dev/NOTES.md` at the tasks that introduced them, repeated here because this
is the user-facing document people will actually read before typing a real
passphrase in.

## Manual E2E checklist

The automated coverage (unit specs + the slow smoke script below) proves the
mechanics work in isolation; this checklist is the full human walkthrough,
worth running once against any new deployment (a fresh Pages site, a new
relay build, a new browser) before trusting it:

1. **Create an instance.** Open the page, click **Create a self host
   instance**, fill in a name/PIN/disk size/relay URL/passphrase (twice),
   submit. If the relay isn't reachable yet, the form shows a banner
   (`#relay-error`) linking back to the relay setup instructions instead of
   silently creating a broken instance — confirm that path too, by trying
   once with no relay running.
2. **First boot to `ready`.** Click **Play**. Watch the phase-progress bar
   advance through `network → luks → install → download → initdb →
   services → ready` (each label + percentage is live, driven by markers
   the guest prints over its serial console). Budget generously — roughly
   6–8 minutes is typical for a first boot (LUKS format, 81 packages
   installed over the relay, a ~100 MB payload download, a Postgres
   `initdb` + 366-migration `migrate up`). **Open Dashboard** becomes
   enabled exactly when `ready` is reached.
3. **Open Dashboard.** Click it. A real in-tab dashboard tab isn't possible
   in this build — v86's `wisp://` network backend has no JS-side API for
   this page to open a connection *into* the guest, only out of it (see
   `dev/NOTES.md`, "Task 15", for the full spike writeup) — so this opens a
   documented fallback panel instead, explaining the limitation and offering
   **Run health check**, which does a real `curl localhost:3000` over the
   serial console and reports the HTTP status. Confirm it reports
   `Reachable (HTTP 200)`.
4. **Pause.** Click **Pause** on the instance card. This halts the emulated
   CPU and writes a coherent RAM+disk snapshot to IndexedDB before
   returning — confirm the state badge changes to `paused`.
5. **Close the tab**, then **reopen** the page URL fresh (a real new tab,
   not a reload-in-place — this proves persistence across a genuine loss of
   the in-memory JS state, not just a soft reload).
6. **PIN.** Because a sealed vault blob already exists, the page shows the
   PIN gate (**Unlock your instances**) instead of the ordinary creation
   flow. Enter the PIN you used at creation.
7. **Resume.** Your paused instance should be listed with a **Resume**
   button (the same Play button, relabeled). Click it — the guest picks up
   exactly where it left off (restored from the pause-time snapshot, not a
   fresh boot), with no LUKS re-prompt needed from you: the disk passphrase
   was never re-typed here, it flowed automatically from the PIN-unlocked
   vault the moment `VmController` needed it.
8. **Data intact.** Confirm whatever you'd expect to still be there is —
   e.g., open the console (**View Console**) and inspect state directly, or
   re-run the dashboard health check and confirm `HTTP 200` again with no
   re-provisioning having occurred.
9. **Cold restart with passphrase.** Click **Stop** (a full guest shutdown —
   distinct from Pause), then **Play** again. This exercises the "no live
   emulator object survives" path end to end: a brand-new `VmController` is
   constructed, and the disk passphrase is again supplied silently from the
   PIN-unlocked vault rather than asked of you. Confirm the instance returns
   to `ready` and your data is still there. (Note: because `Stop` itself
   persists a snapshot before tearing down, this exercises the "vault
   supplies the passphrase with zero live state carried over" path, not a
   from-scratch LUKS re-unlock against an empty RAM — that specific case,
   restoring from disk blocks alone with *no* snapshot at all, is what
   `dev/verify-firstboot.mjs`'s cold-boot step proves at the engineering
   level; see `dev/NOTES.md` "Task 8" for that evidence if you need it.)
10. **Delete.** Click **Delete** on the card, then **Delete permanently** in
    the confirmation that appears inside the card. This is the only way to
    reclaim the (multi-GB) IndexedDB an instance occupies: it removes the
    instance's metadata, every disk block, every snapshot, and its passphrase
    inside the sealed vault blob. There is no undo — confirm you actually
    meant it. Afterwards, the page should list one fewer instance, and your
    browser's site-storage figure should drop accordingly.

Anything that goes wrong along the way (a failed autosave, a provisioning
error the guest reports over its serial console, a start refused because the
vault has no passphrase for that instance) appears in a red banner above the
instance list, dismissible — errors are not silent.

## Testing

Three layers, fastest to slowest:

**Unit/DOM specs** (fast, browser-driven, no v86 boot — run these on every
change):

```sh
cd deploy/selfhost-web
node tests/run-tests.mjs
```

Runs `tests/vault.spec.mjs`, `tests/instance-manager.spec.mjs`,
`tests/vm-controller.spec.mjs`, `tests/ui.spec.mjs`, and
`tests/subpath.spec.mjs` against a real Chromium loading the real
`selfhost.html` — no relay, no boot artifacts needed. The runner serves the
page from a **subpath prefix**, matching a GitHub Pages project site, so any
origin-rooted reference in the shipped page fails the suite instead of only
failing in production (`tests/subpath.spec.mjs` asserts that directly).

**Relay unit tests** (Go, no browser):

```sh
cd deploy/selfhost-web/relay
go test ./...
```

**Landing edit lint** (the Task 18 changes to the real marketing site's nav,
covered by the monorepo's own lint):

```sh
pnpm --filter web lint
```

**The slow first-boot smoke test** (real v86 boot, real local relay, real
~100 MB payload download — SLOW, run on demand only, never in CI):

```sh
cd deploy/selfhost-web
node tests/smoke-firstboot.mjs
```

Drives the actual shipped page (not a lower-level test harness) through
Playwright: fills the real creation form, clicks the real Play button, and
asserts the phase-progress UI advances through `network → … → ready`
against a real locally-built relay. Requires the boot artifacts
(`boot/vmlinuz`, `boot/initramfs.img`), the v86/xterm vendor bundle
(`vendor/`), and a built payload tarball at
`dev/multica-selfhost-386.tar.gz` (a symlink — see `dev/NOTES.md` for how
`build-selfhost-tarball.sh` produces it); it fails fast with a clear message
if any are missing rather than hanging. It is intentionally **not** in
`tests/run-tests.mjs`'s default spec list and not wired into any CI
workflow — it's a human-triggered proof, not a gate.

For lower-level, per-stage verification during development (boot-only,
LUKS-only, install-only, networking-only, etc.), see the `dev/verify-*.mjs`
scripts and `dev/NOTES.md`, which this script's plumbing (relay
build-and-spawn, static server, LAN-IP resolution for the payload URL) is
directly modeled on. Those dev-only scripts additionally need large local
artifacts (a 2 GiB empty disk image, the Alpine install ISO) that aren't
part of a normal checkout and are out of scope for this README.

## Troubleshooting

- **"See relay setup instructions" banner on Create**: the page tried to
  open a WebSocket to the relay URL you entered and it didn't connect
  within 5 seconds. Confirm the relay is actually running and the address/
  port match (`wisp://localhost:8086` is the default both sides agree on).
- **Relay download 404s**: `relay.sh`/`relay.ps1` pull from this repo's
  `selfhost-latest` release tag, not the plain "latest release" (which is
  claimed by ordinary app releases and ships no relay binaries at all). If
  you're on a fork with no releases published yet, build the relay locally
  instead (see "Local usage without Pages") and set
  `MULTICA_RELAY_URL_BASE`/`$env:MULTICA_RELAY_URL_BASE` to your own
  release/host if you want the one-liners to work unmodified.
- **WebSocket blocked / mixed content errors in the console**: see the
  `wss://` note above.
- **Relay refuses the connection and logs `websocket accept rejected
  (origin …)`**: the relay only accepts localhost origins plus whatever you
  passed via `MULTICA_RELAY_ORIGIN`/`-origin`, and the page you're using is
  served from some other origin. Restart the relay with that origin (copy the
  one-liner straight from the page's "Run a relay" panel, which now includes
  it), or, if the relay isn't reachable at all from another machine, remember
  that it binds `127.0.0.1` by default — see "Who can reach the relay" above.
