// Task 15 spec coverage: the parts of js/vm-controller.js's httpRequest()
// fallback that are testable without booting v86 — see dev/NOTES.md
// "Task 15" for the spike verdict this fallback implements and the
// no-split-marker-needed reasoning parseHealthCheckLine relies on.
import { VmController, parseHealthCheckLine } from "../js/vm-controller.js";

export async function run() {
  // --- parseHealthCheckLine: matches genuine command output only --------
  const token = "Habc123xyz";

  const real = parseHealthCheckLine(`some curl output\n${token}HC_200\n`, token);
  if (!real || real.ok !== true || real.status !== 200) {
    throw new Error(`expected a genuine 200 match, got: ${JSON.stringify(real)}`);
  }

  const notReachable = parseHealthCheckLine(`${token}HC_000`, token);
  if (!notReachable || notReachable.ok !== false || notReachable.status !== 0) {
    throw new Error(`expected curl's "000" sentinel to parse as ok:false, got: ${JSON.stringify(notReachable)}`);
  }

  const serverError = parseHealthCheckLine(`${token}HC_500`, token);
  if (!serverError || serverError.ok !== true || serverError.status !== 500) {
    throw new Error(`a real 5xx status should still be ok:true (the guest DID answer), got: ${JSON.stringify(serverError)}`);
  }

  // No marker yet -> null, not a false match.
  if (parseHealthCheckLine("nothing relevant here", token) !== null) {
    throw new Error("expected null when the marker hasn't appeared");
  }

  // The exact shape ttyS0 echoes back BEFORE the command runs (raw typed
  // input, `$STATUS` not yet substituted) must never false-match — this is
  // the "no split-marker needed" claim from dev/NOTES.md "Task 15", proven
  // by direct example rather than only by reasoning about it.
  const echoedTypedLine = `STATUS=$(curl -s -o /dev/null -m 5 -w '%{http_code}' 'http://127.0.0.1:3000/'); echo ${token}HC_$STATUS`;
  if (parseHealthCheckLine(echoedTypedLine, token) !== null) {
    throw new Error("the raw echoed (not-yet-executed) command line must not false-match");
  }

  // A different token's real output must not match this call's regex either
  // (per-call random tokens exist precisely to prevent cross-matching).
  if (parseHealthCheckLine(`${token}zzz_differentHC_200`, token) !== null) {
    throw new Error("a non-matching prefix before the token must not match");
  }

  // --- VmController.httpRequest(): "not-running" guard, no v86 needed ---
  // Constructing a VmController touches IndexedDB (via instance-manager.js's
  // BlockStore) but never boots v86 — same pattern tests/ui.spec.mjs already
  // relies on for View Console's getOrCreateController. state defaults to
  // "stopped" and no start() is called, so this exercises the guard clause
  // with zero serial traffic and no emulator at all (a bug here would throw
  // on `this.emulator.serial0_send`, not silently pass).
  const controller = new VmController({
    instance: { id: "vmc-spec-httprequest", name: "spec", diskSizeGB: 1, relayUrl: "wisp://localhost:1/" },
    passphrase: "unused",
    onPhase: () => {},
    onError: () => {},
    onSerial: () => {},
    onStateChange: () => {},
  });
  if (controller.state !== "stopped") throw new Error(`expected a fresh VmController to start "stopped", got "${controller.state}"`);

  const notRunning = await controller.httpRequest("/");
  if (notRunning.ok !== false || notRunning.error !== "not-running") {
    throw new Error(`expected {ok:false, error:"not-running"} for a stopped controller, got: ${JSON.stringify(notRunning)}`);
  }

  // --- a failed start returns to "stopped" and reports (review finding) ---
  // A rejection inside _start() used to leave the controller stuck in
  // "starting" forever, which instanceCardButtons renders as a card with no
  // play/pause/stop button at all — an instance the user can never touch
  // again. The failure is injected by swapping the global V86 constructor
  // (vm-controller.js resolves it at call time), so no emulator, no boot and
  // no relay are involved.
  {
    const errors = [];
    const states = [];
    const failing = new VmController({
      instance: { id: "vmc-spec-start-failure", name: "spec", diskSizeGB: 1, relayUrl: "wisp://localhost:1/" },
      passphrase: "correct horse battery staple",
      onPhase: () => {},
      onError: (e) => errors.push(String(e)),
      onSerial: () => {},
      onStateChange: (s) => states.push(s),
    });
    const realV86 = window.V86;
    window.V86 = function ThrowingV86() {
      throw new Error("v86 construction blew up");
    };
    try {
      // Must not reject: onError is the error surface, and the click handlers
      // that call start() have no catch of their own.
      await failing.start();
    } finally {
      window.V86 = realV86;
    }
    if (failing.state !== "stopped") {
      throw new Error(`a failed start must return to "stopped" (was "${failing.state}") so Play is available for a retry`);
    }
    if (!states.includes("starting") || states[states.length - 1] !== "stopped") {
      throw new Error(`expected a starting -> stopped transition, got ${JSON.stringify(states)}`);
    }
    if (!errors.some((e) => e.startsWith("start-failed:") && e.includes("v86 construction blew up"))) {
      throw new Error(`expected a "start-failed:" onError report, got ${JSON.stringify(errors)}`);
    }
  }

  // --- refuses to start with no passphrase (review finding) -------------
  // _onSerialByte writes `passphrase + "\n"` to ttyS1 unconditionally, so an
  // undefined passphrase would type "undefined" at the guest's LUKS prompt —
  // and on a first boot stage1_disk would FORMAT the disk with it. Starting
  // must be refused outright, with a report, and without touching V86 at all.
  {
    const errors = [];
    const noPass = new VmController({
      instance: { id: "vmc-spec-no-passphrase", name: "spec", diskSizeGB: 1, relayUrl: "wisp://localhost:1/" },
      passphrase: undefined,
      onPhase: () => {},
      onError: (e) => errors.push(String(e)),
      onSerial: () => {},
      onStateChange: () => {},
    });
    const realV86 = window.V86;
    let constructed = false;
    window.V86 = function GuardedV86() {
      constructed = true;
      throw new Error("V86 must not be constructed without a passphrase");
    };
    try {
      await noPass.start();
    } finally {
      window.V86 = realV86;
    }
    if (constructed) throw new Error("start() constructed a V86 despite having no passphrase");
    if (noPass.state !== "stopped") throw new Error(`expected to stay "stopped", got "${noPass.state}"`);
    if (!errors.some((e) => e.startsWith("missing-passphrase:"))) {
      throw new Error(`expected a "missing-passphrase:" onError report, got ${JSON.stringify(errors)}`);
    }
  }
}
