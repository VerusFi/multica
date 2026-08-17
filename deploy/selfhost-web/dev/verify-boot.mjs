// Task 4 boot-test: boots the committed boot artifacts (../boot/vmlinuz +
// ../boot/initramfs.img, no cdrom) under v86 and asserts the skeleton
// init-selfhost prints its @@SH:phase:network@@ marker within 120s. Unlike
// verify-net.mjs (Task 3), this does not need multica-relay — the
// skeleton /init skeleton does no networking, it only proves the
// initramfs/kernel pair boots and our /init runs.
import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const devDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(devDir); // deploy/selfhost-web — serves both dev/ and boot/

// static file server on :18123, rooted one level up from dev/ so relative
// paths in harness-boot.html (../boot/vmlinuz etc.) resolve on disk too.
const srv = createServer((req, res) => {
  const reqPath = req.url === "/" ? "/dev/harness-boot.html" : req.url.split("?")[0];
  const filePath = path.join(rootDir, reqPath);
  try { res.end(readFileSync(filePath)); } catch { res.statusCode = 404; res.end(); }
}).listen(18123);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));
// NOTE: must navigate to the actual /dev/ path (not "/") so the document's
// base URL makes harness-boot.html's relative references resolve
// correctly: node_modules/v86/... under /dev/, and ../boot/vmlinuz up to
// the parent (rootDir). Navigating to "/" broke node_modules/v86/... (it
// resolved to a nonexistent /node_modules at rootDir) even though the
// ../boot/... paths happened to still work by URL-root clamping. See
// dev/NOTES.md.
await page.goto("http://localhost:18123/dev/harness-boot.html");

async function waitSerial(pattern, timeoutMs) {
  await page.waitForFunction(
    (p) => new RegExp(p).test(window.serialLog),
    pattern, { timeout: timeoutMs, polling: 500 },
  );
}

let verdict = "VERDICT: BOOT FAILED — record failure mode in NOTES.md";
const start = Date.now();
try {
  await waitSerial("@@SH:phase:network@@", 120_000);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const log = await page.evaluate(() => window.serialLog);
  console.log(log.slice(-2000));
  verdict = `VERDICT: BOOT OK — marker seen at +${elapsed}s`;
  console.log(verdict);

  const marks = await page.evaluate(() => window.bootMarks);
  console.log("bootMarks:", JSON.stringify(marks));
} catch (err) {
  console.log("verify-boot.mjs: error/timeout during verification:", err && err.message ? err.message : err);
  const log = await page.evaluate(() => window.serialLog).catch(() => "<no serialLog available>");
  console.log("--- last 2000 chars of serialLog at failure ---");
  console.log(log.slice(-2000));
  const marks = await page.evaluate(() => window.bootMarks).catch(() => ({}));
  console.log("bootMarks at failure:", JSON.stringify(marks));
  console.log(verdict);
} finally {
  await browser.close(); srv.close();
}
