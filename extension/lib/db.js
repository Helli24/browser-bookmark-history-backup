// IndexedDB: the picked directory handle plus the cumulative page index.
const DB_NAME = "chrome-backup";
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles");
      if (!db.objectStoreNames.contains("pages")) {
        const s = db.createObjectStore("pages", { keyPath: "url" });
        s.createIndex("host", "host");
        s.createIndex("first", "first");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Runs fn inside one transaction. fn gets a setter; whatever it passes is resolved
// once the transaction completes - so values collected in request callbacks are final.
function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let out;
    try { fn(tx.objectStore(store), v => { out = v; }); }
    catch (e) { try { tx.abort(); } catch {} return reject(e); }
    tx.oncomplete = () => { db.close(); resolve(out); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}

/* ---------- Directory handle ---------- */

export const saveDirHandle = h => run("handles", "readwrite", s => s.put(h, "dir"));
export const clearDirHandle = () => run("handles", "readwrite", s => s.delete("dir"));
export const loadDirHandle = () =>
  run("handles", "readonly", (s, set) => {
    const r = s.get("dir");
    r.onsuccess = () => set(r.result || null);
  });

/* ---------- Search key ---------- */

// Put what a person types and what we stored on the same footing: no scheme,
// no "www.", lower case. That way "github.com/xyz" also matches
// "https://www.github.com/xyz/readme" - the path is what people remember.
export function suchSchluessel(url) {
  return String(url || "").toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "");
}

/* ---------- Page index ---------- */

// rows: [{ url, host, title, first, last, count }]
// Merge instead of overwrite: keep the earliest first visit and the highest counts.
export function mergePages(rows) {
  const stats = { neu: 0, aktualisiert: 0 };
  return run("pages", "readwrite", (store, set) => {
    for (const row of rows) {
      const eintrag = { ...row, k: suchSchluessel(row.url) };
      const get = store.get(row.url);
      get.onsuccess = () => {
        const alt = get.result;
        if (!alt) { stats.neu++; store.put(eintrag); return; }
        stats.aktualisiert++;
        store.put({
          url: eintrag.url,
          k: eintrag.k,
          host: eintrag.host || alt.host,
          title: eintrag.title || alt.title,
          first: Math.min(alt.first || Infinity, eintrag.first),
          last: Math.max(alt.last || 0, eintrag.last),
          count: Math.max(alt.count || 0, eintrag.count || 0)
        });
      };
    }
    set(stats);
  });
}

export const countPages = () =>
  run("pages", "readonly", (s, set) => { const r = s.count(); r.onsuccess = () => set(r.result); });

// Substring search over the normalised URL (path included) and the title.
// Full cursor scan - a few hundred thousand rows are milliseconds in IndexedDB,
// and it beats maintaining a token index for a once-in-a-while lookup.
// Oldest first visit first, because that is usually the question being asked.
export function searchPages(term, limit = 300) {
  const q = suchSchluessel(String(term || "").trim());
  return run("pages", "readonly", (store, set) => {
    const treffer = [];
    let gesamt = 0;
    const cur = store.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) {
        treffer.sort((a, b) => a.first - b.first);
        set({ treffer: treffer.slice(0, limit), gesamt });
        return;
      }
      const v = c.value;
      const k = v.k || suchSchluessel(v.url);
      if (!q || k.includes(q) || (v.title || "").toLowerCase().includes(q)) {
        gesamt++;
        if (treffer.length < 5000) treffer.push(v);
      }
      c.continue();
    };
  });
}

export function allPages() {
  return run("pages", "readonly", (store, set) => {
    const out = [];
    const cur = store.index("first").openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return set(out);
      out.push(c.value);
      c.continue();
    };
  });
}

export const clearPages = () => run("pages", "readwrite", s => s.clear());
