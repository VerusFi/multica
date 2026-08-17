// Creation-flow UI: form validation, relay pre-flight, and the DOM wiring for
// the zero-instance "Create a self host instance" flow (spec §4, plan Task 13).
//
// Passphrase hygiene (spec §4 "Configuration vault and PIN"): the disk
// passphrase is only ever handed to sealVault() as part of the encrypted
// vault payload. It is never written into instance metadata (putInstance),
// never touches localStorage, and is cleared from its <input> the moment a
// creation attempt finishes (success or failure). The PIN is used in-memory
// to derive the vault key and is never persisted anywhere, per spec.
//
// Task 14 extends this file with the PIN-gated instance list and lifecycle
// controls (play/pause/stop/View Console/Open Dashboard).
//
// PIN-gate + vault-in-memory model (spec §4 "Configuration vault and PIN",
// carried over from Task 13's header note above): on load, a non-empty DB
// (a sealed vault blob exists in `meta`) shows a PIN prompt and renders
// nothing else until it is unlocked. `openVault()` either returns the
// decrypted `{ passphrases: {instanceId: passphrase} }` object (kept in the
// `unlockedVault` module-level variable below — page memory only, never
// written back to IndexedDB/localStorage, never in the DOM) or throws
// WrongPinError, which is surfaced as a visible error while the instance
// list stays hidden/empty. The PIN itself is read from its <input> only for
// the duration of the unlock attempt and is cleared immediately on success
// (mirroring Task 13's `resetForm`); a wrong PIN is treated the same
// retry-UX way Task 13 treats a wrong PIN during vault-merge on create — see
// the comment at `handlePinUnlock`'s catch branch below.
import { createVaultSession, unsealVault, resealVault, WrongPinError } from "./vault.js";
import { getVaultBlob, putVaultBlob, listInstances, putInstance, deleteInstance } from "./instance-manager.js";
import { VmController } from "./vm-controller.js";
import { attachConsole } from "./console.js";

const RELAY_PROTOCOLS = new Set(["wisp:", "ws:", "wss:"]);

// --- pure/exported logic (unit-tested directly, no DOM) ------------------

/**
 * Validate the creation form's values.
 * @param {object} values - { name, pin, diskSizeGB, relayUrl, passphrase, passphrase2 }
 * @returns {{ok:true}|{ok:false, errors:Record<string,string>}}
 */
export function validateCreationForm(values) {
  const v = values || {};
  const errors = {};

  const name = typeof v.name === "string" ? v.name.trim() : "";
  if (!name) errors.name = "Instance name is required.";

  const pin = typeof v.pin === "string" ? v.pin : v.pin == null ? "" : String(v.pin);
  if (!pin) errors.pin = "Vault PIN is required.";

  const diskSizeGB = v.diskSizeGB;
  const diskNum = typeof diskSizeGB === "number" ? diskSizeGB : Number(diskSizeGB);
  const diskProvided = diskSizeGB !== "" && diskSizeGB !== undefined && diskSizeGB !== null;
  if (!diskProvided || !Number.isInteger(diskNum) || diskNum <= 0) {
    errors.diskSizeGB = "Disk size must be a positive whole number of GB.";
  }

  const relayUrl = typeof v.relayUrl === "string" ? v.relayUrl.trim() : "";
  if (!relayUrl) {
    errors.relayUrl = "Relay address is required.";
  } else {
    let parsed = null;
    try {
      parsed = new URL(relayUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || !RELAY_PROTOCOLS.has(parsed.protocol)) {
      errors.relayUrl = "Relay address must start with wisp://, ws:// or wss://.";
    }
  }

  const passphrase = typeof v.passphrase === "string" ? v.passphrase : v.passphrase == null ? "" : String(v.passphrase);
  const passphrase2 = typeof v.passphrase2 === "string" ? v.passphrase2 : v.passphrase2 == null ? "" : String(v.passphrase2);
  if (!passphrase) errors.passphrase = "Disk passphrase is required.";
  if (!passphrase2) errors.passphrase2 = "Please confirm the disk passphrase.";
  if (passphrase && passphrase2 && passphrase !== passphrase2) {
    errors.passphrase2 = "Passphrases do not match.";
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true };
}

/**
 * Test whether a relay is reachable by opening a WebSocket to it.
 * `wisp://` addresses are dialled over `ws://` — WISP is a protocol layered
 * on top of a plain WebSocket, not a distinct transport scheme.
 * @param {string} relayUrl
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<void>} resolves on `open`, rejects on `error` or timeout.
 */
export function preflightRelay(relayUrl, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;

    const finish = (ok, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws) {
        ws.onopen = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      ok ? resolve() : reject(err);
    };

    const timer = setTimeout(() => {
      finish(false, new Error(`Timed out connecting to relay at ${relayUrl}.`));
    }, timeoutMs);

    try {
      ws = new WebSocket(relayUrl.replace(/^wisp/, "ws"));
    } catch (err) {
      finish(false, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false, new Error(`Could not connect to relay at ${relayUrl}.`));
  });
}

// Boot-phase marker order, per the shipped guest's `@@SH:phase:*@@` marker
// contract (see dev/NOTES.md "Task 8"/vm-controller.js's PHASE_RE). Used
// only to compute the phase-progress bar's fill percentage below.
const PHASES = ["network", "luks", "install", "download", "initdb", "services", "ready"];

/**
 * Button-visibility matrix for an instance card, keyed by VmController
 * state ("stopped"|"starting"|"running"|"paused"). Exported standalone
 * (independent of `renderInstanceCard`) so a spec can assert the matrix
 * directly without touching the DOM.
 * @param {string} state
 * @returns {{play:boolean, pause:boolean, stop:boolean}}
 */
export function instanceCardButtons(state) {
  if (state === "running") return { play: false, pause: true, stop: true };
  if (state === "paused") return { play: true, pause: false, stop: true };
  // "stopped" -> play only; any other/transitional state (e.g. "starting")
  // -> no actionable buttons, a safe default for a state not in the brief's
  // matrix.
  return { play: state === "stopped", pause: false, stop: false };
}

function formatCreatedAt(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "unknown date";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/**
 * Pure instance-card renderer: builds the `<li>` for one instance from its
 * metadata plus an explicit VmController state (+ optional latest onPhase
 * marker), with no dependency on a live VmController/v86 instance. This is
 * deliberately structured as a pure function of (instance, state, phase) —
 * per the Task 14 brief — so the spec can drive the state matrix directly
 * ("do NOT boot v86 in unit specs"); the live page wires the buttons this
 * produces via event delegation on `#instance-list` (see
 * `wireInstanceListActions`), not from inside this function.
 *
 * The phase-progress bar is gated on `phase` presence, NOT on `state`:
 * VmController transitions "starting" -> "running" synchronously on
 * `emulator-ready` (vm-controller.js's `_start`/`_bindEmulator`), which
 * fires before the guest has written a single byte of serial output — every
 * `@@SH:phase:*@@` marker therefore always arrives while `state ===
 * "running"`, never while `state === "starting"`. Gating on `state ===
 * "starting"` would make the bar structurally dead (fix from review: was
 * gated on state, which never overlaps with when a phase is actually
 * known). The state badge itself is still driven by `state`, independently.
 * @param {Document} doc
 * @param {object} instance - metadata record (id, name, diskSizeGB, relayUrl, createdAt)
 * @param {string} [state="stopped"] - "stopped"|"starting"|"running"|"paused"
 * Persisted-metadata flags matter here precisely because `state`/`phase` are
 * page-session-only: after a reload there is no controller and no phase
 * marker, so `instance.provisioned` is what keeps "Open Dashboard" reachable
 * and `instance.state` is what tells the card that Play will resume from a
 * snapshot (label "Resume") rather than cold-boot.
 * @param {string|null} [phase=null] - latest onPhase marker seen this session, or null
 * @returns {HTMLLIElement}
 */
export function renderInstanceCard(doc, instance, state = "stopped", phase = null) {
  const li = doc.createElement("li");
  li.className = "instance-card";
  li.dataset.instanceId = instance.id;

  const name = doc.createElement("strong");
  name.textContent = instance.name;
  li.appendChild(name);

  const badge = doc.createElement("span");
  badge.className = "state-badge";
  badge.dataset.testid = "state-badge";
  badge.textContent = state;
  li.appendChild(badge);

  const summary = doc.createElement("p");
  summary.className = "instance-summary";
  summary.textContent = `${instance.diskSizeGB} GB · ${instance.relayUrl} · created ${formatCreatedAt(instance.createdAt)}`;
  li.appendChild(summary);

  // Shown whenever a phase marker has been seen and provisioning isn't done
  // yet — see the phase-vs-state gating note in this function's doc comment
  // above (NOT gated on `state`).
  if (phase && phase !== "ready") {
    const bar = doc.createElement("div");
    bar.className = "phase-progress";
    bar.dataset.testid = "phase-progress";
    const idx = PHASES.indexOf(phase);
    const pct = idx >= 0 ? Math.round(((idx + 1) / PHASES.length) * 100) : 0;
    bar.style.setProperty("--pct", `${pct}%`);
    bar.textContent = `${phase} (${pct}%)`;
    li.appendChild(bar);
  }

  const actions = doc.createElement("div");
  actions.className = "actions instance-actions";

  const buttons = instanceCardButtons(state);

  const playBtn = doc.createElement("button");
  playBtn.type = "button";
  playBtn.dataset.action = "play";
  // "Resume" for a live paused controller, and also for a stopped card whose
  // last persisted state was "paused" (i.e. after a reload): start() restores
  // that snapshot instead of cold-booting, so "Play" would misdescribe it.
  const resumes = state === "paused" || (state === "stopped" && instance.state === "paused");
  playBtn.textContent = resumes ? "Resume" : "Play";
  playBtn.hidden = !buttons.play;
  actions.appendChild(playBtn);

  const pauseBtn = doc.createElement("button");
  pauseBtn.type = "button";
  pauseBtn.dataset.action = "pause";
  pauseBtn.textContent = "Pause";
  pauseBtn.hidden = !buttons.pause;
  actions.appendChild(pauseBtn);

  const stopBtn = doc.createElement("button");
  stopBtn.type = "button";
  stopBtn.dataset.action = "stop";
  stopBtn.textContent = "Stop";
  stopBtn.hidden = !buttons.stop;
  actions.appendChild(stopBtn);

  const consoleBtn = doc.createElement("button");
  consoleBtn.type = "button";
  consoleBtn.dataset.action = "console";
  consoleBtn.textContent = "View Console";
  actions.appendChild(consoleBtn);

  // Open Dashboard: enabled from phase "ready" onward. Task 15's spike
  // (dev/NOTES.md "Task 15") found no way for this page to open a real
  // connection into a wisp://-networked guest, so this opens the
  // documented fallback panel (#dashboard-panel) instead of a live
  // dashboard tab — wired through the same [data-action] delegation as
  // play/pause/stop/console (see onCardAction).
  //
  // Gated on `provisioned || phase === "ready"`, not on the phase alone
  // (fix from review): `phase` comes from `phaseByInstance`, which is
  // page-session state, and the guest emits the `ready` marker exactly once
  // per provisioning — a resumed snapshot never replays it. Gating on the
  // marker alone left the button permanently disabled for every instance
  // after a reload, i.e. for every instance a user comes back to.
  const dashboardBtn = doc.createElement("button");
  dashboardBtn.type = "button";
  dashboardBtn.dataset.action = "dashboard";
  dashboardBtn.textContent = "Open Dashboard";
  dashboardBtn.disabled = !(instance.provisioned || phase === "ready");
  actions.appendChild(dashboardBtn);

  const deleteBtn = doc.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.dataset.action = "delete";
  deleteBtn.className = "danger";
  deleteBtn.textContent = "Delete";
  actions.appendChild(deleteBtn);

  li.appendChild(actions);

  // Two-step, in-card delete confirmation. Deliberately not window.confirm():
  // a modal browser dialog blocks the whole page (including the emulator's
  // own event loop) and cannot be driven by the DOM specs. Rendered hidden;
  // `onCardAction` reveals it and the confirm button does the real work.
  const confirmRow = doc.createElement("div");
  confirmRow.className = "actions delete-confirm";
  confirmRow.dataset.testid = "delete-confirm";
  confirmRow.hidden = true;

  const confirmText = doc.createElement("span");
  confirmText.className = "hint";
  confirmText.textContent = "Delete this instance and everything stored for it — virtual disk, snapshots and its saved passphrase? This cannot be undone.";
  confirmRow.appendChild(confirmText);

  const confirmBtn = doc.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.dataset.action = "delete-confirm";
  confirmBtn.className = "danger";
  confirmBtn.textContent = "Delete permanently";
  confirmRow.appendChild(confirmBtn);

  const cancelDeleteBtn = doc.createElement("button");
  cancelDeleteBtn.type = "button";
  cancelDeleteBtn.dataset.action = "delete-cancel";
  cancelDeleteBtn.textContent = "Keep";
  confirmRow.appendChild(cancelDeleteBtn);

  li.appendChild(confirmRow);
  return li;
}

// --- vault plumbing --------------------------------------------------------

// The decrypted vault payload (`{ passphrases: {instanceId: passphrase} }`),
// held only in page memory once unlocked (initial PIN gate, per
// `handlePinUnlock`, or implicitly right after a successful create, per
// `addInstanceToVault` below — the user already proved they know the PIN).
// Never persisted anywhere beyond this variable; see the header comment.
let unlockedVault = null;

// The vault session (derived key + salt) matching `unlockedVault`, so the
// page can reseal an updated payload — deleting an instance has to remove
// its passphrase from the blob — without ever holding on to the PIN. See
// js/vault.js's session comment.
let vaultSession = null;

// Add a newly created instance's passphrase to the (possibly not-yet-existing)
// sealed vault. Never stores the PIN itself; the passphrase lives only inside
// the encrypted blob under `passphrases[instanceId]`.
async function addInstanceToVault(pin, instanceId, passphrase) {
  const existingBlob = await getVaultBlob();
  let data = { passphrases: {} };
  let session;
  if (existingBlob) {
    const opened = await unsealVault(pin, existingBlob); // may throw WrongPinError
    data = opened.data && typeof opened.data === "object" ? opened.data : {};
    if (!data.passphrases) data.passphrases = {};
    session = opened.session;
  } else {
    session = await createVaultSession(pin);
  }
  data.passphrases[instanceId] = passphrase;
  await putVaultBlob(await resealVault(session, data));
  // The vault is now sealed with `data` as its plaintext — the caller just
  // proved they know the PIN, so treat the vault as unlocked for the rest of
  // this page session (no reason to make them re-enter the PIN they just
  // typed to see the card they just created).
  unlockedVault = data;
  vaultSession = session;
}

// --- DOM wiring ------------------------------------------------------------

function computePagesUrl() {
  const { origin, pathname } = location;
  const dir = pathname.slice(0, pathname.lastIndexOf("/") + 1);
  return origin + dir;
}

// The relay is an unauthenticated outbound proxy, so it accepts WebSockets
// only from localhost origins unless told otherwise (relay.py's -origin /
// DEFAULT_ORIGIN_PATTERNS). This page may be served from anywhere (a Pages
// site), so the one-liners hand the relay *this page's* origin via
// MULTICA_RELAY_ORIGIN — the only origin that legitimately needs access —
// instead of the relay having to trust every origin by default. The page's
// base URL rides along as MULTICA_RELAY_URL_BASE so relay.sh downloads
// relay.py from the same site that served it (fork-friendly).
function relayCommands() {
  const base = computePagesUrl();
  const origin = location.origin;
  return {
    macos: `curl -fsSL ${base}relay.sh | MULTICA_RELAY_ORIGIN=${origin} MULTICA_RELAY_URL_BASE=${base} sh`,
    linux: `curl -fsSL ${base}relay.sh | MULTICA_RELAY_ORIGIN=${origin} MULTICA_RELAY_URL_BASE=${base} sh`,
    windows: `$env:MULTICA_RELAY_ORIGIN='${origin}'; irm ${base}relay.ps1 | iex`,
  };
}

function collectElements(doc) {
  const byId = (id) => doc.getElementById(id);
  return {
    emptyState: byId("empty-state"),
    showCreateBtn: byId("btn-show-create"),
    creationForm: byId("creation-form"),
    cancelBtn: byId("btn-cancel-create"),
    createBtn: byId("btn-create"),
    relayError: byId("relay-error"),
    instanceList: byId("instance-list"),
    // Visible surface for lifecycle/runtime errors (see showLifecycleError).
    lifecycleError: byId("lifecycle-error"),
    lifecycleErrorMessage: byId("lifecycle-error-message"),
    btnLifecycleErrorDismiss: byId("btn-lifecycle-error-dismiss"),
    fields: {
      name: byId("field-name"),
      pin: byId("field-pin"),
      diskSizeGB: byId("field-disk-size"),
      relayUrl: byId("field-relay-url"),
      passphrase: byId("field-passphrase"),
      passphrase2: byId("field-passphrase2"),
      pinGate: byId("field-pin-gate"),
    },
    tabButtons: [...doc.querySelectorAll(".tab-btn")],
    tabPanels: [...doc.querySelectorAll("[data-tab-panel]")],
    copyButtons: [...doc.querySelectorAll(".copy-btn")],
    cmdMacos: byId("cmd-macos"),
    cmdLinux: byId("cmd-linux"),
    cmdWindows: byId("cmd-windows"),
    // Task 14: PIN gate.
    pinGate: byId("pin-gate-form"),
    pinGateError: byId("pin-gate-error"),
    btnUnlock: byId("btn-unlock"),
    // Task 14: console drawer.
    consoleDrawer: byId("console-drawer"),
    consoleDrawerTitle: byId("console-drawer-title"),
    consoleMount: byId("console-mount"),
    btnConsoleClose: byId("btn-console-close"),
    // Task 15: dashboard-access fallback panel.
    dashboardPanel: byId("dashboard-panel"),
    dashboardPanelTitle: byId("dashboard-panel-title"),
    btnDashboardClose: byId("btn-dashboard-close"),
    btnDashboardHealthcheck: byId("btn-dashboard-healthcheck"),
    dashboardHealthcheckResult: byId("dashboard-healthcheck-result"),
    dashboardHealthcheckHint: byId("dashboard-healthcheck-hint"),
  };
}

function readFormValues(els) {
  return {
    name: els.fields.name.value,
    pin: els.fields.pin.value,
    diskSizeGB: els.fields.diskSizeGB.value,
    relayUrl: els.fields.relayUrl.value,
    passphrase: els.fields.passphrase.value,
    passphrase2: els.fields.passphrase2.value,
  };
}

function clearFieldErrors(doc, els) {
  for (const el of doc.querySelectorAll(".field-error")) el.textContent = "";
  for (const key of Object.keys(els.fields)) {
    const input = els.fields[key];
    if (input) input.removeAttribute("aria-invalid");
  }
}

function showFieldErrors(doc, els, errors) {
  for (const [field, message] of Object.entries(errors)) {
    const errorEl = doc.querySelector(`[data-error-for="${field}"]`);
    if (errorEl) errorEl.textContent = message;
    const input = els.fields[field];
    if (input) input.setAttribute("aria-invalid", "true");
  }
}

function hideRelayError(els) {
  if (!els.relayError) return;
  els.relayError.hidden = true;
  els.relayError.textContent = "";
}

function showRelayError(doc, els, err) {
  if (!els.relayError) return;
  const message = err && err.message ? err.message : String(err);
  els.relayError.textContent = "";
  els.relayError.appendChild(doc.createTextNode(`${message} `));
  const link = doc.createElement("a");
  link.href = "#relay-instructions";
  link.textContent = "See relay setup instructions.";
  els.relayError.appendChild(link);
  els.relayError.hidden = false;
}

// Clear the passphrase/PIN inputs' live values without ever writing them
// anywhere else (attribute, storage) — see the passphrase-hygiene note at
// the top of this file.
function clearSecretFields(els) {
  if (els.fields.pin) els.fields.pin.value = "";
  if (els.fields.passphrase) els.fields.passphrase.value = "";
  if (els.fields.passphrase2) els.fields.passphrase2.value = "";
}

function resetForm(els) {
  if (els.creationForm && typeof els.creationForm.reset === "function") els.creationForm.reset();
  clearSecretFields(els);
}

// --- lifecycle: VmControllers, phase tracking, console drawer -------------
//
// One VmController per instance, created lazily (on first Play or View
// Console click, whichever comes first) and kept for the rest of the page
// session so pause/stop/View Console reuse the same live controller/
// emulator. Never constructed inside `renderInstanceCard` (kept pure per
// the brief) — only from real user interaction, via `getOrCreateController`.
const controllers = new Map(); // instanceId -> VmController
const phaseByInstance = new Map(); // instanceId -> latest onPhase marker seen
let currentInstances = []; // last listInstances() result, for click delegation lookups
let currentDoc = null;
let currentEls = null;
let activeConsoleSession = null; // { dispose, terminal, instanceId } | null
let activeDashboardInstance = null; // instance metadata | null — Task 15 dashboard panel

function controllerStateFor(instanceId) {
  const controller = controllers.get(instanceId);
  return controller ? controller.state : "stopped";
}

function rerenderList() {
  if (!currentDoc || !currentEls) return;
  renderInstanceList(currentDoc, currentEls, currentInstances);
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

// --- visible error surface -------------------------------------------------
//
// Every runtime failure an instance can hit — VmController's
// `autosave-failed:`/`start-failed:`/`resume-no-snapshot` reports, the
// guest's own `@@SH:err:*@@` markers, a refused start for a missing
// passphrase, a failed delete — lands here. It used to go to console.error
// only (with a comment deferring the surface to a later task that never
// delivered it), which means a user watched an instance quietly fail with no
// indication anything was wrong.
function hideLifecycleError(els) {
  if (!els.lifecycleError) return;
  els.lifecycleError.hidden = true;
  if (els.lifecycleErrorMessage) els.lifecycleErrorMessage.textContent = "";
}

function showLifecycleError(els, instance, message) {
  const text = instance && instance.name ? `${instance.name}: ${message}` : String(message);
  // Kept as a console.error too: the banner is for the user, the console
  // line is what a bug report can be built from.
  console.error(`[selfhost]`, text);
  if (!els.lifecycleError || !els.lifecycleErrorMessage) return;
  els.lifecycleErrorMessage.textContent = text;
  els.lifecycleError.hidden = false;
}

/**
 * Persist "provisioning finished" for an instance. The `ready` marker fires
 * exactly once per provisioning (VmController dedupes markers, and a snapshot
 * restore never replays them), so it must be written down: `phaseByInstance`
 * dies with the page session. The `provisioned` field existed for this from
 * the start but was written `false` at creation and never updated, which is
 * what left "Open Dashboard" permanently disabled after a reload.
 *
 * Exported for the same reason `checkVaultGate` is: it lets a spec assert the
 * write itself without a ~6-minute real boot to reach the marker.
 * @param {object} instance - metadata record (mutated in place, then stored)
 */
export async function recordProvisioned(instance) {
  if (instance.provisioned) return instance;
  instance.provisioned = true;
  await putInstance(instance);
  return instance;
}

function markProvisioned(els, instance) {
  recordProvisioned(instance).catch((err) =>
    showLifecycleError(els, instance, `could not record that provisioning finished: ${errText(err)}`),
  );
}

// Same persisted-once-never-updated trap as `provisioned`: `state` was
// written "stopped" at creation and never touched again. Keeping it truthful
// is what lets a reloaded card label its Play button "Resume" for an
// instance that was paused (renderInstanceCard) — the badge itself always
// reflects the live controller, which after a reload is correctly "stopped".
function persistState(els, instance, next) {
  if (instance.state === next) return;
  instance.state = next;
  putInstance(instance).catch((err) =>
    showLifecycleError(els, instance, `could not record instance state: ${errText(err)}`),
  );
}

// Returns null (after showing a visible error) when the instance has no
// passphrase in the unlocked vault. VmController delivers
// `this.passphrase + "\n"` to ttyS1 unconditionally, so an absent one — a
// metadata/vault disagreement, e.g. an instance record restored into a
// profile whose vault blob predates it — would type "undefined" at the LUKS
// prompt, and on a first boot the guest's stage1 would *format* the disk
// with that as its passphrase. Never construct a controller in that state.
function getOrCreateController(els, instance) {
  let controller = controllers.get(instance.id);
  if (controller) return controller;
  const passphrase = unlockedVault && unlockedVault.passphrases ? unlockedVault.passphrases[instance.id] : undefined;
  if (typeof passphrase !== "string" || passphrase === "") {
    showLifecycleError(
      els,
      instance,
      "no disk passphrase for this instance in the unlocked vault, so it cannot be started or reached. " +
        "This happens when the instance's metadata and the vault disagree (e.g. the vault was resealed elsewhere). " +
        "Nothing was started — starting anyway would re-encrypt the disk with an unusable passphrase. Delete the instance and create a new one.",
    );
    return null;
  }
  controller = new VmController({
    instance,
    passphrase,
    onPhase: (phase) => {
      phaseByInstance.set(instance.id, phase);
      if (phase === "ready") markProvisioned(els, instance);
      rerenderList();
    },
    onError: (err) => showLifecycleError(els, instance, errText(err)),
    onStateChange: (next) => {
      persistState(els, instance, next);
      rerenderList();
    },
  });
  controllers.set(instance.id, controller);
  return controller;
}

function closeConsoleDrawer(els) {
  if (activeConsoleSession) {
    activeConsoleSession.dispose();
    activeConsoleSession = null;
  }
  if (els.consoleDrawer) els.consoleDrawer.hidden = true;
  syncDashboardHealthcheckAvailability(els);
}

function openConsoleDrawer(els, instance) {
  if (!els.consoleMount || !els.consoleDrawer) return;
  // Resolved before tearing down any existing session: a refused controller
  // (no passphrase — see getOrCreateController) must leave whatever is
  // currently open exactly as it was.
  const controller = getOrCreateController(els, instance);
  if (!controller) return;
  if (activeConsoleSession) activeConsoleSession.dispose();
  els.consoleMount.textContent = "";
  const session = attachConsole(els.consoleMount, controller);
  activeConsoleSession = { ...session, instanceId: instance.id };
  if (els.consoleDrawerTitle) els.consoleDrawerTitle.textContent = `Console — ${instance.name}`;
  els.consoleDrawer.hidden = false;
  syncDashboardHealthcheckAvailability(els);
}

// --- Task 15: dashboard-access fallback panel -------------------------
//
// Per dev/NOTES.md "Task 15"'s spike verdict, v86's wisp:// network
// backend (required for the guest's real internet access, Task 3) has no
// JS-side API for this page to open a connection into the guest — so
// "Open Dashboard" shows this documented panel (instructions + a
// VmController.httpRequest() health check) instead of opening a live
// dashboard tab.
//
// Mutual exclusion with the console drawer (post-review finding — see
// dev/NOTES.md "Task 15", "Console/health-check serial mutual exclusion"):
// attachConsole wires the xterm terminal's onData straight to
// vmController.sendToConsole() per keystroke, and httpRequest() writes its
// own full command through that exact same ttyS0 channel. With no
// exclusion, a user mid-typing an unterminated console command who clicks
// "Run health check" would get the health-check command appended onto
// their partial input, corrupting both. Fixed at the UI level (not the
// serial level): the health-check button disables itself — with a visible
// hint — for as long as the console drawer is open, and `runDashboardHealthcheck`
// re-checks the same condition defensively before actually sending
// anything, so a programmatic click that bypasses the `disabled` attribute
// (e.g. a test, or a race between opening the console and an in-flight
// click) still can't reach the guest's serial line while the console is
// open. The reverse direction (opening the console while a health check is
// already in flight) is NOT guarded: httpRequest() always sends one
// complete, newline-terminated command in a single write, so there is
// never a "partial" health-check line for the user's own typing to land
// in the middle of — the only residual effect is the health check's own
// reply appearing interleaved in the console's *output*, which is a
// cosmetic nuisance, not input corruption, and is left as-is.
function syncDashboardHealthcheckAvailability(els) {
  if (!els.btnDashboardHealthcheck) return;
  const consoleOpen = !!(els.consoleDrawer && !els.consoleDrawer.hidden);
  els.btnDashboardHealthcheck.disabled = consoleOpen;
  if (els.dashboardHealthcheckHint) els.dashboardHealthcheckHint.hidden = !consoleOpen;
}

function closeDashboardPanel(els) {
  activeDashboardInstance = null;
  if (els.dashboardHealthcheckResult) els.dashboardHealthcheckResult.textContent = "";
  if (els.dashboardPanel) els.dashboardPanel.hidden = true;
}

function openDashboardPanel(els, instance) {
  if (!els.dashboardPanel) return;
  activeDashboardInstance = instance;
  if (els.dashboardPanelTitle) els.dashboardPanelTitle.textContent = `Dashboard — ${instance.name}`;
  if (els.dashboardHealthcheckResult) els.dashboardHealthcheckResult.textContent = "";
  els.dashboardPanel.hidden = false;
  syncDashboardHealthcheckAvailability(els);
}

// Runs the health check against whichever instance the panel is currently
// open for. Reuses/creates the same VmController the play/pause/console
// buttons use (getOrCreateController), so a health check against an
// instance that was never started surfaces VmController.httpRequest()'s own
// "not-running" guard rather than this function reimplementing that check.
async function runDashboardHealthcheck(els) {
  if (!activeDashboardInstance || !els.dashboardHealthcheckResult) return;
  // Defensive re-check (see the mutual-exclusion comment above the
  // console-drawer functions) — the button is disabled while the console
  // is open, but this guards a direct/programmatic call too.
  if (els.consoleDrawer && !els.consoleDrawer.hidden) return;
  const instance = activeDashboardInstance;
  const controller = getOrCreateController(els, instance);
  if (!controller) return; // refused (no passphrase) — the banner explains why
  els.dashboardHealthcheckResult.textContent = "Checking…";
  const result = await controller.httpRequest("/");
  // The panel may have been closed (or reopened for a different instance)
  // while the check was in flight — don't clobber whatever it's showing now.
  if (activeDashboardInstance !== instance) return;
  if (result.ok) {
    els.dashboardHealthcheckResult.textContent = `Reachable (HTTP ${result.status}) — the frontend is answering on port 3000 inside the guest.`;
  } else if (result.error === "not-running") {
    els.dashboardHealthcheckResult.textContent = "Instance is not running — start it first.";
  } else if (result.error === "timeout") {
    els.dashboardHealthcheckResult.textContent = "No response within the timeout.";
  } else {
    els.dashboardHealthcheckResult.textContent = `Not reachable${typeof result.status === "number" ? ` (HTTP ${result.status})` : ""}.`;
  }
}

// play = start() when stopped (cold boot, or resume-from-snapshot if a
// previous stop() left one — VmController.start()/loadSnapshot handles
// that distinction internally) or resume() when paused (continues the
// live/restored emulator); pause = pause(); stop = stop(). All three are
// no-ops from a state VmController doesn't expect (see vm-controller.js's
// own state guards), so it is safe to just call through.
async function onCardAction(els, event) {
  const btn = event.target.closest("[data-action]");
  if (!btn || !els.instanceList.contains(btn)) return;
  const li = btn.closest("[data-instance-id]");
  if (!li) return;
  const instance = currentInstances.find((i) => i.id === li.dataset.instanceId);
  if (!instance) return;
  const action = btn.dataset.action;

  if (action === "console") {
    openConsoleDrawer(els, instance);
    return;
  }

  if (action === "dashboard") {
    openDashboardPanel(els, instance);
    return;
  }

  // Delete is a two-step, in-card confirmation (no window.confirm(), which
  // would block the emulator's own event loop and can't be driven by specs).
  if (action === "delete" || action === "delete-cancel") {
    const confirmRow = li.querySelector('[data-testid="delete-confirm"]');
    if (confirmRow) confirmRow.hidden = action !== "delete";
    return;
  }

  if (action === "delete-confirm") {
    btn.disabled = true;
    try {
      await deleteInstanceAndData(els, instance);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  const controller = getOrCreateController(els, instance);
  if (!controller) return; // refused (no passphrase) — the banner explains why
  btn.disabled = true;
  try {
    if (action === "play") {
      if (controller.state === "paused") await controller.resume();
      else await controller.start();
    } else if (action === "pause") {
      await controller.pause();
    } else if (action === "stop") {
      await controller.stop();
    }
  } finally {
    btn.disabled = false;
  }
}

// Full teardown of one instance: the only way a user can reclaim the
// multi-GB of IndexedDB an instance occupies (deleteInstance()/
// deleteSnapshot() shipped and were tested, but nothing ever called them).
// Everything belonging to the instance goes, in an order that can't
// resurrect any of it:
//   1. live controller — callbacks detached first, then `discard()` (NOT
//      stop(), which would snapshot into the store we're about to clear);
//      detaching matters because onStateChange -> persistState would
//      otherwise re-`putInstance` the record after we deleted it.
//   2. any open console/dashboard view of it.
//   3. IndexedDB: metadata + blocks + snapshots, in deleteInstance's single
//      cascading transaction.
//   4. its passphrase inside the sealed vault blob (resealed under the same
//      session key, so the PIN is not needed and other instances' entries
//      are untouched).
//   5. page-session maps (controllers, phaseByInstance).
async function deleteInstanceAndData(els, instance) {
  hideLifecycleError(els); // clear any stale error before reporting this one
  try {
    const controller = controllers.get(instance.id);
    if (controller) {
      controller.onStateChange = null;
      controller.onPhase = null;
      controller.onError = null;
      await controller.discard();
    }
    controllers.delete(instance.id);
    phaseByInstance.delete(instance.id);

    if (activeConsoleSession && activeConsoleSession.instanceId === instance.id) closeConsoleDrawer(els);
    if (activeDashboardInstance && activeDashboardInstance.id === instance.id) closeDashboardPanel(els);

    await deleteInstance(instance.id);

    if (unlockedVault && unlockedVault.passphrases && instance.id in unlockedVault.passphrases) {
      delete unlockedVault.passphrases[instance.id];
      if (vaultSession) {
        await putVaultBlob(await resealVault(vaultSession, unlockedVault));
      } else {
        // Unreachable in practice (the list only renders while the vault is
        // open, which is also when the session exists), but leaving a
        // deleted instance's passphrase sealed in the blob would be a silent
        // secret leak, so say so rather than swallow it.
        showLifecycleError(els, instance, "instance data deleted, but its saved passphrase could not be removed from the vault (vault session unavailable).");
      }
    }

    await refreshInstanceState(currentDoc || els.instanceList.ownerDocument, els);
  } catch (err) {
    showLifecycleError(els, instance, `could not delete this instance: ${errText(err)}`);
  }
}

function wireInstanceListActions(els) {
  if (!els.instanceList) return;
  els.instanceList.addEventListener("click", (event) => onCardAction(els, event));
}

// --- rendering --------------------------------------------------------

function renderInstanceList(doc, els, instances) {
  if (!els.instanceList) return;
  els.instanceList.textContent = "";
  for (const inst of instances) {
    const state = controllerStateFor(inst.id);
    // Tracked independently of `state` (see `renderInstanceCard`'s doc
    // comment): by the time any phase marker arrives, the controller has
    // already moved past "starting" into "running", so `phase` must be
    // threaded through on its own rather than inferred from `state`.
    const phase = phaseByInstance.get(inst.id) || null;
    els.instanceList.appendChild(renderInstanceCard(doc, inst, state, phase));
  }
}

// Shown/populated only once the vault is unlocked (`unlockedVault` set) —
// see `checkVaultGate`, which gates the call path that reaches here while a
// vault blob exists but hasn't been unlocked yet.
async function refreshInstanceState(doc, els) {
  currentDoc = doc;
  currentEls = els;
  const instances = await listInstances();
  currentInstances = instances;
  if (unlockedVault) {
    renderInstanceList(doc, els, instances);
  } else if (els.instanceList) {
    els.instanceList.textContent = "";
  }
  const hasInstances = instances.length > 0;
  if (els.emptyState) els.emptyState.hidden = hasInstances;
  if (els.instanceList) els.instanceList.hidden = !unlockedVault || !hasInstances;
  if (els.creationForm) els.creationForm.hidden = true;
  return instances;
}

function hidePinGateError(els) {
  if (!els.pinGateError) return;
  els.pinGateError.hidden = true;
  els.pinGateError.textContent = "";
}

function showPinGateError(els, message) {
  if (!els.pinGateError) return;
  els.pinGateError.textContent = message;
  els.pinGateError.hidden = false;
}

async function handlePinUnlock(doc, els, event) {
  event.preventDefault();
  hidePinGateError(els);
  const pin = els.fields.pinGate ? els.fields.pinGate.value : "";
  const blob = await getVaultBlob();
  if (!blob) return; // gate is only ever shown when a vault blob exists

  if (els.btnUnlock) els.btnUnlock.disabled = true;
  try {
    let opened;
    try {
      opened = await unsealVault(pin, blob);
    } catch (err) {
      // Same retry-UX rationale as Task 13's create-flow PIN failure: a
      // wrong PIN here is a typo, not a security event worth punishing —
      // leave the PIN field populated so correcting it is one edit. The
      // list stays hidden/empty (nothing was ever unlocked).
      const message = err instanceof WrongPinError ? "Incorrect PIN." : (err.message || String(err));
      showPinGateError(els, message);
      return;
    }
    unlockedVault = opened.data && typeof opened.data === "object" ? opened.data : {};
    if (!unlockedVault.passphrases) unlockedVault.passphrases = {};
    // Kept so the page can reseal the blob later (instance deletion) without
    // the PIN, which is cleared right below.
    vaultSession = opened.session;
    // Unlike the failure path above, the PIN is no longer needed once the
    // vault is open — clear it immediately (mirrors Task 13's `resetForm`
    // clearing secret fields only on success) so it doesn't linger in the
    // DOM past the moment it was used.
    if (els.fields.pinGate) els.fields.pinGate.value = "";
    if (els.pinGate) els.pinGate.hidden = true;
    await refreshInstanceState(doc, els);
  } finally {
    if (els.btnUnlock) els.btnUnlock.disabled = false;
  }
}

/**
 * Decide what the page should show for the current DB state: a sealed vault
 * blob present (non-empty DB) means "show the PIN gate, nothing else"; no
 * vault blob means the ordinary Task 13 creation flow. Called once at real
 * page load (from `initSelfhostPage`) and directly by the spec after
 * seeding the DB, to exercise the same on-load decision without a full page
 * reload.
 * @param {Document} [doc]
 */
export async function checkVaultGate(doc = document) {
  const els = collectElements(doc);
  const blob = await getVaultBlob();
  if (blob) {
    if (els.emptyState) els.emptyState.hidden = true;
    if (els.creationForm) els.creationForm.hidden = true;
    if (els.instanceList) {
      els.instanceList.hidden = true;
      els.instanceList.textContent = "";
    }
    hidePinGateError(els);
    if (els.pinGate) els.pinGate.hidden = false;
    return els;
  }
  if (els.pinGate) els.pinGate.hidden = true;
  await refreshInstanceState(doc, els);
  return els;
}

async function handleCreateSubmit(doc, els, event) {
  event.preventDefault();
  clearFieldErrors(doc, els);
  hideRelayError(els);

  const values = readFormValues(els);
  const result = validateCreationForm(values);
  if (!result.ok) {
    showFieldErrors(doc, els, result.errors);
    return;
  }
  const relayUrl = values.relayUrl.trim(); // trimmed once; reused below so the
  // pre-flight probe and the stored metadata never disagree on the address.

  els.createBtn.disabled = true;
  try {
    try {
      await preflightRelay(relayUrl);
    } catch (err) {
      // Intentionally do NOT clear the PIN/passphrase inputs here: a relay
      // that isn't running yet is an expected, common retry case (the user
      // is likely mid-way through the relay-instructions steps below), and
      // secrets never leave this form except into sealVault()'s ciphertext
      // — so there is no hygiene reason to force retyping them. Only a
      // successful create (resetForm, below) or explicit Cancel clears them.
      showRelayError(doc, els, err);
      return;
    }

    const instanceId = crypto.randomUUID();
    try {
      await addInstanceToVault(values.pin, instanceId, values.passphrase);
    } catch (err) {
      // Same retry-UX rationale as the pre-flight catch above: a wrong PIN
      // is a typo, not a security event worth punishing with a blanked
      // form — leave the fields populated so correcting it is one edit.
      const message = err instanceof WrongPinError ? "Incorrect PIN — could not unlock the existing vault." : (err.message || String(err));
      showFieldErrors(doc, els, { pin: message });
      return;
    }

    await putInstance({
      id: instanceId,
      name: values.name.trim(),
      diskSizeGB: Number(values.diskSizeGB),
      relayUrl,
      createdAt: Date.now(),
      provisioned: false,
      state: "stopped",
    });

    resetForm(els);
    await refreshInstanceState(doc, els);
  } finally {
    els.createBtn.disabled = false;
  }
}

function wireTabs(els) {
  for (const btn of els.tabButtons) {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      for (const b of els.tabButtons) b.setAttribute("aria-selected", String(b === btn));
      for (const panel of els.tabPanels) panel.hidden = panel.dataset.tabPanel !== target;
    });
  }
}

function wireCopyButtons(doc, els) {
  for (const btn of els.copyButtons) {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.copyTarget;
      const codeEl = targetId && doc.getElementById(targetId);
      if (!codeEl) return;
      try {
        await navigator.clipboard.writeText(codeEl.textContent);
      } catch {
        // Clipboard access can be denied (permissions, non-secure context,
        // headless test runner) — the command text is still visible and
        // selectable, so this is a non-fatal best-effort affordance.
      }
    });
  }
}

function renderRelayCommands(els) {
  const cmds = relayCommands();
  if (els.cmdMacos) els.cmdMacos.textContent = cmds.macos;
  if (els.cmdLinux) els.cmdLinux.textContent = cmds.linux;
  if (els.cmdWindows) els.cmdWindows.textContent = cmds.windows;
}

/**
 * Wire up and render the creation-flow page. Safe to call once per page
 * load; returns a promise that resolves once the initial instance-list
 * render has completed (tests await this via `window.__selfhostReady`).
 * @param {Document} [doc]
 */
export async function initSelfhostPage(doc = document) {
  const els = collectElements(doc);

  renderRelayCommands(els);
  wireTabs(els);
  wireCopyButtons(doc, els);

  if (els.showCreateBtn) {
    els.showCreateBtn.addEventListener("click", () => {
      if (els.emptyState) els.emptyState.hidden = true;
      if (els.creationForm) els.creationForm.hidden = false;
    });
  }

  if (els.cancelBtn) {
    els.cancelBtn.addEventListener("click", (event) => {
      event.preventDefault();
      clearFieldErrors(doc, els);
      hideRelayError(els);
      resetForm(els);
      refreshInstanceState(doc, els);
    });
  }

  if (els.creationForm) {
    els.creationForm.addEventListener("submit", (event) => handleCreateSubmit(doc, els, event));
  }

  if (els.pinGate) {
    els.pinGate.addEventListener("submit", (event) => handlePinUnlock(doc, els, event));
  }

  wireInstanceListActions(els);

  if (els.btnConsoleClose) {
    els.btnConsoleClose.addEventListener("click", () => closeConsoleDrawer(els));
  }

  if (els.btnLifecycleErrorDismiss) {
    els.btnLifecycleErrorDismiss.addEventListener("click", () => hideLifecycleError(els));
  }

  if (els.btnDashboardClose) {
    els.btnDashboardClose.addEventListener("click", () => closeDashboardPanel(els));
  }
  if (els.btnDashboardHealthcheck) {
    els.btnDashboardHealthcheck.addEventListener("click", () => runDashboardHealthcheck(els));
  }

  await checkVaultGate(doc);
  return els;
}
