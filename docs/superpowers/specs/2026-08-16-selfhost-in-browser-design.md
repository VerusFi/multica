# Self-hosting multica in a browser tab (v86) — Design

**Date:** 2026-08-16
**Status:** Approved by Rodrigo (sections A/B/C reviewed in conversation)
**Feasibility:** Proven by spike — Alpine x86 (32-bit) boots in v86 in the browser; guest
networking works end-to-end through a local wsnic WebSocket relay (DHCP, DNS, real TLS);
PostgreSQL 17 (32-bit) serves TCP queries in-guest; Node.js 24 (ia32) runs;
`postgresql-pgvector` exists in the official Alpine x86 repository.

## 1. Goal

A single static page, `selfhost.html`, living in the VerusFi/multica fork, that runs a
complete multica instance inside the visitor's browser tab: Alpine Linux (x86, 32-bit)
emulated by v86 (WebAssembly), with PostgreSQL + pgvector, the multica Go backend, and the
Next.js frontend all running as guest services. Nobody installs Docker or anything else —
opening the page is the whole setup. The page (plus a lightweight static replica of the
multica landing page with a "Selfhost" button) is deployable to GitHub Pages.

Success criterion for this project: **prove it works** (feasibility POC). Slowness is
acceptable; correctness and persistence are not negotiable.

### Non-goals

- Production-grade performance. An emulated 32-bit single-core CPU is inherently slow.
- Serving other people from one tab. Each visitor gets their own private instance.
- Replacing the "real" self-host paths (docker compose / Lima VM). This is an additional
  distribution channel.

## 2. Architecture

```
┌─ Visitor's browser ────────────────────────────────────────────┐
│  selfhost.html                                                 │
│  ├─ Configuration / instance-manager UI (play/pause/stop)      │
│  ├─ v86 (WebAssembly) ── Alpine x86 + LUKS + btrfs             │
│  │    └─ multica: Postgres+pgvector, Go backend (386),         │
│  │       Next.js frontend — OpenRC services                    │
│  ├─ Service Worker: routes an iframe/tab to the guest's        │
│  │    frontend port via v86's JS TCP API                       │
│  └─ IndexedDB: per-instance disks + snapshots + config vault   │
└───────────────┬────────────────────────────────────────────────┘
                │ ws:// (configurable "relay address")
        wsnic (Docker) ──► NAT ──► internet
```

Components:

1. **`selfhost.html` (launcher)** — one static page: configuration panel, instance
   manager, serial console. No backend of its own; every asset ships with the page
   (vendored v86, xterm.js, BIOS, kernel, initramfs). No CDN dependencies.
2. **Guest OS** — Alpine Linux x86 (32-bit), booted by loading `vmlinuz-virt` + a custom
   initramfs directly (v86 `bzimage`/`initrd` options; no bootloader, proven in spike).
3. **Guest↔UI access** — v86 exposes guest TCP listeners to JavaScript. A Service Worker
   intercepts fetches under `…/instance/<id>/app/*` and forwards them into the guest's
   frontend port. "Open Dashboard" opens the multica UI served through the page's own
   HTTPS origin. Fallback if this API proves immature: document an "open via relay port
   forward" mode.
4. **Outbound networking** — guest virtio-net → WebSocket → wsnic relay (address is a
   per-instance setting; default `ws://localhost:8086`). Mixed-content rule: a page served
   over HTTPS (GitHub Pages) requires `wss://` for non-localhost relays; `ws://localhost`
   remains valid.
5. **Persistence** — IndexedDB holds: per-instance disk blocks (ciphertext — LUKS happens
   in-guest), full VM snapshots **including RAM**, and the PIN-encrypted configuration
   vault.

## 3. Guest provisioning — no prebuilt system image

Decision: there is **no `system.img`** artifact. The instance builds itself from scratch
on first boot, driven by configuration. The page ships only small boot artifacts: kernel
(`vmlinuz-virt`), a custom initramfs (with `cryptsetup` support and the provisioning
hooks), v86 itself, and the BIOS files.

### First boot (provisioning)

1. v86 starts with kernel+initramfs and an empty raw data disk of the configured size.
2. The page writes the disk passphrase to a dedicated secondary serial port (`ttyS1`);
   the provisioning script reads it there. The passphrase never appears on the visible
   console (`ttyS0`), in the kernel cmdline, or in guest storage.
3. The script brings up networking (DHCP via the relay), then:
   - fetches the Alpine base system from the official CDN (netboot-style, through the relay);
   - `cryptsetup luksFormat` on the data disk → `mkfs.btrfs` inside LUKS;
   - installs the entire system **onto the encrypted disk** (Alpine base, OpenRC,
     postgresql17 + postgresql-pgvector, nodejs, cryptsetup, btrfs-progs);
   - downloads `multica-selfhost-386.tar.gz` from the fork's GitHub Releases (see §6):
     Go backend built with `GOARCH=386`, Next.js standalone frontend with 386-native
     modules, SQL migrations;
   - runs `initdb`, applies migrations, registers and starts the OpenRC services;
   - emits progress markers on `ttyS0` for the UI progress bar
     (boot → network → download → LUKS → install → initdb → services → ready).
4. When services are healthy, the page opens the dashboard automatically.

System and data live together on the single encrypted disk; that disk is what IndexedDB
persists. First boot is expected to be slow (potentially tens of minutes under emulation);
it happens once per instance.

**Why binaries are prebuilt:** compiling the Go backend or building the Next.js frontend
inside an emulated 386 CPU would take days. The environment assembles itself in-tab, but
the multica binaries come from a fork release built by GitHub Actions.

### Subsequent boots and resume

- **Resume (normal path):** every snapshot includes RAM (`save_state`). Reopening the page
  restores the instance in seconds, exactly where the person left off. No reboot, no
  re-provisioning.
- **Cold boot (when needed):** kernel+initramfs ask for the passphrase (`ttyS1`),
  `luksOpen` the disk, and boot the installed system from it. Nothing is re-downloaded.

### Snapshot policy

Full snapshot (RAM + devices + dirty disk blocks) on **pause**, on **stop**, on a periodic
**autosave** (~5 min), and best-effort on tab hide/close. Maximum loss: one autosave
interval. The page calls `navigator.storage.persist()` and monitors quota, warning before
space runs out. Data is lost only if the person clears the site's browser data.

## 4. Instance manager UI

Three areas on `selfhost.html`:

1. **"Self hosting" panel** — fields: instance name, disk passphrase (+ confirmation),
   disk size (GB), relay WebSocket address (default `ws://localhost:8086`), vault PIN, and
   the button **"Run on Linux contained in this page (100% private)"**.
2. **Instance list** — on load, the page asks for the PIN, decrypts the vault, and lists
   every previously configured instance found in IndexedDB: name, configuration summary,
   running/paused/stopped indicator, and buttons **play**, **pause**, **stop** (visible
   only while running), **View Console**, **Open Dashboard**.
3. **View Console** — an interactive xterm.js terminal attached to the guest's `ttyS0`:
   a real root shell for administering the instance. During first boot it shows the
   provisioning progress bar fed by the serial markers.

### Configuration vault and PIN

Instance metadata — including the LUKS passphrase, so an instance can be restarted without
retyping it — is stored in an IndexedDB vault encrypted with a **PIN** (key derived with a
deliberately heavy KDF, AES-GCM payload).

Security stance (stated honestly in the UI and docs): a short PIN protecting the LUKS
passphrase reduces effective at-rest security to the PIN, because an attacker with a copy
of IndexedDB can brute-force PINs offline. Therefore: the PIN has no length limit, and
"remember passphrase" is **optional** — maximum-security users type the passphrase on
every cold boot and the PIN protects only non-secret settings.

## 5. Page implementation

Vanilla JS, no framework. Modules:

- `vault` — PIN → key (heavy KDF), AES-GCM encrypt/decrypt of the config store.
- `instance-manager` — IndexedDB schema: `instances` (encrypted metadata), `disks`
  (block-addressed chunks), `snapshots` (state chunks).
- `vm-controller` — v86 lifecycle: create/boot, passphrase injection over `ttyS1`,
  `save_state`/`restore_state`, play/pause/stop semantics.
- `sw-bridge` — Service Worker routing `…/instance/<id>/app/*` to the guest frontend port
  through v86's JS TCP API.
- `console` — xterm.js wiring to `serial0`.

Error handling with clear UI messages: relay unreachable (banner + retry), wrong
passphrase (LUKS refuses; guest reports on serial), wrong PIN (vault stays sealed; nothing
is exposed), insufficient storage quota.

Lessons already learned in the spike, baked in: the page must host the v86 BIOS files (the
npm package does not ship them); the guest must bring `lo` up (PostgreSQL will not start
otherwise); `PAGER=cat` for serial-friendly psql; strip ANSI with a correct escape-sequence
regex when parsing serial output.

## 6. Repository layout, build, and deploy

Everything lives in the fork:

- `deploy/selfhost-web/` — `selfhost.html`, `index.html` (landing replica), vendored
  assets (libv86, xterm.js, BIOS), kernel + initramfs, `README.md` (deploy docs).
- `deploy/selfhost-web/build-boot.sh` — produces the boot artifacts: extracts
  `vmlinuz-virt` from the official Alpine x86 netboot/ISO media and assembles the custom
  initramfs (cryptsetup + provisioning hooks) in a `linux/386` Alpine container. Run
  locally (Lima VM Docker) or by `selfhost-release.yml`; outputs are committed to
  `deploy/selfhost-web/boot/`.
- `.github/workflows/selfhost-release.yml` — builds `multica-selfhost-386.tar.gz`
  (backend `GOARCH=386`; frontend `next build` standalone with 386-native modules built in
  a `linux/386` container; migrations) and publishes it as a GitHub Release. This is what
  first boot downloads.
- `.github/workflows/selfhost-pages.yml` — publishes `deploy/selfhost-web/` to GitHub
  Pages.
- Real landing (`apps/web/features/landing/`): add a "Selfhost" button to
  `landing-header.tsx` with i18n strings (en/zh/ja/ko), linking to the configured Pages
  URL.

### Landing replica

The real landing is Next.js SSR with no static export, so GitHub Pages gets a
**lightweight static replica**: same visual identity (logo, hero), with Download /
Dashboard / **Selfhost** actions; Selfhost links to `selfhost.html`. (Note: in the real
landing header the CTA is "Get started"/"Dashboard" and "Download Desktop" lives in the
hero/footer — the replica mirrors the spirit, not the DOM.)

### Documentation (`deploy/selfhost-web/README.md`)

- Enabling GitHub Pages on a fork and pointing it at the workflow.
- Running the relay: the wsnic Docker one-liner
  (`docker run … --cap-add=NET_ADMIN --device /dev/net/tun -p 8086:8086 chschnell86/wsnic -i`),
  plus the `wss://` requirement for non-localhost relays behind HTTPS pages.
- Local usage without Pages (any static file server).
- The manual end-to-end checklist (see §8).

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `dm-crypt`/`btrfs` modules missing from the Alpine x86 `virt` kernel | Verify early (plan task); fall back to the `lts` kernel shipped with the page |
| Next.js standalone native modules on 386 | Build inside a `linux/386` container; if qemu-user is too slow in CI, split JS (arch-neutral) from native rebuilds |
| v86 JS TCP API immaturity (dashboard bridge) | Fallback: relay-side port forward, "open in new tab" mode |
| RAM snapshots are large (≈ guest RAM size) | Compress state; autosave interval balances safety vs. churn; quota monitoring |
| First boot very slow under emulation | Progress bar with honest phase markers; happens once per instance |
| PIN brute-force against the vault | Unlimited PIN length; heavy KDF; "remember passphrase" optional |
| GitHub Pages 100 MB/file, ~1 GB/site | No system image at all (largest shipped file is the initramfs); release tarball hosted on GitHub Releases, not Pages |

## 8. Testing

- **Unit tests** for `vault` (crypto round-trips, wrong-PIN behavior) and
  `instance-manager` (IndexedDB schema, block read/write, snapshot bookkeeping).
- **Playwright smoke e2e** (slow, on-demand): load `selfhost.html`, create an instance
  against a real local relay, boot to the shell-ready serial marker.
- **Manual end-to-end checklist** in the README: full first boot → dashboard opens →
  pause → close tab → reopen → PIN → resume → data intact; cold restart with passphrase.
