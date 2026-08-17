// v86 lifecycle controller for a single selfhost instance: boots the Alpine
// guest under v86 (see dev/NOTES.md "Task 6"/"Task 8" for the pinned v86 API
// forms this file follows), parses the @@SH:phase:*@@ / @@SH:err:*@@ marker
// protocol off the serial console, delivers the LUKS passphrase over ttyS1,
// and persists the guest disk plus VM snapshots via Task 10's
// instance-manager.js (IndexedDB) so an instance survives a page reload.
// Task 15 adds httpRequest(): a serial-driven curl health check, the
// documented fallback for dashboard access — see dev/NOTES.md "Task 15"
// for the spike verdict on why the JS-side guest-TCP-connect path isn't
// available here.
//
// V86 itself is loaded as a classic (non-module) <script src="vendor/libv86.js">
// by the host page before this module runs; it is used here as the global
// `V86` constructor, per libv86.js's own UMD-style build (it is not an ES
// module — vendor/libv86.mjs exists in the upstream package but is not what
// this task vendors).

import { BlockStore, saveSnapshot, loadSnapshot } from "./instance-manager.js";

// Production default points at the real release artifact. A dev/check page
// can override it by setting window.SELFHOST_RELEASE_URL before this module
// loads. Per dev/NOTES.md "Task 8" ("Interface note: sh_release_url must use
// the host's real LAN IP"), whatever ends up here is dialled by the relay on
// the *host* side, not resolved in the browser or the guest — a relative
// URL, blob: URL or "localhost" cannot work from a real deployment, so that
// resolution is entirely the caller/dev-page's concern, not this module's.
//
// Pinned to the rolling `selfhost-latest` release tag, not
// `releases/latest/download` — this repo's GitHub "latest release" is
// claimed by the ordinary vX.Y.Z app releases (release.yml), which publish
// no selfhost tarball at all; a plain "latest" URL here would 404 every
// guest boot. See dev/NOTES.md ("rolling selfhost-latest release channel").
const RELEASE_URL =
  window.SELFHOST_RELEASE_URL ??
  "https://github.com/VerusFi/multica/releases/download/selfhost-latest/multica-selfhost-386.tar.gz";

// 1 GiB, not the 512 MiB earlier harnesses used — see dev/NOTES.md "Task 8"
// ("Interface note: memory_size must be 1 GiB"): a provisioned instance runs
// Postgres + the Go backend + a Next.js standalone server all resident at
// once, and 512 MiB starves that (verified there via a stuck cold boot).
const MEMORY_SIZE = 1024 * 1024 * 1024;

const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

// Chars of serial output kept around for marker scanning. Markers are short
// (`@@SH:phase:\w+@@`, `@@SH:err:` + a short slug + `@@`); this is generous
// headroom, not a tuned limit — see _scanMarkers.
const MARKER_WINDOW = 512;

const PHASE_RE = /@@SH:phase:(\w+)@@/g;
const ERR_RE = /@@SH:err:(.+?)@@/g;

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

// Chars of serial output a single httpRequest() call scans for its own
// marker. Same generous-headroom reasoning as MARKER_WINDOW above, kept as
// a separate constant (rather than reusing MARKER_WINDOW) since this scans
// a per-call local buffer, not the shared marker-scanning one.
const HEALTHCHECK_WINDOW = 512;

// Extracts an `httpRequest()` health-check result out of a chunk of raw
// ttyS0 serial output, or null if the marker hasn't appeared (yet).
//
// Factored out as a standalone, exported pure function (no VmController/
// emulator involved) specifically so it can be spec-tested directly — see
// dev/NOTES.md "Task 15" ("Spec coverage") for why this needs no
// split-marker trick, unlike the boot-phase markers this file's Task 3
// section documents: the raw *typed* command line this pairs with always
// contains a literal `$STATUS` (unsubstituted) right where the regex below
// requires 3 digits, so an echoed-but-not-yet-executed command can never
// false-match this pattern — only genuine command output (after the shell
// substitutes `$STATUS`) can.
export function parseHealthCheckLine(buf, token) {
  const m = new RegExp(`${token}HC_(\\d{3})`).exec(buf);
  if (!m) return null;
  const status = Number(m[1]);
  // curl's own sentinel for "never got an HTTP response at all" (connection
  // refused, timed out, etc.) — anything else is a real status line, even a
  // 4xx/5xx, which still proves the guest answered.
  return { ok: status !== 0, status };
}

// A v86 "loadable" disk backed by Task 10's BlockStore (IndexedDB) instead
// of an HTTP file, so every write an instance's guest makes to its disk
// survives a reload.
//
// Why this shape and not one of v86's documented disk options: v86's public
// `V86Image` union (node_modules/v86/v86.d.ts:12-76, three forms —
// `V86AsyncFileImage`, `V86SyncFileImage`, `V86BufferImage`) has no
// "persist writes somewhere durable" option. Its own async-file backend
// (`AsyncXHRBuffer`, node_modules/v86/build/libv86-debug.js:666-751) reads
// over HTTP Range on demand but caches writes only in an in-memory `Map`
// that is discarded on reload (`this.block_cache`, never flushed back to
// the server) — exactly what dev/NOTES.md's Task 6 section documents using
// for the *stateless* harness disks, and exactly wrong for a page whose
// whole point is durable per-instance state. dev/NOTES.md's Task 8 section
// ("Finding: v86's restart() cannot reboot...") separately records that
// v86's option normalizer accepts an already-constructed loadable object
// directly, bypassing the V86Image union entirely, whenever it exposes
// `.get`/`.set`/`.load` — the exact branch is
// `libv86-debug.js:6180`: `if ($file.get && $file.set && $file.load) { ... }`.
// This class is that loadable, with BlockStore as the actual persistence
// layer instead of an in-memory cache:
// - `load()` resolves immediately; BlockStore needs no upfront fetch.
// - `get(offset, len, fn)` / `set(offset, data, fn)` are called by v86's IDE
//   layer (libv86-debug.js:9540, 9732, 9802) with byte offsets that are
//   sector-aligned (512 B) but not aligned to BlockStore's own block size —
//   both methods split/reassemble across BlockStore blocks accordingly.
//   Reads of a block that was never written return zeros (an absent/empty
//   block), which is what gives "empty disk" semantics with no
//   pre-provisioned image file anywhere.
// - `get_state()` / `set_state()` are the hooks v86's save_state/
//   restore_state call on any nested object that exposes them
//   (`save_object`, libv86-debug.js:2190-2191; concretely for a disk,
//   `IDEInterface.prototype.get_state` at libv86-debug.js:9846 stores
//   `this.buffer` — the loadable itself — and `set_state` at 9873 calls
//   `this.buffer.set_state(...)` on that *same, already-existing* object
//   rather than reconstructing it from the snapshot). They are no-ops here
//   on purpose: BlockStore already persists every write the instant it
//   happens, independent of whether or when a VM snapshot is taken, so
//   there is nothing disk-shaped left to fold into the (much smaller)
//   CPU/device snapshot blob.
class BlockStoreDisk {
  constructor(blockStore, byteLength) {
    this.blockStore = blockStore;
    this.blockSize = blockStore.blockSize;
    this.byteLength = byteLength;
    this.onload = undefined;
  }

  async load() {
    this.onload && this.onload(Object.create(null));
  }

  get(offset, len, fn) {
    this._read(offset, len).then(fn);
  }

  set(offset, data, fn) {
    this._write(offset, data).then(() => fn());
  }

  get_state() {
    return [];
  }

  set_state(_state) {
    // Intentional no-op — see class comment above.
  }

  async _read(offset, len) {
    const bs = this.blockSize;
    const out = new Uint8Array(len);
    let pos = 0;
    while (pos < len) {
      const abs = offset + pos;
      const blockIndex = Math.floor(abs / bs);
      const blockOffset = abs - blockIndex * bs;
      const take = Math.min(bs - blockOffset, len - pos);
      const block = await this.blockStore.read(blockIndex);
      if (block) out.set(new Uint8Array(block, blockOffset, take), pos);
      pos += take;
    }
    return out;
  }

  async _write(offset, data) {
    const bs = this.blockSize;
    let pos = 0;
    while (pos < data.byteLength) {
      const abs = offset + pos;
      const blockIndex = Math.floor(abs / bs);
      const blockOffset = abs - blockIndex * bs;
      const take = Math.min(bs - blockOffset, data.byteLength - pos);
      const existing = await this.blockStore.read(blockIndex);
      const block = existing ? new Uint8Array(existing) : new Uint8Array(bs);
      block.set(data.subarray(pos, pos + take), blockOffset);
      await this.blockStore.write(blockIndex, block.buffer);
      pos += take;
    }
  }
}

// state ∈ "stopped" | "starting" | "running" | "paused"
export class VmController {
  constructor({ instance, passphrase, onPhase, onError, onSerial, onStateChange }) {
    this.instance = instance;
    this.passphrase = passphrase;
    this.onPhase = onPhase;
    this.onError = onError;
    this.onSerial = onSerial;
    this.onStateChange = onStateChange;

    this.state = "stopped";
    this.emulator = null;
    this.blockStore = new BlockStore(instance.id);

    this._passphraseSent = false;
    this._seenPhases = new Set();
    this._seenErrors = new Set();
    this._markerBuf = "";
    this._autosaveTimer = null;

    // Fed from the same _onSerialByte hook as marker-scanning and the
    // public onSerial callback, but deliberately a *separate* channel from
    // onSerial: js/console.js's attachConsole swaps `this.onSerial`
    // wholesale while the console drawer is open, so anything that must
    // keep working regardless of whether the console is attached (i.e.
    // httpRequest(), see below) cannot ride on onSerial. See dev/NOTES.md
    // "Task 15".
    this._serialWatchers = new Set();

    // Serializes every lifecycle operation that touches `this.emulator`
    // (start/pause/resume/stop and the autosave tick) so they can never
    // interleave — e.g. an autosave tick halting the CPU to snapshot it
    // while a concurrent pause() call also halts/snapshots/transitions
    // state. See dev/NOTES.md "Task 11" (autosave coherence) for the
    // failure mode this closes off.
    this._opLock = Promise.resolve();
  }

  _enqueue(fn) {
    const result = this._opLock.then(fn, fn);
    // Keep the chain alive regardless of outcome, without leaking a
    // rejection into whatever queues next.
    this._opLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  _setState(next) {
    this.state = next;
    this.onStateChange && this.onStateChange(next);
  }

  _resetSerialParsing() {
    this._passphraseSent = false;
    this._seenPhases.clear();
    this._seenErrors.clear();
    this._markerBuf = "";
  }

  _onSerialByte(byte) {
    // Passphrase delivery: write it to ttyS1 on the first serial output
    // byte seen after boot. This does not need to be synchronized to any
    // particular boot phase — the guest's tty layer buffers ttyS1 input
    // until init actually reads it during the LUKS stage (see dev/NOTES.md
    // "Task 6"), so sending it as soon as the emulator is demonstrably
    // alive is both simpler and safe.
    if (!this._passphraseSent) {
      this._passphraseSent = true;
      this.emulator.serial_send_bytes(1, new TextEncoder().encode(this.passphrase + "\n"));
    }

    const ch = String.fromCharCode(byte);
    this._markerBuf += ch;
    if (this._markerBuf.length > MARKER_WINDOW) {
      this._markerBuf = this._markerBuf.slice(-MARKER_WINDOW);
    }
    this._scanMarkers();
    for (const watcher of this._serialWatchers) watcher(ch);
    this.onSerial && this.onSerial(ch);
  }

  _scanMarkers() {
    PHASE_RE.lastIndex = 0;
    let m;
    while ((m = PHASE_RE.exec(this._markerBuf))) {
      if (!this._seenPhases.has(m[1])) {
        this._seenPhases.add(m[1]);
        this.onPhase && this.onPhase(m[1]);
      }
    }
    ERR_RE.lastIndex = 0;
    while ((m = ERR_RE.exec(this._markerBuf))) {
      if (!this._seenErrors.has(m[0])) {
        this._seenErrors.add(m[0]);
        this.onError && this.onError(m[1]);
      }
    }
  }

  _buildOptions(initialStateBuffer) {
    const opts = {
      wasm_path: "vendor/v86.wasm",
      memory_size: MEMORY_SIZE,
      bios: { url: "vendor/seabios.bin" },
      vga_bios: { url: "vendor/vgabios.bin" },
      bzimage: { url: "boot/vmlinuz" },
      initrd: { url: "boot/initramfs.img" },
      cmdline: `console=ttyS0,115200 sh_release_url=${RELEASE_URL}`,
      net_device: { type: "virtio", relay_url: this.instance.relayUrl },
      hda: new BlockStoreDisk(this.blockStore, this.instance.diskSizeGB * 1024 ** 3),
      uart1: true,
      autostart: true,
    };
    if (initialStateBuffer) opts.initial_state = { buffer: initialStateBuffer };
    return opts;
  }

  async _bindEmulator(emulator) {
    this.emulator = emulator;
    emulator.add_listener("serial0-output-byte", (b) => this._onSerialByte(b));
    await new Promise((resolve) => emulator.add_listener("emulator-ready", resolve));
  }

  // Cold boot if no snapshot exists; otherwise restore the last snapshot
  // (autosaved or from a prior pause()/stop()) via V86's own
  // `initial_state` construction path, which restores state and continues
  // (autostart:true) without this module driving restore_state itself.
  // Never emulator.restart() — see dev/NOTES.md "Task 8": for a
  // bzimage+initrd guest with no bootloader/MBR, restart() only redoes
  // load_bios() and panics (#GP) instead of reloading the kernel. A
  // "restart" here is always a fresh V86 instance over the same disk.
  //
  // All four public lifecycle methods (start/pause/resume/stop) and the
  // autosave tick run through `_enqueue` so they never interleave — see the
  // constructor comment and dev/NOTES.md "Task 11".
  async start() {
    return this._enqueue(() => this._start());
  }

  async pause() {
    return this._enqueue(() => this._pause());
  }

  async resume() {
    return this._enqueue(() => this._resume());
  }

  async stop() {
    return this._enqueue(() => this._stop());
  }

  // Tear down without persisting anything. Used when the instance itself is
  // being deleted (js/ui.js's delete flow): stop() would first write a fresh
  // snapshot into the very store that is about to be cleared, resurrecting
  // multi-GB of data the user just asked to reclaim.
  async discard() {
    return this._enqueue(async () => {
      this._stopAutosave();
      if (this.emulator) {
        try {
          if (this.state === "running") await this.emulator.stop();
          await this.emulator.destroy();
        } finally {
          this.emulator = null;
        }
      }
      this._setState("stopped");
    });
  }

  // Everything after the "starting" transition is wrapped: a rejection used
  // to leave the controller stuck in "starting" forever, which
  // instanceCardButtons renders as a card with no actionable button at all
  // (no play, no pause, no stop) and — before the host page grew an error
  // banner — no message either. On failure we return to "stopped" (so Play
  // is available again for a retry) and report through onError, which the
  // page surfaces visibly. Deliberately does NOT rethrow: onError is the
  // error surface now, and the click handlers that call start() have no
  // catch of their own, so rethrowing would only add an unhandled rejection
  // on top of an already-reported failure.
  async _start() {
    if (this.state !== "stopped") return;
    // Refuses rather than booting with a missing passphrase: _onSerialByte
    // sends `this.passphrase + "\n"` to ttyS1 unconditionally, so an
    // undefined/empty one would type the literal string "undefined" (or a
    // bare newline) at the guest's LUKS prompt — and on a first boot,
    // stage1_disk would *format* the disk with it. The host page also guards
    // this before constructing a controller (js/ui.js's
    // getOrCreateController); this is the same guard at the layer that
    // actually does the damage.
    if (typeof this.passphrase !== "string" || this.passphrase === "") {
      this.onError && this.onError("missing-passphrase: no disk passphrase available for this instance; refusing to start");
      return;
    }
    this._setState("starting");
    this._resetSerialParsing();

    try {
      const snapshot = await loadSnapshot(this.instance.id);
      const emulator = new V86(this._buildOptions(snapshot || undefined));
      await this._bindEmulator(emulator);
    } catch (err) {
      // Drop whatever half-built emulator we may have on the floor: a v86
      // instance that never reached "emulator-ready" still owns workers and
      // timers, and the next start() must build a fresh one.
      if (this.emulator) {
        try {
          await this.emulator.destroy();
        } catch {
          // Already broken; nothing useful to do with a teardown failure here.
        }
        this.emulator = null;
      }
      this._setState("stopped");
      this.onError && this.onError(`start-failed: ${errMessage(err)}`);
      return;
    }

    this._setState("running");
    this._startAutosave();
  }

  async _pause() {
    if (this.state !== "running" || !this.emulator) return;
    this._stopAutosave();
    await this.emulator.stop();
    const bytes = await this.emulator.save_state();
    await saveSnapshot(this.instance.id, bytes);
    this._setState("paused");
  }

  async _resume() {
    if (this.state !== "paused") return;
    const bytes = await loadSnapshot(this.instance.id);
    if (this.emulator) {
      // Same in-memory emulator pause() left alive (not destroyed) — restore
      // the persisted snapshot onto it (covers the case where it changed
      // since pause(), e.g. nothing here, but keeps one code path) and
      // continue.
      if (bytes) await this.emulator.restore_state(bytes);
      await this.emulator.run();
    } else {
      // No live emulator — e.g. resuming a "paused" instance after a page
      // reload. Rebuild one with initial_state set; V86's own construction
      // path restores state and continues (autostart:true) internally. A
      // "paused" instance with no persisted snapshot at all is unexpected
      // (pause()/the autosave tick always save before/while claiming that
      // state) — surface it rather than silently cold-booting.
      if (!bytes) {
        this.onError &&
          this.onError("resume-no-snapshot: no live emulator and no persisted snapshot found; cold-booting instead");
      }
      const emulator = new V86(this._buildOptions(bytes || undefined));
      await this._bindEmulator(emulator);
    }
    this._setState("running");
    this._startAutosave();
  }

  async _stop() {
    if (this.state === "stopped") return;
    this._stopAutosave();
    if (this.emulator) {
      if (this.state === "running") await this.emulator.stop();
      const bytes = await this.emulator.save_state();
      await saveSnapshot(this.instance.id, bytes);
      await this.emulator.destroy();
      this.emulator = null;
    }
    this._setState("stopped");
  }

  sendToConsole(text) {
    this.emulator && this.emulator.serial0_send(text);
  }

  // Serial-driven HTTP health check — the documented fallback for
  // "reach the guest's dashboard from JS", per dev/NOTES.md "Task 15"'s
  // spike verdict: v86's JS-side guest-TCP-connect API
  // (`network_adapter.connect()`/`.tcp_probe()`) exists only on
  // `FetchNetworkAdapter` (dev/node_modules/v86/build/libv86-debug.js:
  // 3911-3915), never on `WispNetworkAdapter` — what every instance here
  // actually uses (Task 3's decision gate) — and v86 supports exactly one
  // network backend per emulator (libv86-debug.js:6151-6153), so there is
  // no way to gain that API without giving up the guest's real internet
  // access. This types a `curl` health check over the ttyS0 root shell
  // (guest/provision.sh: `ttyS0::respawn:/bin/sh`) instead of opening a
  // real connection into the guest.
  //
  // Not a general HTTP client: no headers, no body, just "did the guest
  // answer on :3000, and with what status". Resolves (never rejects):
  // `{ok, status}` on a genuine reply (ok is false only for curl's own
  // "000" no-response sentinel), `{ok:false, error:"not-running"}` if
  // there's no live emulator to ask, or `{ok:false, error:"timeout"}` if
  // no reply marker appears within `timeoutMs`.
  httpRequest(path, { timeoutMs = 20000 } = {}) {
    if (this.state !== "running" || !this.emulator) {
      return Promise.resolve({ ok: false, error: "not-running" });
    }
    // Random per call so two concurrent/overlapping calls (or a stale
    // leftover watcher) can never cross-match each other's marker.
    const token = `H${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      let buf = "";
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._serialWatchers.delete(watcher);
        resolve(result);
      };
      const watcher = (ch) => {
        buf += ch;
        if (buf.length > HEALTHCHECK_WINDOW) buf = buf.slice(-HEALTHCHECK_WINDOW);
        const parsed = parseHealthCheckLine(buf, token);
        if (parsed) finish(parsed);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
      this._serialWatchers.add(watcher);
      this.sendToConsole(
        `STATUS=$(curl -s -o /dev/null -m 5 -w '%{http_code}' 'http://127.0.0.1:3000${path}'); echo ${token}HC_$STATUS\n`,
      );
    });
  }

  _startAutosave() {
    this._stopAutosave();
    this._autosaveTimer = setInterval(() => {
      this._enqueue(() => this._autosaveTick());
    }, AUTOSAVE_INTERVAL_MS);
  }

  // Coherent autosave: halt the CPU for the duration of the snapshot, same
  // as pause()/stop() already do, instead of calling save_state() on a
  // still-running emulator. See dev/NOTES.md "Task 11" ("autosave
  // coherence") for the full risk analysis — in short: without halting,
  // save_state() and the guest's own concurrent BlockStore writes race,
  // so the RAM snapshot produced may not correspond to any single instant
  // the guest's disk was actually in. Halting first makes every snapshot
  // (pause, stop, autosave alike) a genuinely coherent {RAM, disk} pair; a
  // crash between two such points just discards whatever happened after
  // the last one, exactly like an ordinary power loss — which the guest's
  // journaled filesystem (btrfs) and, once provisioned, Postgres's own WAL
  // are already designed to tolerate.
  //
  // Exposed as a regular (non-#-private) method deliberately: it is called
  // by the timer above via `_enqueue`, and dev/verify-vmc.mjs's coherence
  // check invokes it directly to exercise this path without waiting the
  // real 5-minute interval.
  async _autosaveTick() {
    if (this.state !== "running" || !this.emulator) return;
    let stopped = false;
    try {
      await this.emulator.stop();
      stopped = true;
      const bytes = await this.emulator.save_state();
      await saveSnapshot(this.instance.id, bytes);
    } catch (err) {
      // Surfaced via onError (distinguishable "autosave-failed:" prefix)
      // rather than only console.error: restore correctness depends on
      // autosaves actually landing, so the host page needs a way to warn
      // the user. The timer itself keeps running — one failed attempt
      // (e.g. a transient IndexedDB quota error) should not stop future
      // ones.
      this.onError && this.onError(`autosave-failed: ${errMessage(err)}`);
    } finally {
      if (stopped && this.emulator && this.state === "running") {
        try {
          await this.emulator.run();
        } catch (err) {
          this.onError && this.onError(`autosave-resume-failed: ${errMessage(err)}`);
        }
      }
    }
  }

  _stopAutosave() {
    if (this._autosaveTimer) {
      clearInterval(this._autosaveTimer);
      this._autosaveTimer = null;
    }
  }
}
