// Tiny IndexedDB wrapper. Stores:
//   tracks    id -> track metadata
//   analysis  id -> BPM/key/beat grid/waveform
//   cues      id -> { hotcues[8], cuePoint }
//   kv        misc (folder handles, settings)
//   blobs     id -> Blob (downloaded open-music audio, kept offline)   [v2]
//   playlists id -> { id, name, trackIds[], createdAt }                 [v2]
// Upgrades only add missing stores, existing data is kept.
// Without IndexedDB (Node tests, locked-down browsers) an in-memory store is used.

const DB_NAME = 'pulsar-dj';
const DB_VERSION = 2;
export const STORES = ['tracks', 'analysis', 'cues', 'kv', 'blobs', 'playlists'];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => {
      const h = req.result;
      // another tab wants to upgrade: let it, reopen lazily next time
      h.onversionchange = () => { h.close(); dbp = null; };
      resolve(h);
    };
    req.onblocked = () => {
      console.warn('IndexedDB-Upgrade wartet: andere Pulsar-Tabs schließen.');
      // older Pulsar windows (before v2) don't release the database on their own
      globalThis.dispatchEvent?.(new CustomEvent('pulsar-db-blocked'));
    };
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  all: async (store) => {
    const dbh = await open();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = dbh.transaction(store, 'readonly');
      const req = t.objectStore(store).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  },
  putMany: async (store, entries) => {
    const dbh = await open();
    return new Promise((resolve, reject) => {
      const t = dbh.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      for (const [k, v] of entries) s.put(v, k);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
};

// In-memory fallback with the same API (structuredClone mimics IDB copying).
function memoryDb() {
  const m = new Map(STORES.map((s) => [s, new Map()]));
  const st = (s) => { if (!m.has(s)) m.set(s, new Map()); return m.get(s); };
  const copy = (v) => { try { return structuredClone(v); } catch { return v; } };
  return {
    memory: true,
    get: async (s, k) => copy(st(s).get(k)),
    put: async (s, k, v) => { st(s).set(k, copy(v)); },
    del: async (s, k) => { st(s).delete(k); },
    keys: async (s) => [...st(s).keys()],
    all: async (s) => [...st(s)].map(([k, v]) => [k, copy(v)]),
    putMany: async (s, entries) => { for (const [k, v] of entries) st(s).set(k, copy(v)); },
  };
}

export const db = typeof indexedDB !== 'undefined' ? idb : memoryDb();
