import { validateCreationForm, preflightRelay, renderInstanceCard, instanceCardButtons, checkVaultGate, recordProvisioned } from "../js/ui.js";
import { listInstances, getVaultBlob, putVaultBlob, putInstance, openDb, BlockStore, saveSnapshot } from "../js/instance-manager.js";
import { sealVault, openVault } from "../js/vault.js";

function isVisible(el) {
  return !!(el.offsetParent || el.getClientRects().length);
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  el.value = val;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// Raw IndexedDB key count for one instance's blocks/snapshots — the delete
// assertions have to look at the store directly, not through the manager's
// own helpers, to prove the data is really gone.
function boundedKeyCount(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAllKeys(range);
    req.onsuccess = () => resolve(req.result.length);
    req.onerror = () => reject(req.error);
  });
}

async function waitFor(fn, timeoutMs = 4000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const VALID_VALUES = {
  name: "test-instance",
  pin: "1234-pin",
  diskSizeGB: 8,
  relayUrl: "wisp://localhost:8086",
  passphrase: "correct horse battery staple",
  passphrase2: "correct horse battery staple",
};

function expectFieldError(overrides, field) {
  const result = validateCreationForm({ ...VALID_VALUES, ...overrides });
  if (result.ok) throw new Error(`expected ${field} to fail validation`);
  const msg = result.errors && result.errors[field];
  if (typeof msg !== "string" || !msg) {
    throw new Error(`expected a message for errors.${field}, got ${JSON.stringify(result.errors)}`);
  }
}

export async function run() {
  // --- validateCreationForm: per-field rejection ---
  expectFieldError({ name: "" }, "name");
  expectFieldError({ pin: "" }, "pin");
  expectFieldError({ diskSizeGB: 0 }, "diskSizeGB");
  expectFieldError({ diskSizeGB: -3 }, "diskSizeGB");
  expectFieldError({ diskSizeGB: 1.5 }, "diskSizeGB");
  expectFieldError({ diskSizeGB: "" }, "diskSizeGB");
  expectFieldError({ relayUrl: "http://localhost:8086" }, "relayUrl");
  expectFieldError({ relayUrl: "not a url" }, "relayUrl");
  expectFieldError({ relayUrl: "" }, "relayUrl");
  expectFieldError({ passphrase: "" }, "passphrase");
  expectFieldError({ passphrase2: "" }, "passphrase2");
  expectFieldError({ passphrase: "aaa", passphrase2: "bbb" }, "passphrase2");

  // --- validateCreationForm: accepts a fully valid set ---
  const validResult = validateCreationForm(VALID_VALUES);
  if (!validResult.ok) throw new Error(`expected valid set to pass, got ${JSON.stringify(validResult.errors)}`);

  // relayUrl accepts ws:// and wss:// too
  if (!validateCreationForm({ ...VALID_VALUES, relayUrl: "ws://localhost:8086" }).ok) {
    throw new Error("ws:// relayUrl should be accepted");
  }
  if (!validateCreationForm({ ...VALID_VALUES, relayUrl: "wss://relay.example/" }).ok) {
    throw new Error("wss:// relayUrl should be accepted");
  }

  // --- preflightRelay: rejects when nothing listens ---
  let preflightThrew = false;
  try {
    await preflightRelay("ws://localhost:1", 500);
  } catch {
    preflightThrew = true;
  }
  if (!preflightThrew) throw new Error("preflightRelay should reject when nothing listens");

  // --- DOM: empty DB shows exactly one "Create a self host instance" button ---
  if (!window.__selfhostReady) throw new Error("selfhost.html did not set window.__selfhostReady");
  await window.__selfhostReady;

  const visibleButtons = [...document.querySelectorAll("button")].filter(isVisible);
  if (visibleButtons.length !== 1) {
    throw new Error(`expected exactly one visible button, got ${visibleButtons.length}`);
  }
  if (visibleButtons[0].textContent.trim() !== "Create a self host instance") {
    throw new Error(`unexpected button label: ${visibleButtons[0].textContent}`);
  }

  // --- DOM: Create instance with an unreachable relay shows relay-error, stores nothing ---
  visibleButtons[0].click();

  setValue("field-name", "test-instance");
  setValue("field-pin", "1234-pin");
  setValue("field-disk-size", "8");
  setValue("field-relay-url", "ws://localhost:1");
  setValue("field-passphrase", "correct horse battery staple");
  setValue("field-passphrase2", "correct horse battery staple");

  const createBtn = document.getElementById("btn-create");
  if (!createBtn) throw new Error("missing #btn-create");
  createBtn.click();

  const relayErrorEl = document.querySelector('[data-testid="relay-error"]');
  if (!relayErrorEl) throw new Error('missing [data-testid="relay-error"] element');

  const becameVisible = await waitFor(() => !relayErrorEl.hidden && isVisible(relayErrorEl));
  if (!becameVisible) throw new Error("relay-error did not become visible after a failed preflight");

  const list = await listInstances();
  if (list.length !== 0) throw new Error("no instance should be stored when the relay preflight fails");

  const vaultBlob = await getVaultBlob();
  if (vaultBlob !== null) throw new Error("no vault blob should be written when the relay preflight fails");

  // --- Task 14: renderInstanceCard / instanceCardButtons — pure, no VmController/v86 ---
  const fakeInstance = {
    id: "fake-1",
    name: "Fake Instance",
    diskSizeGB: 16,
    relayUrl: "wisp://localhost:8086",
    createdAt: Date.parse("2026-01-02T03:04:05Z"),
  };

  function actionHidden(li, action) {
    const btn = li.querySelector(`[data-action="${action}"]`);
    if (!btn) throw new Error(`missing [data-action="${action}"] button in rendered card`);
    return btn.hidden;
  }

  // button visibility matrix per state (brief: stopped -> play only;
  // running -> pause+stop; paused -> play+stop), driven directly through
  // the pure renderer — no controller, no v86, no boot.
  {
    const li = renderInstanceCard(document, fakeInstance, "stopped");
    if (actionHidden(li, "play")) throw new Error("stopped: play should be visible");
    if (!actionHidden(li, "pause")) throw new Error("stopped: pause should be hidden");
    if (!actionHidden(li, "stop")) throw new Error("stopped: stop should be hidden");
  }
  {
    const li = renderInstanceCard(document, fakeInstance, "running");
    if (!actionHidden(li, "play")) throw new Error("running: play should be hidden");
    if (actionHidden(li, "pause")) throw new Error("running: pause should be visible");
    if (actionHidden(li, "stop")) throw new Error("running: stop should be visible");
  }
  {
    const li = renderInstanceCard(document, fakeInstance, "paused");
    if (actionHidden(li, "play")) throw new Error("paused: play should be visible");
    if (!actionHidden(li, "pause")) throw new Error("paused: pause should be hidden");
    if (actionHidden(li, "stop")) throw new Error("paused: stop should be visible");
  }

  // instanceCardButtons matches the same matrix directly (no DOM at all).
  const stoppedButtons = instanceCardButtons("stopped");
  if (!stoppedButtons.play || stoppedButtons.pause || stoppedButtons.stop) {
    throw new Error(`instanceCardButtons("stopped") wrong: ${JSON.stringify(stoppedButtons)}`);
  }
  const runningButtons = instanceCardButtons("running");
  if (runningButtons.play || !runningButtons.pause || !runningButtons.stop) {
    throw new Error(`instanceCardButtons("running") wrong: ${JSON.stringify(runningButtons)}`);
  }
  const pausedButtons = instanceCardButtons("paused");
  if (!pausedButtons.play || pausedButtons.pause || !pausedButtons.stop) {
    throw new Error(`instanceCardButtons("paused") wrong: ${JSON.stringify(pausedButtons)}`);
  }

  // Config summary (diskSizeGB, relayUrl, createdAt), Open Dashboard's
  // phase-"ready" gating, and the phase-progress bar — all driven directly
  // through the pure renderer.
  //
  // The progress bar must be gated on `phase` presence, NOT on `state`:
  // VmController moves "starting" -> "running" synchronously on
  // emulator-ready, before the guest has written any serial output, so
  // every real `@@SH:phase:*@@` marker arrives while state is already
  // "running" — a card is never simultaneously `state === "starting"` AND
  // carrying a phase. These assertions exercise that real condition
  // (`state: "running"` + an in-progress phase), not the disconnected one.
  {
    const inProgress = renderInstanceCard(document, fakeInstance, "running", "install");
    const summaryText = inProgress.querySelector(".instance-summary").textContent;
    if (!summaryText.includes("16 GB") || !summaryText.includes(fakeInstance.relayUrl)) {
      throw new Error(`card summary missing diskSizeGB/relayUrl: ${summaryText}`);
    }
    const dashboardBtn = inProgress.querySelector('[data-action="dashboard"]');
    if (!dashboardBtn || !dashboardBtn.disabled) throw new Error("Open Dashboard should be disabled before phase ready");

    const bar = inProgress.querySelector('[data-testid="phase-progress"]');
    if (!bar) throw new Error('state "running" with phase "install" should show the phase-progress bar');
    // "install" is index 2 of 7 in PHASES -> (2+1)/7 = 42.857% -> rounds to 43%.
    if (!bar.textContent.includes("install") || !bar.textContent.includes("43%")) {
      throw new Error(`phase-progress bar content wrong for phase "install": ${bar.textContent}`);
    }
  }
  {
    // phase "ready": Open Dashboard enables, and the progress bar disappears
    // (provisioning is done, nothing left to show progress on).
    const ready = renderInstanceCard(document, fakeInstance, "running", "ready");
    const dashboardBtn = ready.querySelector('[data-action="dashboard"]');
    if (!dashboardBtn || dashboardBtn.disabled) throw new Error("Open Dashboard should be enabled once phase is ready");
    if (ready.querySelector('[data-testid="phase-progress"]')) {
      throw new Error('phase "ready" should not show the phase-progress bar');
    }
  }
  {
    // No phase at all (e.g. a "running" instance from a prior session, no
    // markers seen yet this page load): no progress bar either.
    const noPhase = renderInstanceCard(document, fakeInstance, "running", null);
    if (noPhase.querySelector('[data-testid="phase-progress"]')) {
      throw new Error("no phase should not show the phase-progress bar");
    }
  }

  // --- Task 14: PIN gate — seeded DB (2 instances) ---------------------
  // Seeded directly via vault.js/instance-manager.js (brief: "Seed via
  // instance-manager APIs in the spec"), not through the creation form —
  // this is the vault-merge/WrongPinError path Task 13 left untested (its
  // own creation flow only ever hit the "no vault yet" branch).
  const GATE_PIN = "correct-gate-pin-42";
  const seededInstances = [
    { id: "seed-1", name: "seed-one", diskSizeGB: 4, relayUrl: "wisp://localhost:8086", createdAt: Date.now(), provisioned: false, state: "stopped" },
    { id: "seed-2", name: "seed-two", diskSizeGB: 12, relayUrl: "wss://relay.example", createdAt: Date.now(), provisioned: false, state: "stopped" },
  ];
  for (const inst of seededInstances) await putInstance(inst);
  const seededVault = await sealVault(GATE_PIN, { passphrases: { "seed-1": "pw-one", "seed-2": "pw-two" } });
  await putVaultBlob(seededVault);

  // Re-run the same on-load decision `initSelfhostPage` made at page load
  // (when the DB was still empty) now that the DB is non-empty — simulates
  // a fresh load without an actual page navigation.
  await checkVaultGate(document);

  const pinGateForm = document.getElementById("pin-gate-form");
  if (!pinGateForm) throw new Error("missing #pin-gate-form");
  const gateBecameVisible = await waitFor(() => !pinGateForm.hidden && isVisible(pinGateForm));
  if (!gateBecameVisible) throw new Error("PIN gate did not appear for a non-empty DB");

  const instanceListEl = document.getElementById("instance-list");
  if (!instanceListEl) throw new Error("missing #instance-list");
  if (!instanceListEl.hidden || instanceListEl.children.length !== 0) {
    throw new Error("instance list should stay hidden/empty before unlocking");
  }

  // Wrong PIN: visible error, nothing listed.
  setValue("field-pin-gate", "totally-wrong-pin");
  const unlockBtn = document.getElementById("btn-unlock");
  if (!unlockBtn) throw new Error("missing #btn-unlock");
  unlockBtn.click();

  const pinGateErrorEl = document.querySelector('[data-testid="pin-gate-error"]');
  if (!pinGateErrorEl) throw new Error('missing [data-testid="pin-gate-error"] element');
  const gateErrorVisible = await waitFor(() => !pinGateErrorEl.hidden && isVisible(pinGateErrorEl));
  if (!gateErrorVisible) throw new Error("wrong PIN should show a visible error");
  if (instanceListEl.children.length !== 0 || pinGateForm.hidden) {
    throw new Error("wrong PIN must keep the list hidden/empty and the gate open");
  }

  // Correct PIN: unlocks and lists both seeded instances.
  setValue("field-pin-gate", GATE_PIN);
  unlockBtn.click();

  const gateUnlocked = await waitFor(() => pinGateForm.hidden && instanceListEl.children.length === 2);
  if (!gateUnlocked) throw new Error("correct PIN should unlock and list the 2 seeded instances");

  const cardNames = [...instanceListEl.querySelectorAll(".instance-card strong")].map((n) => n.textContent);
  if (!cardNames.includes("seed-one") || !cardNames.includes("seed-two")) {
    throw new Error(`expected both seeded instance names, got ${JSON.stringify(cardNames)}`);
  }

  // Both seeded (freshly unlocked, never started) cards are "stopped" ->
  // play-only, matching the button matrix end to end through the real DOM.
  for (const li of instanceListEl.querySelectorAll(".instance-card")) {
    if (actionHidden(li, "play")) throw new Error("seeded stopped card should show play");
    if (!actionHidden(li, "pause")) throw new Error("seeded stopped card should hide pause");
    if (!actionHidden(li, "stop")) throw new Error("seeded stopped card should hide stop");
  }

  // View Console opens the xterm drawer for a card without booting v86.
  const firstCard = instanceListEl.querySelector(".instance-card");
  firstCard.querySelector('[data-action="console"]').click();
  const consoleDrawerEl = document.getElementById("console-drawer");
  const consoleMountEl = document.getElementById("console-mount");
  if (!consoleDrawerEl || !consoleMountEl) throw new Error("missing #console-drawer / #console-mount");
  const drawerOpened = await waitFor(() => !consoleDrawerEl.hidden && consoleMountEl.childElementCount > 0);
  if (!drawerOpened) throw new Error("View Console should open the xterm drawer");
  const closeBtn = document.getElementById("btn-console-close");
  if (!closeBtn) throw new Error("missing #btn-console-close");
  closeBtn.click();
  if (!consoleDrawerEl.hidden) throw new Error("Close should hide the console drawer");

  // --- Task 15: dashboard-access fallback panel --------------------------
  // The button is gated on phase "ready" (already proven above via the pure
  // renderInstanceCard assertions); this seeded card is "stopped" with no
  // phase yet, so it's rendered disabled — enable it here to exercise the
  // click-wiring itself without requiring a real ~5min v86 boot to reach
  // "ready" for real (dev/verify-dashboard.mjs, run separately, is the
  // real-boot end-to-end proof — see dev/NOTES.md "Task 15").
  const dashboardBtn = firstCard.querySelector('[data-action="dashboard"]');
  if (!dashboardBtn) throw new Error('missing [data-action="dashboard"] button in a live card');
  dashboardBtn.disabled = false;
  dashboardBtn.click();

  const dashboardPanelEl = document.getElementById("dashboard-panel");
  const dashboardPanelTitleEl = document.getElementById("dashboard-panel-title");
  if (!dashboardPanelEl || !dashboardPanelTitleEl) throw new Error("missing #dashboard-panel / #dashboard-panel-title");
  const panelOpened = await waitFor(() => !dashboardPanelEl.hidden);
  if (!panelOpened) throw new Error("Open Dashboard should open #dashboard-panel");
  if (!dashboardPanelTitleEl.textContent.includes("seed-one")) {
    throw new Error(`dashboard panel title should include the instance name, got: ${dashboardPanelTitleEl.textContent}`);
  }

  // --- Console/health-check mutual exclusion (post-review finding) -------
  // Both attachConsole's term.onData and httpRequest() write to the same
  // ttyS0 serial channel via vmController.sendToConsole(); with the
  // console drawer open, a user could be mid-typing an unterminated
  // command, so the health-check button must disable itself (with a
  // visible hint) for as long as the drawer is open. See dev/NOTES.md
  // "Task 15" ("Console/health-check serial mutual exclusion").
  const healthcheckHintEl = document.getElementById("dashboard-healthcheck-hint");
  const healthcheckBtnEl = document.getElementById("btn-dashboard-healthcheck");
  if (!healthcheckHintEl || !healthcheckBtnEl) throw new Error("missing #dashboard-healthcheck-hint / #btn-dashboard-healthcheck");
  if (healthcheckBtnEl.disabled || !healthcheckHintEl.hidden) {
    throw new Error("health check should start enabled/hint-hidden while the console is closed");
  }

  firstCard.querySelector('[data-action="console"]').click();
  const drawerReopened = await waitFor(() => !consoleDrawerEl.hidden);
  if (!drawerReopened) throw new Error("View Console should reopen the drawer");
  if (!healthcheckBtnEl.disabled) throw new Error("health check should disable itself while the console drawer is open");
  if (healthcheckHintEl.hidden) throw new Error("the close-the-console hint should be visible while the console drawer is open");

  // Defensive re-check inside runDashboardHealthcheck itself, independent
  // of the disabled attribute (proves a programmatic click bypassing
  // `disabled` — e.g. a race, or a test — still can't reach the guest's
  // serial line while the console is open, not just that the button LOOKS
  // disabled).
  healthcheckBtnEl.disabled = false;
  healthcheckBtnEl.click();
  await new Promise((r) => setTimeout(r, 200));
  if (document.getElementById("dashboard-healthcheck-result").textContent !== "") {
    throw new Error("a bypassed click while the console is open must still be a no-op (defensive re-check)");
  }

  closeBtn.click();
  if (!consoleDrawerEl.hidden) throw new Error("Close should hide the console drawer (re-check)");
  if (healthcheckBtnEl.disabled) throw new Error("health check should re-enable once the console drawer closes");
  if (!healthcheckHintEl.hidden) throw new Error("the hint should hide again once the console drawer closes");

  // Health check against a never-started instance: VmController.httpRequest()
  // resolves its own {ok:false, error:"not-running"} guard with zero serial
  // traffic and no v86/relay involved — end-to-end proof of the real
  // button -> handler -> VmController.httpRequest() wiring, not a stub.
  const healthcheckBtn = document.getElementById("btn-dashboard-healthcheck");
  const healthcheckResultEl = document.getElementById("dashboard-healthcheck-result");
  if (!healthcheckBtn || !healthcheckResultEl) throw new Error("missing #btn-dashboard-healthcheck / #dashboard-healthcheck-result");
  healthcheckBtn.click();
  const healthcheckShown = await waitFor(() => /not running/i.test(healthcheckResultEl.textContent));
  if (!healthcheckShown) throw new Error(`expected a "not running" health check result, got: ${healthcheckResultEl.textContent}`);

  const dashboardCloseBtn = document.getElementById("btn-dashboard-close");
  if (!dashboardCloseBtn) throw new Error("missing #btn-dashboard-close");
  dashboardCloseBtn.click();
  if (!dashboardPanelEl.hidden) throw new Error("Close should hide the dashboard panel");
  if (healthcheckResultEl.textContent !== "") throw new Error("Close should clear the health check result");

  // --- Reloaded instances: persisted `provisioned`/`state` (review) -------
  // Boot-phase markers live only in page memory (`phaseByInstance`), and the
  // guest emits `ready` exactly once per provisioning, so after a reload no
  // card has a phase. Gating "Open Dashboard" on the marker alone therefore
  // left it disabled forever for every returning user; it is now gated on
  // the persisted `provisioned` flag as well, which is written when the
  // marker fires. `state` is persisted the same way, which is what lets a
  // reloaded paused instance say "Resume".
  const PROVISIONED_ID = "seed-3-provisioned";
  const NO_PASSPHRASE_ID = "seed-4-no-vault-entry";
  await putInstance({
    id: PROVISIONED_ID, name: "seed-provisioned", diskSizeGB: 8, relayUrl: "wisp://localhost:8086",
    createdAt: Date.now(), provisioned: true, state: "paused",
  });
  // An instance whose metadata exists but whose vault entry does not — the
  // metadata/vault disagreement that used to LUKS-format the disk with the
  // literal string "undefined".
  await putInstance({
    id: NO_PASSPHRASE_ID, name: "seed-no-passphrase", diskSizeGB: 8, relayUrl: "wisp://localhost:8086",
    createdAt: Date.now(), provisioned: false, state: "stopped",
  });
  // Real stored bytes for the provisioned instance, so the delete assertions
  // below are about actual reclaimed space rather than empty stores.
  await new BlockStore(PROVISIONED_ID).write(0, new Uint8Array(1 << 20).fill(3).buffer);
  await saveSnapshot(PROVISIONED_ID, new Uint8Array(4096).fill(9).buffer);
  await putVaultBlob(await sealVault(GATE_PIN, {
    passphrases: { "seed-1": "pw-one", "seed-2": "pw-two", [PROVISIONED_ID]: "pw-three" },
  }));

  // Simulate the reload: re-run the on-load gate decision, then unlock.
  await checkVaultGate(document);
  setValue("field-pin-gate", GATE_PIN);
  unlockBtn.click();
  const relisted = await waitFor(() => pinGateForm.hidden && instanceListEl.children.length === 4);
  if (!relisted) throw new Error(`expected 4 cards after unlocking, got ${instanceListEl.children.length}`);

  const cardFor = (id) => {
    const li = instanceListEl.querySelector(`[data-instance-id="${id}"]`);
    if (!li) throw new Error(`missing card for ${id}`);
    return li;
  };

  const provisionedCard = cardFor(PROVISIONED_ID);
  const provisionedDashboardBtn = provisionedCard.querySelector('[data-action="dashboard"]');
  if (!provisionedDashboardBtn || provisionedDashboardBtn.disabled) {
    throw new Error("a reloaded provisioned instance must have Open Dashboard enabled (no phase marker exists after a reload)");
  }
  if (provisionedCard.querySelector('[data-action="play"]').textContent !== "Resume") {
    throw new Error("a reloaded instance whose persisted state was paused should offer Resume");
  }
  const unprovisionedDashboardBtn = cardFor("seed-1").querySelector('[data-action="dashboard"]');
  if (!unprovisionedDashboardBtn.disabled) {
    throw new Error("a never-provisioned instance must still have Open Dashboard disabled");
  }

  // --- Visible error surface + refusing to start without a passphrase ----
  // Both halves of one review finding: lifecycle errors reached console.error
  // only, and a missing vault entry silently booted a guest that would LUKS
  // format the disk with "undefined". Clicking Play on an instance with no
  // vault entry must report visibly and change nothing.
  const errorBannerEl = document.querySelector('[data-testid="lifecycle-error"]');
  if (!errorBannerEl) throw new Error('missing [data-testid="lifecycle-error"] element');
  if (!errorBannerEl.hidden) throw new Error("the error banner should start hidden");

  const noPassCard = cardFor(NO_PASSPHRASE_ID);
  noPassCard.querySelector('[data-action="play"]').click();
  const errorShown = await waitFor(() => !errorBannerEl.hidden && isVisible(errorBannerEl));
  if (!errorShown) throw new Error("a start refused for a missing passphrase must show a visible error");
  const errorText = errorBannerEl.textContent;
  if (!errorText.includes("seed-no-passphrase") || !/passphrase/i.test(errorText)) {
    throw new Error(`the error banner should name the instance and the problem, got: ${errorText}`);
  }
  if (noPassCard.querySelector('[data-testid="state-badge"]').textContent !== "stopped") {
    throw new Error("a refused start must leave the card in its stopped state, not a button-less transitional one");
  }
  if (noPassCard.querySelector('[data-action="play"]').hidden) {
    throw new Error("a refused start must leave Play available for a retry");
  }
  document.getElementById("btn-lifecycle-error-dismiss").click();
  if (!errorBannerEl.hidden) throw new Error("Dismiss should hide the error banner");

  // --- Delete an instance (review finding: no UI caller existed) ---------
  // deleteInstance()/deleteSnapshot() shipped and were unit-tested, but no
  // button ever called them, so multi-GB of IndexedDB was unreclaimable.
  const confirmRow = provisionedCard.querySelector('[data-testid="delete-confirm"]');
  if (!confirmRow || !confirmRow.hidden) throw new Error("the delete confirmation should start hidden");
  provisionedCard.querySelector('[data-action="delete"]').click();
  if (confirmRow.hidden) throw new Error("Delete should reveal the in-card confirmation");
  provisionedCard.querySelector('[data-action="delete-cancel"]').click();
  if (!confirmRow.hidden) throw new Error("Keep should hide the confirmation without deleting anything");
  if (instanceListEl.children.length !== 4) throw new Error("cancelling must not delete anything");

  provisionedCard.querySelector('[data-action="delete"]').click();
  provisionedCard.querySelector('[data-action="delete-confirm"]').click();
  const deleted = await waitFor(() => instanceListEl.children.length === 3);
  if (!deleted) throw new Error(`expected 3 cards after deleting one, got ${instanceListEl.children.length}`);
  if (instanceListEl.querySelector(`[data-instance-id="${PROVISIONED_ID}"]`)) {
    throw new Error("the deleted instance's card should be gone");
  }
  if ((await listInstances()).some((i) => i.id === PROVISIONED_ID)) {
    throw new Error("the deleted instance's metadata should be gone");
  }
  const db = await openDb();
  if ((await boundedKeyCount(db, "blocks", PROVISIONED_ID)) !== 0) {
    throw new Error("deleting an instance must leave zero disk blocks (that is the point: reclaiming the space)");
  }
  if ((await boundedKeyCount(db, "snapshots", PROVISIONED_ID)) !== 0) {
    throw new Error("deleting an instance must leave zero snapshots");
  }
  const vaultAfterDelete = await openVault(GATE_PIN, await getVaultBlob());
  if (PROVISIONED_ID in vaultAfterDelete.passphrases) {
    throw new Error("deleting an instance must remove its passphrase from the sealed vault blob");
  }
  if (!("seed-1" in vaultAfterDelete.passphrases) || !("seed-2" in vaultAfterDelete.passphrases)) {
    throw new Error("deleting one instance must not disturb the other instances' vault entries");
  }

  // --- the `ready` marker's persistence itself ---------------------------
  // The card assertions above prove a *persisted* provisioned instance keeps
  // its dashboard button; this proves the write that produces that state
  // (what the page runs when the guest's `@@SH:phase:ready@@` marker fires),
  // without a ~6-minute real boot to reach the marker.
  const readyInstance = {
    id: "seed-5-ready-marker", name: "seed-ready", diskSizeGB: 8, relayUrl: "wisp://localhost:8086",
    createdAt: Date.now(), provisioned: false, state: "stopped",
  };
  await putInstance(readyInstance);
  await recordProvisioned(readyInstance);
  const storedReady = (await listInstances()).find((i) => i.id === readyInstance.id);
  if (!storedReady || storedReady.provisioned !== true) {
    throw new Error("reaching phase ready must persist provisioned:true, or the dashboard button dies on the next reload");
  }
}
