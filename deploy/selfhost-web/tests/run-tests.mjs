// Standalone browser test runner (no monorepo deps): serves the page dir,
// loads each spec module in Chromium, executes its exported run().
import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, statSync } from "fs";
import { extname, join } from "path";

const root = new URL("..", import.meta.url).pathname;

// The whole suite is served from a SUBPATH prefix, exactly like a GitHub
// Pages *project* site (owner.github.io/<repo>/selfhost.html) — nothing is
// reachable at the origin root here. Any origin-rooted reference in the
// shipped page or in a spec ("/js/ui.js") therefore 404s instead of
// silently working, which is how a real subpath deployment behaves and what
// the suite used to be blind to (it served everything from "/"). Specs
// import their modules relatively ("../js/…"); tests/subpath.spec.mjs
// asserts the page still initializes here and that no absolute-rooted
// asset references have crept back in.
const BASE = "/subpath-deploy-check";
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".css": "text/css", ".wasm": "application/wasm" };
const srv = createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url !== BASE && !url.startsWith(`${BASE}/`)) { res.statusCode = 404; res.end(); return; }
  const p = join(root, url.slice(BASE.length));
  try {
    statSync(p);
    res.setHeader("content-type", mime[extname(p)] ?? "application/octet-stream");
    res.end(readFileSync(p));
  } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const port = srv.address().port;

const specs = process.argv.slice(2).length ? process.argv.slice(2) : ["tests/vault.spec.mjs", "tests/instance-manager.spec.mjs", "tests/vm-controller.spec.mjs", "tests/ui.spec.mjs", "tests/subpath.spec.mjs"];
const browser = await chromium.launch();
let failed = 0;
for (const spec of specs) {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => m.type() === "error" && console.error(`[${spec}]`, m.text()));
  await page.goto(`http://localhost:${port}${BASE}/selfhost.html`);
  try {
    await page.evaluate(async (s) => (await import(s)).run(), `${BASE}/${spec}`);
    console.log(`PASS ${spec}`);
  } catch (e) { failed++; console.error(`FAIL ${spec}\n${e}`); }
}
await browser.close(); srv.close();
process.exit(failed ? 1 : 0);
