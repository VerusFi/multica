// SLOW — first-boot smoke test. Run ON DEMAND ONLY:
//
//   node tests/smoke-firstboot.mjs
//
// NOT part of `node tests/run-tests.mjs` (that runner's default spec list is
// hardcoded to the four fast unit specs — vault/instance-manager/
// vm-controller/ui — and only ever loads a file this script names on its own
// command line, so this file is invisible to it unless explicitly passed)
// and NOT wired into any CI workflow. It boots a real Alpine Linux guest
// under v86/WASM end to end (LUKS format, package install, ~100MB payload
// download, Postgres initdb, service start) — expect roughly 6-8 minutes
// wall clock. See `deploy/selfhost-web/README.md` ("Manual E2E checklist")
// for the full human walkthrough this script partially automates, and
// `deploy/selfhost-web/dev/verify-firstboot.mjs` (which this script's
// structure is deliberately modeled on) for the lower-level harness variant
// that additionally proves a cold reboot on the same disk — out of scope
// here, which only needs to prove first boot reaches `ready`.
//
// Unlike dev/verify-firstboot.mjs (which drives a bare harness page that
// talks to v86 directly), this script drives the REAL shipped page
// (selfhost.html) through Playwright exactly as a visitor would: the actual
// creation form, the actual Play button, and the actual phase-progress UI
// (js/ui.js's `renderInstanceCard`) — same approach as
// dev/verify-dashboard.mjs, minus the dashboard-panel/health-check portion
// (out of scope for this task; that path already has its own coverage).
//
// Requires, all already present in a normal checkout after Tasks 4-9's own
// build steps (this script does NOT rebuild any of them):
//   - deploy/selfhost-web/boot/{vmlinuz,initramfs.img}  (build-boot.sh)
//   - deploy/selfhost-web/vendor/*                        (v86 + xterm)
//   - deploy/selfhost-web/dev/multica-selfhost-386.tar.gz (symlink to the
//     built payload tarball, e.g. build-selfhost-tarball.sh's output at
//     /tmp/multica-selfhost-386.tar.gz — regenerate only if this is missing)
// If any of those are absent this script fails fast with a clear message
// rather than hanging on a 404.
//
// Same runner infra as every deploy/selfhost-web/dev/verify-*.mjs (see
// dev/NOTES.md for the underlying reasoning, repeated briefly here):
//   - relay is relay.py, spawned directly via `python3` on port 18086.
//   - static file server on port 18123, rooted at deploy/selfhost-web/ so
//     the real page's relative asset paths (vendor/*, boot/*, js/*)
//     resolve exactly as they do in the actual deployment.
//   - explicit MIME types for .js/.mjs — Chromium refuses to execute a
//     module script served with no content-type.
//   - waits for the relay's listen socket before navigating (a real race
//     hit during Task 8's development: v86's first WISP connect attempt can
//     beat the relay's own bind).
//   - the payload download needs `window.SELFHOST_RELEASE_URL` pointed at
//     a real, non-loopback LAN IP (computed via os.networkInterfaces(), not
//     hardcoded) — `localhost`/`127.0.0.1` are short-circuited by the
//     guest's own local resolution and never reach the relay; see
//     dev/verify-firstboot.mjs's header comment for the full HTTP_000-vs-
//     HTTP_200 trace that established this.
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
  throw new Error("no non-internal IPv4 interface found — cannot compute a host LAN IP for SELFHOST_RELEASE_URL");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(testsDir); // deploy/selfhost-web

// Fail fast, with a clear message, rather than hanging on a 404 mid-boot.
for (const rel of ["boot/vmlinuz", "boot/initramfs.img", "vendor/libv86.js", "vendor/v86.wasm", "dev/multica-selfhost-386.tar.gz"]) {
  try {
    statSync(path.join(rootDir, rel));
  } catch {
    console.error(`smoke-firstboot.mjs: missing required build artifact "${rel}" — see this file's header comment for how to produce it.`);
    process.exit(1);
  }
}

const RELEASE_HOST = hostLanIP();
console.log("host LAN IP for SELFHOST_RELEASE_URL:", RELEASE_HOST);

const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".css": "text/css", ".wasm": "application/wasm" };

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
page.on("console", (msg) => msg.type() === "error" && console.log("[page:error]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));

// Must run before selfhost.html's own <script type="module"> — vm-controller.js
// reads window.SELFHOST_RELEASE_URL at module-eval time.
const RELEASE_URL = `http://${RELEASE_HOST}:18123/dev/multica-selfhost-386.tar.gz`;
await page.addInitScript((url) => { window.SELFHOST_RELEASE_URL = url; }, RELEASE_URL);

const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(1);
let verdict = "VERDICT: SMOKE FAILED — record failure mode before re-running";

const NAME = "smoke-firstboot";
const PIN = "smoke-firstboot-pin-4242";
const PASSPHRASE = "smoke-firstboot-passphrase";
const PHASES = ["network", "luks", "install", "download", "initdb", "services", "ready"];

try {
  await page.goto("http://localhost:18123/selfhost.html");
  await page.evaluate(() => window.__selfhostReady);
  console.log(`[+${elapsed()}s] selfhost.html loaded, initSelfhostPage() resolved`);

  // --- Creation form: real UI, real fields, real pre-flight -----------------
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

  // Observational only (a MutationObserver over the real DOM js/ui.js
  // already renders) — does not touch app internals, just records every
  // distinct phase-progress label this session sees, with a timestamp, so
  // the full sequence can be asserted/logged below even though the DOM only
  // ever shows the LATEST phase (early transitions like network->luks can
  // be seconds apart — see dev/NOTES.md "Task 6" LUKS timings).
  await page.evaluate(() => {
    window.__smokeStart = Date.now();
    window.__smokePhases = [];
    const list = document.getElementById("instance-list");
    const record = () => {
      const el = document.querySelector('.instance-card [data-testid="phase-progress"]');
      const text = el ? el.textContent : null;
      const last = window.__smokePhases.length ? window.__smokePhases[window.__smokePhases.length - 1].text : null;
      if (text && text !== last) window.__smokePhases.push({ text, t: Date.now() - window.__smokeStart });
    };
    new MutationObserver(record).observe(list, { childList: true, subtree: true, characterData: true });
    record();
  });

  // --- Play: real first boot through the real VmController ------------------
  await page.click('.instance-card [data-action="play"]');
  console.log(`[+${elapsed()}s] Play clicked, controller.start() invoked`);

  // Wait for the Open Dashboard button to become enabled — js/ui.js enables
  // it on `provisioned || phase === "ready"` (renderInstanceCard), and a
  // freshly created instance is `provisioned: false` until the `ready`
  // marker itself flips it, so this is still the real, UI-level "reached
  // ready" gate for this run, same evidence
  // dev/verify-dashboard.mjs relies on. Generous window: dev/NOTES.md
  // ("Task 8"/"how to reproduce") puts first boot to ready at roughly 6.5
  // minutes on this class of machine; not expected to be fast.
  const dashboardBtn = page.locator('.instance-card [data-action="dashboard"]');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('.instance-card [data-action="dashboard"]');
      return btn && !btn.disabled;
    },
    undefined,
    { timeout: 15 * 60_000, polling: 2000 },
  );
  console.log(`[+${elapsed()}s] Open Dashboard button enabled (phase: ready)`);

  const phases = await page.evaluate(() => window.__smokePhases);
  console.log("phase timeline observed via DOM:", JSON.stringify(phases));

  const seenLabels = phases.map((p) => p.text.split(" ")[0]);
  const phasesInOrder = PHASES.every((p, i) => {
    const idx = seenLabels.indexOf(p);
    return i === 0 || idx === -1 || seenLabels.indexOf(PHASES[i - 1]) <= idx;
  });
  const sawNetwork = seenLabels.includes("network");
  const dashboardEnabled = await dashboardBtn.isEnabled();

  console.log(`sawNetwork=${sawNetwork} phasesInOrder=${phasesInOrder} dashboardEnabled(readyGate)=${dashboardEnabled}`);

  if (sawNetwork && phasesInOrder && dashboardEnabled) {
    verdict = "VERDICT: SMOKE OK — instance created against a real local relay and reached ready";
  } else {
    verdict = `VERDICT: SMOKE FAILED — sawNetwork=${sawNetwork} phasesInOrder=${phasesInOrder} dashboardEnabled=${dashboardEnabled}`;
  }
  console.log(verdict);
  if (!(sawNetwork && phasesInOrder && dashboardEnabled)) throw new Error(verdict);
} catch (err) {
  console.log("smoke-firstboot.mjs: error/timeout during verification:", err && err.message ? err.message : err);
  const phases = await page.evaluate(() => window.__smokePhases).catch(() => []);
  console.log("phase timeline at failure:", JSON.stringify(phases));
  console.log(verdict);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.close();
  relay.kill();
}
