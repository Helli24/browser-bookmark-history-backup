// IndexedDB: the picked directory handle, the cumulative page index, and the
// individual visit timestamps behind it.
// Do NOT rename: IndexedDB cannot rename a database, so a new name means an empty
// one and every existing install silently loses its index. The name is internal -
// scoped to this extension's own origin, never shown to anyone.
const DB_NAME = "chrome-backup";
const DB_VERSION = 2;

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
      // v2: one row per visit. The composite key makes re-runs idempotent -
      // writing the same visit twice replaces it instead of duplicating it.
      if (!db.objectStoreNames.contains("visits")) {
        const s = db.createObjectStore("visits", { keyPath: ["url", "t"] });
        s.createIndex("t", "t");
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
export function searchKey(url) {
  return String(url || "").toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "");
}

/* ---------- Page index ---------- */

// rows: [{ url, host, title, first, last, count }]
// Merge instead of overwrite: keep the earliest first visit and the highest counts.
export function mergePages(rows) {
  const stats = { added: 0, updated: 0 };
  return run("pages", "readwrite", (store, set) => {
    for (const row of rows) {
      const entry = { ...row, k: searchKey(row.url) };
      const get = store.get(row.url);
      get.onsuccess = () => {
        const old = get.result;
        if (!old) { stats.added++; store.put(entry); return; }
        stats.updated++;
        store.put({
          url: entry.url,
          k: entry.k,
          host: entry.host || old.host,
          title: entry.title || old.title,
          first: Math.min(old.first || Infinity, entry.first),
          last: Math.max(old.last || 0, entry.last),
          count: Math.max(old.count || 0, entry.count || 0)
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
// and it beats maintaining a token index for an occasional lookup.
// Oldest first visit first, because that is usually the question being asked.
export function searchPages(term, limit = 300) {
  const q = searchKey(String(term || "").trim());
  return run("pages", "readonly", (store, set) => {
    const hits = [];
    let total = 0;
    const cur = store.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) {
        hits.sort((a, b) => a.first - b.first);
        set({ hits: hits.slice(0, limit), total });
        return;
      }
      const v = c.value;
      const k = v.k || searchKey(v.url);
      if (!q || k.includes(q) || (v.title || "").toLowerCase().includes(q)) {
        total++;
        if (hits.length < 5000) hits.push(v);
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

/* ---------- Individual visits ---------- */

// rows: [{ url, t }]. Returns the calendar years touched, so only those year
// files have to be rewritten on export.
export function mergeVisits(rows) {
  const years = new Set();
  return run("visits", "readwrite", (store, set) => {
    for (const row of rows) {
      if (!row.url || !row.t) continue;
      years.add(new Date(row.t).getFullYear());
      store.put({ url: row.url, t: row.t });
    }
    set(years);
  });
}

export const countVisits = () =>
  run("visits", "readonly", (s, set) => { const r = s.count(); r.onsuccess = () => set(r.result); });

// All known timestamps for one URL, oldest first.
export function visitsForUrl(url) {
  return run("visits", "readonly", (store, set) => {
    const range = IDBKeyRange.bound([url, 0], [url, Number.MAX_SAFE_INTEGER]);
    const out = [];
    const cur = store.openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return set(out);
      out.push(c.value.t);
      c.continue();
    };
  });
}

// Every visit in one calendar year, for the per-year export files.
export function visitsInYear(year) {
  const from = new Date(year, 0, 1).getTime();
  const to = new Date(year + 1, 0, 1).getTime();
  return run("visits", "readonly", (store, set) => {
    const out = [];
    const cur = store.index("t").openCursor(IDBKeyRange.bound(from, to, false, true));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return set(out);
      out.push(c.value);
      c.continue();
    };
  });
}

export const clearVisits = () => run("visits", "readwrite", s => s.clear());
