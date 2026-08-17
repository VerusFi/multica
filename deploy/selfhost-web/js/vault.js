// PIN vault: PBKDF2(SHA-256, 600k iterations) -> AES-GCM over the config JSON.
// A wrong PIN fails GCM authentication, surfaced as WrongPinError.
export class WrongPinError extends Error {
  constructor() { super("wrong PIN"); this.name = "WrongPinError"; }
}

const ITER = 600000;
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pin, salt) {
  const raw = await crypto.subtle.importKey("raw", te.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
    raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// A vault *session*: the derived (non-extractable) AES-GCM key plus the salt
// it came from. It lets the page reseal an updated payload — e.g. after
// deleting an instance, whose passphrase must leave the blob — without
// keeping the PIN in memory to re-derive the key from. Strictly better
// hygiene than holding the PIN: a CryptoKey created here is non-extractable
// and usable for nothing but this blob. Never persisted anywhere, same as
// the decrypted payload itself.
export async function createVaultSession(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(pin, salt), salt };
}

// Encrypt `dataObj` under an existing session, with a fresh random IV (an
// AES-GCM key may only ever see a given IV once; the salt/key stay put).
export async function resealVault(session, dataObj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, session.key, te.encode(JSON.stringify(dataObj)));
  return { v: 1, iter: ITER, salt: b64(session.salt), iv: b64(iv), ct: b64(ct) };
}

// Open a sealed blob and hand back both the payload and the session needed
// to reseal it later. Throws WrongPinError on a bad PIN, like openVault.
export async function unsealVault(pin, sealed) {
  const salt = unb64(sealed.salt);
  const key = await deriveKey(pin, salt);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
    return { data: JSON.parse(td.decode(pt)), session: { key, salt } };
  } catch { throw new WrongPinError(); }
}

export async function sealVault(pin, dataObj) {
  return resealVault(await createVaultSession(pin), dataObj);
}

export async function openVault(pin, sealed) {
  return (await unsealVault(pin, sealed)).data;
}
