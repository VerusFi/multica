// Boots the harness and asserts: shell ready, address configured, DNS + HTTPS work.
import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";

// NOTE: brief's default ports (relay :8086, static server :8123) were both
// already bound by unrelated processes on this dev machine (a Lima VM
// hostagent, and a stray Python server). Using 18086/18123 instead; this is
// purely a local port choice and does not affect the WISP verification
// itself. harness.html's net_device.relay_url is kept in sync — see
// dev/NOTES.md.
// NOTE: relay is relay.py, spawned directly via `python3` — no build step,
// so relay.kill() below controls the actual listening process directly.
// See dev/NOTES.md for the historical go-run/go-build rationale.
const relayPy = new URL("../relay.py", import.meta.url).pathname;
const relay = spawn("python3", [relayPy, "-listen", ":18086"], { stdio: "inherit" });
// static file server on :18123 serving this directory
const srv = createServer((req, res) => {
  const path = "." + (req.url === "/" ? "/harness.html" : req.url.split("?")[0]);
  try { res.end(readFileSync(path)); } catch { res.statusCode = 404; res.end(); }
}).listen(18123);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));
await page.goto("http://localhost:18123/");

async function waitSerial(pattern, timeoutMs) {
  await page.waitForFunction(
    (p) => new RegExp(p).test(window.serialLog),
    pattern, { timeout: timeoutMs, polling: 1000 },
  );
}

// IMPORTANT: the interactive shell echoes typed input back over the same
// ttyS0 stream (normal tty cooked-mode echo). Since the commands below
// *contain* their own success marker as literal text (`echo NET_UP`,
// `echo APK_NET_OK`), that marker string appears in serialLog TWICE: once
// almost immediately as part of the echoed input line, and once (much
// later, and only on success) as genuine command output. A plain
// substring/regex test against serialLog matches on the first (input-echo)
// occurrence, which is a false positive that fires even if the command
// never runs or fails — confirmed experimentally: with the relay refusing
// connections, "VERDICT: WISP OK" still printed. Fix: split the marker
// with an empty-string shell concatenation (`NET''_UP`) so the literal,
// contiguous marker text is never present in the typed/echoed command —
// only the executed `echo` prints it contiguously.
let verdict = "VERDICT: WISP FAILED — record failure mode in NOTES.md";
try {
  await waitSerial("localhost:~#", 240_000);                       // shell ready
  await page.evaluate(() => sendCmd("ifconfig eth0 up; udhcpc -i eth0 -t 10 && echo NET''_UP"));
  await waitSerial("NET_UP|no lease", 90_000);
  await page.evaluate(() => sendCmd(
    "printf \"https://dl-cdn.alpinelinux.org/alpine/v3.23/main\\n\" > /etc/apk/repositories && apk update && echo APK''_NET''_OK"));
  await waitSerial("APK_NET_OK|ERROR|WARNING", 180_000);

  const log = await page.evaluate(() => window.serialLog);
  console.log(log.slice(-2000));
  verdict = /APK_NET_OK/.test(log) ? "VERDICT: WISP OK" : "VERDICT: WISP FAILED — record failure mode in NOTES.md";
  console.log(verdict);

  const marks = await page.evaluate(() => window.bootMarks);
  console.log("bootMarks:", JSON.stringify(marks));
} catch (err) {
  console.log("verify-net.mjs: error/timeout during verification:", err && err.message ? err.message : err);
  const log = await page.evaluate(() => window.serialLog).catch(() => "<no serialLog available>");
  console.log("--- last 2000 chars of serialLog at failure ---");
  console.log(log.slice(-2000));
  const marks = await page.evaluate(() => window.bootMarks).catch(() => ({}));
  console.log("bootMarks at failure:", JSON.stringify(marks));
  console.log(verdict);
} finally {
  await browser.close(); srv.close(); relay.kill();
}
