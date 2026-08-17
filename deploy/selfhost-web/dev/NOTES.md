# Task 3 — Guest networking verification (DECISION GATE)

## Verdict: **WISP OK**

v86's `wisp://` backend against `multica-relay` (Tasks 1–2) works end to end:
DHCP lease, hostname-based DNS resolution, and an HTTPS fetch through the
relay all succeeded, repeatedly and reproducibly. **The fallback (`wsnic` /
`ws://`) is not needed.** Later tasks (6, 11+) can proceed with `wisp://` +
`net_device: { type: "virtio", relay_url: "wisp://<host>:<port>/" }` as
planned.

Evidence, per the three questions in the task brief:

- **(a) Guest gets an address:** yes. v86 answers DHCP (`udhcpc`) itself —
  confirmed this also happens **with the relay not running at all**
  (negative-control run below), so address assignment does not depend on
  relay connectivity, only on v86's built-in DHCP server. `udhcpc -i eth0`
  obtains a lease in well under a second once the interface is up.
- **(b) DNS resolves:** yes. `/etc/apk/repositories` pointed at
  `dl-cdn.alpinelinux.org` by hostname (no IP), and `apk update` fetched the
  index successfully — this requires the relay to have resolved that
  hostname server-side on the WISP `CONNECT` (the relay just calls
  `net.Dial("tcp", host:port)` in `relay/main.go`, which resolves via the
  host machine's resolver). No client-side/v86 DNS config was needed beyond
  the default (WISP backend defaults `dns_method` to `doh`, but since actual
  resolution happens relay-side on CONNECT-by-hostname, this path wasn't
  exercised — worth remembering if a future task needs raw DNS (UDP:53)
  from the guest specifically, as opposed to hostname CONNECT).
- **(c) `apk update` over HTTPS succeeds:** yes — `OK: 5858 distinct
  packages available` on every successful run.

## Numbers (4 independent successful runs, this machine)

Emulated boot is fast here (WASM JIT on Apple Silicon, everything served
from local disk — no real network latency for kernel/initrd/ISO). Do not
assume these numbers hold on a visitor's machine loading assets over the
real internet from GitHub Pages; they're useful as a relative/functional
baseline, not a production SLA.

| Mark (relative to boot-start) | run 2 | run 3 | final | clean re-run* |
|---|---|---|---|---|
| emulator-ready | +0.22s | +0.22s | +0.24s | +0.21s |
| login prompt | +19.8s | +20.0s | +20.5s | +20.3s |
| **shell ready** | **+20.1s** | **+20.3s** | **+20.8s** | **+20.7s** |
| DHCP lease (`NET_UP`) | n/a† | +21.2s | +21.3s | +21.3s |
| `apk update` done (`APK_NET_OK`) | n/a† | +22.2s | +24.4s | +24.6s |

\* "clean re-run" repeated `setup-harness.sh && node verify-net.mjs` after
removing `node_modules/`, `bios/`, `package.json`/`package-lock.json` and
`.relay-bin` to simulate a fresh checkout (the already-verified ISO
download/extraction was left in place to avoid a redundant 53MB
re-download) — included as the 4th data point for the reproducibility
claim below.

† run 2 predates adding the `net-up`/`apk-net-ok` boot marks to
`harness.html`; only shell-ready timing was captured, still consistent with
the other three runs.

So: **time to shell ≈ 20–21s**, **DHCP ≈ 0.5–0.9s after shell**, **apk
update ≈ 1–3.3s after DHCP**. Brief's budgets (240s shell / 90s DHCP / 180s
apk) have very wide margin on this machine; kept as-is in `verify-net.mjs`
since real-world (network-loaded, slower CPU) runs will be much slower.

## A real bug this harness caught in itself (important for Task 6+ reuse)

The task brief's own `verify-net.mjs` pattern has a **false-positive trap**
that I want future harness copies (`verify-luks.mjs` etc., per the plan) to
avoid repeating:

The interactive shell **echoes typed input** back over ttyS0 (normal
cooked-mode tty echo). The verification commands embed their own success
marker as literal text in the command itself, e.g.
`... && echo NET_UP` / `... && echo APK_NET_OK`. That means the marker
string `NET_UP` / `APK_NET_OK` appears in `serialLog` **twice**: almost
immediately as part of the echoed input line, and — only on genuine
success, much later — as real command output. A bare
`new RegExp(pattern).test(serialLog)` (as in the brief's `waitSerial`)
matches on the **first** occurrence, i.e. the echo, which fires
**regardless of whether the command ever ran or succeeded**.

I caught this empirically: an early run of this exact harness printed
`VERDICT: WISP OK` while the relay had actually failed to start (a separate
bug, see below) and every WebSocket connection was `ERR_CONNECTION_REFUSED`
— the "pass" was spurious.

**Fix applied** (in `verify-net.mjs`): split the marker with an empty-string
shell concatenation so the literal contiguous marker text never appears in
the typed/echoed command, only in genuine `echo` output —
`echo NET''_UP` / `echo APK''_NET''_OK` (bash/ash strip the empty quotes and
concatenate, so real output is still the plain `NET_UP` / `APK_NET_OK`
substring the regex expects). Verified this closes the hole with a
negative control: relay intentionally not started → DHCP still succeeds
(v86-internal), but `apk update`'s `[fetch ...]` line never resolves and
the run correctly times out and reports `VERDICT: WISP FAILED`, with no
false "OK".

**Recommendation for Task 6+:** when copying this harness pattern
(`verify-luks.mjs`, stage-boot tests, etc.), apply the same split-marker
trick to any `sendCmd` whose success token is echoed back by the shell
before the command completes, or anchor matches to a marker printed by a
command whose own text doesn't contain the marker at all.

## Environment adjustments made (all local to this dev machine, documented for reproducibility)

1. **Ports 8086 and 8123 (the brief's defaults) were already bound** by
   unrelated pre-existing local processes (a Lima VM hostagent on 8086, a
   stray Python server on 8123). `verify-net.mjs` and `harness.html` use
   **18086** (relay) and **18123** (static file server) instead — purely a
   port number, does not affect what's being verified. Search-and-replace
   both files if the actual shipped page/tests need a specific port.
2. **`npm install` inside `dev/` fails without a local `package.json`.**
   Without one, npm walks up the directory tree, finds the multica monorepo
   root `package.json` (a pnpm workspace with `"catalog:"` version
   specifiers), and errors with `EUNSUPPORTEDPROTOCOL` — npm doesn't
   understand pnpm's catalog protocol. Fixed by having `setup-harness.sh`
   write a minimal `package.json` (`{ "name": ..., "private": true }`)
   before `npm install`, so `dev/` is npm's own project root. `package.json`
   / `package-lock.json` are regenerated by the script and gitignored, not
   committed (matches this task's committed-file list).
3. **`go run ../relay` does not work from `dev/`** on this toolchain
   (go1.26.1): go resolves the main module by walking **up** from the
   current working directory, not by inspecting the target argument's own
   directory; since `dev/` has no `go.mod` and none of its ancestors up to
   the worktree's `.git` do either, it fails with "cannot find main
   module". `verify-net.mjs` instead does `go build` once (cwd = the relay
   directory) to a `.relay-bin` binary and spawns that directly.
4. **`go run` orphans its child binary.** Killing the `go run` process (as
   the brief's snippet does via `relay.kill()`) does not reliably kill the
   compiled binary it forked on macOS — an early test left a `multica-relay`
   process listening on the port across script runs, which silently
   invalidated an early negative-control attempt (it was talking to the
   leftover relay from a previous run, not to "no relay"). Building once and
   spawning the resulting binary directly (see #3) gives `relay.kill()` a
   real, killable PID.

## Decision for Task 6 (kernel cmdline / network bring-up)

- **Networking backend:** use `wisp://` as planned. No fallback needed.
- **`net_device`:** `{ type: "virtio", relay_url: "wisp://<relay-host>/" }`
  — `virtio` NIC type confirmed working with this kernel/cmdline.
- **Kernel cmdline:** the brief's
  `"modules=loop,squashfs,sd-mod,usb-storage console=ttyS0,115200"` boots
  Alpine virt 3.23.5 x86 cleanly to a login prompt over ttyS0; no
  networking-related cmdline flags were needed (no static IP, no explicit
  DNS server) — DHCP + relay-side hostname resolution is sufficient.
- **Network bring-up commands** for the real init (`init-selfhost`, Tasks
  6–8): `ifconfig eth0 up; udhcpc -i eth0 -t 10` (or the OpenRC-native
  equivalent, e.g. an `/etc/network/interfaces` `iface eth0 dhcp` +
  `service networking start`, if Task 6 goes that route) is sufficient and
  fast (< 1s to lease in this environment). No retries beyond `udhcpc`'s own
  `-t 10` were needed in any run.
- **No `wsnic`/`ws://` fallback work is required** by this gate's outcome.
  If a *future* task hits WISP trouble in a different context (e.g. from
  GitHub Pages instead of localhost, or a different relay host), re-run
  `verify-net.mjs` against that target before assuming the same verdict
  holds — this result is specific to relay-on-localhost from a page also
  served on localhost.
- Harness reuse for Task 6/verify-luks.mjs: copy `harness.html`'s
  `serialLog`/`bootMarks`/`sendCmd`/auto-login plumbing as-is; apply the
  split-marker fix from this NOTES.md to any new `sendCmd` success checks.

## How to reproduce

```
cd deploy/selfhost-web/dev
sh setup-harness.sh
node verify-net.mjs
```

Expect `VERDICT: WISP OK` printed near the end, after `apk update`'s
`OK: NNNN distinct packages available` line. Total wall time on this
machine: ~25s (mostly Playwright/Chromium startup + relay `go build`;
the emulated boot itself is ~20s to shell, ~24s to full verdict).

---

# Task 4 — Boot artifacts: kernel decision + build-boot.sh (DECISION GATE)

## Verdict: **KERNEL_PKG=linux-virt**, boot artifacts built and boot-tested OK

## Step 1: binfmt (one-time host mutation, as instructed)

```
docker run --privileged --rm tonistiigi/binfmt --install 386
```
→ `installing: 386 OK`, emulators now `["qemu-i386","rosetta"]`.
`docker run --rm --platform linux/386 alpine:3.23 uname -m` → `i686`, confirming
linux/386 containers actually run i686 code under emulation on this
(aarch64 Lima VM) host.

## Step 2: kernel module check → decision

```
docker run --rm --platform linux/386 alpine:3.23 sh -c '
  apk add --no-cache linux-virt >/dev/null 2>&1
  ls /lib/modules/*/kernel/drivers/md/dm-crypt.ko* /lib/modules/*/kernel/fs/btrfs/btrfs.ko* 2>/dev/null && echo VIRT_OK || echo VIRT_MISSING'
```
→ both modules present (`/lib/modules/6.18.44-0-virt/kernel/drivers/md/dm-crypt.ko.gz`,
`.../kernel/fs/btrfs/btrfs.ko.gz`) → `VIRT_OK`. **Did not need to test
linux-lts** — `linux-virt` ships both modules the plan needs, and `virt` is
the smaller/purpose-built-for-VM flavor, so it's the obvious pick once it
passes. **Decision: `KERNEL_PKG=linux-virt`.**

## Bugs found in the brief's `build-boot.sh` snippet, and the fixes applied

The brief's Step 3 script (used as the starting point, per "use verbatim")
did not work as-is in this environment. Four distinct problems, in the
order hit:

1. **`docker run <img> sh -eux <<'EOF' ... EOF` needs `-i`.** Without `-i`,
   `docker run` doesn't attach stdin to the container, so the heredoc
   script never reaches the container's `sh` — it reads an immediately-closed
   stdin and exits 0 having run nothing. Symptom: the whole build "succeeded"
   (exit 0) but `boot/` stayed empty, no error printed. Confirmed by adding
   `-i` and re-running — the inner script's `+`-prefixed trace lines
   (`set -x` from `-eux`) then appeared.

2. **`KERNEL_PKG` was never exported**, so `docker run -e KERNEL_PKG` (bare
   form, no `=value`) — which pulls the value from the *invoking process's*
   environment — saw nothing. Combined with `-eux` (which is `-e -u -x`,
   i.e. **nounset is on**), the container hit
   `sh: KERNEL_PKG: parameter not set` and aborted. Fix: `export KERNEL_PKG`
   in `build-boot.sh` right after the default-assignment line.

3. **The Lima VM (`multica` docker context) mounts the host home directory
   read-only.** `~/.lima/multica/lima.yaml` has
   `mounts: [{location: "~", writable: false}]`. `deploy/selfhost-web` is
   under `$HOME`, so `-v "$PWD/boot:/out"` mounts fine but every *write*
   through it fails inside the container with `Read-only file system` —
   confirmed in isolation: `docker run --platform linux/386 -v $PWD/boot:/out
   alpine:3.23 sh -c 'touch /out/testfile'` → `touch: /out/testfile:
   Read-only file system`, even though reading via a `:ro` mount from the
   same directory tree (`-v guest:/guest:ro`) worked fine throughout. This
   is a host/VM-level mount policy, not something `build-boot.sh` can fix
   with mount flags. **Fix applied:** don't bind-mount the output directory
   at all — build into a directory *inside* the container, then pull the
   two files out with `docker cp <container>:/out/... boot/...`, which goes
   through the Docker API/daemon (a copy, not a bind-mount write) and is
   unaffected by the VM's mount read-only-ness.
   - This in turn meant switching from `docker run --rm -i ... <<EOF` to
     `docker create` + `docker cp <script> <container>:/build.sh` +
     `docker start -a` + `docker cp <container>:/out/* boot/` + `docker rm -f`,
     because `docker create` does **not** consume a heredoc piped to itself
     the way `docker run -i` does — the CMD only actually runs later, at
     `docker start`, by which point the creating shell's stdin/heredoc is
     long gone. The build script is instead written to a host tempfile
     (`mktemp`, cleaned via `trap ... EXIT`) and `docker cp`'d into the
     container before starting it.
   - Considered but rejected: reconfiguring the Lima VM's mount to
     `writable: true`. That's a persistent change to shared host/VM infra
     outside this task's declared one-time mutation (the binfmt install);
     the `docker cp` route fixes it entirely within `build-boot.sh` itself,
     no host reconfiguration needed, so that's what shipped.

4. **`/etc/mkinitfs/files.d/<name>` (verbatim from the brief) is not a real
   mkinitfs mechanism** — grepping `/sbin/mkinitfs` and
   `/etc/mkinitfs/features.d/*` in a live container shows the actual
   convention is **`/etc/mkinitfs/features.d/<name>.files`** (one path per
   line, e.g. `cryptsetup.files` contains `/sbin/cryptsetup`), with
   `<name>` then added to the `features=` string in `mkinitfs.conf` so
   mkinitfs actually picks the file up. The brief's path is silently
   ignored — **no error, no warning**, `mkinitfs` just doesn't include the
   listed files and exits 0. This was caught by actually extracting the
   built `initramfs.img` (`gzip -dc initramfs.img | cpio -idm`) and
   grepping for `apk.static` / `provision.sh` — both were missing on the
   first successful-looking build. Fix: write to
   `/etc/mkinitfs/features.d/selfhost.files` and add `selfhost` to
   `features="base virtio ata ext4 btrfs cryptsetup network dhcp selfhost"`.
   Re-extracted and confirmed both `usr/sbin/apk.static` and
   `guest/provision.sh` land in the initramfs after the fix.
   **Recommendation:** any future edit to the files.d/features.d list in
   `build-boot.sh` should be re-verified the same way (extract + grep) —
   this class of bug produces a "successful" build with silently missing
   content, not a build failure.

None of these are "kernel-flavor quirks" in the mkinitfs-features sense the
task anticipated — they're Docker/Lima plumbing and one mkinitfs
path-convention error in the brief's own snippet. Recorded here per the
"capture the exact error / iterate" instruction, generalized to this whole
build pipeline since that's where the actual problems were.

## Verified initramfs contents (post-fix build)

Extracted `boot/initramfs.img` (`gzip -dc | cpio -idm`) and confirmed:
- `/init` = our `guest/init-selfhost` skeleton (byte-identical).
- `bin/busybox`, `sbin/cryptsetup`, `usr/sbin/btrfs`, `usr/sbin/apk.static`,
  `guest/provision.sh` all present.
- Kernel modules present: `kernel/fs/btrfs/btrfs.ko.gz`,
  `kernel/drivers/md/dm-crypt.ko.gz`,
  `kernel/drivers/net/virtio_net.ko.gz`, `kernel/drivers/ata/ata_generic.ko.gz`
  (and the rest of the `ata` dir), all under
  `usr/lib/modules/6.18.44-0-virt/`.
- `boot/vmlinuz` is the `linux-virt` `vmlinuz-virt` binary, ~8.0MB.
- `boot/initramfs.img` is ~10.8MB (gzip-compressed cpio, default mkinitfs
  compression).
- Fixed file permissions: `docker cp` landed `initramfs.img` at mode `600`;
  `chmod 644` applied (manually at first, then folded into `build-boot.sh`
  itself as its final step — see the script) so it's servable the same as
  `vmlinuz` (the shipped page will need to fetch this over HTTP).

## `guest/provision.sh` placeholder

`guest/provision.sh` is not in the brief's Task 4 file list, but exists as
a minimal stub (`#!/bin/sh` + `true`). It's required because
`build-boot.sh`'s mkinitfs features list (`selfhost.files`, see the bugs
section above) references `/guest/provision.sh` by path — without the file
present on disk, the `docker create -v "$PWD/guest:/guest:ro"` mount has
nothing there for mkinitfs to copy in, and while mkinitfs doesn't hard-fail
on a missing files.d entry, keeping the referenced path real avoids relying
on that silent-skip behavior. Tasks 6–8 replace this stub with the actual
provisioning logic (LUKS/btrfs setup) that `init-selfhost` will invoke once
the network and disk stages are implemented.

## Step 5: boot-test — variant harness (`dev/harness-boot.html` + `dev/verify-boot.mjs`)

Per the parent task's plumbing-reuse guidance, added a **variant** driver
rather than modifying `verify-net.mjs`/`harness.html` (Task 3's harness,
already verified working, must not regress — Task 6 reuses both):
- `dev/harness-boot.html`: same `serialLog`/`bootMarks`/ANSI-stripper
  plumbing as `harness.html`, but points v86 at `../boot/vmlinuz` +
  `../boot/initramfs.img` directly, **no `cdrom`**, no `net_device` (the
  skeleton `/init` does no networking — it only proves the initramfs boots
  and runs `/init`). Watches for the literal `@@SH:phase:network@@` marker.
  No split-marker anti-echo trick needed here, unlike `verify-net.mjs`'s
  `NET_UP`/`APK_NET_OK`: this marker is printed unprompted by `/init`
  itself, not typed into an interactive tty that echoes input back — see
  the Task 3 section above for why that distinction matters.
- `dev/verify-boot.mjs`: no relay needed (no networking exercised). Static
  file server is rooted **one level up from `dev/`** (`deploy/selfhost-web/`)
  so that `../boot/vmlinuz` in the harness resolves on disk under that same
  root, alongside `/dev/harness-boot.html`, `/dev/node_modules/...`, etc.
  Asserts the marker appears within 120s (brief's budget); actual result
  in the low single digits (see "Result" below for the two runs and which
  one is authoritative).
- **Bug found and fixed while building this variant:** the driver initially
  did `page.goto("http://localhost:18123/")` (matching `verify-net.mjs`'s
  pattern), relying on the static server's `"/" → /dev/harness-boot.html`
  special case. But that serves the file's *content* while leaving the
  document's **base URL** at `/`, not `/dev/`. Relative references inside
  the HTML then resolve wrong: `node_modules/v86/build/libv86.js` resolved
  to `http://localhost:18123/node_modules/...` (rootDir has no
  `node_modules`, only `dev/` does) → 404 → `V86 is not defined`. The
  `../boot/vmlinuz` reference happened to still work by accident (browsers
  clamp `..` at the origin root, so `/` + `../boot/vmlinuz` also lands on
  `/boot/vmlinuz`, which does exist at rootDir) — this partial "accidental
  correctness" made the bug non-obvious from the boot artifact paths alone;
  it only showed up as a `pageerror`/404 on the *other* asset. **Fix:**
  navigate directly to `http://localhost:18123/dev/harness-boot.html` so
  the base URL is actually `/dev/`, matching where the file conceptually
  lives.

### Result

Two runs, back to back, with one change in between:

1. **First run — +3.7s.** Made right after the `harness-boot.html`
   navigation-URL bug fix above, against a `boot/initramfs.img` whose
   permissions had been fixed **manually** (`chmod 644`, not yet part of
   `build-boot.sh`).
   ```
   [bootmark] boot-start   <t0>
   [bootmark] emulator-ready +0.19s
   [bootmark] phase-network +3.7s
   VERDICT: BOOT OK — marker seen at +3.7s
   ```
2. **Second, final run — +3.2s.** After folding the `chmod 644` step into
   `build-boot.sh` itself (see the "Fixed file permissions" bullet above),
   re-ran `sh build-boot.sh` from clean and re-ran `verify-boot.mjs`
   against that freshly-rebuilt artifact — this is the build produced by
   the exact `build-boot.sh` that's committed, so it's the authoritative
   number:
   ```
   VERDICT: BOOT OK — marker seen at +3.2s
   ```

Both runs pass comfortably inside the 120s budget; the ~0.5s difference is
ordinary run-to-run noise (Playwright/Chromium + WASM JIT timing), not a
behavior change. **+3.2s is the number to cite** as it's the one measured
against the artifact that `build-boot.sh` (as committed) actually produces.

Serial log around the marker (trimmed, from the first run — same
`/init` output on both):
```
[    2.490155] Run /init as init process
/init: line 3: mount: not found
/init: line 4: mount: not found
/init: line 5: mount: not found
@@SH:phase:network@@
/bin/sh: can't access tty; job control turned off
~ #
```

**Boot succeeds and the marker prints — this task's gate condition is met.**
But note the three `mount: not found` lines, which is a real finding for
Tasks 6–8, not just harness noise (the marker still printed because
`init-selfhost` has no `set -e`, so the failed `mount` calls didn't abort
the script — they'd matter a lot more once real provisioning logic depends
on those mounts actually succeeding).

## Finding for Tasks 6–8: no busybox applet symlinks in this initramfs

Extracting `boot/initramfs.img`, `bin/` contains only
`busybox kmod sh ssl_client` and `sbin/` only
`apk apk.static btrfs cryptsetup modprobe nlplug-findfs` — **no `mount`,
`ifconfig`, `udhcpc`, `cat`, etc. symlinks**. This mkinitfs build does not
run `busybox --install` to populate `/bin` with per-applet symlinks the way
a full Alpine root filesystem does; it only ships the small set of
standalone binaries each `features.d/*.files` entry explicitly lists, plus
whatever `/bin/sh` needs. The brief's Step-4 skeleton's bare `mount -t proc
none /proc` (etc.) calls are consequently **no-ops that print "not found"
and silently fall through** — harmless for this task's narrow proof (only
`echo` and `exec /bin/sh` need to work, and both did), but **Tasks 6–8's
real init logic must not assume bare applet names are on `PATH`**. Two
known fixes, either is standard on Alpine initramfs: call applets via
`busybox mount ...` / `busybox ifconfig ...` explicitly, or run
`/bin/busybox --install -s /bin` as the first line of `/init` before using
any other applet name bare. Left the Step-4 skeleton verbatim as specified
(this task's job was proving boot, not fixing init logic) but flagging this
loudly here so Task 6 doesn't rediscover it the hard way.

## How to reproduce

```
cd deploy/selfhost-web
sh build-boot.sh                 # builds boot/vmlinuz + boot/initramfs.img
cd dev
node verify-boot.mjs             # boot-tests the artifacts, no relay needed
```
Expect `VERDICT: BOOT OK — marker seen at +N s` with N in the low single
digits on this machine (WASM JIT, everything local disk). `KERNEL_PKG`
defaults to `linux-virt` in `build-boot.sh`; override with
`KERNEL_PKG=linux-lts sh build-boot.sh` if a future re-decision is needed
(not required by this gate's outcome).

---

# Task 5 — `build-selfhost-tarball.sh` (DECISION GATE — frontend packaging blocked, later resolved — see "Task 5 continuation" below)

## Verdict: **backend half verified on 386; frontend half blocked by a real upstream gap (no `sharp` linux/ia32 build) — controller decision needed, not resolved here**

**Superseded by the spec owner's ruling — see the "Task 5 continuation" section
further down for the resolution actually shipped (source-build `sharp` for
`linux-ia32` inside the build script, plus a self-contained `vips-apks/`
payload).** This section is left as-is for the historical record of what
was found and why it needed a decision.

Per this task's own instructions: if the native-module guard trips, don't
silently work around it — record exactly which package(s) and report
severity, since the spec's suggested fix (rebuild for `linux/386` in a
container) is a controller call. That's what happened, so the full
`multica-selfhost-386.tar.gz` was **not** produced by this task. Details
below.

## Two environment adaptations made to the brief's script (both kept, documented, not workarounds of the guard)

1. **`pnpm --filter web build` → `pnpm --filter @multica/web build`.**
   `apps/web/package.json`'s `name` is `@multica/web`, not `web`. `--filter
   web` happens to also resolve correctly (pnpm does substring matching on
   package names), confirmed empirically, but the exact name matches what
   `Dockerfile.web` already uses for this same app's production build, so
   the script uses that instead of relying on the substring-match behavior.

2. **Standalone-output root autodetected one level too deep.** Next's
   output-file-tracing-root autodetection walks *up* from `apps/web`
   looking for a workspace root (a `pnpm-workspace.yaml`) and uses the
   first one it finds. This dev worktree lives at
   `.claude/worktrees/selfhost-sdd/` **inside** a checkout that itself has
   its own `pnpm-workspace.yaml` at its root — so Next picked that outer
   root instead of the worktree's own, and nested the standalone output an
   extra `.claude/worktrees/selfhost-sdd/` deeper than the brief's script
   assumed (i.e. `server.js` landed at
   `.next/standalone/.claude/worktrees/selfhost-sdd/apps/web/server.js`,
   not `.next/standalone/apps/web/server.js`). Confirmed via the build's
   own warning: `Next.js inferred your workspace root... selected the
   directory of /Users/rodrigo/dev/multica/pnpm-workspace.yaml as the root
   directory` — that's the *outer* repo root, not this worktree's.
   **Fix applied:** instead of assuming `apps/web/.next/standalone` is
   already correctly rooted, the script now locates the standalone root by
   finding the file matching `*/apps/web/server.js` and stripping that
   known suffix, then copies from the discovered root. This is a
   generalization, not a special case: in a normal (non-nested) checkout —
   which is what Task 17's CI runner will be — the discovered root
   resolves to exactly `apps/web/.next/standalone`, identical to the
   brief's original assumption, so this is a no-op there. Recommend Task 17
   re-verify this assumption once CI actually runs the script (i.e. confirm
   CI's checkout isn't itself nested inside another pnpm workspace on the
   runner's filesystem — normally it won't be).

## The native-module guard trip (not resolved — needs a controller decision)

After the above two fixes, the script's Next.js build and copy steps ran
correctly, and the guard then correctly fired:

```
ERROR: native modules found in standalone output; rebuild them for linux/386:
.../frontend/node_modules/.pnpm/sharp@0.34.5/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node
.../frontend/node_modules/.pnpm/@img+sharp-darwin-arm64@0.34.5/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node
```

**Root cause:** `sharp@^0.34.5` is declared as an `optionalDependency` of
`next` itself (`node_modules/.pnpm/next@16.2.6.../node_modules/next/package.json`
line 130), not something `apps/web` opts into directly — Next.js uses it
for the built-in `next/image` optimizer when available. pnpm installs the
build host's matching platform variant (`darwin-arm64` here), and Next's
output-file-tracing includes it in the standalone bundle as a traced
dependency.

**Why this is a controller decision, not a quick fix:** checked
`pnpm-lock.yaml`'s full `@img/sharp-*` platform matrix (the packages
`sharp@0.34.5` optionally depends on) —
`darwin-arm64, darwin-x64, linux-arm64, linux-arm, linux-ppc64,
linux-riscv64, linux-s390x, linux-x64, linuxmusl-arm64, linuxmusl-x64,
wasm32, win32-arm64, win32-ia32, win32-x64`. **There is no
`linux-ia32`/`linux-386` variant published at all** — 32-bit x86 Linux
isn't one of libvips/sharp's supported targets upstream. So the spec §7
suggested fix ("rebuild those packages in a `linux/386` container and
overlay them") isn't a routine rebuild here — it would mean compiling
libvips + sharp from source for a target platform upstream doesn't
officially support, which is a real scope/feasibility question, not
something to decide unilaterally inside this task. Options for whoever
makes that call (not evaluated further here — out of this task's scope):
(a) source-build libvips/sharp for linux-ia32 (unknown effort/feasibility),
(b) keep `next/image` on the unoptimized/JS-only path for the selfhost
build so sharp is never traced into the standalone output (e.g.
`images.unoptimized: true`, gated behind the same `STANDALONE` env var
already used for `output: "standalone"` in `next.config.ts`), or (c)
strip `.node` files from the tarball post-build and accept degraded image
handling for the selfhost target specifically. Left to spec owner.

## Backend half: verified good on 386

Independent of the frontend blocker — the Go cross-compiles are
unaffected and were fully verified:

```
CGO_ENABLED=0 GOOS=linux GOARCH=386 go build -ldflags "-s -w" -o backend/server ./cmd/server
CGO_ENABLED=0 GOOS=linux GOARCH=386 go build -ldflags "-s -w" -o backend/migrate ./cmd/migrate
```
Both produce `ELF 32-bit LSB executable, Intel 80386` static binaries (no
cgo dependencies in `server/` — no `mattn/go-sqlite3` or similar — so the
cross-compile is trivial, as the brief's script comment predicted).

**386 execution check** (brief's Step 3, adapted for this Lima setup —
same `docker create`/`docker cp` pattern as `build-boot.sh`, since the
`multica` Lima VM mounts the host home read-only and a bind-mounted `-v
/tmp:/t` write target is unreliable here):
```
docker create --platform linux/386 --name selfhost-verify-386 alpine:3.23 sh -c 'apk add --no-cache libc6-compat >/dev/null; chmod +x /s; /s --help'
docker cp <backend/server> selfhost-verify-386:/s
docker start -a selfhost-verify-386
```
Output — a real, fully-functional startup sequence, not `exec format error`:
```
WRN JWT_SECRET is not set — using insecure default. Set JWT_SECRET for production use.
WRN no email backend configured (RESEND_API_KEY and SMTP_HOST both empty) — verification codes will be printed to the log instead of emailed.
INF feature flags initialised file="" rules=0 env_prefix=FF_
ERR unable to ping database error="failed to connect to `user=multica database=multica`:\n\t127.0.0.1:5432 (localhost): dial error: dial tcp 127.0.0.1:5432: connect: connection refused..."
```
Confirms the binary is a genuine, correctly-linked linux/386 executable —
it parses config, logs, and reaches a real runtime failure mode (no DB in
this bare-Alpine container), never a binary-format error. Gate condition
met for the backend.

## Tarball status

**Not produced.** The script (as committed) correctly builds the backend,
then correctly builds and copies the frontend, then correctly detects and
loudly refuses to package `sharp`'s darwin-arm64 native binary — this is
the guard working exactly as speced (§7), not a bug in the script. No
tarball size to record until the sharp question above is resolved and the
script is re-run to completion.

## How to reproduce (historical — see below for the resolved version)

```
sh deploy/selfhost-web/build-selfhost-tarball.sh /tmp/multica-selfhost-386.tar.gz
```
Expect it to fail at the native-module guard with the `sharp` diagnostic
above, until the frontend/sharp question is resolved.

---

# Task 5 continuation — sharp built for ia32, self-contained via `vips-apks/` (RESOLVED)

## Verdict: **tarball produced successfully — 99M, all four layout pieces present, guard passes, offline sanity check passes**

Spec owner's ruling on the blocker above: **option (a)** — source-build
`sharp`/its native binding for `linux-ia32` inside the build script itself
(Task 17's CI runs this same script, so the build must be reproducible
there too, not just locally). Additionally ruled: the guest must **not**
fetch `vips` from the Alpine CDN at provisioning time — the tarball ships
the pinned `.apk` files itself, installed offline. Both are now implemented
in `build-selfhost-tarball.sh`.

## How the sharp build works

Inside a `--platform linux/386 alpine:3.23` container (`docker create` /
`docker cp` / `docker start -a` / `docker cp ... out` / `docker rm -f`,
same pattern as `build-boot.sh`'s Lima workaround — see that task's notes
above):

1. `apk update && apk add --no-cache nodejs npm python3 make g++ vips-dev pkgconf`.
   Alpine 3.23's `vips-dev` is `8.17.3-r1`, which satisfies sharp's own
   declared minimum (`sharp/package.json`: `"config": {"libvips": ">=8.17.3"}`)
   — no manual libvips cross-build needed, exactly as the ruling anticipated.
2. `export SHARP_FORCE_GLOBAL_LIBVIPS=1` (from `sharp/lib/libvips.js`) forces
   sharp to link against the system (apk-installed) libvips via `pkg-config`
   instead of trying to download a prebuilt libvips tarball for a platform
   that doesn't exist.
3. `npm install --build-from-source --foreground-scripts sharp@<version> node-addon-api node-gyp`
   — all three in **one** `npm install` call. `node-addon-api`/`node-gyp`
   are sharp's own from-source build prerequisites (its `install/build.js`
   requires them but doesn't declare them as its own dependencies).
   **Bug hit and fixed:** installing them first via a separate
   `npm install --no-save node-addon-api node-gyp`, then a second
   `npm install sharp@...`, silently breaks the build — the second install
   reconciles the tree against `package.json` and prunes the first
   install's packages as extraneous (they were never saved), so by the time
   sharp's install script runs, `require('node-addon-api')` fails with
   "Please add node-addon-api to your dependencies". Fixed by combining
   into a single `npm install` invocation.
4. The actual C++ compile (`node-gyp rebuild`) succeeded and produced
   `node_modules/sharp/src/build/Release/sharp-linuxmusl-ia32.node` — an
   `ELF 32-bit LSB shared object, Intel 80386` (confirmed via `file`),
   dynamically linked against the container's `libvips-cpp.so.42`.

## Bug found: the Lima VM's 1GiB RAM OOM-kills the compile

First attempt failed with `c++: fatal error: Killed signal terminated
program cc1plus` compiling `sharp/src/common.cc` — a SIGKILL from the OOM
killer, not a compiler bug. `limactl show-ssh` / the `multica` VM's own
`free -h` showed only **966MiB total RAM, 1 CPU** (`~/.lima/multica/lima.yaml`:
`cpus: 1`, `memory: 1GiB`) — genuinely too tight for a C++ template-heavy
compile under `qemu-i386` emulation on this aarch64 host, even with
`node-gyp`'s default `--no-parallel`.

**Fix applied (host/VM mutation, documented per this task's own
convention of recording one-time host adjustments — see Task 4's binfmt
install above):** added a 2GiB swapfile *inside* the Lima VM, not a
`lima.yaml` memory bump (which would need a VM stop/start and is a more
invasive, persistent change to shared infra — rejected for the same reason
Task 4 rejected reconfiguring the mount to `writable: true`):
```
limactl shell multica -- sh -c '
  sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
'
```
This is reversible (`swapoff -a && rm /swapfile`), survives only until the
VM is recreated, and needed no `build-selfhost-tarball.sh` changes — it's
purely local dev-machine headroom. **Recommendation for Task 17:** GitHub
Actions runners have far more RAM (7GB+ standard) and CPU, so this OOM is
very unlikely to reproduce in CI: flagging only in case a minimal/self-hosted
CI runner is ever used for this workflow instead.

## `vips-apks/` — self-contained runtime payload

Per the ruling, the tarball now ships a fourth top-level directory,
`vips-apks/`, alongside `backend/`, `frontend/`, `VERSION`. Built via
`apk fetch -R -o /out/vips-apks vips vips-cpp` inside the same linux/386
container (after an `apk update`, needed because the earlier `apk add
--no-cache` step doesn't leave a usable index cache for `apk fetch`
afterward — hit this as a separate, quick bug: `apk fetch` failed with
`ERROR: unable to select packages: vips (no such package)` until `apk
update` ran first).

**Bug found: `vips-cpp` is a separate Alpine subpackage from `vips`.**
Fetching only `vips` (the CLI/runtime base) is not enough — sharp's
binding dynamically links against `libvips-cpp.so.42`, which ships in a
sibling `vips-cpp` package, not `vips` itself. Missing it produces, at
`require('sharp')` time: `ERR_DLOPEN_FAILED: Error loading shared library
libvips-cpp.so.42: No such file or directory`. Confirmed via `apk search
vips`, which lists `vips`, `vips-cpp`, `vips-dev`, `vips-tools`,
`vips-doc`, etc. as distinct packages sharing one upstream release.
Fetching both (`apk fetch -R -o /out/vips-apks vips vips-cpp`) pulls the
correct **78-file, 22MB** recursive closure (`vips-cpp` and its own extra
deps like `openexr-*`, `librsvg`, `pango`, `harfbuzz`, etc. — libvips'
optional format/codec support pulls in a lot; kept the full closure exactly
as fetched, per guidance that completeness beats cleverness here and `apk`
handles already-installed packages gracefully). Full package list (name +
Alpine version), for reference:

```
acl-libs-2.3.2-r1                  libidn2-2.3.8-r0                   libxft-2.3.9-r0
brotli-libs-1.2.0-r0                libimagequant-4.2.2-r0              libxml2-2.13.9-r1
busybox-1.37.0-r30                  libintl-0.24.1-r1                  libxrender-0.9.12-r0
busybox-binsh-1.37.0-r30            libjpeg-turbo-3.1.2-r0              lz4-libs-1.10.0-r0
c-ares-1.34.8-r0                    libmd-1.1.0-r0                      musl-1.2.5-r23
ca-certificates-bundle-20260611-r0  libmount-2.41.4-r0                  nghttp2-libs-1.69.0-r0
cairo-1.18.4-r0                     libpng-1.6.58-r1                    openexr-libiex-3.4.13-r0
cfitsio-4.6.3-r0                    libpsl-0.21.5-r3                    openexr-libilmthread-3.4.13-r0
cgif-0.5.0-r1                       librsvg-2.61.2-r0                   openexr-libopenexr-3.4.13-r0
fftw-double-libs-3.3.10-r7          libsharpyuv-1.6.0-r0                openexr-libopenexrcore-3.4.13-r0
fontconfig-2.17.1-r0                libspng-0.7.4-r1                    openjpeg-2.5.4-r1
freetype-2.14.3-r0                  libssl3-3.5.7-r0                    pango-1.56.4-r0
fribidi-1.0.16-r2                   libstdc++-15.2.0-r2                 pcre2-10.47-r0
gdk-pixbuf-2.44.4-r0                libunistring-1.4.1-r0               pixman-0.46.4-r0
glib-2.86.3-r0                      libwebp-1.6.0-r0                    pkgconf-2.5.1-r0
graphite2-1.3.14-r6                 libwebpdemux-1.6.0-r0               shared-mime-info-2.4-r6
harfbuzz-12.2.0-r0                  libwebpmux-1.6.0-r0                 ssl_client-1.37.0-r30
imath-3.1.12-r0                     libx11-1.8.12-r1                    tiff-4.7.1-r0
lcms2-2.19-r0                       libxau-1.0.12-r0                    vips-8.17.3-r1
libarchive-3.8.5-r0                 libxcb-1.17.0-r1                    vips-cpp-8.17.3-r1
libblkid-2.41.4-r0                  libxdmcp-1.1.5-r1                   xz-libs-5.8.3-r0
libbsd-0.12.2-r0                    libxext-1.3.6-r2                    zlib-1.3.2-r0
libbz2-1.0.8-r6                     libcrypto3-3.5.7-r0
libcurl-8.20.0-r0                   libdav1d-1.5.2-r0
libdeflate-1.25-r0                  libeconf-0.8.3-r0
libexif-0.6.26-r0                   libexpat-2.8.2-r0
libffi-3.5.2-r0                     libgcc-15.2.0-r2
libhwy-1.3.0-r0
```

## Overlay into the staged tarball

The build script:
1. Copies the built `sharp-linuxmusl-ia32.node` out of the container via
   `docker cp` to a host tempfile.
2. Deletes every `@img/sharp-*` directory under the staged `frontend/`
   that contains a `.node` file (the wrong-arch native bindings Next's
   tracer bundled — in this run, two duplicate copies of
   `@img/sharp-darwin-arm64`, one under `.pnpm/sharp@0.34.5/...` and one
   under `.pnpm/@img+sharp-darwin-arm64@0.34.5/...`, both matching pnpm's
   dedup layout). **Bug found and fixed while writing this:** doing the
   `find ... -exec sh -c 'rm -rf ...'` deletion in a single pass, live
   during `find`'s own traversal, hit `find: fts_read: No such file or
   directory` on macOS/BSD `find` — deleting an ancestor directory
   mid-traversal invalidates `find`'s internal tree-walk state. Fixed by
   collecting all matches into a shell variable first (`for f in
   $(find ...)`), letting `find` finish completely, *then* deleting.
3. For every `sharp/lib/sharp.js` found under the staged `frontend/`
   (there are two copies in this build — pnpm's own `sharp@0.34.5` store
   entry and a separate one nested under `next@16.2.6...`'s own
   `node_modules/sharp`, both real physical copies in Next's traced
   output, not symlinks), drops the built `.node` at
   `<that sharp dir>/src/build/Release/sharp-linuxmusl-ia32.node` — the
   *first* path sharp's own `lib/sharp.js` resolution tries
   (`../src/build/Release/sharp-${runtimePlatform}.node`, tried before any
   `@img/sharp-<platform>` package), so this is sufficient on its own; the
   now-deleted `@img/sharp-*` packages were never going to be reached once
   this overlay is in place.

## Guard amended (verify-arch, not deny-any)

Per the ruling, the guard's job changed: it no longer treats *any* `.node`
file as disqualifying — it now runs `file` on every `.node` file remaining
in the staged `frontend/` and requires the output to contain both `"ELF
32-bit"` and `"Intel 80386"`, failing loudly with the offending path +
`file` output for anything that doesn't match. On the actual build, both
remaining `.node` files (the two overlaid sharp copies) passed cleanly;
zero offenders.

## Offline sanity check (fully self-contained, no CDN)

Two checks, both passing:

1. **Build-time check** (inside the build container, network available):
   `node -e "require('sharp')"` right after the from-source install —
   `sharp OK ['jpeg','png','webp','tiff','magick']`.
2. **The actual required check** — a **separate, fresh `--network none`**
   `linux/386 alpine:3.23` container, proving the shipped `vips-apks/` (and,
   incidentally, a locally-fetched `nodejs` apk set — test-rig only, *not*
   shipped, since guest `nodejs` provisioning is Task 7's existing
   CDN-based job and unaffected by this ruling) are sufficient with **zero**
   CDN access:
   ```
   apk add --allow-untrusted /apks-node/*.apk /apks-vips/*.apk
   node -e "const sharp=require('/tarball-frontend/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp'); console.log(...)"
   ```
   Confirmed `wget` to `dl-cdn.alpinelinux.org` fails (`bad address` — DNS
   unreachable, i.e. genuinely offline) *before* the apk install, so the
   install is proven to use only the locally-provided files. Ran this
   against the **exact `sharp` directory extracted from the real, final
   `multica-selfhost-386.tar.gz`** (not a separately-reconstructed copy),
   for full rigor. Result: `TARBALL SHARP OK ['jpeg','png','webp','tiff','magick']`.

## Interface note for Tasks 7 and 8 (consumed contract — read this before changing either task)

- **Task 7 must NOT add `vips` (or `vips-cpp`) to the guest's CDN apk
  package list.** The pinned closure ships inside the tarball itself, at
  the build's own resolved versions (`vips-8.17.3-r1`, `vips-cpp-8.17.3-r1`
  as of this run) — adding it to Task 7's CDN list would be redundant at
  best and a version-drift risk at worst (a newer `vips` from the live CDN
  could mismatch the `sharp-linuxmusl-ia32.node` binary this tarball ships,
  which is compiled and dynamically linked against the exact
  `libvips-cpp.so.42` from *this* pinned build).
- **Task 8's provisioning (stage3 or equivalent, after the tarball is
  unpacked to `/opt/multica/`) must install the shipped closure offline,
  before starting the backend/frontend services:**
  ```
  apk add --allow-untrusted /opt/multica/vips-apks/*.apk
  ```
  `--allow-untrusted` is required here (not a weakening of security beyond
  what already applies) — these are official Alpine `.apk` files fetched
  from the real CDN at build time, `--allow-untrusted` only skips
  re-verifying signatures for locally-provided files at install time,
  which is the standard way `apk` installs from a local file rather than a
  configured repository.

## Tarball size (final, resolved build)

```
99M   /tmp/multica-selfhost-386.tar.gz   (compressed, the shipped artifact)
```
Uncompressed staging breakdown:
```
 64M  backend/     (server + migrate ELF 32-bit binaries + migrations/)
193M  frontend/    (Next standalone output, node_modules, static, public)
 22M  vips-apks/   (78 .apk files, the sharp/vips runtime closure)
```
(`VERSION` is a few bytes, not worth listing.) The ~99M compressed vs.
~279M uncompressed staged size reflects mostly-already-compressed content
(the `.apk` files are themselves gzip-based archives; JS/JSON compresses
well; the two ELF binaries and the sharp `.node` binaries compress
moderately).

## Lingering local-machine adaptation

The 2GiB swapfile added to the `multica` Lima VM (see above) is **not**
undone by this task — it's a one-time, reversible, local-dev-machine
adaptation in the same spirit as Task 4's `binfmt --install 386`, useful
for any future re-run of this build (or `build-boot.sh`, if it ever needs
more headroom) on this same machine. Not part of `build-selfhost-tarball.sh`
itself and not something CI needs (CI runners have ample RAM already).

## How to reproduce (current, resolved script)

```
sh deploy/selfhost-web/build-selfhost-tarball.sh /tmp/multica-selfhost-386.tar.gz
```
Expect: ~10-12 minutes on this machine (dominated by the linux/386 apk
package installs + the qemu-emulated C++ compile of sharp, even with the
swap fix), ending with `ls -lh` showing the ~99M tarball. `docker context`
must be `multica` (the Lima VM binfmt-registered for `linux/386` per Task
4), and that VM should have some swap headroom per the OOM note above if
its `lima.yaml` still caps it at 1GiB RAM.

---

# Task 6 — Guest provisioning stage 1: passphrase, LUKS, btrfs

## Verdict: **PASS** — marker sequence `network` → `luks` confirmed, LUKS→btrfs
mount confirmed via debug-shell probe, on both a temporary test build and the
actual shipped (committed) boot artifacts.

## v86 API names pinned (read from vendored `dev/node_modules/v86/v86.d.ts` and
cross-checked against `dev/node_modules/v86/build/libv86.js`) — **Task 11
must copy these verbatim**:

- **Empty 2 GiB disk config**: v86's `V86Image` union has exactly three
  forms (`V86AsyncFileImage`, `V86SyncFileImage`, `V86BufferImage` —
  `hda?: V86Image`). There is **no dedicated "sparse empty disk" type**.
  `hda: { buffer: new ArrayBuffer(2 * 1024 ** 3) }` (`V86BufferImage`)
  would eagerly allocate the full 2 GiB in the JS heap up front — the form
  to avoid, per the brief. The form actually used:
  ```js
  hda: { url: "empty-disk.img", async: true, size: 2 * 1024 * 1024 * 1024 }
  ```
  (`V86AsyncFileImage`, `use_parts` omitted). Confirmed by reading
  `libv86.js`'s backing `za` class: `.get()` issues real HTTP `Range:
  bytes=start-end` requests on demand (no eager/full download despite the
  `async: true` field name — that field's own doc comment, "if true the
  file is downloaded completely", is misleading/stale; the actual behavior
  with a `url` + no `use_parts` is demand-paged Range requests, verified
  empirically too via the server's request log), and `.set()` (writes)
  land **only** in an in-browser `block_cache` Map, never sent back to the
  server. `empty-disk.img` is a real, sparsely-allocated 2 GiB file
  (`truncate -s 2147483648`; `du -h` shows 0 actual blocks vs 2.0G apparent
  size), served by `verify-luks.mjs`'s static server, which was extended
  with real `Range`/206-Partial-Content support (v86 aborts a Range
  request with a console error if the server answers 200 instead of 206 —
  confirmed reading the fetch wrapper in `libv86.js`). `setup-harness.sh`
  now generates `empty-disk.img` via `truncate` (gitignored, like the other
  regenerated harness assets).
- **uart1**: `uart1: true` in the `V86` constructor options (confirmed:
  `v86.d.ts` line ~601, `uart1?: boolean; /** Enable serial port 1 */`).
- **Passphrase send API**: `emulator.serial_send_bytes(1, data: Uint8Array)`
  — confirmed in `v86.d.ts`: `serial_send_bytes(serial: number, data:
  Uint8Array): void`. Used as
  `emulator.serial_send_bytes(1, new TextEncoder().encode(pass + "\n"))`,
  serial index `1` = ttyS1/uart1, matching the Global Constraints
  passphrase contract (ttyS1 only, newline-terminated). `serial0_send(data:
  string)` (used for ttyS0/`sendCmd` in every harness so far, including
  this one) is a **different, string-based** convenience method that only
  exists for serial 0 — not usable for ttyS1.

## Adaptations made (all documented inline in the shipped files too)

1. **`busybox --install -s /bin`, invoked by absolute path `/bin/busybox`**
   (pre-approved per this task's own briefing) — this initramfs ships no
   busybox applet symlinks (Task 4 finding). Extra finding beyond what Task
   4 flagged: a **bare** `busybox --install -s /bin` call silently fails
   with `busybox: 'busybox' is not an absolute path` and creates **no**
   symlinks at all — busybox's `--install` needs to resolve its own
   absolute path from argv[0] and refuses a bare/PATH-resolved argv[0].
   Caught via `verify-boot.mjs` (skeleton harness, no LUKS/disk involved)
   showing `ip: not found` / `udhcpc: not found` *after* the install call
   supposedly ran. Fixed by calling `/bin/busybox --install -s /bin`
   explicitly. Targeted `/bin` only (not `/sbin`) so it doesn't shadow the
   real `/sbin` binaries (`cryptsetup`, `btrfs`, `mkfs.btrfs`, `apk.static`,
   `modprobe`) with busybox's own same-named, more limited applets.
2. **Disk device is `/dev/sda`, not `/dev/vda`.** The task brief's
   interface spec says "disk at `/dev/vda`" (virtio-blk naming). Audited
   `v86.d.ts` end to end: v86 has **no virtio block device** — `virtio` only
   appears for `net_device.type`, a virtio console, a virtio balloon device,
   and 9p (also virtio-transport, for a shared filesystem, not a raw disk).
   `hda`/`hdb` are IDE/ATA only. Confirmed by boot log:
   `ata1.00: ATA-0: v86 ATA HD` / `scsi 0:0:0:0: Direct-Access ATA ...`,
   never anything virtio-blk-shaped. Every `/dev/vda` reference in
   `guest/init-selfhost` / `guest/provision.sh` was changed to `/dev/sda`.
   This is the device name actually exercised by this project's whole
   boot/test pipeline (v86, Task 4 onward) — **Task 11 (the real shipped
   page) must use the same naming**, since it also targets v86.
3. **`sd_mod` must be explicitly `modprobe`'d.** Even after fixing #2's
   naming, the disk still didn't appear: dmesg showed it recognized at the
   SCSI transport layer, but `/proc/partitions` and `/sys/class/block` were
   empty and `cryptsetup` reported "Device /dev/sda does not exist" — no
   `/dev/sda` node was ever created. Root cause: `sd_mod.ko` (the actual
   SCSI-disk block driver that registers the block device) lives under
   `kernel/drivers/scsi/`, gated behind mkinitfs's **separate** `scsi`
   feature — `ata` (already in the features list) only pulls in
   `kernel/drivers/ata/*`, the transport layer, not the disk driver. Two
   fixes, both needed: (a) added `scsi` to `build-boot.sh`'s
   `features="..."` string so `sd_mod.ko` actually lands in the initramfs
   at all (confirmed missing entirely beforehand via `find` on the
   extracted image); (b) added `sd_mod` to `init-selfhost`'s `modprobe`
   loop, since this stripped initramfs has no udev/mdev-driven uevent
   autoloading (no `nlplug-findfs`-equivalent runs from our custom `/init`)
   — the module has to be loaded explicitly.
4. **`mkfs.btrfs` is a separate file, not shipped by mkinitfs's own `btrfs`
   feature.** `features.d/btrfs.files` (mkinitfs's own convention) lists
   only `/sbin/btrfs`. `/sbin/mkfs.btrfs` is a distinct real binary in
   `btrfs-progs` (different file size from `/sbin/btrfs`, not a
   symlink/multicall dispatch) and was missing from the initramfs, causing
   `mkfs.btrfs: not found` right after a successful `cryptsetup
   luksFormat`/`open`. Fixed by adding `/sbin/mkfs.btrfs` to
   `build-boot.sh`'s `selfhost.files` extra-files list, alongside
   `apk.static` and `provision.sh`.
5. **LUKS KDF pinned to `--pbkdf pbkdf2 --pbkdf-force-iterations 1000`**
   (pre-approved per this task's own briefing, as a documented POC
   adaptation) instead of LUKS2's default `argon2id`. **SECURITY CAVEAT:**
   pbkdf2 at 1000 iterations is *not* an acceptable production KDF — far
   too fast to resist offline brute-force of a weak passphrase. This must
   be revisited before this path ships for real users (either a properly
   benchmarked `argon2id` on real target hardware, or a much higher pbkdf2
   iteration count) once boot-test wall time under WASM/386 emulation isn't
   the driving constraint. In practice, on this dev machine, the reduced
   KDF made LUKS format + open + `mkfs.btrfs` + mount complete in ~3s
   end-to-end (see timings below) — comfortably inside budget, so it's
   plausible the default `argon2id` would also have been tolerable, but
   that wasn't tested (once the KDF was pinned for safety, the rest of this
   task's iteration cycles used it rather than re-testing the slower
   default).

## Boot-test evidence

Two full `verify-luks.mjs` runs, both `VERDICT: LUKS OK`:

1. **Test build** (`guest/init-selfhost` with a temporary
   `exec /bin/sh` inserted immediately after the `stage1_disk` call, per
   the brief's own suggested approach — never committed):
   ```
   [+5.1s] network marker seen        (@@SH:phase:network@@)
   [+5.1s] passphrase sent on ttyS1   (sendPassphrase, right after network mark)
   [+6.1s] luks marker seen           (@@SH:phase:luks@@)
   [+9.2s] debug shell ready          (stage1_disk — luksFormat+open+mkfs.btrfs+mount — took ~3.1s)
   [+10.2s] btrfs probe confirmed
   VERDICT: LUKS OK
   ```
   Debug-shell probe output:
   ```
   ~ # grep btrfs /proc/mounts && echo BTRFS''_OK
   /dev/mapper/shroot /mnt btrfs rw,relatime,compress=zstd:3,space_cache=v2,subvolid=5,subvol=/ 0 0
   BTRFS_OK
   ```
2. **Shipped build** (actual committed `guest/init-selfhost`, no debug
   line — rebuilt via `sh build-boot.sh` after removing the test-only
   line, and this is the exact `boot/` output committed by this task):
   same marker sequence and btrfs mount, then (as expected, since Task 6
   only implements `stage1_disk`/`coldboot_mount` — `stage2_install`/
   `stage3_multica` are Task 7/8's job) `stage2_install` is undefined,
   which busybox ash reports as `stage2_install: not found` (exit 127),
   correctly caught by `|| fail "install-failed"`, which itself `exec
   /bin/sh`s — giving the same debug-shell/btrfs-probe opportunity via a
   **natural** code path, not a hack:
   ```
   @@SH:phase:network@@
   ...udhcpc lease...
   @@SH:phase:luks@@
   ...cryptsetup + mkfs.btrfs output...
   /init: line 69: stage2_install: not found
   @@SH:err:install-failed@@
   ~ # grep btrfs /proc/mounts && echo BTRFS''_OK
   /dev/mapper/shroot /mnt btrfs rw,relatime,compress=zstd:3,space_cache=v2,subvolid=5,subvol=/ 0 0
   BTRFS_OK
   VERDICT: LUKS OK
   ```
   This second run is the one that matters for "does the actual committed
   artifact work" — confirmed yes. `stage2_install`'s "not found" is
   expected/known at this point in the task sequence, not a bug; Task 7
   removes it by defining that function.

## Files added/changed for the harness

- `dev/harness-luks.html` — new variant (harness.html's networking plumbing
  + harness-boot.html's direct-artifact-boot plumbing), adds `hda` (empty
  disk) + `uart1: true` + `window.sendPassphrase()`.
- `dev/verify-luks.mjs` — new variant of `verify-net.mjs`/`verify-boot.mjs`;
  adds a Range-aware static file server (required for the `async: true`
  disk image — see the pinned-API section above) and the passphrase-over-
  ttyS1 step. Uses the same split-marker anti-echo trick as `verify-net.mjs`
  for the `grep btrfs /proc/mounts` probe (`echo BTRFS''_OK`) since that
  command is typed/echoed interactive input, same false-positive risk
  documented in the Task 3 section above; the `@@SH:phase:*@@`/
  `@@SH:err:*@@` markers themselves don't need it (unprompted /init output,
  same reasoning as `verify-boot.mjs`).
- `dev/setup-harness.sh` — now also generates `dev/empty-disk.img` (sparse,
  `truncate -s 2147483648`), gitignored like the other regenerated assets.

## How to reproduce

```
cd deploy/selfhost-web
sh build-boot.sh                 # rebuilds boot/vmlinuz + boot/initramfs.img
cd dev
sh setup-harness.sh              # ensures empty-disk.img exists, among other setup
node verify-luks.mjs             # boot-tests LUKS+btrfs stage against the shipped artifacts
```
Expect `VERDICT: LUKS OK`, with the shipped-build marker/log sequence shown
above (ending in `@@SH:err:install-failed@@` + a working debug shell — this
is the correct, expected state of the artifact until Task 7 lands).
Total wall time on this machine: comfortably under a minute end to end
(dominated by Playwright/Chromium + relay `go build` startup, same as the
other harnesses — the LUKS/btrfs stage itself is ~3s with the pinned
reduced-KDF).

---

# Task 7 — Guest provisioning stage 2: Alpine install onto the encrypted disk

## Verdict: **PASS** — marker sequence `network` → `luks` → `install` → `download`
confirmed, `chroot /mnt /usr/bin/psql --version` prints `psql (PostgreSQL)
17.11` via debug-shell probe, on the actual shipped (committed) boot
artifacts. **One package dropped from the brief's list, flagged as a
BLOCKING FINDING needing a controller decision** — see below.

## `--allow-untrusted` decision: **not used** (verified empirically that it isn't needed)

Per the brief's own instruction ("try WITHOUT --allow-untrusted first and
keep it only with written justification"): a bare
`apk.static --root /mnt --initdb ... add ...` with no keys present in the
new root fails **every** package with `UNTRUSTED signature` /
`no such package` — confirmed by direct reproduction (host docker,
`--platform linux/386 alpine:3.23`, `apk.static --root /new --initdb` with
`/new` completely empty). Root cause: apk resolves its trusted-keys
directory as `$ROOT/etc/apk/keys` (relative to `--root`), not the real
`/etc/apk/keys` of the process actually running `apk.static` — a
freshly-`--initdb`'d root has no keys dir at all yet. This is the same
reason tools like `alpine-chroot-install` pre-seed `<newroot>/etc/apk/keys`
before their first `apk --root` call.

**Fix (no `--allow-untrusted` needed):** ship the initramfs's own trusted
Alpine signing keys into the image (`build-boot.sh`'s `selfhost.files` now
lists `/etc/apk/keys/*.rsa.pub` alongside `apk.static`/`mkfs.btrfs`/
`provision.sh` — confirmed mkinitfs's `feature_files()` glob-expands each
line, so the wildcard works, verified by extracting the built
`initramfs.img` and finding all three `*.rsa.pub` files present at
`etc/apk/keys/`), then `stage2_install` copies them into
`/mnt/etc/apk/keys` before its `apk.static` call. Confirmed empirically
(same docker rig) that this makes an otherwise-identical
`apk.static --root <newroot> add alpine-base` succeed cleanly with **no**
`--allow-untrusted`, and the real boot-test run (below) confirms it works
inside the actual initramfs too — no `UNTRUSTED` warnings anywhere in the
serial log.

## BLOCKING FINDING: `postgresql-pgvector` dropped from the package list — controller decision needed

The brief's snippet lists `postgresql17 postgresql17-contrib
postgresql-pgvector` verbatim, and its Interfaces line says stage 2
produces "PostgreSQL 17 + pgvector". **This combination does not exist in
Alpine v3.23's CDN repos as of this run.** Verified via `apk info -R
postgresql-pgvector` against the live `main` repo:

```
postgresql-pgvector-0.8.1-r0 depends on:
postgresql18
so:libc.musl-x86.so.1
```

`postgresql-pgvector` has a **hard** dependency on `postgresql18`, not a
version-agnostic "postgresql" virtual package. `apk search -e
'*pgvector*'` confirms there is no `postgresql17-pgvector` (or 16/18-suffixed
sibling) at all — only `postgresql-pgvector[-bitcode|-dev]`, all three
pinned to 18. This is not a fluke: v3.23 ships postgresql16/17/18 all
as explicit, separately-versioned packages, but the *unversioned*
`postgresql-pgvector` convenience package is hardwired to whichever major
Alpine currently treats as "latest" (18), matching how Alpine packages
this class of "default version" extension.

**How this was caught:** the first `verify-install.mjs` run (against the
brief's package list verbatim) reached all four markers fine, but the
`psql --version` probe printed `psql (PostgreSQL) 18.6`, not 17.x — apk had
silently pulled in `postgresql18` as `postgresql-pgvector`'s dependency,
and `postgresql-common`'s post-install trigger then auto-selected it as
the "default" version (`Setting postgresql18 as the default version` in
the apk output), pointing `/usr/bin/psql` at psql18 instead of psql17.
`VERDICT: INSTALL FAILED` on that run — the exact failure mode is preserved
in `dev/verify-install-run1` (see reproduction section below for how to
regenerate it against the pre-fix package list, if ever needed).

**Why this isn't fixed by pinning the "default version" back to 17
instead:** considered forcing `postgresql17` back as the alternatives
default (postgresql-common's mechanism) while leaving `postgresql18` +
`postgresql-pgvector` installed alongside it — that would make the printed
`psql --version` say 17.x again, but doesn't fix the *real* problem:
pgvector's `.so` is compiled against postgresql18's server ABI and lands in
postgresql18's own extension directory
(`/usr/lib/postgresql18/vector.so`-equivalent), which postgresql17 never
looks in. Postgres extension binaries are not ABI-stable across major
versions (internal struct layouts change), so even copying the `.so` into
postgresql17's extension directory by hand would risk crashing the server
or silently misbehaving rather than working — worse than just not
installing it, because `CREATE EXTENSION vector` would *look* installed
(package present) while remaining functionally broken against whichever
Postgres is actually running the multica database. Rejected as a fix for
that reason — this is a genuine version-compatibility problem, not a
cosmetic packaging one.

**What shipped instead:** `stage2_install`'s package list is
`alpine-base openrc busybox-openrc linux-virt postgresql17
postgresql17-contrib nodejs curl ca-certificates cryptsetup btrfs-progs` —
`postgresql-pgvector` omitted. `psql --version` now correctly reports
`17.11` (see boot-test evidence below), matching this task's own
boot-test gate, and only one Postgres major is ever installed
(`postgresql-common`'s trigger auto-selects 17 as "the default version"
since it's the only one present — confirmed in the passing run's log).

**Left to spec owner** (same class of decision as Task 5's sharp/vips
blocker — reporting severity rather than silently choosing, per this
task's own instruction): (a) move this project's Postgres pin from 17 to
18 project-wide, so pgvector installs cleanly straight from the CDN with
no extra build machinery (simplest fix, but a version bump with its own
blast radius on whatever else assumes 17); or (b) source-build pgvector
against `postgresql17-dev` inside this project's build pipeline and ship
it as a pinned, offline-installed payload — the same pattern Task 5 used
for `vips`/`sharp` (`vips-apks/` in the tarball, installed offline by Task
8). Neither is implemented here. **Task 8 and beyond should not assume
pgvector is present in `/mnt` until this is resolved** — right now, stage 2
ships a working PostgreSQL 17 with no vector extension.

## Boot-test evidence (`dev/verify-install.mjs` against `dev/harness-install.html`)

No temporary debug-shell modification was needed (unlike Task 6): the
shipped, unmodified `guest/init-selfhost` already calls `stage3_multica`
immediately after `stage2_install` returns, and `stage3_multica` is
intentionally still undefined until Task 8 — so it naturally
"`stage3_multica: not found`"s (ash exit 127), `|| fail "multica-failed"`
fires, and `fail()` `exec /bin/sh`s over ttyS0. This is the exact
natural-fallthrough mechanism Task 6's NOTES.md documented for its own
"shipped build" run one stage earlier; same code path, one stage further
along now that `stage2_install` is defined. **`guest/init-selfhost` was
not modified at all by this task** (confirmed: `git diff` against it is
empty) — the debug shell used for the `psql --version` probe is reached
through ordinary, already-shipped control flow, not a test-only insertion.

Two full runs, against the actual committed boot artifacts:

1. **First run — package list as the brief wrote it verbatim (before the
   pgvector fix above).** Reached every marker including `download`, then
   `chroot /mnt /usr/bin/psql --version` printed `psql (PostgreSQL) 18.6`.
   `VERDICT: INSTALL FAILED`. This run is what caught the pgvector/
   postgresql18 problem — see the BLOCKING FINDING section above. Timing
   (kept for record, same machine/conditions as run 2 below):
   ```
   [+5.1s]  network marker seen
   [+5.1s]  passphrase sent on ttyS1
   [+6.2s]  luks marker seen
   [+9.2s]  install marker seen
   [+95.2s] download marker seen (stage2_install completed)
   [+95.2s] debug shell ready
   [+96.3s] psql probe confirmed — printed 18.6, gate failed
   ```
2. **Second, final run — after dropping `postgresql-pgvector` from the
   package list and rebuilding `boot/initramfs.img`.** This is the build
   produced by the exact `guest/provision.sh` / `build-boot.sh` that are
   committed, so it's the authoritative result:
   ```
   [+5.1s]  network marker seen
   [+5.1s]  passphrase sent on ttyS1
   [+6.1s]  luks marker seen
   [+9.2s]  install marker seen         (disk setup — luksFormat+open+mkfs.btrfs+mount — ~3.1s, consistent with Task 6)
   [+88.2s] download marker seen        (stage2_install itself: ~79s — apk.static installing 81 packages, 132.5 MiB, over the wisp:// relay under 386 emulation, then the chroot rc-update calls)
   [+88.2s] debug shell ready           (natural stage3_multica-not-found fallthrough — effectively instant after the download marker)
   [+89.2s] psql probe confirmed
   VERDICT: INSTALL OK
   ```
   Debug-shell probe transcript:
   ```
   ~ # chroot /mnt /usr/bin/psql --version && echo PSQL''_OK
   psql (PostgreSQL) 17.11
   PSQL_OK
   ```
   `bootMarks`: `{"phase-network": ..., "phase-luks": ..., "phase-install": ...,
   "phase-download": ..., "err-multica-failed": ...}` — `err-multica-failed`
   fires as an expected, natural side effect (see above), not a bug.

Both runs comfortably inside the brief's 20-minutes-of-emulated-time
budget (~90s actual on this machine — WASM JIT on Apple Silicon, packages
fetched over the wisp:// relay from the real Alpine CDN, not a synthetic
local mirror). Real-world (network-loaded page, slower CPU, real visitor
network to the CDN) runs will be slower; not tested here, consistent with
every earlier harness's caveat in this file.

## Files added for the harness

- `dev/harness-install.html` — new variant, same plumbing as
  `dev/harness-luks.html` (Task 6: wisp:// relay, ttyS1 passphrase, async
  Range-loaded empty disk) plus marks for the two extra unprompted phase
  markers `stage2_install` emits (`@@SH:phase:install@@`,
  `@@SH:phase:download@@`). Bumped `memory_size` from Task 6's 256 MiB to
  512 MiB — installing PostgreSQL 17 + Node.js + full Alpine base needs
  more apk-extraction/chroot headroom than the LUKS/btrfs-only Task 6 stage.
- `dev/verify-install.mjs` — new variant of `verify-luks.mjs`, same
  Range-aware static server + relay-build-and-spawn pattern. Waits for
  `network` → `luks` → `install` → `download`, then the natural debug
  shell (see above), then probes `psql --version` with the same
  split-marker anti-echo trick as `verify-luks.mjs`'s btrfs probe
  (`echo PSQL''_OK`) since that command is typed/echoed interactive input —
  same false-positive risk documented in the Task 3 section of this file.
  The actual version string is then extracted from `serialLog` via
  `/psql \(PostgreSQL\) [0-9.]+/` and checked against `^17\.` for the
  verdict, rather than trusting the split marker alone (the marker only
  proves the command exited 0, not which version string it printed).
- No changes needed to `dev/setup-harness.sh` — Task 6 already generates
  `dev/empty-disk.img`, reused as-is.

## How to reproduce

```
cd deploy/selfhost-web
sh build-boot.sh                 # rebuilds boot/vmlinuz + boot/initramfs.img
cd dev
sh setup-harness.sh              # ensures empty-disk.img exists, among other setup
node verify-install.mjs          # boot-tests stage2_install against the shipped artifacts
```
Expect `VERDICT: INSTALL OK`, `psql (PostgreSQL) 17.11` in the probe output,
and the marker/timing sequence shown above (run 2). Total wall time on this
machine: a little under 2 minutes end to end (dominated by the ~79s
package install itself, plus the usual Playwright/Chromium + relay `go
build` startup overhead shared with every other harness in this file).

---

# Task 7 continuation — pgvector built for PostgreSQL 17, shipped in the payload tarball (RESOLVED)

## Verdict: **tarball rebuilt successfully — 99M, `pgvector-pg17/` present, guards pass, container-level covering test passes against the exact artifacts inside the final tarball**

Spec owner's ruling on the BLOCKING FINDING above: **keep the project's Postgres pin at 17** (do not move to 18), **source-build pgvector for postgresql17 inside `build-selfhost-tarball.sh`** and ship it as a pinned offline payload — the same pattern already used for `vips`/`sharp`. Implemented; the pgvector CDN package problem documented above no longer applies to the shipped build (stage3/Task 8 installs the source-built artifacts offline instead of trying to `apk add postgresql-pgvector`).

## Pinned version

**pgvector `v0.8.6`** (commit `8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c`) — the latest tag at the time of this build. pgvector does **not** use GitHub's "Releases" feature (`GET /repos/pgvector/pgvector/releases/latest` 404s: `{"message":"Not Found",...}`), only git tags, so `git ls-remote`/the tags API is the correct source of truth, not the Releases endpoint a naive script might reach for first. Confirmed via `curl https://api.github.com/repos/pgvector/pgvector/tags` inside a build container (same network path the real build uses) — `v0.8.6` is the newest of `v0.8.6` down through `v0.7.4` and older, incidentally identical to the exact version Alpine's own (PG18-only) `postgresql-pgvector-0.8.1-r0`... no — note Alpine's CDN package is actually 0.8.1, one version behind; this build intentionally tracks pgvector's own latest tag rather than mirroring whatever Alpine happens to package, since we're building from source specifically because Alpine's package doesn't fit our PG17 pin.

## The real problem this stage had to solve: there is no per-major `pg_config` on Alpine

pgvector's build (PGXS) needs `pg_config --pgxs` / `--includedir-server` / `--pkglibdir` / `--sharedir` to point at whichever PostgreSQL major it's building against. The naive approach — install `postgresql17-dev` and just run `make` — silently builds and "installs" against the **wrong** major:

```
+ pg_config --version
PostgreSQL 18.6
+ pg_config --pgxs
/usr/lib/postgresql18/pgxs/src/makefiles/pgxs.mk
```

**Root cause** (confirmed empirically, host docker `--platform linux/386 alpine:3.23`): Alpine's `/usr/bin/pg_config` is shipped by `libpq-dev` — a single, unversioned package that always tracks whichever Postgres major is Alpine's current "latest" (18.6 in v3.23) — **not** by `postgresqlNN-dev`. Installing `postgresql17-dev` pulls in `libpq-dev` (18.6) as a dependency regardless, and `postgresql-common`'s own version-management tool (`pg_versions`) can't fix this either: its install-time trigger tries to symlink `/usr/bin/pg_config` to the selected-default version but fails, because `libpq-dev` already put a *real file* there, not a symlink it can retarget. apk's own install output says so directly:
```
* Setting postgresql17 as the default version
* pg_versions: WARN: /usr/bin/pg_config exists and it's not a symlink!
```
This is silent and easy to miss — a build using the generic `pg_config` would compile and "successfully" produce a `vector.so`/install tree, just against postgresql18's headers/ABI/paths, which is exactly the same class of problem Task 7's earlier `postgresql-pgvector` finding hit, now showing up again one layer down even when building from source.

**Fix:** every `postgresqlN` package ships its own *real*, version-specific `pg_config` at `/usr/libexec/postgresqlN/pg_config` (confirmed: `apk info -L postgresql17` lists `usr/libexec/postgresql17/pg_config`). Point `PG_CONFIG` at that explicitly:
```
PG_CONFIG=/usr/libexec/postgresql17/pg_config
```
Confirmed this resolves correctly for PG17 (`--version` → `PostgreSQL 17.11`, `--pkglibdir` → `/usr/lib/postgresql17`, `--sharedir` → `/usr/share/postgresql17`, `--pgxs` → `/usr/lib/postgresql17/pgxs/...`), and `make PG_CONFIG=$PG_CONFIG && make install PG_CONFIG=$PG_CONFIG DESTDIR=/out` then places everything under the correct `postgresql17` paths inside `/out`.

## Exact destination paths (interface note for Task 8 — read before writing stage3)

Confirmed via `apk info -L postgresql17-contrib` (the existing contrib extensions' own install locations, e.g. `pg_trgm.so`, `hstore.control`) as ground truth, cross-checked against pgvector's own `make install DESTDIR=/out` output:

- **`vector.so`** → `/usr/lib/postgresql17/vector.so` (this is `pkglibdir` for pg17 — a flat directory, no subdirectory nesting; confirmed by every existing contrib `.so` living directly there).
- **`vector.control` + `vector--*.sql`** → `/usr/share/postgresql17/extension/` (this is `sharedir/extension` for pg17; confirmed by every existing contrib `.control`/`--*.sql` file living there).

**Task 8 must, before the guest ever runs `create extension vector` for the first time:**
```sh
cp /opt/multica/pgvector-pg17/lib/vector.so /mnt/usr/lib/postgresql17/vector.so
cp /opt/multica/pgvector-pg17/extension/vector.control /mnt/usr/share/postgresql17/extension/
cp /opt/multica/pgvector-pg17/extension/vector--*.sql /mnt/usr/share/postgresql17/extension/
```
(adjust the `/opt/multica/...` source prefix to wherever Task 8 actually unpacks the tarball — the payload's own top-level directory is `pgvector-pg17/lib/` + `pgvector-pg17/extension/`, see "Payload layout" below). No `apk add`/CDN access needed or wanted for this — it's a plain file copy, matching the `vips-apks/` precedent's "install offline" spirit, except pgvector doesn't need `apk` at all since it's a single `.so` + SQL files rather than a package with its own dependency closure.

## Payload layout shipped in the tarball

```
pgvector-pg17/
  lib/
    vector.so               # ELF 32-bit LSB shared object, Intel 80386, stripped (206100 bytes)
  extension/
    vector.control
    vector--0.1.0--0.1.1.sql
    ... (41 SQL files total: every version-to-version migration path pgvector
         ships, from 0.1.0 through 0.8.6, plus the base vector--0.8.6.sql —
         kept in full, same "completeness over cleverness" reasoning as
         vips-apks/'s full dependency closure, since `create extension
         vector` needs whichever exact path the installed/upgraded version
         requires)
```
Deliberately **not** shipped (present in the build container's own `DESTDIR` tree but not copied into the payload): LLVM bitcode (`.bc` files, JIT support — stage2_install never installs `postgresql17-jit`, so nothing would ever load them) and the `extension/vector/*.h` headers (only needed by other C extensions that want to interoperate with pgvector's types at *their own* build time, not by pgvector itself at runtime).

## Build script changes (`build-selfhost-tarball.sh`)

New stage inserted between the existing sharp native-module guard and the final `VERSION`/`tar` step (same `docker create`/`cp`/`start -a`/`cp .../rm -f` pattern already used for the sharp build):
1. `apk add postgresql17 postgresql17-dev build-base git` in a fresh `--platform linux/386 alpine:3.23` container.
2. `git clone --branch v0.8.6 --depth 1 https://github.com/pgvector/pgvector.git`.
3. `make PG_CONFIG=/usr/libexec/postgresql17/pg_config` then `make install PG_CONFIG=... DESTDIR=/out` (per the pg_config finding above).
4. `strip /out/usr/lib/postgresql17/vector.so` (matches the project's existing size-hygiene pattern for the Go binaries' `-ldflags "-s -w"`; unstripped was ~242KB with debug info, stripped is ~201KB before the final `docker cp`... actual shipped size after cp/tar is 206100 bytes, see below).
5. Collect only `vector.so` + `vector.control` + `vector--*.sql` into `/out/payload/{lib,extension}` (explicitly skip the `.bc`/header files per the "deliberately not shipped" note above), `docker cp` those into the staging tree at `$STAGE/pgvector-pg17/`.
6. New guards, same discipline as the sharp guard: assert `vector.so` is non-empty AND is actually `ELF 32-bit ... Intel 80386` (via `file`, same check style as the sharp `.node` guard), assert `vector.control` is non-empty, assert at least one `vector--*.sql` file exists (`find | wc -l` count, same "don't let a layout change pass silently" style as the sharp overlay-count guard).

**Cleanup trap hardening**: introduced separate `$PGVECTOR_CONTAINER` / `$PGVECTOR_BUILD_SCRIPT` variables (not reusing the sharp stage's `$CONTAINER`/`$SHARP_BUILD_SCRIPT`) and added them to the single `cleanup()` trap function. Reusing the same variable name across two sequential container-creating stages would have meant the *first* container's name gets silently overwritten by the second before the trap ever runs — the trap only ever sees whatever the variable holds *at exit*, so the earlier container would leak (never `docker rm`'d) on any failure path. Confirmed no leaked containers after the real run (`docker ps -a --filter name=selfhost` empty post-build).

## Container-level covering test (per this task's own instruction — Task 8 does the in-VM proof, this only needs container-level)

Two rounds, both passing:

1. **Standalone build verification** (before wiring into the tarball script): built pgvector in isolation exactly as `build-selfhost-tarball.sh` now does, then in a **separate, fresh** `--platform linux/386 alpine:3.23` container with `postgresql17` installed (no `-dev`, no build tools — a realistic "just the runtime" target), copied the built `vector.so`/`vector.control`/`vector--*.sql` into `/usr/lib/postgresql17/` and `/usr/share/postgresql17/extension/`, then:
   ```sh
   su postgres -c '/usr/libexec/postgresql17/initdb -D /var/lib/postgresql/data'
   su postgres -c '/usr/libexec/postgresql17/pg_ctl -D /var/lib/postgresql/data -l /tmp/pglog.txt -w start'
   su postgres -c '/usr/bin/psql -c "create extension vector;" postgres'
   su postgres -c "/usr/bin/psql -c \"select '[1,2,3]'::vector;\" postgres"
   ```
   Result: `CREATE EXTENSION` succeeds, `select '[1,2,3]'::vector;` returns `[1,2,3]`, `select extversion from pg_extension where extname='vector';` returns `0.8.6`. `PGVECTOR_CONTAINER_CHECK_OK`.
2. **Final, authoritative run — against the actual committed `multica-selfhost-386.tar.gz`**, not a separately-reconstructed copy (same rigor as Task 5's sharp offline check): extracted `./pgvector-pg17` from the real, final tarball produced by the committed `build-selfhost-tarball.sh`, copied *those* files into the same fresh-container setup, repeated the identical `initdb`/`start`/`create extension`/`select` sequence. Identical result: `CREATE EXTENSION` succeeds, `[1,2,3]` round-trips, `extversion` = `0.8.6`, `PGVECTOR_CONTAINER_CHECK_OK`.

(One quirk hit purely in this ad hoc container-only test rig, not in the real build/boot pipeline: a bare `pg_ctl start` failed with `could not create lock file "/run/postgresql/.s.PGSQL.5432.lock": No such file or directory` until `/run/postgresql` was `mkdir -p`'d and `chown`'d to `postgres` — an artifact of this throwaway container not having that directory pre-created the way a real Alpine `postgresql17-openrc` service's init script would; not a pgvector or build-script issue, and not something Task 8's real OpenRC-managed `postgresql` service will hit, since `postgresql17-openrc`'s own init script handles that directory.)

## Tarball size (final, with pgvector added)

```
99M   multica-selfhost-386.tar.gz   (compressed, unchanged from the pre-pgvector build)
```
`pgvector-pg17/` adds ~1.1MB uncompressed (41 small SQL files + one 206KB stripped `.so`) to the existing ~279MB uncompressed staging tree — far too small to move the rounded compressed total off 99M. Confirmed via `tar -tzf` that `pgvector-pg17/lib/vector.so` and all 41 `pgvector-pg17/extension/*` files are present in the actual shipped artifact.

## How to reproduce

```
sh deploy/selfhost-web/build-selfhost-tarball.sh /tmp/multica-selfhost-386.tar.gz
```
Expect ~10-12 minutes on this machine (unchanged bottleneck: the sharp C++ compile under qemu-i386 emulation, same as the original Task 5 timing — pgvector's own build adds only a couple of minutes, dominated by its own single-threaded `cc`/LTO-bitcode compile of ~18 small `.c` files, negligible next to sharp's ~6 minute `npm install --build-from-source`). Ends with the same `ls -lh` line as before, `99M`, now also containing `pgvector-pg17/`.

---

# Task 8 — guest provisioning stage 3 (multica install, initdb, services)

Capstone stage. `stage3_multica` in `guest/provision.sh` downloads the
release tarball over `sh_release_url`, unpacks it into `/mnt/opt/multica`,
installs the offline `vips-apks/` closure and the `pgvector-pg17/` payload,
initializes Postgres, runs the migrations, and wires the two OpenRC services
(`guest/multica-backend.initd`, `guest/multica-web.initd`) plus the
`ready`-marker `local.d` script. Verified end to end with
`dev/verify-firstboot.mjs` + `dev/harness-firstboot.html`.

## GATE VERDICT: `VERDICT: FIRSTBOOT OK; COLDBOOT OK`

Both phases in one driver run. Marker timelines (from `window.bootMarks`,
authoritative — the driver prints the raw epoch-ms objects):

**First boot** (empty 2 GiB disk, t0 = boot-start):

| marker | t | delta |
|---|---|---|
| emulator-ready | +0.2s | |
| phase-network | +4.6s | +4.4s |
| phase-luks | +5.3s | +0.7s (passphrase over ttyS1) |
| phase-install | +8.7s | +3.4s |
| phase-download | +101.7s | +93.0s (stage2: 81 pkgs from the CDN over the wisp relay) |
| phase-initdb | +211.9s | +110.2s (99M tarball fetch + unpack + 78 vips apks + pgvector copy) |
| phase-services | +302.2s | +90.3s (initdb + create user/db/extension + 366 migrations) |
| phase-ready | +333.6s | +31.4s (switch_root -> OpenRC -> node answers on :3000) |
| curl probe | +381.5s | HTML confirmed |

**Cold boot** (same disk, t0 = the second emulator's `emulator-ready`):

| marker | t | delta |
|---|---|---|
| phase-network | +4.4s | |
| phase-luks | +5.1s | +0.7s |
| phase-services | +6.1s | +1.0s (`coldboot_mount` only — no reinstall) |
| phase-ready | +43.8s | +37.7s |
| curl probe | +205.6s (driver clock) | HTML confirmed |

`bootMarks` for the cold boot contains **no `phase-install` and no
`phase-download`** — nothing was re-bootstrapped and nothing re-downloaded,
which is the actual assertion of the cold-boot step. Both boots' `curl -s
localhost:3000` returned real markup
(`<!DOCTYPE html><html lang="en" class="antialiased font-sans h-full ...`),
and the cold boot's OpenRC output shows `PostgreSQL 17 [ok]`,
`multica-backend [ok]`, `multica-web [ok]`, `local [ok]`.

## Finding: Next's standalone output does not reproduce pnpm's hoisting

**Symptom.** Everything up to and including OpenRC succeeded — `Starting
multica-web ... [ ok ]` — but the `ready` marker never fired, for boot after
boot. `command_background=yes` means OpenRC reports `[ok]` as soon as it has
*forked* the process; it says nothing about whether that process survived.
`/var/log/multica-web.log` had the real story:

```
Error: Cannot find module '@swc/helpers/_/_interop_require_default'
Require stack:
- /opt/multica/frontend/apps/web/node_modules/next/dist/shared/lib/constants.js
- /opt/multica/frontend/apps/web/node_modules/next/dist/server/config.js
- ...
```

and, once that one package was fixed in isolation, the identical failure for
`@next/env`.

**Cause.** Next's output-file-tracing copies `next`'s own transitive runtime
deps into the pnpm *virtual store* shape only —
`node_modules/.pnpm/next@<hash>/node_modules/<pkg>` — which is not on the
upward `node_modules` walk from `apps/web/node_modules/next/dist/**/*.js`.
In the source tree these resolve because pnpm **hoists** them (`readlink
node_modules/@swc/helpers` points into the repo root's own
`node_modules/.pnpm`); the tracer does not reconstruct that hoisting. This
is systemic — next's whole private dependency set — not one missing package,
so chasing them one at a time as each new one crashes is the wrong shape of
fix.

**Fix** (`build-selfhost-tarball.sh`): mirror what a real pnpm-managed
`next/node_modules/` would contain — every sibling package in next's own
pnpm-hash directory — into `apps/web/node_modules/next/node_modules/`, the
first location Node's walk checks after `next/dist/**`. Excludes `next`
itself and `sharp` (the latter has its own linux/386 overlay, and a traced
darwin-arm64 copy at this higher-priority location would shadow it). Guarded
by an assert that `@swc/helpers/cjs/_interop_require_default.cjs` and
`@next/env` are actually present afterwards.

**Container-level verification of that fix** (much faster than a boot — this
is the reproduction rig worth reusing for any future frontend-payload
change): extract the built tarball's `frontend/` and `vips-apks/`, `docker
cp` both into a `--platform linux/386 alpine:3.23` container (`docker
create` + `docker cp`, not a bind mount — the Lima home is read-only, same
constraint `build-boot.sh` documents), `apk add nodejs curl` plus
`apk add --allow-untrusted /opt/multica/vips-apks/*.apk`, then run
`node /opt/multica/frontend/apps/web/server.js` with the same env
`multica-web.initd` sets. Result on the fixed tarball:

```
▲ Next.js 16.2.6
- Local:        http://localhost:3000
✓ Ready in 0ms
=== PORT 3000 IS LISTENING (after 12s) ===
HTTP_200 SIZE_276635
<!DOCTYPE html><html lang="en" ...
```

## Finding: v86's `emulator.restart()` cannot reboot a `bzimage`+`initrd` guest — RELEVANT TO TASK 11

The first attempt at the cold-boot step used v86's own `restart()`. It
panics the emulator immediately:

```
panicked at src/rust/cpu/cpu.rs:815: Unimplemented: #GP handler
  instr32_CA (RETF) -> far_return -> trigger_gp -> call_interrupt_vector
```

Reading `node_modules/v86/build/libv86.js`: `restart()` calls
`cpu.reboot_internal()`, which does `reset_cpu()`, resets a handful of
devices, and then `load_bios()` — and `load_bios()` *only* re-writes the
BIOS/VGA-BIOS ROM blobs back into memory. It never re-runs the Linux
boot-protocol loader that placed the kernel, the initrd and the cmdline in
RAM at construction time. This project has no bootloader and no MBR (the
disk is raw LUKS), so after `restart()` the machine is a bare SeaBIOS with
nothing bootable and dies on the spot. Confirmed on a run whose *first* boot
had just fully succeeded, with the panic landing on the very next statement.

**Task 11 must not offer a "restart this instance" control backed by
`emulator.restart()`.** What works instead (and is what
`harness-firstboot.html`'s `coldBootReset()` does): construct a brand-new
`V86` — fresh CPU, RAM and devices, kernel/initrd/cmdline loaded from
scratch — and hand it the *first* instance's own disk-buffer object as
`hda`. v86's option normalization accepts an already-constructed loadable
directly (it branches on `r.get && r.set && r.load` before ever looking at
`r.url`), and that object holds every block the guest wrote, since v86's
async disks are copy-on-write in memory (`dev/empty-disk.img` on the static
server is never modified — confirmed, its mtime and first 4 KiB are
unchanged across every run). The harness locates that buffer structurally
(get/set/load + exact `byteLength`) rather than by a fixed property path,
because `libv86.js` is a minified Closure build. This is a *stricter*
reading of "cold boot, no state restore" than `restart()` would have been:
nothing but the disk survives.

## Interface note: `sh_release_url` must use the host's real LAN IP — RELEVANT TO TASK 11

Both `verify-firstboot.mjs` and `harness-firstboot.html` cite this section
for the finding, so it is recorded here in full.

The guest downloads its payload with `chroot /mnt curl -fL ... "$REL"`, where
`$REL` comes from the `sh_release_url=` kernel cmdline parameter. Which host
address works there is not obvious, and three plausible choices all fail:

- **`localhost`** — short-circuited by the guest's own `/etc/hosts`. Never
  reaches the network at all; curl connects to the guest itself.
- **`127.0.0.1`** — same problem, guest-local loopback.
- **A guessed v86-internal gateway IP** — tried `192.168.86.1` (which really
  is the gateway v86's built-in DHCP server hands out, so it looks right) and
  the QEMU-slirp-convention `10.0.2.2`. Both fail. The wisp relay does a
  literal `net.Dial(host, port)` with whatever string it is handed, from the
  *host* machine's network namespace — so a raw IP that is not actually
  bound to one of the host's own interfaces simply fails to connect. Curl
  inside the guest hung to its own timeout: `HTTP_000`.

**What works: the host machine's own real, non-loopback LAN IP.** A raw IP in
the guest's curl bypasses the guest's local-resolution shortcuts (no
`/etc/hosts` entry can match an arbitrary real IP), routes out via eth0/wisp
as a raw-IP CONNECT, and the relay's `net.Dial` reaches it directly because
it is a real address already bound to a host interface — a same-machine
self-connect to its own LAN IP, which routes correctly. Confirmed:
`HTTP_200 SIZE_4101`.

The harness computes it with `os.networkInterfaces()` (first non-internal
IPv4) and passes it to the page as `?release_host=`, rather than hardcoding
it, so the test is not pinned to one dev machine's network.

**Implication for Task 11:** the shipped page serves the release from a real
origin over the same wisp relay, so it does not inherit this specific
localhost problem — but it inherits the underlying rule. Whatever host string
ends up in `sh_release_url` is resolved and dialled *by the relay, on the
host side*, not by the browser and not inside the guest. Anything that is
only meaningful in the browser's own context (a relative URL, a blob: URL,
`localhost`) cannot work.

## Interface note: `memory_size` must be 1 GiB — RELEVANT TO TASK 11

`harness-firstboot.html` configures `memory_size: 1024 * 1024 * 1024`, up
from the 512 MiB every earlier `dev/harness-*.html` used. Task 8 is the first
stage where the guest has to run a real workload rather than just install
packages: Postgres doing `initdb` plus 366 migrations, and then — after
`switch_root` — Postgres, the Go backend and a Next.js standalone server all
resident at once, on top of everything Task 7 already needed. Task 11 must
size the shipped VM at 1 GiB as well; the earlier tasks' 512 MiB is not a
usable reference point for a provisioned instance.

## Finding: nothing in the installed system mounts `/dev` — the first boot only worked by accident

Found by the cold-boot test, and the reason the first cold boot hung.

`stage2_install`'s `apk.static --initdb` bootstrap populates **no sysinit
runlevel** — the only `rc-update add`s anywhere are `networking`, `syslog`,
`postgresql` and Task 8's own two services, all into `default`. So OpenRC
never runs `devfs`. The first-boot serial log confirms it: OpenRC mounts
`/proc`, `/run` and the local filesystems, and never mounts `/dev`.

The first boot works anyway, but only incidentally: `stage3_multica` mounts
a devtmpfs at `/mnt/dev` for its own needs (the `apk add` triggers want
`/dev/null`; the JWT generation wants `/dev/urandom`), and busybox's
`switch_root` leaves an already-mounted target alone — so that mount
silently *becomes* the booted system's `/dev`. None of that survives a
reboot: a devtmpfs mount is not filesystem content, and the btrfs directory
underneath it is empty.

The cold-boot path never runs stage3, so `switch_root` handed `/sbin/init`
an empty `/dev`. busybox init then spun at 100% CPU respawning its inittab
entries against nothing, for the entire 15-minute ready window:

```
can't open /dev/ttyS0: No such file or directory
can't open /dev/tty1: No such file or directory
... repeating forever
```

No OpenRC output, no services, no `ready` marker. **Fix:** `coldboot_mount`
mounts the same devtmpfs, so both paths hand `switch_root` an identically
populated `/dev`. Verified — the very next run passed both phases.

Worth revisiting later (not required for this task's gate): the durable fix
is for the *installed* system to mount its own `/dev`, i.e. populate the
sysinit runlevel (`devfs`, `dmesg`, `hwdrivers`) during stage 2, rather than
depending on an initramfs mount leaking through `switch_root`.

## Other bugs found and fixed via boot-testing

- **`CREATE DATABASE` inside a transaction block.** The brief's snippet
  combined `create user ...; create database ...;` into one `psql -c`. psql
  sends a `;`-joined string as a single implicit transaction, and
  `CREATE DATABASE` is one of the commands Postgres refuses to run in one:
  `ERROR: CREATE DATABASE cannot run inside a transaction block`. Split into
  two `psql -c` invocations.
- **Wrong `PGDATA`, silently.** The brief initializes at
  `/var/lib/postgresql/data`, but Alpine's `postgresql17-openrc` init script
  hardcodes `data_dir="/var/lib/postgresql/17/data"` *and* defaults to
  `auto_setup="yes"` — so it silently ran its own `initdb` at its expected
  path and booted a brand-new empty cluster ("Creating a new PostgreSQL 17
  database cluster..." right in the OpenRC output). The cluster stage 3 had
  just spent two minutes initializing and migrating was never looked at.
  Fixed by using `/var/lib/postgresql/17/data` throughout.
- **`/mnt/dev` empty during stage 3.** `apk add`'s `shared-mime-info`
  trigger fails hard ("can't open /dev/null") without it. Fixed by the
  devtmpfs mount described above.
- **macOS AppleDouble sidecars became migrations.** `cp -r`/`tar` on APFS
  emit `._<name>` files for anything carrying an xattr. macOS's own tar is
  copyfile-aware and hides them, so a build machine never notices — but the
  guest's busybox `tar` extracts `._001_init.up.sql` as an ordinary file and
  `migrations.Files("up")`'s `*.up.sql` glob picks it up as a real
  migration, whose "SQL" is binary metadata: `ERROR: invalid message
  format`. Fixed in `build-selfhost-tarball.sh` by stripping `._*`/
  `.DS_Store` from the staging tree (with an assert that none remain) and
  setting `COPYFILE_DISABLE=1` for the `tar`.
- **pgvector built with `-march=native`.** pgvector's Makefile defaults
  `OPTFLAGS=-march=native`; under the qemu-i386-emulated build container
  that probes a CPU feature set v86 does not implement, and `create
  extension vector` crashed the whole Postgres backend with `trap invalid
  opcode ... in vector.so` / `terminated by signal 4: Illegal instruction`.
  Fixed with pgvector's own documented portability flag, `OPTFLAGS=""`.
- **`multica-web` is not `rc-update`-visible unless the initd files are in
  the initramfs.** `build-boot.sh`'s `features.d/selfhost.files` list is the
  only way anything under `guest/` lands in the image, and omitting an entry
  is a silent no-op rather than a build failure (Task 4's finding, hit again
  here). Both `.initd` files added to that list.
- **Relay/emulator startup race.** v86's first WS connect can beat the
  relay's own `listen`, producing `ERR_CONNECTION_REFUSED`; the guest's DHCP
  still succeeds (v86's built-in DHCP server is independent of the relay),
  which masks it until stage 2's CDN fetch hangs for the rest of the run.
  Earlier `verify-*.mjs` scripts win this race by luck;
  `verify-firstboot.mjs` waits for the port explicitly.

## Diagnosing "service started but nothing is listening"

`command_background=yes` makes OpenRC print `[ok]` on fork, so a crash-loop
looks identical to a slow start from the outside. That ambiguity cost a full
boot cycle. `verify-firstboot.mjs` now waits for `ready` in a probe loop
rather than one long `waitSerial`: every 60s it sends, over the ttyS0 root
shell, `nc -z 127.0.0.1 3000` (UP3000/DOWN3000), `nc -z 127.0.0.1 8080`
(UP8080/DOWN8080) and a `node` process count, using the split-marker
anti-echo trick from the Task 3 section. That distinguishes "still starting"
from "dead" live, and a probe returning nothing at all is itself the
signature of the empty-`/dev` failure above.

**The `:8080` assertion is load-bearing, and HTML on `:3000` does not
subsume it.** The frontend serves its entire app shell with no backend
whatsoever — proven, not assumed: the container-level pre-check above ran
`server.js` with nothing at all on 8080 and got back the same HTTP 200 and
the same 276635 bytes of markup the in-guest `curl` gets. A gate built only
on the `ready` marker and an HTML check would therefore pass an instance
whose API never came up. The `ready` marker itself is no help here: its
`local.d` script only polls port 3000. So both boots now assert `UP8080`
explicitly (with a short retry, since the marker can fire while the backend
is still opening its listener — the two services start in the same OpenRC
runlevel), and that assertion is what catches a backend that refuses to
start, including the deliberate fail-closed case below.

## `multica-backend` fails closed on a missing/blank `JWT_SECRET`

`server/cmd/server/main.go` only *warns* when `JWT_SECRET` is unset and then
falls back to a hardcoded default signing key — which also derives the
Composio state secret (`router.go`) and the avatar/attachment HMAC keys
(`internal/handler/avatar.go`). An earlier version of `multica-backend.initd`
sourced `/opt/multica/env` inside a bare `if [ -f ... ]`, so a missing or
truncated env file produced a silently-insecure instance that looks perfectly
healthy from outside: OpenRC prints `[ok]`, the API answers, tokens verify.
That is the worst possible failure mode for a secret.

The service now refuses to start if the file is absent *or* if `JWT_SECRET`
is empty after sourcing it (a file that exists but never assigns the variable
— a provision truncated by a crash mid-write — would otherwise sail straight
through an `-f` test). An instance that does not come up is a visible,
diagnosable problem, and the `:8080` gate assertion above is what makes it
visible.

Relatedly, `stage3_multica` now writes `/opt/multica/env` under `umask 077`
and `chmod 600`s it. The umask is what actually closes the window in which
the file exists at the default 644; the explicit chmod states the intent and
fixes the mode on a re-provision over an existing file. This box runs a
`postgres` system user, so a world-readable secret hands every one of those
signing domains to any local account.

## Security caveat (carry to Task 12)

`stage3_multica` enables a bare, unauthenticated root shell on ttyS0
(`sed -i 's|^#ttyS0::respawn:.*|ttyS0::respawn:/bin/sh|' /mnt/etc/inittab`).
This extends the trust boundary `init-selfhost`'s `fail()` path already
establishes (whoever holds the serial channel proved possession of the LUKS
passphrase at boot) to the success path, and it is what makes this task's
own gate — `curl -s localhost:3000` *inside* the guest — verifiable at all.
Same class/severity as Task 6's pbkdf2 KDF downgrade: flagged, not silently
shipped. It must be gated behind a generated one-time credential or removed
before this path is exposed beyond the local v86 harness.

## How to reproduce

```
sh deploy/selfhost-web/build-selfhost-tarball.sh /tmp/multica-selfhost-386.tar.gz
ln -sf /tmp/multica-selfhost-386.tar.gz deploy/selfhost-web/dev/multica-selfhost-386.tar.gz
sh deploy/selfhost-web/build-boot.sh          # only if guest/ changed
cd deploy/selfhost-web/dev && node verify-firstboot.mjs
```

Roughly 6.5 minutes to `VERDICT: FIRSTBOOT OK`, then ~3.5 more for the cold
boot. `dev/empty-disk.img` must be a pristine all-zero 2 GiB file; v86 never
writes to it, so it stays reusable across runs.

---

# Task 11 — `vm-controller.js`: v86 lifecycle controller for the shipped page

## Verdict: **PASS** — `VERDICT: VMC OK`. `onPhase("network")` fires (~3.1s),
a real `pause()`→`resume()` round trip lands `states` at
`["starting","running","paused","running"]` with a persisted, non-trivial
snapshot in between, and — bonus, non-gating evidence — the guest keeps
executing after `resume()`: `onPhase("luks")` fires ~0.4s later, proving
`resume()` genuinely continued the CPU rather than just flipping a state
string.

## Disk-backing decision: BlockStore-backed custom v86 "loadable", not any `V86Image` form

This is the one part of this task with no directly-reusable prior art —
every earlier harness's disk (Task 6 onward) was `{url: "empty-disk.img",
async: true, size: ...}`, an HTTP-Range-loaded file whose writes only ever
land in an **in-memory** `block_cache` Map (`AsyncXHRBuffer`,
`node_modules/v86/build/libv86-debug.js:666-751` — `.set()` at line 714
never touches `this.filename`/the server at all). That's exactly right for
a stateless test harness and exactly wrong for a shipped page whose whole
point is that an instance's disk survives a reload. v86's public `V86Image`
union (`node_modules/v86/v86.d.ts:12-76`) has no fourth, "persist writes
somewhere durable" form — confirmed by reading the type end to end, not
just skimming: `V86AsyncFileImage` / `V86SyncFileImage` (URL-backed) and
`V86BufferImage` (`{buffer: ArrayBuffer}`, would need the whole disk resident
in the JS heap up front) are the only three shapes it accepts.

What made a real BlockStore-backed disk possible is a finding **already on
record from Task 8**, in this same file (see "Finding: v86's
`emulator.restart()` cannot reboot..." above), just not previously exploited
for this purpose: v86's option normalizer accepts an **already-constructed
loadable object directly**, bypassing the `V86Image` union entirely,
whenever it exposes `.get`/`.set`/`.load` — the exact branch, read again for
this task to get the file:line right, is
`node_modules/v86/build/libv86-debug.js:6180`:
```js
if ($file.get && $file.set && $file.load) {
  $files_to_load$$.push({name: $name, loadable: $file});
}
```
This is not documented in `v86.d.ts` at all (`hda?: V86Image` is the only
declared type) — it is real, load-bearing behavior in the shipped JS that
the public type declarations simply don't describe. Confirmed empirically
too, not just by reading: `dev/vm-controller-check.html` passes a
`BlockStoreDisk` instance as `hda` and the guest boots and reaches the
`luks` phase, which would be impossible if v86 had silently ignored the
object or fallen through to treating it as `undefined`.

`js/vm-controller.js`'s `BlockStoreDisk` class implements that trio against
Task 10's `BlockStore` (IndexedDB) as the actual backing store:
- `load()` resolves immediately — no upfront fetch, unlike the HTTP forms.
- `get(offset, len, fn)` / `set(offset, data, fn)`: v86's IDE layer calls
  these with byte offsets that are sector-aligned (512 B,
  `libv86-debug.js:9540` `do_write`'s own `dbg_assert(data_length % 512 ===
  0)`) but **not** aligned to `BlockStore`'s block size (1 MiB by default).
  Both methods split a request across as many `BlockStore` blocks as it
  spans, reading/writing each with `blockStore.read(index)` /
  `blockStore.write(index, buf)`. A block that was never written reads back
  as `null` from `BlockStore`, which `get()` treats as all-zero — that's
  what gives "empty disk" semantics with no pre-provisioned image file
  anywhere (no `empty-disk.img` equivalent needed or shipped).
- `get_state()` / `set_state()`: these exist because v86's `save_state`
  walks into `get_state()` on any nested object that has one
  (`save_object`, `libv86-debug.js:2190-2191`), and concretely for a disk,
  `IDEInterface.prototype.get_state` (`libv86-debug.js:9846`) stores
  `this.buffer` — the loadable object itself, unserialized — at slot 28,
  and `set_state` (`libv86-debug.js:9873`) calls
  `this.buffer.set_state(state[28])` on the **existing** buffer object
  rather than reconstructing one from the snapshot. `BlockStoreDisk` makes
  both no-ops on purpose: `BlockStore` already persists every write the
  instant it happens (a normal IndexedDB `put`), independent of whether or
  when a VM snapshot is taken, so there is nothing disk-shaped left to fold
  into the (much smaller, CPU/device-only) snapshot blob. Verified this is
  the right call empirically too: the persisted snapshot in the check run
  was ~87-90 MB (varies slightly run to run — RAM pages touched by boot
  time, via v86's own `pack_memory()` sparse packing, `libv86-debug.js`
  around `CPU.prototype.get_state`), not anywhere near the 2 GiB disk size,
  confirming disk content genuinely isn't embedded in the snapshot blob.

This is a closest-workable-form decision, not a documented/supported API —
flagging per the task's own instruction to prefer honesty over forcing an
API that doesn't exist. The mechanism is real and empirically verified
(boots, persists, and — see below — round-trips through pause/resume
correctly), but it rests on undocumented internals of a vendored,
minified-in-production dependency (`vendor/libv86.js`), not a contract v86
promises to keep across versions. If `deploy/selfhost-web/dev/node_modules/v86`
is ever upgraded, re-verify this specific branch still exists before
assuming disk persistence still works — a future v86 release narrowing
that duck-typed check (e.g. requiring an explicit `instanceof` or a marker
property) would silently turn every instance's disk back into an in-memory
scratch disk with no error at boot time.

## `restart()` reminder honored

No `restart()` anywhere in `vm-controller.js`, by construction — the module
only ever exposes `start()`/`pause()`/`resume()`/`stop()`. `start()`'s
"snapshot exists" path does not call `restore_state()` itself either;
it constructs a fresh `V86` with `initial_state: {buffer: snapshotBytes}`
in the options and lets `autostart: true` drive the constructor's own
`restore_state()` + `run()` sequence (`libv86-debug.js:6107`, the
`settings.initial_state && (emulator.restore_state(...), ...);
options.autostart && this.v86.run();` pair) — one code path, not two, and
it's the same "brand-new V86, no `restart()`" shape Task 8 already proved
works for a bzimage+initrd guest with no bootloader/MBR.

## Passphrase timing: sent on the first serial byte, not tied to the `network` marker

Every earlier harness (Task 6 onward) sent the passphrase from the
**driver script**, explicitly after observing `@@SH:phase:network@@` in
`serialLog`. `vm-controller.js` has no external driver watching markers —
it sends `passphrase + "\n"` over `serial_send_bytes(1, ...)` on the
**first** `serial0-output-byte` event it ever sees, full stop, per this
task's own instructions. This works because of something already
established, not newly assumed: the guest's tty layer buffers ttyS1 input
until `init-selfhost` actually reads it during the LUKS stage (well after
boot start) — sending early just means the bytes sit in the tty input
queue for a couple of seconds, harmlessly. The check run's marks confirm
this is fine in practice: passphrase is sent at effectively t=0 (first
serial byte, well before the `network` mark at +3.1s), and `luks` still
fires correctly (both before and after the pause/resume round trip in the
same run) — no passphrase-related error marker (`@@SH:err:*@@`) was ever
observed.

## Marker parsing: bounded rolling window, not the whole accumulated log

Unlike every `harness-*.html`'s `onSerialByte`, which appends to an
ever-growing `rawBuf` and re-runs the marker regexes over the **entire**
accumulated string on every single byte (fine for a short-lived, thrown-away
test harness; `O(n^2)` over a multi-minute boot with megabytes of `apk`
install output otherwise), `vm-controller.js` keeps only the last
`MARKER_WINDOW` (512) characters for marker scanning and dedupes fired
phases/errors by name so a marker is never reported twice even though the
window re-scans overlapping text on every byte. `onSerial(chunk)` itself
(the raw pass-through callback for a future terminal UI, Task 12) still
gets every byte, unbounded — only the controller's own internal marker
buffer is capped. This is a genuine behavioral difference from the harness
pattern, made deliberately: this module is meant to run for an instance's
whole lifetime (hours), not one test's few minutes.

## Check evidence (`dev/vm-controller-check.html` + `dev/verify-vmc.mjs`)

Real boot, real relay, no mocking — `VmController` constructed exactly as a
real page would, against `vendor/{libv86.js,v86.wasm,seabios.bin,vgabios.bin}`
and `boot/{vmlinuz,initramfs.img}`. `dev/vm-controller-check.html` lives in
`dev/` but `verify-vmc.mjs`'s static server special-cases `"/"` to serve its
*content* while leaving the navigated URL (and therefore the page's base
URL) at `/` — the mirror image of Task 4's `harness-boot.html` fix (that
harness needed base `/dev/` for its own `../boot/...` references; this
check needs base `/` because `vm-controller.js`'s asset paths are written
relative to the repo root, matching where the real `selfhost.html` lives).

One environment bug hit and fixed while building the driver: the static
server initially set no `content-type` header at all, and Chromium refused
to execute `js/vm-controller.js` as a module script ("Strict MIME type
checking is enforced for module scripts... responded with a MIME type of
`''`"). Fixed by adding an explicit MIME map (`.js`/`.mjs` →
`text/javascript`, `.wasm` → `application/wasm`, `.html` → `text/html`),
same fix shape as Task 9's `run-tests.mjs` already applies for its own
static server — this task's driver just hadn't copied that part yet.

Representative run (`node verify-vmc.mjs`, timings vary a little run to
run — same WASM-JIT-on-Apple-Silicon caveat as every earlier harness in
this file):

```
[+0.1s] start() resolved (state -> running, emulator-ready fired)
[+3.1s] onPhase("network") fired
states at network phase: ["starting","running"]
[+3.3s] pause() resolved
[+3.3s] snapshot persisted: 86843836 bytes
[+3.4s] resume() resolved
[+3.8s] bonus: onPhase("luks") fired after resume — guest execution genuinely continued
phase timeline (marks): {
  "check-start": 1786948261051,
  "state-starting-1": 1786948261053,
  "state-running-2": 1786948261176,
  "phase-network": 1786948264173,
  "state-paused-3": 1786948264335,
  "state-running-4": 1786948264448,
  "phase-luks": 1786948264868
}
phases seen: ["network","luks"]
errors seen: []
full state transition list: ["starting","running","paused","running"]
VERDICT: VMC OK
```

Three consecutive runs all passed with snapshot sizes in the same
~86-90 MB range (86.8M, 89.4M, 90.4M) — small relative to the 2 GiB disk
(confirming disk content is not embedded in the state blob, per the
disk-backing section above) but non-trivial (confirming `save_state()` is
capturing real, non-empty guest RAM state, not an empty/placeholder
buffer). Total wall time per run: ~15-20s including Playwright/Chromium +
relay `go build` startup, comfortably inside the "keep run under ~3-4 min"
budget.

## Task 11 fix — autosave coherence (post-review finding)

Review of this task found a real bug in the autosave path as first shipped:
`_startAutosave`'s `setInterval` callback called `emulator.save_state()`
directly on a **still-running** emulator — unlike `pause()`/`stop()`, which
both call `emulator.stop()` first. Two distinct problems, not one:

1. **The individual snapshot itself could be internally torn.**
   `save_state()` reads the WASM RAM buffer while, if the CPU is not
   halted, the guest keeps *executing* — including writing to
   `BlockStoreDisk`, which persists straight to IndexedDB the instant each
   write happens, independent of any snapshot. `save_state()`'s own read of
   RAM is not instantaneous either. With nothing halted, there is no
   guarantee the RAM bytes captured and the disk-block writes that happened
   during that same window correspond to the *same* instant in the guest's
   execution — the snapshot produced might not describe any single real
   state the guest was ever actually in.
2. **A crash between two (even individually-coherent) snapshots restores an
   old CPU/RAM state paired with a disk that kept evolving.** If the tab
   dies (crash/force-quit/OS kill) after further guest writes past the last
   autosave, `start()` would restore that older RAM snapshot while
   `BlockStoreDisk` already reflects everything written up to the crash —
   Postgres's own in-RAM WAL/checkpoint bookkeeping (captured in the
   snapshot) would then disagree with what's actually on disk.

### Chosen mitigation: (a) halt-before-snapshot, not (b) generation tagging

Considered both options raised in review. **Chose (a):** `_autosaveTick`
now does `emulator.stop()` → `save_state()` → `saveSnapshot()` → `run()`,
exactly mirroring `pause()`/`stop()`'s existing sequence, accepting a
sub-second CPU stall every 5 minutes. Rejected (b) (a persisted
write-generation counter + refuse-stale-restore-and-cold-boot) as
unnecessary added complexity here: it would only guard against problem #2
(stale-relative-to-newer-disk) and does nothing for problem #1 (a snapshot
that's torn *at the moment it's taken*, before any subsequent writes even
happen) — halting is required either way to fix #1, and once the CPU is
halted for the snapshot, problem #2 stops being a coherence bug at all and
becomes ordinary, expected "the disk kept moving after the last checkpoint"
behavior:

A crash strictly *between* two coherent snapshot instants (autosave every 5
min, or pause/stop) just discards whatever guest execution and disk writes
happened after the last one — indistinguishable, from the guest's own
perspective, from an ordinary power-loss event. This is *exactly* the
failure mode btrfs's own copy-on-write design and crash-consistency
guarantees exist to tolerate (any block written by the "lost future" was
written via COW to new locations, never overwriting anything still
reachable from the last committed superblock the restored CPU snapshot
believes is current — restoring an older, fully — self-consistent
generation and continuing from there is not corruption, it is a valid
continuation of an earlier point in the same history). Postgres's WAL gives
the same guarantee one layer up, once Task 8's stage 3 is what's running.
So: correctness only actually requires each *individual* snapshot to be a
genuinely coherent {RAM, disk-as-of-that-instant} pair — which halting
guarantees — not that no snapshot is ever "stale" relative to a disk that
kept moving after it, which is unavoidable for any periodic-checkpoint
scheme and is not itself a bug.

`_startAutosave`'s `setInterval` callback and the public `start`/`pause`/
`resume`/`stop` methods are now all routed through a new `_enqueue` helper
(`this._opLock`, a serialized promise chain) so an in-flight autosave tick
(which now also halts/resumes the CPU, like pause/stop) can never interleave
with a concurrent `pause()`/`stop()`/`resume()` call touching the same
`emulator` — a race the halt-before-snapshot fix would otherwise have
introduced (e.g. autosave's own `run()` firing after a concurrent `pause()`
had already halted the CPU and transitioned to `"paused"`, silently
un-pausing it).

### Autosave failures now surfaced via `onError`, timer kept alive

`_autosaveTick`'s catch block now calls `this.onError` with a distinguishable
`"autosave-failed: <message>"` prefix (previously: `console.error` only, an
easy-to-miss silent failure given that restore-correctness *depends on*
autosaves actually landing). If the emulator was already halted when the
save itself failed, a `finally` block still calls `emulator.run()` so the
guest doesn't silently freeze — a failure in that resume step gets its own
distinguishable `"autosave-resume-failed: <message>"` onError call. Either
way the `setInterval` timer itself is left running — one failed attempt
(e.g. a transient IndexedDB quota error) must not stop future ones.

### Minor also folded in: `resume()`'s no-snapshot cold-boot fallback

Review also flagged (as a minor, only worth doing if it intersected this
fix) that `resume()`'s fallback path — no live `emulator` *and* no
persisted snapshot found, e.g. some future code path reaches `"paused"`
after a reload without ever having saved — silently cold-boots with no
signal. It now calls `onError("resume-no-snapshot: ...")` before doing so.
Under the current design this branch shouldn't be reachable in practice
(`pause()`/`_autosaveTick` both always `saveSnapshot` before/while claiming
`"paused"`, and a fresh page load's `VmController` starts at `"stopped"`,
never `"paused"`, so there is no code path that calls `resume()` without
either a live `emulator` or a snapshot from this same session) — the
`onError` call is defensive, in case a future task's persistence of
`state` itself makes it reachable.

## Covering test: `verify-vmc.mjs` "Phase 2: autosave coherence"

Extended the same driver (not a new variant file — this exercises the same
`VmController` class and check page as Phase 1, not a different boot
stage) with a second phase that reproduces exactly the scenario review
asked for: autosave, further writes, destroy WITHOUT `stop()`, `start()`.

`dev/vm-controller-check.html` gained `window.makeController(id, label)`,
so the driver can construct independent `VmController` instances in the
same page (the original flat `window.vmc`/`phases`/`errors`/`states` stay
as aliases into `controllers.main`, so Phase 1 is unchanged).

Phase 2 sequence, all against a second instance id (`vmc-check-2`, isolated
from Phase 1's `vmc-check-1`):
1. `start()`, wait for `onPhase("network")`.
2. Call `vmc._autosaveTick()` directly — the same method the real 5-minute
   timer invokes — to exercise the coherent-snapshot path without a real
   5-minute wait. Assert no `onError` fired and a non-trivial snapshot was
   persisted.
3. Wait for `onPhase("luks")` — the guest keeps running and writing
   (LUKS format + `mkfs.btrfs` is disk-write-heavy) well past the autosave
   point, exactly the "further writes" step review asked for.
4. `vmc.emulator.destroy()` directly (bypassing `VmController.stop()`,
   which would itself save first) — the "destroy WITHOUT stop" simulated
   crash. Nothing written since step 2's autosave is preserved in any
   snapshot.
5. `makeController` a **fresh** `VmController` over the *same* instance id
   (`vmc-check-2`) — exactly what a real page reload would construct — and
   `start()` it.
6. Assert: `start()` resolves (no exception, `emulator-ready` fired),
   `onPhase("luks")` fires again within 90s (the restored CPU state is from
   *before* `luks` was reached the first time, so it must reach that point
   again on its own — proving genuine, correct continuation, not a stuck or
   corrupted restore), and zero `onError` calls throughout.

Representative run (`node verify-vmc.mjs`, both phases in one process):

```
PHASE 1 (pause/resume): OK
--- Phase 2: autosave coherence ---
[+3.9s] coherence: start() resolved
[+9.1s] coherence: onPhase("network") fired
[+9.3s] coherence: autosave tick completed (CPU halted for the snapshot, then resumed)
[+9.4s] coherence: snapshot after autosave tick: 91935180 bytes
coherence: errors after autosave tick (want none): []
[+9.7s] coherence: onPhase("luks") fired post-autosave (guest kept writing past the snapshot point)
[+9.7s] coherence: emulator destroyed WITHOUT stop() (simulated crash)
[+9.8s] coherence: restored controller's start() resolved
[+19.9s] coherence: restored controller reached onPhase("luks") again — coherent continuation confirmed
coherence: restored phases: ["luks"]
coherence: restored states: ["starting","running"]
coherence: restored errors (want none): []
PHASE 2 (autosave coherence): OK
VERDICT: VMC OK
```

Two consecutive full runs (both phases) passed identically; total wall
time ~20s each, well inside budget. Phase 1's own asserts (network phase,
pause/resume round trip, snapshot size) are unchanged and still pass —
confirmed both are green in the same run, not just Phase 2.

## How to reproduce

```
cd deploy/selfhost-web/dev
node verify-vmc.mjs
```
Expect `VERDICT: VMC OK`, both `PHASE 1 (pause/resume): OK` and
`PHASE 2 (autosave coherence): OK`, the marker/state timelines shown above,
and non-zero `snapshot persisted`/`snapshot after autosave tick` byte
counts (tens of millions, not 0, not anywhere near 2 GiB). Requires
`../vendor/{libv86.js,v86.wasm,seabios.bin,vgabios.bin}` and
`../boot/{vmlinuz,initramfs.img}` to already exist (vendored/built by this
task and Task 4 respectively, both committed) and Go available to build the
relay (same as every other `verify-*.mjs` in this directory).

---

# Task 15 — `sw.js` bridge / dashboard access (DECISION GATE — timeboxed spike)

## Spike verdict: **FALLBACK** — wisp precludes the JS-side "connect into the guest" path

v86 ships **two entirely separate JS-side TCP-into-guest surfaces**, and
only one of them is reachable from the network backend this project already
committed to (Task 3's decision gate: `wisp://` against `multica-relay`,
required for the guest's own real internet access — DHCP/DNS/`apk update`).
Evidence, all read from the vendored source (`dev/node_modules/v86/`, this
task's ground truth per the brief):

1. **`FetchNetworkAdapter` (the `fetch` backend) exposes `.connect(port)`
   and `.tcp_probe(port)`** — `dev/node_modules/v86/build/libv86-debug.js:
   3911-3915`:
   ```js
   FetchNetworkAdapter.prototype.connect = function(port) {
     return fake_tcp_connect(port, this);
   };
   FetchNetworkAdapter.prototype.tcp_probe = function(port) {
     return fake_tcp_probe(port, this);
   };
   ```
   `fake_tcp_connect$$module$src$browser$fake_network$$` (defined at
   `libv86-debug.js:3656`) is exactly the "JS-side guest-listener" API the
   brief asked about: it lets *this page's JS* open a connection to a
   `dport` on the guest's simulated network, as if a peer on the router's
   subnet dialled in — the shape a Service Worker would need to forward
   `fetch()` calls into the guest's port 3000.
2. **`WispNetworkAdapter` (the backend this project actually uses) has no
   such method at all.** Its full prototype surface —
   `libv86-debug.js:4088-4194` — is `register_ws`, `send_packet`,
   `process_incoming_wisp_frame`, `send_wisp_frame`, `destroy`,
   `on_tcp_connection`, `send`, `receive`. No `connect`, no `tcp_probe`.
   `on_tcp_connection` (`libv86-debug.js:4174-4190`) is the closest thing
   present, but it runs in the *other* direction: it fires when the
   **guest** initiates an outbound TCP connection, and its job is to issue
   a WISP `CONNECT` frame to the relay so the guest can reach a real
   internet host — `hostname:packet.ipv4.dest.join("."), port:conn.sport`.
   There is no code path anywhere in `wisp_network.js` that lets the *page*
   originate a connection toward the guest.
3. **v86 supports exactly one active network backend per emulator, chosen
   exclusively by the single `net_device.relay_url`'s URL scheme** —
   `libv86-debug.js:6151-6153`: the constructor does
   `"fetch" === relay_url ? new FetchNetworkAdapter(...) : ... :
   relay_url.startsWith("wisp://") || relay_url.startsWith("wisps://") ?
   new WispNetworkAdapter(...) : new NetworkAdapter(...)` and assigns the
   result to a single `this.network_adapter` field (confirmed no
   multi-adapter/array form exists in the public options either —
   `v86.d.ts:595`, `net_device?: V86NetworkDevice`, a single object, not an
   array). Running `fetch` and `wisp` simultaneously for one guest — e.g. a
   second, dashboard-only NIC — is not something v86 exposes a way to do;
   this is exactly the "a second `net_device` is not possible" the brief
   already flagged, now confirmed against the actual constructor logic
   rather than assumed.
4. `emulator.network_adapter` is not part of the public API at all — absent
   from `v86.d.ts`'s `V86` class member list (`v86.d.ts:623-903`, no
   `network_adapter` getter/method). It happens to survive property-name
   mangling in the production build too (`grep -c network_adapter
   vendor/libv86.js` → 2 occurrences, same as the debug build), so it is
   technically reachable as `emulator.network_adapter.connect(...)` if the
   active adapter were `FetchNetworkAdapter` — but reaching into an
   undocumented internal field is a second reason (beyond point 3) not to
   lean on it even if the backend question were reversed.

**Conclusion:** switching this project's guest network backend from
`wisp://` to `fetch` would gain the JS-side guest-TCP-connect API this task
wants, but would break the guest's real internet access that Task 3's own
decision gate already proved necessary and working (DHCP + DNS-by-hostname
+ `apk update`, none of which the `fetch` backend is designed for — it
translates *guest-initiated* HTTP-shaped connections on port 80 into a
browser `fetch()`, not general outbound TCP). Running both is not an option
v86 exposes. So: **honest answer is fallback, not primary** — the Service
Worker (`sw.js`) forwarding fetches into the guest's port 3000 is not
buildable against this project's actual network configuration. `sw.js` is
consequently **not created** by this task; there is nothing for it to do
that the chosen `wisp://` backend can service.

## What ships instead

- **`VmController.httpRequest(path)`** (`js/vm-controller.js`) — a
  serial-driven health check, exactly per the brief's fallback: it types a
  `curl` command over the ttyS0 root shell (`guest/provision.sh` sets
  `ttyS0::respawn:/bin/sh` — see this file's "Task 8" section) and scans
  the reply for an HTTP status code. Not a general HTTP client — no
  headers, no body, just "does the guest answer on :3000 and with what
  status". Implementation notes:
  - Adds a `_serialWatchers` `Set` to `VmController`, fed from the same
    `_onSerialByte` hook that already feeds marker-scanning and the public
    `onSerial` callback — deliberately a *separate* channel from
    `onSerial`, because `js/console.js`'s `attachConsole` swaps
    `vmController.onSerial` wholesale while the console drawer is open
    (see `console.js`'s doc comment); a health check must keep working
    independent of whether the user happens to have the console drawer
    open at the same time.
  - Builds a per-call random token and sends
    `` STATUS=$(curl -s -o /dev/null -m 5 -w '%{http_code}' 'http://127.0.0.1:3000<path>'); echo <token>HC_$STATUS `` ,
    then watches for `/<token>HC_(\d{3})/` in the accumulated serial
    output. Unlike Task 3's `NET_UP`/`APK_NET_OK` split-marker trap (this
    file's "Task 3" section), **no split-marker trick is needed here**: the
    ttyS0 shell echoes the *typed* command back verbatim before it runs,
    and the typed line contains `$STATUS` (a literal dollar sign, not yet
    substituted) immediately after `HC_` — the echo can never match
    `\d{3}` right after `HC_` no matter what, only the shell's real
    executed output (after variable substitution) can. Documented inline
    in `vm-controller.js` so a future editor doesn't "fix" this by adding
    an unnecessary split.
  - Status `"000"` (curl's own sentinel for "never got an HTTP response" —
    connection refused/timeout) is treated as `ok: false`; any real
    `1xx`-`5xx` code is `ok: true` with that status. Guarded on
    `state === "running"` — returns `{ok:false, error:"not-running"}`
    immediately, no serial traffic, otherwise.
  - `parseHealthCheckLine(buf, token)` is factored out as a standalone
    exported pure function specifically so `tests/vm-controller.spec.mjs`
    can exercise the token/regex logic without booting v86 — see "Spec
    coverage" below.
- **Open Dashboard → a documented instructions panel**, not a new tab
  (`js/ui.js`, `selfhost.html`). Replaces Task 14's `data-configure-me`
  placeholder with `data-action="dashboard"`, wired through the same
  `[data-action]` delegation `onCardAction` already uses for
  play/pause/stop/console. The panel:
  - States the technical reason plainly (this section's verdict, in
    user-facing language) instead of a silent dead button.
  - Has a **Run health check** button wired to `VmController.httpRequest("/")`
    — the *only* thing this task can prove is reachable from JS, so it is
    surfaced directly rather than only existing as an internal API.
  - Documents the one thing that does still work today: **View Console**
    (already wired, Task 14) gives a root shell on ttyS0, from which
    `curl localhost:3000`, `rc-status`, etc. all work directly against the
    guest — slower than a browser tab, but real. A true "browser tab
    pointed at the dashboard" additionally requires a TCP path from the
    *user's own machine* into the guest's simulated network, which
    `deploy/selfhost-web/relay` does not provide today — `relay/main.go`
    /`relay/wisp.go` only implement the WISP `CONNECT`-outbound direction
    (dialling *out* on the guest's behalf), never a reverse/bind listener.
    Flagged as explicit follow-up work in the panel copy, not silently
    implied.

## Spec coverage (per this task's own guidance — unit-testable parts only)

- `tests/vm-controller.spec.mjs` (new): `parseHealthCheckLine` matches a
  genuine `<token>HC_<3 digits>` occurrence and ignores a raw, unsubstituted
  `<token>HC_$STATUS` echo (the actual shape ttyS0 echoes back before the
  command runs) — proving the "no split-marker needed" claim above by
  direct example, not just by reasoning about it. Also constructs a real
  `VmController` (no `.start()`, so no v86/relay/IndexedDB-heavy boot) and
  asserts `httpRequest()` resolves `{ok:false, error:"not-running"}`
  synchronously against the `state === "stopped"` guard, with zero serial
  traffic sent (no `emulator`, so a bug here would throw, not silently
  pass).
- `tests/ui.spec.mjs` (extended): dashboard button now carries
  `data-action="dashboard"` (was `data-configure-me`) and still gates on
  phase `ready` exactly as Task 14 proved (existing assertions updated, not
  weakened); clicking it opens `#dashboard-panel` with the instance's name
  in the title, independent of any live VmController/v86 boot — mirrors how
  Task 14's own View-Console assertion opens the console drawer without
  booting v86.

## End-to-end verification against a REAL provisioned instance

Per this task's own instruction ("For the primary mode this needs a REAL
provisioned instance... you know the drill"), and since the fallback panel's
**health check** claim ("the guest really is reachable over ttyS0") is only
meaningfully proven against a live, fully-provisioned guest, not a stub —
ran the real thing rather than only the DOM-level specs above.

New harness: `dev/verify-dashboard.mjs`, closely modeled on
`dev/verify-firstboot.mjs` (LAN-IP `sh_release_url`, Range-aware static
server, relay on `:18086`) but driving the **actual shipped page**
(`selfhost.html`) through Playwright exactly as a visitor would, not a
lower-level harness page: fills in the creation form (name/PIN/disk
size/relay URL/passphrase), submits, clicks **Play**, waits for the Open
Dashboard button to become enabled (phase `ready`, same gating Task 14
already unit-tests), clicks it, and asserts:
1. `#dashboard-panel` becomes visible with the instance's name in the title.
2. Clicking **Run health check** inside the panel eventually shows
   `Reachable (HTTP 200)` — i.e. `VmController.httpRequest("/")` genuinely
   round-tripped a `curl` through the real ttyS0 shell of a guest that
   really did finish first-boot provisioning (Postgres + Go backend +
   Next.js frontend, per Task 8) and really is answering on port 3000.

Reused the already-built, already-verified artifacts from earlier tasks
(no rebuild needed): `boot/{vmlinuz,initramfs.img}` (Task 4),
`vendor/{libv86.js,v86.wasm,...}` (Task 9), and the local
`multica-selfhost-386.tar.gz` payload (Task 5 continuation's
`build-selfhost-tarball.sh` output, symlinked at
`dev/multica-selfhost-386.tar.gz`).

### Result

```
relay confirmed listening on :18086
[+0.0s] selfhost.html loaded, initSelfhostPage() resolved
[+0.2s] creation form submitted, instance card rendered
[+0.2s] Play clicked, controller.start() invoked
[+242.3s] Open Dashboard button enabled (phase: ready)
[+242.3s] #dashboard-panel visible, title "Dashboard — task15-dashboard"
[+247.8s] health check attempt 1: Not reachable (HTTP 0).
[+258.4s] health check attempt 2: Not reachable (HTTP 0).
[+268.9s] health check attempt 3: Not reachable (HTTP 0).
[+275.4s] health check attempt 4: Reachable (HTTP 200) — the frontend is answering on port 3000 inside the guest.
VERDICT: DASHBOARD FALLBACK OK
```

Total ~4 minutes to `ready` (242s — on the faster end of Task 8/9's
~220-330s range, this run's tarball fetch benefiting from the payload
already being warm on local disk), consistent with those tasks' own
first-boot timing.

**A real, reproducible finding, not a fluke:** the *first three* health
checks, run back to back right after the Open Dashboard button became
enabled, all got curl's `000` ("no HTTP response") — not `Reachable` until
the 4th attempt, ~28s after `ready`. This is not a bug in `httpRequest()`,
in the `curl` command, or in the `ready` marker itself — it's a genuine gap
between two different readiness signals:
- `ready` fires as soon as `nc -z 127.0.0.1 3000` sees the **TCP listener
  bound** (`guest/provision.sh`'s `ready-marker.start`, this file's "Task 8"
  section already flagged the analogous gap for `:8080`/the backend).
- `next start`'s standalone server can accept the TCP connection slightly
  before it's actually ready to answer a **full HTTP request** on it —
  under 386 emulation, "slightly" here measured as up to ~28s in this run.

Confirmed via the raw ttyS0 transcript captured while debugging this (each
`000` was a real, prompt curl reply — not a hang, not a timeout, not a
parsing bug in `parseHealthCheckLine`):
```
~ # [6n@@SH:phase:ready@@
STATUS=$(curl -s -o /dev/null -m 5 -w '%{http_code}' 'http://127.0.0.1:3000/
'); echo Hmswyoq562jlvHC_$STATUS
Hmswyoq562jlvHC_000
~ # [6n...
Hmswypej36deaHC_200
```
(The mid-line wrap after `3000/` is the guest's own 80-column console
display wrap on a long echoed input line — cosmetic, not a real injected
newline; confirmed the shell still executed each line as one command, per
the real `curl` output that follows each one.)

**Fix applied to `httpRequest()` along the way:** its internal timeout
started at 8000ms (matching nothing in particular) and was bumped to
20000ms after this script's *first* run failed at a **different**
problem — `page.waitForFunction`'s call signature is `(fn, arg, options)`,
not `(fn, options)`; the verification script's own bug, passing the options
object as `arg`, silently fell back to Playwright's default 30s action
timeout instead of the intended long wait for `ready`. Fixed in
`verify-dashboard.mjs` (now passes `undefined` explicitly for `arg`). The
20000ms `httpRequest()` bump is a real, independent improvement — a 386-
emulated guest's very first ttyS0 command after a fresh boot deserves more
headroom than 8s — but it was **not** what fixed the `000`s above (each
`000` above came back in a few seconds, well under even the old 8s limit;
retrying is the only thing that helps here, not waiting longer per attempt).

**No shipped-code change from this finding beyond the timeout bump** — a
manual "Run health check" button is expected to reflect exactly this kind
of transient window truthfully (a user who clicks right as the phase bar
hits "ready" and sees "Not reachable" is seeing something real, and the
obvious next action — click again — works, proven above). Recorded here so
a future reader doesn't mistake the first few `000`s in a fresh run's
console log for a regression.

## How to reproduce

```
cd deploy/selfhost-web/dev
node verify-dashboard.mjs
```
Expect `VERDICT: DASHBOARD FALLBACK OK`. Takes several minutes (a real
first boot, per Task 8/9's own timing notes) — not a quick check. Requires
the same artifacts `verify-firstboot.mjs` requires: `../boot/*`,
`../vendor/*`, and a locally built `../dev/multica-selfhost-386.tar.gz`
symlink (Task 5 continuation's `build-selfhost-tarball.sh` output).

For the fast, no-VM specs: `cd deploy/selfhost-web && node
tests/run-tests.mjs tests/vm-controller.spec.mjs tests/ui.spec.mjs` (or no
args, to run the full default suite).

## Task 15 fix — console/health-check serial mutual exclusion (post-review finding)

Review caught a real gap: `js/console.js`'s `attachConsole` wires the xterm
terminal's `term.onData` straight to `vmController.sendToConsole()` **per
keystroke**, and `httpRequest()` (above) writes its own full command
through that exact same ttyS0 channel via the same `sendToConsole`. Nothing
originally stopped both being active at once — a user mid-typing an
unterminated shell command in the console drawer who clicked "Run health
check" would get the health-check command silently appended onto their
partial input, corrupting both (the console command runs garbled, and the
health check then just sits waiting for its own marker until it times out,
since the marker was never actually issued as a clean line).

**Fix: UI-level exclusion (chosen over serial-level flushing).** A
serial-level fix (e.g. `httpRequest()` first sending a lone `\n` to flush
whatever partial line exists) was considered and rejected: it would still
silently execute the user's partial command as garbage right before the
health check, just with a cleaner failure mode — not actually honest about
what happened, and it does nothing for the symmetric worry of the
console's *display* getting the health check's output spliced into
whatever the user was about to see. UI-level exclusion is more honest: the
health check is simply unavailable while there's any chance of unflushed
console input, with a visible reason instead of a silent, best-effort
patch-up.

Implementation (`js/ui.js`):
- `syncDashboardHealthcheckAvailability(els)` — disables
  `#btn-dashboard-healthcheck` and shows `#dashboard-healthcheck-hint`
  ("Close the console to run a health check…") whenever
  `#console-drawer` is not hidden; re-enables/hides otherwise. Called from
  `openConsoleDrawer`, `closeConsoleDrawer`, and `openDashboardPanel` — all
  three orderings (open dashboard then console, open console then
  dashboard, console already open when dashboard opens) converge on the
  same computed state, since it's derived fresh from
  `els.consoleDrawer.hidden` each call rather than tracked as separate
  mutable flags that could drift out of sync with each other.
- `runDashboardHealthcheck` re-checks `els.consoleDrawer.hidden`
  **defensively, inside the handler**, before doing anything else — not
  just relying on the `disabled` attribute stopping real clicks. A
  disabled button's real DOM `click()` is a no-op in browsers, so this
  specifically guards a *programmatic* click that bypasses `disabled`
  (proven directly in the spec below) and any theoretical race between the
  drawer opening and an already-in-flight click event.
- **Deliberately NOT guarded: opening the console while a health check is
  already in flight.** `httpRequest()` always sends one complete,
  newline-terminated command in a single `sendToConsole()` call — there is
  never a "partial, unsent" health-check line for the user's subsequent
  typing to land in the middle of. The only residual effect is the health
  check's own reply appearing interleaved into the console's *displayed*
  output if the user opens the drawer during that window — a cosmetic
  nuisance (same category as any two processes writing to one console),
  not input corruption, and out of scope for this fix.

Spec coverage (`tests/ui.spec.mjs`, in the same live-DOM flow the rest of
Task 15's dashboard-panel test already uses — no v86 boot): asserts the
health-check button starts enabled/hint-hidden, opens the console drawer
and asserts it becomes disabled with the hint visible, force-enables it and
clicks it anyway (bypassing `disabled`) and asserts the result text stays
empty (defensive re-check caught it — proof it didn't just *look* blocked),
then closes the drawer and asserts it re-enables/hint-hides again, before
proceeding to the existing "not-running" health-check assertion. Full
suite (`node tests/run-tests.mjs`) green, including this new coverage.

**Ledgered, not fixed here (per review's own triage — skip unless
touched):** `_serialWatchers` isn't explicitly cleared on `stop()`/`destroy()`
(self-cleans: each watcher removes itself via its own `finish()`, and its
`setTimeout` still fires and cleans up even if the emulator is gone by
then — no leak, just not proactively cleared early); the `dev/NOTES.md`
cross-reference in the shipped `#dashboard-panel` copy assumes a reader
with repo access, which isn't guaranteed for a visitor on the deployed
GitHub Pages site (the *reasoning* is still given in-panel either way, the
NOTES.md pointer is "for more detail," not load-bearing); one citation in
this file's earlier "Spike verdict" section may be off by one line versus
the exact vendored source line — none of these change this task's
verdict or shipped behavior, left as-is.

# Task 17 fix — rolling `selfhost-latest` release channel (post-review finding)

## Problem: repo-wide "latest" is contended between two release streams

`selfhost-release.yml` (Task 17) publishes on `selfhost-vX.Y.Z` tags;
`release.yml` (pre-existing, unrelated to this plan) publishes on plain
`vX.Y.Z` tags via GoReleaser and ships no selfhost artifacts at all.
GitHub's "latest release" designation is **repo-wide** — there is exactly
one — so three consumers that all resolved their download URL against
`.../releases/latest/download/<asset>` were silently racing that ordinary
app release for it:

- `relay.sh` / `relay.ps1` (Task 16) — default `MULTICA_RELAY_URL_BASE`.
- `js/vm-controller.js`'s `RELEASE_URL` default (Task 11) — the tarball
  the guest's `sh_release_url` kernel cmdline param points at.

Whichever tag most recently pushed with `make_latest` unset (GitHub's own
default is effectively "latest" for the newest non-prerelease release)
would claim the slot. In practice `release.yml`'s ordinary app releases
are expected to be far more frequent than `selfhost-v*` tags, so the
realistic failure mode is: an app release ships, "latest" moves to it, and
every relay/tarball download 404s immediately after — a silent, delayed
break with no connection to whatever selfhost-related change actually
triggered it.

## Fix: a second, rolling release at a fixed tag

`selfhost-release.yml` now publishes **two** releases per `selfhost-v*`
tag push, both with `make_latest: false` (so neither one can ever become
the repo's one "latest" release) and both `fail_on_unmatched_files: true`
(a missing asset fails the job rather than quietly shipping short):

1. **`selfhost-vX.Y.Z`** (the pushed tag) — an immutable, versioned
   snapshot, exactly as before.
2. **`selfhost-latest`** (a fixed tag, force-updated every run) — the
   actual download channel. `softprops/action-gh-release` updates
   (doesn't duplicate) a release whose tag already exists, and — per its
   own documented default (`overwrite_files: true`) — deletes/replaces any
   asset whose filename already exists in that release. Re-running the
   same "publish to `tag_name: selfhost-latest`" step on every
   `selfhost-v*` tag push therefore moves the tag to the new commit and
   clobbers all 8 assets with the fresh build — a standard "rolling
   release" / "continuous delivery" pattern, distinct from GitHub's own
   repo-wide "Latest release" concept.

Both jobs share one `RELEASE_FILES` job-level env block (8 paths: the
tarball, 5 relay binaries, `boot/vmlinuz`, `boot/initramfs.img`) so the
two publish steps can never drift apart from each other.

All three consumers now point at
`https://github.com/VerusFi/multica/releases/download/selfhost-latest/<asset>`
by default (`MULTICA_RELAY_URL_BASE` / `window.SELFHOST_RELEASE_URL`
overrides unchanged) — a URL immune to `release.yml`'s app releases,
because it names an explicit tag rather than asking GitHub to resolve
"latest".

## Why not just set `make_latest: true` only on `release.yml`'s job instead

Considered and rejected: that only fixes the *current* contention, not the
underlying one-slot-per-repo constraint — any future workflow that forgets
to pin `make_latest: false` (or a manual release published through the
GitHub UI, which defaults to "set as latest") silently re-breaks both
`relay.sh`/`relay.ps1` and the guest tarball URL again, with no error at
publish time. Pinning every selfhost consumer to an explicit, repo-owned
tag name removes the shared mutable state entirely instead of relying on
every future release staying disciplined about a flag.

## Verification

- `shellcheck deploy/selfhost-web/relay.sh` — clean (0 issues, same as
  Task 16's original validation).
- End-to-end re-run of Task 16's local test (`MULTICA_RELAY_URL_BASE`
  override against a local `python3 -m http.server`): binary downloaded
  (7.9M), `wisp://localhost:8086` printed, service listened, `curl -v
  http://localhost:8086/` returned `HTTP/1.1 426 Upgrade Required` with an
  `Upgrade: websocket` header — identical result to Task 16's original
  run, confirming the URL-base edit didn't change runtime behavior when
  overridden (as expected — the change is only to the *default*).
- `node tests/run-tests.mjs` (deploy/selfhost-web) — all 4 specs PASS,
  exit 0, no regression from the `RELEASE_URL` default-string change in
  `js/vm-controller.js`.
- `docker run --rm -v "$PWD:/repo" rhysd/actionlint:latest -color
  /repo/.github/workflows/selfhost-release.yml
  /repo/.github/workflows/selfhost-pages.yml` — clean.

---

# Task 19 — README, manual E2E checklist, slow first-boot smoke

## `tests/smoke-firstboot.mjs` — one real end-to-end run

Same relay-build-and-spawn / static-server / LAN-IP-for-`SELFHOST_RELEASE_URL`
plumbing as the `dev/verify-*.mjs` scripts (see the Task 3/8/15 sections
above), but — unlike `dev/verify-firstboot.mjs`, which drives a bare test
harness — this drives the REAL shipped `selfhost.html` through Playwright
(real creation form, real Play button), same approach as
`dev/verify-dashboard.mjs`, and stops once phase `ready` is reached (no
dashboard-panel/health-check assertions — out of scope for this task, and
already covered by Task 15's own verification). Phase progression is
observed via a `MutationObserver` over the real DOM (`js/ui.js`'s
`[data-testid="phase-progress"]` element), not a reimplemented serial-log
watcher, since the phase text is genuinely user-visible UI, not test-only
plumbing.

One full run against the already-built local artifacts (boot/, vendor/,
and the existing `/tmp/multica-selfhost-386.tar.gz` payload — none
regenerated for this task, all reused as-is):

```
host LAN IP for SELFHOST_RELEASE_URL: 192.168.1.179
relay confirmed listening on :18086
[+0.0s] selfhost.html loaded, initSelfhostPage() resolved
[+0.2s] creation form submitted, instance card rendered
[+0.2s] Play clicked, controller.start() invoked
[+228.3s] Open Dashboard button enabled (phase: ready)
phase timeline observed via DOM: [{"text":"network (14%)","t":3140},{"text":"luks (29%)","t":3359},{"text":"install (43%)","t":5795},{"text":"download (57%)","t":60446},{"text":"initdb (71%)","t":135256},{"text":"services (86%)","t":205270}]
sawNetwork=true phasesInOrder=true dashboardEnabled(readyGate)=true
VERDICT: SMOKE OK — instance created against a real local relay and reached ready
```

~3.8 minutes wall clock to `ready` on this machine (all assets local,
no real internet latency for the payload download or CDN fetches) —
faster than the README's stated 6-8 minute budget, which is written for a
visitor's machine loading everything over the real internet from GitHub
Pages; consistent with the same "don't assume this machine's numbers hold
elsewhere" caveat recorded for every earlier boot-timing measurement in
this file (Task 3's numbers table, Task 8's "how to reproduce" section).
`network`/`luks` land within ~3.5s of each other (matches Task 6's LUKS
timing), `install`→`download` is the ~55s apk-package-install stretch,
`download`→`initdb` is the ~75s tarball fetch+extract+offline-vips-install,
`initdb`→`services` is the ~70s migration run, and `services`→`ready` is
the final ~23s Next.js standalone server startup — all consistent with the
per-stage numbers already recorded in the Task 6-8 sections above.

Cleanup confirmed after the run: `lsof -i :18086 -i :18123` empty, no
leftover `multica-relay`/`smoke-firstboot` processes — the script's
`finally` block (browser close, static server close, `relay.kill()`) left
nothing behind.

## Full test sweep (Step 3)

```
cd deploy/selfhost-web/relay && go test ./...          # ok, 0.230s
cd deploy/selfhost-web && node tests/run-tests.mjs      # 4/4 PASS (vault, instance-manager, vm-controller, ui)
pnpm --filter web lint                                  # 0 errors, 1 pre-existing warning (login/page.tsx, react-hooks/exhaustive-deps — same one Task 18 disclosed, untouched by this task)
```

## Manual E2E checklist — design note

`js/vm-controller.js`'s `_start()`/`_stop()` both always persist a snapshot
before tearing down (see the `_stop`/`_resume` doc comments in that file),
so there is no path through the shipped UI alone — short of manually
deleting only the `snapshots` IndexedDB store via devtools while leaving
`blocks` intact — that forces a genuine from-empty-RAM cold LUKS re-unlock
after the very first boot; `Stop` then `Play` again is a warm
`initial_state` restore, same category as `Pause`/`Resume`, just via a
freshly-constructed `VmController` object with no live emulator carried
over. The README's checklist step 9 ("cold restart with passphrase") is
worded to test exactly what IS provable through the real UI — that the
disk passphrase is never re-typed by the user on that path either, it
flows automatically from the PIN-unlocked vault — and it points at
`dev/verify-firstboot.mjs`'s own cold-boot step (a real disk-blocks-only,
no-snapshot restore) as the place the stronger, from-scratch claim is
already proven at the engineering level.
