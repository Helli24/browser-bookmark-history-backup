// IndexedDB: the picked directory handle, the cumulative page index, and the
// individual visit timestamps behind it.
import { hostOf, dayNumber, dayNumberToKey, bucketStart } from "./collect.js";

// Do NOT rename: IndexedDB cannot rename a database, so a new name means an empty
// one and every existing install silently loses its index. The name is internal -
// scoped to this extension's own origin, never shown to anyone.
const DB_NAME = "chrome-backup";
const DB_VERSION = 3;

// Schema changes happen inside onupgradeneeded, which cannot await anything. They
// park a note in storage instead, and whoever writes the activity log next picks
// it up - so a jump in the numbers has a visible cause sitting right above it.
//
// Storage rather than a variable in this module, because the popup, the options
// page and the service worker each run their own copy of this file. The context
// that happens to open the database first - usually whichever window the user
// clicked after the update - is rarely the one that writes the log afterwards, and
// a note left in module scope dies with it.
const NOTES_KEY = "migrationNotes";

async function noteMigration(text) {
  const { [NOTES_KEY]: notes = [] } = await chrome.storage.local.get(NOTES_KEY);
  notes.push(text);
  await chrome.storage.local.set({ [NOTES_KEY]: notes });
}

export async function takeMigrationNotes() {
  const { [NOTES_KEY]: notes = [] } = await chrome.storage.local.get(NOTES_KEY);
  if (notes.length) await chrome.storage.local.remove(NOTES_KEY);
  return notes;
}

function open() {
  return new Promise((resolve, reject) => {
    // Set while a migration note is on its way into storage.
    let noted = null;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
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
      // v3: the browser reports visitTime as a double with a sub-millisecond
      // fraction, so a visit stored straight from the API and the same visit read
      // back from an export - where Date.parse() gives whole milliseconds - landed
      // under two different keys. Truncate the existing rows; flooring only ever
      // moves a key backwards, so the rewritten row sorts behind the cursor and is
      // not visited twice.
      if (event.oldVersion < 3 && db.objectStoreNames.contains("visits")) {
        const s = req.transaction.objectStore("visits");
        let rewritten = 0;
        const cur = s.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          const v = c.value;
          const t = Math.floor(v.t);
          if (t !== v.t) {
            c.delete();
            s.put({ url: v.url, t });
            rewritten++;
          }
          c.continue();
        };
        req.transaction.addEventListener("complete", () => {
          noted = noteMigration(
            `database upgraded to v3 - ${rewritten} visits with sub-millisecond ` +
            `timestamps rewritten, merging their duplicates`
          );
        });
      }
    };
    // The version-change transaction completes before this fires, so the note is
    // already under way. Wait for it: a service worker can be torn down the moment
    // the work it was woken for is done, and an unwritten note would be gone for
    // good - the upgrade only ever happens once.
    req.onsuccess = () => {
      const db = req.result;
      if (noted) noted.catch(() => {}).then(() => resolve(db));
      else resolve(db);
    };
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

// Holds the `limit` rows that come first in display order, without keeping every
// match in memory: a row that cannot beat the current last one is dropped where it
// is found. Sorting the whole result and then slicing would do the same thing, but
// the number of matches is not bounded by anything the user can see.
function topRows(limit, newestFirst, field) {
  const rows = [];
  const before = (a, b) => (newestFirst ? a[field] > b[field] : a[field] < b[field]);
  return {
    rows,
    offer(v) {
      if (rows.length >= limit && !before(v, rows[rows.length - 1])) return;
      let lo = 0, hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (before(v, rows[mid])) hi = mid; else lo = mid + 1;
      }
      rows.splice(lo, 0, v);
      if (rows.length > limit) rows.pop();
    }
  };
}

// A trailing slash is noise in a comparison: someone asking for the front page of
// a site types it about half the time.
const noSlash = s => (s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s);

// Substring search over the normalised URL (path included) and the title.
// Full cursor scan - a few hundred thousand rows are milliseconds in IndexedDB,
// and it beats maintaining a token index for an occasional lookup.
//
// A term in double quotes is matched against the whole URL instead, which is the
// only way to ask for a site's front page: "facebook.com" cannot otherwise be
// separated from the thousands of pages underneath it.
//
// `sortBy` and `dateField` are "first" or "last" and are deliberately separate:
// changing the order should not silently change what a date range means.
export function searchPages(term, limit = 300, opts = {}) {
  const {
    from = null, to = null, dateField = "first",
    sortBy = "first", newestFirst = false
  } = opts;

  const raw = String(term || "").trim();
  const exact = raw.length > 2 && raw.startsWith('"') && raw.endsWith('"');
  const q = searchKey(exact ? raw.slice(1, -1).trim() : raw);
  const qExact = noSlash(q);

  return run("pages", "readonly", (store, set) => {
    const top = topRows(limit, newestFirst, sortBy);
    let total = 0;
    const cur = store.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) {
        set({ hits: top.rows, total });
        return;
      }
      const v = c.value;
      const d = v[dateField];
      const inRange = (from === null || d >= from) && (to === null || d <= to);
      const k = v.k || searchKey(v.url);
      const hit = exact
        ? noSlash(k) === qExact
        : !q || k.includes(q) || (v.title || "").toLowerCase().includes(q);
      if (inRange && hit) {
        total++;
        top.offer(v);
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
      // Last line of defence: every writer normalises, but this is the only place
      // a key is actually formed, so it normalises too.
      const t = Math.floor(row.t);
      years.add(new Date(t).getFullYear());
      store.put({ url: row.url, t });
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

/* ---------- Statistics ---------- */

// One pass over the visits in a window, bucketed by day or by week, plus the same
// visits grouped by host. Chart and ranking are counted here together, out of the
// same rows: if they were gathered separately they could disagree, and a box whose
// two halves contradict each other is worse than no box.
//
// Cost is the window, not the database: a range on the timestamp index means a
// week reads a week. Only "everything" touches every row.
export async function collectStats({ from = null, to = null, size = 1 } = {}) {
  const anchor = dayNumber(to === null ? Date.now() : to);
  const range =
    from !== null && to !== null ? IDBKeyRange.bound(from, to) :
    from !== null ? IDBKeyRange.lowerBound(from) :
    to !== null ? IDBKeyRange.upperBound(to) : null;

  const seen = new Map();     // bucket key -> Set of urls, for distinct pages
  const buckets = new Map();  // bucket key -> { visits, pages, fresh }
  const hostVisits = new Map();
  const hostPages = new Map();
  const allUrls = new Set();

  const bucketOf = t => dayNumberToKey(bucketStart(dayNumber(t), size, anchor));

  const add = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

  // getAllKeys rather than a cursor: the visit store is keyed by [url, t], so the
  // keys alone already are the whole row, and nothing has to be deserialised.
  // Measured on 100,000 visits: 169 ms against 1,008 ms for stepping a cursor.
  const keys = await run("visits", "readonly", (store, set) => {
    const q = store.index("t").getAllKeys(range);
    q.onsuccess = () => set(q.result);
  });

  let firstT = null, lastT = null;
  for (const [url, t] of keys) {
    if (firstT === null) firstT = t;
    lastT = t;
    allUrls.add(url);

    const key = bucketOf(t);
    const b = buckets.get(key) || { visits: 0, pages: 0, fresh: 0 };
    b.visits++;
    let urls = seen.get(key);
    if (!urls) seen.set(key, (urls = new Set()));
    if (!urls.has(url)) { urls.add(url); b.pages++; }
    buckets.set(key, b);

    const host = hostOf(url);
    if (host) {
      add(hostVisits, host);
      let hu = hostPages.get(host);
      if (!hu) hostPages.set(host, (hu = new Set()));
      hu.add(url);
    }
  }

  // Pages first seen in the window, from the page index rather than the visits -
  // a page can predate everything we hold timestamps for. A key cursor, because
  // the date being counted is the index key itself; the row is never needed.
  const fresh = await run("pages", "readonly", (store, set) => {
    let total = 0;
    const cur = store.index("first").openKeyCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return set(total);
      const key = bucketOf(c.key);
      const b = buckets.get(key) || { visits: 0, pages: 0, fresh: 0 };
      b.fresh++;
      buckets.set(key, b);
      total++;
      c.continue();
    };
  });

  const hosts = [...hostVisits.entries()]
    .map(([host, visits]) => ({ host, visits, pages: hostPages.get(host).size }))
    .sort((a, b) => b.visits - a.visits || a.host.localeCompare(b.host));

  return {
    buckets, hosts, size, anchor,
    visits: keys.length,
    pages: allUrls.size,
    fresh,
    firstT,
    lastT
  };
}

// The buckets that should be drawn, empty ones included: a day without visits is
// part of the shape, and leaving it out would draw a quiet week as if it were busy.
export function bucketRange(fromDay, toDay, size, anchor) {
  const out = [];
  const first = bucketStart(fromDay, size, anchor);
  const last = bucketStart(toDay, size, anchor);
  for (let n = first; n <= last; n += size) out.push(dayNumberToKey(n));
  return out;
}
