// IndexedDB instance manager: vault blob storage, instance metadata CRUD,
// per-instance block store, and chunked disk snapshots.
// Public metadata only — instance passphrases live inside the sealed vault
// blob (see vault.js) and are never written to the `instances` store.

const DB_NAME = "multica-selfhost";
const DB_VERSION = 1;
const SNAPSHOT_CHUNK = 8 * 1024 * 1024; // 8 MiB

// Promisify a single IDBRequest.
function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Promisify an IDBTransaction's completion (used when a write spans
// multiple requests/stores and we care about the whole transaction).
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("instances")) db.createObjectStore("instances", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blocks")) db.createObjectStore("blocks");
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

async function store(name, mode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

function boundRange(id) {
  return IDBKeyRange.bound([id, 0], [id, Infinity]);
}

// --- vault blob -------------------------------------------------------

export async function getVaultBlob() {
  const s = await store("meta", "readonly");
  const v = await req(s.get("vault"));
  return v ?? null;
}

export async function putVaultBlob(blob) {
  const s = await store("meta", "readwrite");
  await req(s.put(blob, "vault"));
}

// --- instance metadata --------------------------------------------------

export async function listInstances() {
  const s = await store("instances", "readonly");
  return req(s.getAll());
}

export async function putInstance(meta) {
  const s = await store("instances", "readwrite");
  await req(s.put(meta));
}

export async function deleteInstance(id) {
  const db = await openDb();
  const tx = db.transaction(["instances", "blocks", "snapshots"], "readwrite");
  tx.objectStore("instances").delete(id);
  tx.objectStore("blocks").delete(boundRange(id));
  tx.objectStore("snapshots").delete(boundRange(id));
  return txDone(tx);
}

// --- block store ----------------------------------------------------------

export class BlockStore {
  constructor(instanceId, blockSize = 1 << 20) {
    this.instanceId = instanceId;
    this.blockSize = blockSize;
  }

  async read(index) {
    const s = await store("blocks", "readonly");
    const v = await req(s.get([this.instanceId, index]));
    return v ?? null;
  }

  async write(index, buf) {
    const s = await store("blocks", "readwrite");
    await req(s.put(buf, [this.instanceId, index]));
  }
}

// --- snapshots --------------------------------------------------------

export async function saveSnapshot(instanceId, arrayBuffer) {
  const total = Math.max(1, Math.ceil(arrayBuffer.byteLength / SNAPSHOT_CHUNK));
  const db = await openDb();
  const tx = db.transaction("snapshots", "readwrite");
  const s = tx.objectStore("snapshots");
  s.delete(boundRange(instanceId));
  for (let seq = 0; seq < total; seq++) {
    const start = seq * SNAPSHOT_CHUNK;
    const chunk = arrayBuffer.slice(start, Math.min(start + SNAPSHOT_CHUNK, arrayBuffer.byteLength));
    s.put({ seq, total, chunk }, [instanceId, seq]);
  }
  return txDone(tx);
}

export async function loadSnapshot(instanceId) {
  const s = await store("snapshots", "readonly");
  const records = await req(s.getAll(boundRange(instanceId)));
  if (!records.length) return null;
  records.sort((a, b) => a.seq - b.seq);
  const size = records.reduce((n, r) => n + r.chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const r of records) {
    out.set(new Uint8Array(r.chunk), offset);
    offset += r.chunk.byteLength;
  }
  return out.buffer;
}

export async function deleteSnapshot(instanceId) {
  const s = await store("snapshots", "readwrite");
  await req(s.delete(boundRange(instanceId)));
}
