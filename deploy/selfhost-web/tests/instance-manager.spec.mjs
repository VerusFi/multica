import {
  openDb, getVaultBlob, putVaultBlob,
  listInstances, putInstance, deleteInstance,
  BlockStore, saveSnapshot, loadSnapshot, deleteSnapshot,
} from "../js/instance-manager.js";

const DB_NAME = "multica-selfhost";

function deleteDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function boundedCount(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAllKeys(range);
    req.onsuccess = () => resolve(req.result.length);
    req.onerror = () => reject(req.error);
  });
}

function buffersEqual(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

export async function run() {
  await deleteDb();

  // vault blob round trip
  const sealed = { v: 1, iter: 600000, salt: "s", iv: "i", ct: "c" };
  await putVaultBlob(sealed);
  const backVault = await getVaultBlob();
  if (JSON.stringify(backVault) !== JSON.stringify(sealed)) throw new Error("vault blob round trip");

  // instance CRUD round trip
  const meta = { id: "inst-1", name: "test", diskSizeGB: 10, relayUrl: "wss://relay.example", createdAt: 12345, provisioned: false };
  await putInstance(meta);
  let list = await listInstances();
  if (list.length !== 1 || list[0].id !== "inst-1" || list[0].name !== "test" || list[0].diskSizeGB !== 10) {
    throw new Error("instance CRUD round trip");
  }

  // block write/read at index 0 and 4097
  const bs = new BlockStore("inst-1");
  const block0 = new Uint8Array(1 << 20).fill(7).buffer;
  const block4097 = new Uint8Array(1 << 20).fill(42).buffer;
  await bs.write(0, block0);
  await bs.write(4097, block4097);
  const r0 = await bs.read(0);
  const r4097 = await bs.read(4097);
  if (!buffersEqual(r0, block0)) throw new Error("block 0 round trip");
  if (!buffersEqual(r4097, block4097)) throw new Error("block 4097 round trip");
  const missing = await bs.read(1);
  if (missing !== null) throw new Error("missing block should read as null");

  // snapshot save/load of a 20 MiB buffer, byte-identical
  const snapBuf = new Uint8Array(20 * 1024 * 1024);
  for (let i = 0; i < snapBuf.length; i++) snapBuf[i] = i % 256;
  await saveSnapshot("inst-1", snapBuf.buffer);
  const loaded = await loadSnapshot("inst-1");
  if (!buffersEqual(loaded, snapBuf.buffer)) throw new Error("snapshot round trip not byte-identical");

  // deleteInstance cascades blocks + snapshots
  await deleteInstance("inst-1");
  list = await listInstances();
  if (list.length !== 0) throw new Error("deleteInstance should remove instance metadata");
  const db = await openDb();
  const blockCount = await boundedCount(db, "blocks", "inst-1");
  const snapCount = await boundedCount(db, "snapshots", "inst-1");
  if (blockCount !== 0) throw new Error("deleteInstance should leave zero blocks");
  if (snapCount !== 0) throw new Error("deleteInstance should leave zero snapshots");

  // deleteSnapshot standalone
  await saveSnapshot("inst-1", new Uint8Array(10).buffer);
  await deleteSnapshot("inst-1");
  const afterDelete = await loadSnapshot("inst-1");
  if (afterDelete !== null) throw new Error("deleteSnapshot should remove the snapshot");
}
