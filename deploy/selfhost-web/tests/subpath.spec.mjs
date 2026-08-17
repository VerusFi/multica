// Subpath-deployment regression spec.
//
// A GitHub Pages *project* site serves this directory from a subpath
// (https://<owner>.github.io/<repo>/selfhost.html), not from the origin
// root. Any origin-rooted reference in a shipped page ("/js/ui.js",
// href="/vendor/…", fetch("/…")) resolves to the domain root there, 404s,
// and — for the module script — leaves the page completely inert with no
// visible error. That is exactly what shipped once (selfhost.html imported
// "/js/ui.js") and the suite could not see it, because tests/run-tests.mjs
// used to serve everything from "/".
//
// The runner now serves the whole suite from a subpath prefix, so every spec
// exercises the real deployment shape. This spec makes the guarantee
// explicit: (1) we really are on a subpath, (2) the page's module graph
// resolved and initialized there, and (3) no absolute-rooted asset
// reference has crept back into the shipped pages.
export async function run() {
  // 1. The runner must actually be serving from a subpath — otherwise the
  // rest of this spec would pass vacuously.
  const dir = location.pathname.replace(/[^/]*$/, "");
  if (dir === "/") {
    throw new Error("this spec is meaningless at the origin root: run-tests.mjs must serve the page from a subpath prefix");
  }

  // 2. The page's module script resolved relative to that subpath and ran.
  // An absolute "/js/ui.js" import 404s here, the module body never
  // executes, and __selfhostReady is never assigned.
  if (!window.__selfhostReady) {
    throw new Error(`selfhost.html did not set window.__selfhostReady when served from ${dir} (absolute module path?)`);
  }
  await window.__selfhostReady;

  // The module didn't just load, it wired the DOM: the empty-DB affordance
  // responds to a real click.
  const showCreate = document.getElementById("btn-show-create");
  const creationForm = document.getElementById("creation-form");
  if (!showCreate || !creationForm) throw new Error("missing #btn-show-create / #creation-form");
  showCreate.click();
  if (creationForm.hidden) throw new Error("the page's own event wiring did not run under a subpath deployment");

  // Every asset the page pulls must also resolve under the prefix.
  for (const url of ["vendor/xterm.css", "js/ui.js", "js/vm-controller.js"]) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} did not resolve relative to ${dir} (HTTP ${res.status})`);
  }
  // Sanity check that the prefix is genuinely enforced (a server that also
  // answered at the root would make the assertions above meaningless).
  const rooted = await fetch("/js/ui.js");
  if (rooted.ok) throw new Error("the test server answered an origin-rooted path — the subpath check is not being enforced");

  // 3. Static scan of the shipped pages for origin-rooted references. Cheap
  // and total: it catches a reintroduction anywhere in the markup, including
  // parts of the page this spec never exercises at runtime. Protocol-relative
  // URLs ("//cdn.example/x") are not subpath-sensitive and are excluded.
  const patterns = [
    /(?:src|href)\s*=\s*["'](\/[^/"'][^"']*)["']/g,
    /(?:import|from)\s*["'](\/[^/"'][^"']*)["']/g,
    /(?:import|fetch|register)\s*\(\s*["'](\/[^/"'][^"']*)["']/g,
  ];
  for (const page of ["selfhost.html", "index.html"]) {
    const res = await fetch(page);
    if (!res.ok) throw new Error(`could not fetch ${page} (HTTP ${res.status})`);
    const html = await res.text();
    const found = [];
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(html))) found.push(m[1]);
    }
    if (found.length) {
      throw new Error(`${page} has origin-rooted reference(s) that break a subpath deployment: ${JSON.stringify(found)}`);
    }
  }
}
