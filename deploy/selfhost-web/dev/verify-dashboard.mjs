// Task 15 end-to-end verification: proves the documented dashboard-access
// FALLBACK (dev/NOTES.md "Task 15" spike verdict — wisp:// precludes the
// JS-side guest-TCP-connect path a Service Worker bridge would need) works
// against a REAL, fully first-booted instance, driven through the ACTUAL
// shipped page (selfhost.html) via Playwright exactly as a visitor would —
// not a lower-level harness reimplementing boot logic (unlike
// harness-firstboot.html, this exercises the real js/ui.js + js/vm-controller.js
// end to end, including the creation form, Play button, and the new
// #dashboard-panel/httpRequest() wiring).
//
// Reuses already-built, already-verified artifacts from earlier tasks: no
// rebuild needed. boot/{vmlinuz,initramfs.img} (Task 4), vendor/*
// (Task 9), and the local multica-selfhost-386.tar.gz payload (Task 5
// continuation's build-selfhost-tarball.sh output, symlinked at
// dev/multica-selfhost-386.tar.gz per dev/.gitignore's own note).
//
// LAN-IP / relay / Range-serving reasoning is identical to
// dev/verify-firstboot.mjs (see that file's own header comment for the
// full HTTP_000-vs-HTTP_200 trace on why a raw LAN IP is required for
// sh_release_url) — this script sets the equivalent
// window.SELFHOST_RELEASE_URL directly (js/vm-controller.js reads that
// global at module-eval time, before ui.js's own top-level code runs, per
// ES module evaluation order — page.addInitScript() runs before any of the
// page's own scripts, so this is set in time).
import { chromium } from "playwright";
import { createServer } from "http";
import { statSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { networkInterfaces } from "os";
import net from "net";
import path, { extname } from "path";

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

const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".css": "text/css", ".wasm": "application/wasm" };

// Static file server rooted at deploy/selfhost-web/ itself (same root
// verify-vmc.mjs uses) so selfhost.html's own relative asset paths
// (vendor/*, boot/*, js/*) resolve exactly as they would in the real
// deployment.
const srv = createServer((req, res) => {
  const reqPath = req.url.split("?")[0];
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

// Same relay-spawn pattern as every other verify-*.mjs: relay is relay.py,
// spawned directly via `python3`, no build step.
const relayPy = new URL("../relay.py", import.meta.url).pathname;
const relay = spawn("python3", [relayPy, "-listen", ":18086"], { stdio: "inherit" });

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
page.on("console", (msg) => console.log("[page]", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));

// Must run before selfhost.html's own <script type="module"> — vm-controller.js
// reads window.SELFHOST_RELEASE_URL at module-eval time (see this file's
// header comment).
const RELEASE_URL = `http://${RELEASE_HOST}:18123/dev/multica-selfhost-386.tar.gz`;
await page.addInitScript((url) => { window.SELFHOST_RELEASE_URL = url; }, RELEASE_URL);

const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(1);
let verdict = "VERDICT: DASHBOARD FALLBACK FAILED — record failure mode in NOTES.md";

const NAME = "task15-dashboard";
const PIN = "task15-pin-4242";
const PASSPHRASE = "task15-dashboard-verify-passphrase";

try {
  await page.goto("http://localhost:18123/selfhost.html");
  await page.evaluate(() => window.__selfhostReady);
  console.log(`[+${elapsed()}s] selfhost.html loaded, initSelfhostPage() resolved`);

  // --- Creation form: real UI, real fields, real preflight -----------------
  await page.click("#btn-show-create");
  await page.fill("#field-name", NAME);
  await page.fill("#field-pin", PIN);
  await page.fill("#field-disk-size", "2");
  await page.fill("#field-relay-url", "wisp://localhost:18086/");
  await page.fill("#field-passphrase", PASSPHRASE);
  await page.fill("#field-passphrase2", PASSPHRASE);
  await page.click("#btn-create");

  await page.waitForSelector(".instance-card", { timeout: 15_000 });
  console.log(`[+${elapsed()}s] creation form submitted, instance card rendered`);

  // --- Play: real cold boot through the real VmController -------------------
  await page.click('.instance-card [data-action="play"]');
  console.log(`[+${elapsed()}s] Play clicked, controller.start() invoked`);

  const card = page.locator(".instance-card").first();
  await card.locator('[data-testid="state-badge"]').waitFor({ state: "attached", timeout: 15_000 });

  // Wait for the Open Dashboard button to become enabled — this is exactly
  // the phase "ready" gate Task 14's own unit spec already proves in
  // isolation (renderInstanceCard); here it's driven by a genuinely
  // provisioned guest, not a synthetic phase argument. Generous window —
  // Task 8/9's own NOTES.md timing puts first boot to "ready" at roughly
  // 5-6 minutes on this class of machine (WASM JIT + 386 emulation +
  // ~100MB tarball fetch over the relay), so this is not expected to be
  // fast, and is not a regression if it takes a few minutes.
  const dashboardBtn = card.locator('[data-action="dashboard"]');
  // waitForFunction's signature is (pageFunction, arg, options) — arg must
  // be passed explicitly (as `undefined` here) or the options object below
  // is silently treated as `arg` instead, and the call falls back to
  // Playwright's default 30s action timeout (hit exactly this empirically:
  // the first run of this script failed at "Timeout 30000ms exceeded" a
  // few hundred ms into a boot that needs several minutes).
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('.instance-card [data-action="dashboard"]');
      return btn && !btn.disabled;
    },
    undefined,
    { timeout: 15 * 60_000, polling: 2000 },
  );
  console.log(`[+${elapsed()}s] Open Dashboard button enabled (phase: ready)`);

  // --- Open Dashboard: the fallback panel, not a new tab --------------------
  await dashboardBtn.click();
  const panel = page.locator("#dashboard-panel");
  await panel.waitFor({ state: "visible", timeout: 5_000 });
  const title = await page.locator("#dashboard-panel-title").textContent();
  console.log(`[+${elapsed()}s] #dashboard-panel visible, title "${title}"`);
  if (!title || !title.includes(NAME)) {
    throw new Error(`dashboard panel title should include the instance name "${NAME}", got: ${title}`);
  }

  // --- Run health check: real curl over ttyS0 against the real guest --------
  // Retries with a short delay between attempts: the "ready" marker fires
  // as soon as `nc -z 127.0.0.1 3000` sees the port bound
  // (guest/provision.sh's ready-marker.start), which can be a few seconds
  // BEFORE `next start` is actually accepting/answering full HTTP requests
  // on that same socket — confirmed empirically running this exact script
  // (see dev/NOTES.md "Task 15" for the real serial transcript: 3
  // "HTTP 0" attempts immediately after ready, then HTTP 200 ~28s later).
  // Not a bug in httpRequest() or the ready marker, and not something a
  // longer internal httpRequest() timeout would fix either (each attempt
  // DOES get a real, prompt "000" reply — curl just isn't lying, the
  // service genuinely isn't answering yet) — a manual "Run health check"
  // button is expected to reflect exactly this transient window, and a
  // real user just clicks again a few seconds later.
  let resultText = "";
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await page.click("#btn-dashboard-healthcheck");
    await page.waitForFunction(
      () => /Reachable|Not reachable|timeout|not running/.test(document.getElementById("dashboard-healthcheck-result")?.textContent || ""),
      undefined,
      { timeout: 25_000, polling: 500 },
    );
    resultText = await page.locator("#dashboard-healthcheck-result").textContent();
    console.log(`[+${elapsed()}s] health check attempt ${attempt}: ${resultText}`);
    if (/Reachable \(HTTP 200\)/.test(resultText)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!/Reachable \(HTTP 200\)/.test(resultText)) {
    throw new Error(`expected "Reachable (HTTP 200)" within 10 retries, got: ${resultText}`);
  }

  verdict = "VERDICT: DASHBOARD FALLBACK OK";
  console.log(verdict);
} catch (err) {
  console.log("verify-dashboard.mjs: error/timeout during verification:", err && err.message ? err.message : err);
  const failText = await page.locator("#dashboard-healthcheck-result").textContent().catch(() => "<unavailable>");
  console.log("dashboard-healthcheck-result text at failure:", JSON.stringify(failText));
  console.log(verdict);
  throw err;
} finally {
  await browser.close();
  srv.close();
  relay.kill();
}
