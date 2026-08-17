// Task 11 check: instantiates the REAL js/vm-controller.js VmController
// class (not a reimplementation) against the real vendored boot artifacts
// (vendor/, boot/) and a real multica-relay (built binary, port 18086 —
// same port choice as every other verify-*.mjs in this dir, see
// dev/NOTES.md "Task 3" re: 8086 already bound on this dev machine).
//
// Asserts onPhase("network") fires and a pause()->resume() round trip
// leaves `states` containing a genuine running -> paused -> running
// transition, with a real snapshot persisted to IndexedDB in between. Does
// NOT wait for full provisioning/ready — the network phase (~5s in) plus a
// quick pause/resume is enough to prove the module's lifecycle wiring
// end-to-end; provisioning correctness was already proven guest-side by
// Tasks 6-8's own harnesses.
//
// No Range-aware serving needed here (unlike verify-luks.mjs/
// verify-firstboot.mjs): the disk is BlockStore-backed (IndexedDB), not an
// HTTP-Range-loaded file, so vendor/boot assets are all served as plain
// 200s.
import { chromium } from "playwright";
import { createServer } from "http";
import { statSync, readFileSync } from "fs";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import path, { extname } from "path";

const devDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(devDir); // deploy/selfhost-web

// Explicit MIME types: without this, .js/.mjs are served with no
// content-type, and Chromium refuses to execute an ES module script
// ("Strict MIME type checking is enforced for module scripts") — hit this
// empirically on the first run.
const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".wasm": "application/wasm" };

// Static file server on :18123, rooted at deploy/selfhost-web/ (same root
// verify-boot.mjs/verify-net.mjs/verify-luks.mjs use). "/" is special-cased
// to serve dev/vm-controller-check.html's *content* while leaving the
// navigated URL (and therefore the document's base URL) at "/" — the
// opposite of Task 4's harness-boot.html fix (see dev/NOTES.md), and
// deliberately so: vm-controller.js's own asset paths ("vendor/v86.wasm",
// "boot/vmlinuz", no "../") are written relative to wherever the real page
// lives, which is the repo root (selfhost.html), not dev/.
const srv = createServer((req, res) => {
  const reqPath = req.url === "/" ? "/dev/vm-controller-check.html" : req.url.split("?")[0];
  const filePath = path.join(rootDir, decodeURIComponent(reqPath));
  try {
    statSync(filePath);
    res.setHeader("content-type", MIME[extname(filePath)] ?? "application/octet-stream");
    res.end(readFileSync(filePath));
  } catch {
    res.statusCode = 404;
    res.end();
  }
}).listen(18123);

// Same relay-build-and-spawn pattern as every other verify-*.mjs (see
// dev/NOTES.md re: `go run` module-resolution/orphan-process issues from
// dev/).
const relayDir = new URL("../relay", import.meta.url).pathname;
const relayBin = new URL(".", import.meta.url).pathname + ".relay-bin";
execSync("go build -o " + JSON.stringify(relayBin) + " .", { cwd: relayDir, stdio: "inherit" });
const relay = spawn(relayBin, ["-listen", ":18086"], { stdio: "inherit" });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));
await page.goto("http://localhost:18123/");

const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(1);
let verdict = "VERDICT: VMC FAILED — record failure mode in NOTES.md";

try {
  // Sanity: the classic vendor script actually defined the global before we
  // rely on it inside VmController.
  const hasV86 = await page.evaluate(() => typeof window.V86 === "function");
  if (!hasV86) throw new Error("window.V86 not defined after loading vendor/libv86.js");

  await page.evaluate(() => window.startVm());
  console.log(`[+${elapsed()}s] start() resolved (state -> running, emulator-ready fired)`);

  await page.waitForFunction(() => window.phases.includes("network"), { timeout: 90_000, polling: 500 });
  console.log(`[+${elapsed()}s] onPhase("network") fired`);

  const statesAtNetwork = await page.evaluate(() => window.states.slice());
  console.log("states at network phase:", JSON.stringify(statesAtNetwork));

  // pause() -> resume() round trip, driving the real public methods.
  await page.evaluate(() => window.pauseVm());
  console.log(`[+${elapsed()}s] pause() resolved`);

  const snapshotSize = await page.evaluate(() => window.getSnapshotSize());
  console.log(`[+${elapsed()}s] snapshot persisted: ${snapshotSize} bytes`);

  await page.evaluate(() => window.resumeVm());
  console.log(`[+${elapsed()}s] resume() resolved`);

  // Bonus, non-gating evidence: confirm resume() genuinely continues guest
  // execution (not just a state-string flip) by watching for the *next*
  // phase marker (luks) to arrive afterwards. Not part of the pass/fail
  // gate — the brief only requires the network phase + the pause/resume
  // round trip — but cheap to capture and strengthens the "resume actually
  // resumed" claim beyond the state machine alone.
  try {
    await page.waitForFunction(() => window.phases.includes("luks"), { timeout: 60_000, polling: 500 });
    console.log(`[+${elapsed()}s] bonus: onPhase("luks") fired after resume — guest execution genuinely continued`);
  } catch {
    console.log(`[+${elapsed()}s] bonus: luks phase did not arrive within 60s of resume (not gating; passphrase-timing/perf, not a resume() correctness signal on its own)`);
  }

  const statesAfterResume = await page.evaluate(() => window.states.slice());
  const marks = await page.evaluate(() => window.marks);
  const phases = await page.evaluate(() => window.phases.slice());
  const errors = await page.evaluate(() => window.errors.slice());
  console.log("phase timeline (marks):", JSON.stringify(marks, null, 2));
  console.log("phases seen:", JSON.stringify(phases));
  console.log("errors seen:", JSON.stringify(errors));
  console.log("full state transition list:", JSON.stringify(statesAfterResume));

  const networkPhaseSeen = phases.includes("network");
  // Look for a genuine running -> paused -> running transition anywhere in
  // the recorded sequence (not just the last two entries), and require a
  // real, non-trivial snapshot to have been written.
  let sawRoundTrip = false;
  for (let i = 0; i + 2 < statesAfterResume.length; i++) {
    if (
      statesAfterResume[i] === "running" &&
      statesAfterResume[i + 1] === "paused" &&
      statesAfterResume[i + 2] === "running"
    ) {
      sawRoundTrip = true;
      break;
    }
  }
  const snapshotOk = typeof snapshotSize === "number" && snapshotSize > 0;
  const phase1Ok = networkPhaseSeen && sawRoundTrip && snapshotOk;
  console.log(
    phase1Ok
      ? "PHASE 1 (pause/resume): OK"
      : `PHASE 1 (pause/resume): FAILED — network=${networkPhaseSeen} roundTrip=${sawRoundTrip} snapshotOk=${snapshotOk}`,
  );

  // --- Phase 2: autosave coherence (review finding) -----------------------
  // The autosave timer used to call save_state() WITHOUT halting the CPU
  // first: the guest kept executing (and writing to BlockStore) while
  // save_state() was reading the WASM RAM buffer, so the resulting snapshot
  // was not guaranteed to correspond to any single real instant the disk
  // was actually in — and separately, restoring an old snapshot after a
  // crash mid-interval would pair it with a disk that had since evolved
  // further. Fixed in js/vm-controller.js by halting the CPU for the
  // duration of every snapshot (pause/stop/autosave alike) — see the
  // `_autosaveTick` doc comment and dev/NOTES.md "Task 11" ("autosave
  // coherence") for the full risk analysis and why that's sufficient (a
  // crash between two coherent snapshots just discards whatever happened
  // after the last one, exactly like an ordinary power loss).
  //
  // This phase proves the fix end to end: trigger an autosave-equivalent
  // snapshot mid-boot (via the internal _autosaveTick, to avoid a real
  // 5-minute wait), let the guest keep running and writing well past it
  // (through the disk-write-heavy LUKS/btrfs stage), then simulate an
  // unclean shutdown — destroy the emulator directly, bypassing
  // VmController.stop()'s own save — and confirm a FRESH VmController over
  // the SAME instance id (as a real page reload would construct) restores
  // cleanly and keeps making genuine forward progress, with no
  // @@SH:err:*@@ ever observed.
  console.log("--- Phase 2: autosave coherence ---");

  await page.evaluate(() => window.makeController("vmc-check-2", "coherence"));
  await page.evaluate(() => window.controllers.coherence.vmc.start());
  console.log(`[+${elapsed()}s] coherence: start() resolved`);

  await page.waitForFunction(() => window.controllers.coherence.phases.includes("network"), {
    timeout: 90_000,
    polling: 500,
  });
  console.log(`[+${elapsed()}s] coherence: onPhase("network") fired`);

  // Directly invoke the same method the 5-minute timer would call.
  await page.evaluate(() => window.controllers.coherence.vmc._autosaveTick());
  console.log(`[+${elapsed()}s] coherence: autosave tick completed (CPU halted for the snapshot, then resumed)`);

  const snapshotAtAutosave = await page.evaluate(() => window.getSnapshotSize("vmc-check-2"));
  console.log(`[+${elapsed()}s] coherence: snapshot after autosave tick: ${snapshotAtAutosave} bytes`);

  const errorsAfterTick = await page.evaluate(() => window.controllers.coherence.errors.slice());
  console.log("coherence: errors after autosave tick (want none):", JSON.stringify(errorsAfterTick));

  // Let the guest keep running and writing to disk well past the autosave
  // point — LUKS format + mkfs.btrfs is disk-write-heavy — before the
  // simulated crash.
  await page.waitForFunction(() => window.controllers.coherence.phases.includes("luks"), {
    timeout: 60_000,
    polling: 500,
  });
  console.log(`[+${elapsed()}s] coherence: onPhase("luks") fired post-autosave (guest kept writing past the snapshot point)`);

  // Simulate an unclean shutdown: destroy the live emulator directly,
  // bypassing VmController.stop() (which would itself save first). Nothing
  // written between the autosave tick above and this instant is preserved
  // in a snapshot — "lost future", same as an unplugged machine.
  await page.evaluate(() => window.controllers.coherence.vmc.emulator.destroy());
  console.log(`[+${elapsed()}s] coherence: emulator destroyed WITHOUT stop() (simulated crash)`);

  // A fresh VmController over the SAME instance id, exactly as a new page
  // load would construct one. This is the actual coherence assertion: it
  // must restore from the autosave snapshot and keep making genuine
  // forward progress (proving the restored {RAM, disk} pair was valid).
  await page.evaluate(() => window.makeController("vmc-check-2", "coherenceRestored"));
  await page.evaluate(() => window.controllers.coherenceRestored.vmc.start());
  console.log(`[+${elapsed()}s] coherence: restored controller's start() resolved`);

  await page.waitForFunction(() => window.controllers.coherenceRestored.phases.includes("luks"), {
    timeout: 90_000,
    polling: 500,
  });
  console.log(`[+${elapsed()}s] coherence: restored controller reached onPhase("luks") again — coherent continuation confirmed`);

  const restoredErrors = await page.evaluate(() => window.controllers.coherenceRestored.errors.slice());
  const restoredStates = await page.evaluate(() => window.controllers.coherenceRestored.states.slice());
  const restoredPhases = await page.evaluate(() => window.controllers.coherenceRestored.phases.slice());
  console.log("coherence: restored phases:", JSON.stringify(restoredPhases));
  console.log("coherence: restored states:", JSON.stringify(restoredStates));
  console.log("coherence: restored errors (want none):", JSON.stringify(restoredErrors));

  const coherenceOk =
    errorsAfterTick.length === 0 &&
    typeof snapshotAtAutosave === "number" &&
    snapshotAtAutosave > 0 &&
    restoredErrors.length === 0 &&
    restoredStates[0] === "starting" &&
    restoredStates.includes("running") &&
    restoredPhases.includes("luks");
  console.log(coherenceOk ? "PHASE 2 (autosave coherence): OK" : "PHASE 2 (autosave coherence): FAILED");

  if (phase1Ok && coherenceOk) {
    verdict = "VERDICT: VMC OK";
  } else {
    verdict = `VERDICT: VMC FAILED — phase1Ok=${phase1Ok} coherenceOk=${coherenceOk}`;
  }
  console.log(verdict);
} catch (err) {
  console.log("verify-vmc.mjs: error/timeout during verification:", err && err.message ? err.message : err);
  const controllers = await page.evaluate(() => {
    const out = {};
    for (const [label, rec] of Object.entries(window.controllers || {})) {
      out[label] = { marks: rec.marks, phases: rec.phases, states: rec.states, errors: rec.errors };
    }
    return out;
  }).catch(() => ({}));
  console.log("controllers at failure:", JSON.stringify(controllers, null, 2));
  console.log(verdict);
} finally {
  await browser.close();
  srv.close();
  relay.kill();
}
