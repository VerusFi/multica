// Task 8 boot-test — the capstone: boots the committed boot artifacts
// (../boot/vmlinuz + ../boot/initramfs.img) plus an empty 2 GiB disk under
// v86, drives networking through multica-relay (wisp://, same as every
// earlier dev/verify-*.mjs), sends a test passphrase over ttyS1, serves the
// locally built payload tarball (Task 5's build-selfhost-tarball.sh output)
// over the same static server the harness page itself is served from, and
// watches for the full marker sequence:
//   network -> luks -> install -> download -> initdb -> services -> ready
// Then, INSIDE the guest (over the ttyS0 root shell stage3_multica enables —
// see dev/NOTES.md "Task 8" and guest/provision.sh's own comment on that
// addition), asserts BOTH services are actually serving: the backend
// listening on :8080 and `curl -s localhost:3000` returning HTML. The :8080
// assertion is load-bearing, not belt-and-braces — the frontend serves its
// whole app shell with no backend at all (proven: the container pre-check in
// dev/NOTES.md got the identical HTTP 200 / 276635 bytes with nothing on
// 8080), and `command_background=yes` makes OpenRC's `[ ok ]` mean "forked",
// not "alive".
//
// Finally (task Step 4) runs the COLD-BOOT test in the same process, on the
// same disk: a power-cycle onto a brand-new V86 instance handed the first
// instance's own disk buffer (NOT `emulator.restart()`, which cannot reboot
// a bzimage+initrd guest at all, and NOT save/restore_state — see
// harness-firstboot.html's coldBootReset and dev/NOTES.md "Task 8"), then
// asserts the guest comes back up from the provisioned disk alone,
// luks -> services -> ready + :8080 + HTML on :3000, with NO install and NO
// download marker (nothing re-bootstrapped, nothing re-downloaded).
//
// Host-address finding (empirically confirmed via an ad hoc probe before
// writing this file — see dev/NOTES.md "Task 8" for the full trace, incl.
// the exact HTTP_000-vs-HTTP_200 evidence): NEITHER `localhost` (short-
// circuited by the guest's own /etc/hosts, never reaches the network) NOR
// `127.0.0.1` (same — guest-local loopback) NOR a guessed v86-internal
// gateway IP (`192.168.86.1`, matching v86's own DHCP-assigned gateway;
// also tried the QEMU-slirp-convention `10.0.2.2`) work — the wisp relay
// just does a literal `net.Dial(host, port)` with whatever string it's
// given, and a raw IP that isn't actually one of the HOST machine's own
// addresses simply fails to connect from the host's side (confirmed:
// curl inside the guest hung to its own timeout, `HTTP_000`). What DOES
// work: the HOST machine's own real, non-loopback LAN IP — computed below
// via `os.networkInterfaces()` rather than hardcoded, so this isn't pinned
// to one dev machine's network address. A raw IP in the guest's curl
// command bypasses the guest's own local-resolution shortcuts (no
// /etc/hosts entry can match an arbitrary real IP), routes out via
// eth0/wisp as a raw-IP CONNECT, and the relay's `net.Dial` reaches it
// directly since it's a real address already bound to one of the host's
// own interfaces (a same-machine self-connect to its own LAN IP, which
// routes correctly, confirmed: `HTTP_200 SIZE_4101`).
import { chromium } from "playwright";
import { createServer } from "http";
import { statSync, createReadStream, readFileSync } from "fs";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { networkInterfaces } from "os";
import path from "path";

function hostLanIP() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  throw new Error("no non-internal IPv4 interface found — cannot compute a host LAN IP for sh_release_url");
}
const RELEASE_HOST = hostLanIP();
console.log("host LAN IP for sh_release_url:", RELEASE_HOST);

const devDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(devDir); // deploy/selfhost-web

// Range-aware static file server on :18123, rooted one level up from dev/ —
// same reasoning/implementation as verify-luks.mjs/verify-install.mjs (see
// dev/NOTES.md): the `hda` empty-disk image needs real HTTP Range support,
// and this same server also serves the payload tarball for the guest's
// `curl` download (a symlink at dev/multica-selfhost-386.tar.gz to the
// locally built tarball — see dev/.gitignore).
const srv = createServer((req, res) => {
  const reqPath = req.url === "/" ? "/dev/harness-firstboot.html" : req.url.split("?")[0];
  const filePath = path.join(rootDir, decodeURIComponent(reqPath));
  let st;
  try { st = statSync(filePath); } catch { res.statusCode = 404; res.end(); return; }

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (!m) { res.statusCode = 416; res.end(); return; }
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : st.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${st.size}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  try { res.end(readFileSync(filePath)); } catch { res.statusCode = 404; res.end(); }
}).listen(18123);

// Same relay-build-and-spawn pattern as every earlier dev/verify-*.mjs (see
// dev/NOTES.md re: `go run` module-resolution/orphan-process issues from dev/).
const relayDir = new URL("../relay", import.meta.url).pathname;
const relayBin = new URL(".", import.meta.url).pathname + ".relay-bin";
execSync("go build -o " + JSON.stringify(relayBin) + " .", { cwd: relayDir, stdio: "inherit" });
const relay = spawn(relayBin, ["-listen", ":18086"], { stdio: "inherit" });

// Wait for the relay to actually be listening before navigating — a real,
// previously-undocumented race hit while developing this test (see
// dev/NOTES.md "Task 8"): v86's very first WS connect attempt (right at
// emulator-ready) can beat the relay's own bind/listen, producing
// ERR_CONNECTION_REFUSED. The guest's own DHCP still succeeds regardless
// (v86's built-in DHCP server, independent of the relay — Task 3's
// NOTES.md), which masks the failure until the first real-network
// operation (apk's CDN fetch in stage2_install) hangs for the rest of the
// run. Every earlier dev/verify-*.mjs spawns the relay and navigates
// back-to-back with no such wait and, empirically, usually wins the race
// by luck (Playwright/Chromium startup + WASM load time is normally
// enough headroom) — but "usually" isn't good enough for a run this long,
// so this script waits explicitly.
import net from "net";
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.end(); resolve(true); });
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`relay port ${port} never became reachable`);
}
await waitForPort(18086, 15_000);
console.log("relay confirmed listening on :18086");

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));
await page.goto(`http://localhost:18123/dev/harness-firstboot.html?release_host=${RELEASE_HOST}`);

async function waitSerial(pattern, timeoutMs) {
  await page.waitForFunction(
    (p) => new RegExp(p).test(window.serialLog),
    pattern, { timeout: timeoutMs, polling: 1000 },
  );
}

// One round of in-guest probing over the ttyS0 root shell: is anything
// listening on 3000 (frontend) and on 8080 (backend), and how many node
// processes exist. Returns the captured output segment, or null if the shell
// did not answer.
//
// Split markers (`UP''3000`) per dev/NOTES.md's Task 3 finding: this is
// typed input, which the tty echoes back into serialLog verbatim, so an
// un-split literal would match its own echo and report a false positive.
async function probeGuest(tag) {
  await page.evaluate((t) => window.sendCmd(
    `echo ${t}_BEG''IN;`
    + ` nc -z 127.0.0.1 3000 && echo UP''3000 || echo DOWN''3000;`
    + ` nc -z 127.0.0.1 8080 && echo UP''8080 || echo DOWN''8080;`
    + ` ps | grep -c node; echo ${t}_E''ND`,
  ), tag);
  try {
    await waitSerial(`${tag}_END`, 30_000);
    const log = await page.evaluate(() => window.serialLog);
    const seg = log.slice(log.lastIndexOf(`${tag}_BEGIN`));
    return seg.slice(0, seg.indexOf(`${tag}_END`) + `${tag}_END`.length);
  } catch {
    return null;
  }
}

// Wait for @@SH:phase:ready@@ with a long window, probing the guest once a
// minute while waiting, then confirm BOTH services are actually listening.
//
// Why a probe loop instead of one long `waitSerial`: the ready marker is
// emitted by /etc/local.d/ready-marker.start, which polls `nc -z 127.0.0.1
// 3000` every 5s — so "no ready marker yet" is indistinguishable, from the
// outside, between (a) the Next.js server is still starting (legitimate, and
// slow under 386 emulation) and (b) the node process died on startup and no
// amount of further waiting will help. That exact ambiguity cost the first
// implementer of this task a full boot cycle (see dev/NOTES.md "Task 8" —
// the frontend was crash-looping on a missing module the whole time).
//
// Why 8080 is asserted separately and is NOT redundant with the HTML check:
// the frontend serves the app shell perfectly well with no backend at all.
// That is not a guess — the container-level pre-check for the pnpm-hoisting
// fix (dev/NOTES.md "Task 8") ran `server.js` with nothing whatsoever on
// 8080 and got back the same HTTP 200 and the same 276635 bytes of markup
// the in-guest curl gets. And `command_background=yes` means OpenRC's
// `Starting multica-backend ... [ ok ]` only reports a successful *fork* —
// the exact reason the frontend's crash-loop went undiagnosed for a whole
// boot cycle in the first place. So without this probe the gate would pass
// on an instance whose API never came up at all, which is precisely the
// failure the new fail-closed JWT_SECRET check in multica-backend.initd is
// designed to cause on a bad provision.
async function waitForReadyWithProbes(windowMs, label) {
  const deadline = Date.now() + windowMs;
  let probe = 0;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      await waitSerial("@@SH:phase:ready@@", Math.min(60_000, Math.max(1000, deadline - Date.now())));
      ready = true;
      break;
    } catch { /* not yet — probe the guest and keep waiting */ }
    probe += 1;
    const seg = await probeGuest(`P${label}${probe}`);
    console.log(seg === null
      ? `[+${elapsed()}s] ${label} probe ${probe}: no response on ttyS0 within 30s (shell not up yet, or guest busy)`
      : `[+${elapsed()}s] ${label} probe ${probe}: ${JSON.stringify(seg.slice(0, 300))}`);
  }
  if (!ready) return { ready: false, backend: false, evidence: null };

  // The ready marker only proves :3000. Confirm :8080 explicitly, with a few
  // retries: the marker can fire while the backend is still opening its
  // listener (both services start in the same OpenRC runlevel).
  let evidence = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    evidence = await probeGuest(`B${label}${attempt}`);
    console.log(`[+${elapsed()}s] ${label} post-ready service probe ${attempt}: ${JSON.stringify((evidence || "<no response>").slice(0, 300))}`);
    if (evidence && /UP8080/.test(evidence) && /UP3000/.test(evidence)) {
      return { ready: true, backend: true, evidence };
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return { ready: true, backend: false, evidence };
}

const PASSPHRASE = "test-passphrase-task8";
let verdict = "VERDICT: FAILED before reaching a per-phase verdict — record failure mode in NOTES.md";
const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(1);
try {
  await waitSerial("@@SH:phase:network@@", 120_000);
  console.log(`[+${elapsed()}s] network marker seen`);

  await page.evaluate((pass) => window.sendPassphrase(pass), PASSPHRASE);
  console.log(`[+${elapsed()}s] passphrase sent on ttyS1`);

  await waitSerial("@@SH:phase:luks@@", 60_000);
  console.log(`[+${elapsed()}s] luks marker seen`);

  await waitSerial("@@SH:phase:install@@", 120_000);
  console.log(`[+${elapsed()}s] install marker seen`);

  await waitSerial("@@SH:phase:download@@", 900_000);
  console.log(`[+${elapsed()}s] download marker seen (stage2_install completed; stage3_multica's own tarball fetch begins next)`);

  // stage3_multica: tarball download (~100M over the relay from localhost)
  // + extraction + offline vips-apks install (78 packages) + pgvector copy.
  // Generous budget — this is new, uncharacterized work for this task.
  await waitSerial("@@SH:phase:initdb@@", 900_000);
  console.log(`[+${elapsed()}s] initdb marker seen (tarball unpacked + vips/pgvector installed offline)`);

  // initdb + create user/db/extension + JWT gen + `migrate up` (366
  // migration files, against a fresh empty schema, all local Postgres —
  // no network latency, but still real DDL work under 386 emulation).
  await waitSerial("@@SH:phase:services@@", 900_000);
  console.log(`[+${elapsed()}s] services marker seen (init-selfhost's own mark, right before switch_root)`);

  // Post-switch_root: OpenRC default runlevel starts postgresql ->
  // multica-backend -> multica-web -> local (ready-marker.start), which
  // polls `nc -z 127.0.0.1 3000` every 5s until the Next.js standalone
  // server answers. 15-minute window: `next start`'s first-request compile/
  // page-data load under 386 emulation is genuinely slow, and the previous
  // 5-minute budget was tight enough that a timeout couldn't be told apart
  // from a real failure. See waitForReadyWithProbes above for why this is a
  // probe loop rather than a single long wait.
  const firstReady = await waitForReadyWithProbes(15 * 60_000, "firstboot");
  if (!firstReady.ready) {
    throw new Error("ready marker never appeared within 15 minutes of the services marker");
  }
  console.log(`[+${elapsed()}s] ready marker seen`);
  if (!firstReady.backend) {
    throw new Error("first boot: frontend is up on :3000 but the backend never started listening on :8080");
  }
  console.log(`[+${elapsed()}s] backend confirmed listening on :8080`);

  // Probe over the ttyS0 root shell stage3_multica enables (see
  // dev/NOTES.md "Task 8" — no natural fallthrough exists on the success
  // path once stage3_multica is defined, unlike Task 7). Split-marker
  // anti-echo trick (see dev/NOTES.md, Task 3 section): this is
  // typed/echoed interactive input.
  await page.evaluate(() =>
    sendCmd("curl -s localhost:3000 | head -c 200 && echo && echo CURL''_DONE"));
  await waitSerial("CURL_DONE", 120_000);
  console.log(`[+${elapsed()}s] curl probe confirmed`);

  const log = await page.evaluate(() => window.serialLog);
  console.log("--- last 3000 chars of serialLog ---");
  console.log(log.slice(-3000));

  // Evidence the response is real HTML, not an error page/empty body:
  // look for a doctype/html tag between the command's own output and the
  // CURL_DONE marker.
  const htmlLikely = /<!doctype html|<html/i.test(log);
  const firstBootOK = /CURL_DONE/.test(log) && htmlLikely;
  const firstMarks = await page.evaluate(() => window.bootMarks);
  console.log("bootMarks (first boot):", JSON.stringify(firstMarks));
  console.log(firstBootOK
    ? "VERDICT: FIRSTBOOT OK"
    : "VERDICT: FIRSTBOOT FAILED — record failure mode in NOTES.md");
  if (!firstBootOK) throw new Error("first boot did not produce HTML from localhost:3000");

  // ---- Step 4: cold boot ------------------------------------------------
  // Power-cycle the guest onto the SAME disk (fresh CPU/RAM/devices, only
  // the disk buffer carried over; no save/restore_state — and NOT v86's
  // `emulator.restart()`, which is structurally broken for bzimage+initrd
  // direct-kernel boots: see harness-firstboot.html's coldBootReset comment
  // and dev/NOTES.md "Task 8" for the #GP panic that produces), then assert
  // the guest comes back up from the provisioned disk alone: luks ->
  // services -> ready, with NO install and NO download marker, i.e. nothing
  // re-bootstrapped and nothing re-downloaded.
  //
  // `sync` first: this is a hard power-cycle from the guest's point of view.
  // btrfs would recover from its log either way, but a real shipped page has
  // no reason to deliberately reboot into an unsynced filesystem, and an
  // avoidable log-replay would only add noise to what this step is actually
  // testing.
  await page.evaluate(() => sendCmd("sync; echo SYN''CED"));
  await waitSerial("SYNCED", 60_000).catch(() => console.log("sync did not confirm within 60s — restarting anyway"));
  console.log(`[+${elapsed()}s] === COLD BOOT: restarting the same VM ===`);

  const coldStart = Date.now();
  const coldElapsed = () => ((Date.now() - coldStart) / 1000).toFixed(1);
  await page.evaluate(() => window.coldBootReset());

  await waitSerial("@@SH:phase:network@@", 180_000);
  console.log(`[cold +${coldElapsed()}s] network marker seen`);
  await page.evaluate((pass) => window.sendPassphrase(pass), PASSPHRASE);
  console.log(`[cold +${coldElapsed()}s] passphrase sent on ttyS1`);
  await waitSerial("@@SH:phase:luks@@", 180_000);
  console.log(`[cold +${coldElapsed()}s] luks marker seen (existing LUKS header detected -> coldboot_mount)`);
  await waitSerial("@@SH:phase:services@@", 300_000);
  console.log(`[cold +${coldElapsed()}s] services marker seen`);

  const coldReady = await waitForReadyWithProbes(15 * 60_000, "coldboot");
  if (!coldReady.ready) throw new Error("cold boot: ready marker never appeared within 15 minutes of the services marker");
  console.log(`[cold +${coldElapsed()}s] ready marker seen`);
  if (!coldReady.backend) {
    throw new Error("cold boot: frontend is up on :3000 but the backend never started listening on :8080");
  }
  console.log(`[cold +${coldElapsed()}s] backend confirmed listening on :8080`);

  await page.evaluate(() =>
    sendCmd("curl -s localhost:3000 | head -c 200 && echo && echo COLDCURL''_DONE"));
  await waitSerial("COLDCURL_DONE", 120_000);
  console.log(`[cold +${coldElapsed()}s] cold-boot curl probe confirmed`);

  const coldLog = await page.evaluate(() => window.serialLog);
  console.log("--- last 3000 chars of serialLog (cold boot) ---");
  console.log(coldLog.slice(-3000));
  const coldMarks = await page.evaluate(() => window.bootMarks);
  console.log("bootMarks (cold boot):", JSON.stringify(coldMarks));

  // bootMarks is authoritative for the negative assertion (serialLog is a
  // ring buffer and could in principle have dropped an early line; bootMarks
  // never forgets a marker once seen, and coldBootReset cleared it).
  const reprovisioned = "phase-install" in coldMarks || "phase-download" in coldMarks;
  const coldHtml = /<!doctype html|<html/i.test(coldLog.slice(coldLog.lastIndexOf("COLDCURL_DONE") - 4000));
  const coldOK = !reprovisioned && /COLDCURL_DONE/.test(coldLog) && coldHtml;
  if (reprovisioned) {
    console.log("COLD BOOT FAILURE: install/download marker seen on the second boot — the guest re-provisioned instead of mounting the existing disk");
  }
  verdict = (firstBootOK && coldOK)
    ? "VERDICT: FIRSTBOOT OK; COLDBOOT OK"
    : "VERDICT: FIRSTBOOT OK; COLDBOOT FAILED — record failure mode in NOTES.md";
  console.log(verdict);
} catch (err) {
  console.log("verify-firstboot.mjs: error/timeout during verification:", err && err.message ? err.message : err);
  const log = await page.evaluate(() => window.serialLog).catch(() => "<no serialLog available>");
  console.log("--- last 5000 chars of serialLog at failure ---");
  console.log(log.slice(-5000));
  const marks = await page.evaluate(() => window.bootMarks).catch(() => ({}));
  console.log("bootMarks at failure:", JSON.stringify(marks));
  console.log(verdict);
} finally {
  await browser.close(); srv.close(); relay.kill();
}
