// Task 7 boot-test: boots the committed boot artifacts (../boot/vmlinuz +
// ../boot/initramfs.img) plus an empty 2 GiB disk under v86, drives
// networking through multica-relay (wisp://, same as verify-net.mjs /
// verify-luks.mjs), sends a test passphrase over ttyS1, and watches for the
// marker sequence network -> luks -> install -> download that
// stage2_install (guest/provision.sh) emits while bootstrapping a full
// Alpine root (OpenRC, PostgreSQL 17 + pgvector, Node.js) into /mnt via
// apk.static.
//
// Reaching a debug shell for the `chroot /mnt /usr/bin/psql --version`
// probe needs NO temporary test-only modification (unlike Task 6): the
// shipped, unmodified guest/init-selfhost calls `stage3_multica` right
// after `stage2_install` returns, and stage3_multica is intentionally
// still undefined until Task 8 — so it naturally "not found"s (exit 127),
// `fail "multica-failed"` fires, and that `exec /bin/sh`s over ttyS0. This
// is the exact natural-fallthrough path Task 6's NOTES.md documented for
// its own "shipped build" run once stage1 was defined but stage2 wasn't;
// same mechanism, one stage further along now that stage2 IS defined.
//
// Installing 40+ packages (Alpine base + PostgreSQL 17/pgvector + Node.js)
// through the relay, then chroot'ing to run rc-update, is slow under 386
// emulation — budgets below are generous (brief allows up to 20 minutes of
// emulated time for this whole stage).
import { chromium } from "playwright";
import { createServer } from "http";
import { statSync, createReadStream, readFileSync } from "fs";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const devDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(devDir); // deploy/selfhost-web

// Range-aware static file server on :18123, rooted one level up from dev/ —
// same reasoning/implementation as verify-luks.mjs (see dev/NOTES.md):
// harness-install.html's `hda` disk image needs real HTTP Range support.
const srv = createServer((req, res) => {
  const reqPath = req.url === "/" ? "/dev/harness-install.html" : req.url.split("?")[0];
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

// Same relay-build-and-spawn pattern as verify-net.mjs/verify-luks.mjs (see
// dev/NOTES.md re: `go run` module-resolution/orphan-process issues from dev/).
const relayDir = new URL("../relay", import.meta.url).pathname;
const relayBin = new URL(".", import.meta.url).pathname + ".relay-bin";
execSync("go build -o " + JSON.stringify(relayBin) + " .", { cwd: relayDir, stdio: "inherit" });
const relay = spawn(relayBin, ["-listen", ":18086"], { stdio: "inherit" });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));
await page.goto("http://localhost:18123/dev/harness-install.html");

async function waitSerial(pattern, timeoutMs) {
  await page.waitForFunction(
    (p) => new RegExp(p).test(window.serialLog),
    pattern, { timeout: timeoutMs, polling: 1000 },
  );
}

const PASSPHRASE = "test-passphrase-task7";
let verdict = "VERDICT: INSTALL FAILED — record failure mode in NOTES.md";
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

  // apk.static bootstrapping ~40+ packages (alpine-base, openrc, linux-virt,
  // postgresql17+contrib+pgvector, nodejs, curl, ca-certificates,
  // cryptsetup, btrfs-progs) over the relay, under 386 emulation. Generous
  // budget per the task's 20-minute-emulated-time allowance.
  await waitSerial("@@SH:phase:download@@", 900_000);
  console.log(`[+${elapsed()}s] download marker seen (stage2_install completed)`);

  // Natural fallthrough: stage3_multica is undefined until Task 8, so
  // init-selfhost's `stage3_multica || fail "multica-failed"` fires next,
  // and fail() execs /bin/sh over ttyS0. Wait for that debug shell prompt.
  await waitSerial("~ #\\s*$", 120_000);
  console.log(`[+${elapsed()}s] debug shell ready`);

  // Split-marker anti-echo trick (see dev/NOTES.md, Task 3 section): this
  // is typed/echoed interactive input, so avoid a literal contiguous
  // "PSQL_OK" appearing in the typed command itself.
  await page.evaluate(() =>
    sendCmd("chroot /mnt /usr/bin/psql --version && echo PSQL''_OK"));
  await waitSerial("PSQL_OK", 30_000);
  console.log(`[+${elapsed()}s] psql probe confirmed`);

  const log = await page.evaluate(() => window.serialLog);
  const psqlMatch = log.match(/psql \(PostgreSQL\) [0-9.]+/);
  console.log("psql --version output:", psqlMatch ? psqlMatch[0] : "<not found in serialLog>");
  console.log(log.slice(-3000));

  verdict = (/PSQL_OK/.test(log) && psqlMatch && /^psql \(PostgreSQL\) 17\./.test(psqlMatch[0]))
    ? "VERDICT: INSTALL OK"
    : "VERDICT: INSTALL FAILED — record failure mode in NOTES.md";
  console.log(verdict);

  const marks = await page.evaluate(() => window.bootMarks);
  console.log("bootMarks:", JSON.stringify(marks));
} catch (err) {
  console.log("verify-install.mjs: error/timeout during verification:", err && err.message ? err.message : err);
  const log = await page.evaluate(() => window.serialLog).catch(() => "<no serialLog available>");
  console.log("--- last 5000 chars of serialLog at failure ---");
  console.log(log.slice(-5000));
  const marks = await page.evaluate(() => window.bootMarks).catch(() => ({}));
  console.log("bootMarks at failure:", JSON.stringify(marks));
  console.log(verdict);
} finally {
  await browser.close(); srv.close(); relay.kill();
}
