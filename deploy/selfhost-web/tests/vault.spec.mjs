import { sealVault, openVault, WrongPinError } from "../js/vault.js";

export async function run() {
  const data = { instances: [{ id: "a1", passphrase: "hunter2" }] };
  const sealed = await sealVault("1234-long-pin", data);
  if (typeof sealed.salt !== "string" || sealed.v !== 1) throw new Error("sealed blob shape");
  const back = await openVault("1234-long-pin", sealed);
  if (back.instances[0].passphrase !== "hunter2") throw new Error("round trip");
  let threw = false;
  try { await openVault("wrong-pin", sealed); } catch (e) {
    threw = true;
    if (!(e instanceof WrongPinError)) throw new Error("wrong error type");
  }
  if (!threw) throw new Error("wrong PIN must throw");
}
