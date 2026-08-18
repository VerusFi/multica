// Task 6 boot-test: boots the committed boot artifacts (../boot/vmlinuz +
// ../boot/initramfs.img) plus an empty 2 GiB disk under v86, drives
// networking through multica-relay (wisp://, same as verify-net.mjs) and
// sends a test passphrase over ttyS1 (uart1) per the Global Constraints
// passphrase contract. Asserts the marker sequence
// @@SH:phase:network@@ -> @@SH:phase:luks@@ and, via a temporary debug
// shell (see dev/NOTES.md — the shipped init-selfhost does NOT carry this;
// only the test build used for this specific run does), that
// `grep btrfs /proc/mounts` shows the LUKS->btrfs mount landed at /mnt.
//
// LUKS format under 386 emulation is slow even with the reduced-KDF
// adaptation documented in guest/provision.sh — budgets below are generous.
import { chromium } from "playwright";
import { createServer } from "http";
import { statSync, createReadStream, readFileSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const devDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(devDir); // deploy/selfhost-web

// Static file server on :18123, rooted one level up from dev/ (same
// resolution reasoning as verify-boot.mjs — see dev/NOTES.md). Range-aware:
// harness-luks.html's `hda` disk image is loaded via `async: true` (HTTP
// Range requests, see dev/NOTES.md for why), and v86 aborts if a ranged
// request comes back as a plain 200 instead of 206 Partial Content
// (confirmed by reading node_modules/v86/build/libv86.js's fetch wrapper),
// so a plain readFileSync-based server (as verify-boot.mjs/verify-net.mjs
// use, fine for their non-ranged assets) is not sufficient here.
const srv = createServer((req, res) => {
  const reqPath = req.url === "/" ? "/dev/harness-luks.html" : req.url.split("?")[0];
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

// Same relay-spawn pattern as verify-net.mjs: relay is relay.py, spawned
// directly via `python3`, no build step.
const relayPy = new URL("../relay.py", import.meta.url).pathname;
const relay = spawn("python3", [relayPy, "-listen", ":18086"], { stdio: "inherit" });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));
await page.goto("http://localhost:18123/dev/harness-luks.html");

async function waitSerial(pattern, timeoutMs) {
  await page.waitForFunction(
    (p) => new RegExp(p).test(window.serialLog),
    pattern, { timeout: timeoutMs, polling: 1000 },
  );
}

const PASSPHRASE = "test-passphrase-task6";
let verdict = "VERDICT: LUKS FAILED — record failure mode in NOTES.md";
const start = Date.now();
const elapsed = () => ((Date.now() - start) / 1000).toFixed(1);
try {
  await waitSerial("@@SH:phase:network@@", 120_000);
  console.log(`[+${elapsed()}s] network marker seen`);

  // Passphrase travels ONLY over ttyS1 (uart1), newline-terminated, per the
  // Global Constraints contract — never on ttyS0/cmdline/storage.
  await page.evaluate((pass) => window.sendPassphrase(pass), PASSPHRASE);
  console.log(`[+${elapsed()}s] passphrase sent on ttyS1`);

  await waitSerial("@@SH:phase:luks@@", 60_000);
  console.log(`[+${elapsed()}s] luks marker seen`);

  // LUKS format (even pbkdf2-reduced) + btrfs mkfs under 386 emulation is
  // slow — generous budget. The test build drops to a debug shell right
  // after stage1_disk (see dev/NOTES.md); wait for that shell prompt.
  await waitSerial("~ #\\s*$", 480_000);
  console.log(`[+${elapsed()}s] debug shell ready`);

  await page.evaluate(() => sendCmd("grep btrfs /proc/mounts && echo BTRFS''_OK"));
  await waitSerial("BTRFS_OK", 30_000);
  console.log(`[+${elapsed()}s] btrfs probe confirmed`);

  const log = await page.evaluate(() => window.serialLog);
  console.log(log.slice(-3000));
  verdict = /BTRFS_OK/.test(log) ? "VERDICT: LUKS OK" : "VERDICT: LUKS FAILED — record failure mode in NOTES.md";
  console.log(verdict);

  const marks = await page.evaluate(() => window.bootMarks);
  console.log("bootMarks:", JSON.stringify(marks));
} catch (err) {
  console.log("verify-luks.mjs: error/timeout during verification:", err && err.message ? err.message : err);
  const log = await page.evaluate(() => window.serialLog).catch(() => "<no serialLog available>");
  console.log("--- last 3000 chars of serialLog at failure ---");
  console.log(log.slice(-3000));
  const marks = await page.evaluate(() => window.bootMarks).catch(() => ({}));
  console.log("bootMarks at failure:", JSON.stringify(marks));
  console.log(verdict);
} finally {
  await browser.close(); srv.close(); relay.kill();
}
