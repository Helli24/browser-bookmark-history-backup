// Orchestration: settings, build the files, write them, prune old ones.
import {
  loadDirHandle, mergePages, allPages, countPages,
  mergeVisits, visitsInYear, countVisits, takeMigrationNotes
} from "./db.js";
import { addLog, getLog, logToText, KINDS } from "./log.js";
import {
  dateKey, collectBookmarks, collectHistory, collectAllHistory, historyToText,
  indexToCsv, indexToJsonl, visitsToJsonl
} from "./collect.js";

export const DEFAULTS = {
  time: "03:00",
  bookmarks: true,
  history: true,
  index: true,
  // Retention is per folder because the two hold very different things. A daily
  // bookmark file is a full snapshot of a slowly changing state, so old ones are
  // near-duplicates. A daily history log is unique: deleting it destroys the only
  // record of that day, which is why it keeps everything by default.
  bookmarksRetentionDays: 30,    // 0 = keep forever
  bookmarksOnlyOnChange: true,
  historyRetentionDays: 0,       // 0 = keep forever
  folderName: "",
  folderNote: ""    // the full path, typed by hand: the browser never tells us
};

export const FOLDERS = { bookmarks: "Bookmarks", history: "History", index: "Index" };
export const LOG_FILE = "activity.log";
const OLD_LOG_FILE = "runs.log";   // superseded; removed on the next write

const retentionFor = cfg => ({
  [FOLDERS.bookmarks]: cfg.bookmarksRetentionDays || 0,
  [FOLDERS.history]: cfg.historyRetentionDays || 0
});

const MAX_CATCHUP_DAYS = 14;
const MAX_QUEUE = 10;

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/* ---------------- Building the files ---------------- */

export async function buildFiles(s = null) {
  const cfg = s || await getSettings();
  const today = dateKey();
  const files = [];
  const info = { bookmarks: 0, visits: 0, indexAdded: 0, indexTotal: 0, visitsTotal: 0, days: [] };

  if (cfg.bookmarks) {
    const { json, html, stats } = await collectBookmarks();
    info.bookmarks = stats.links;

    // The HTML export carries no generation timestamp, so it hashes to the same
    // value as long as nothing about the bookmarks themselves moved.
    const hash = await sha256(html);
    const { lastBookmarkHash } = await chrome.storage.local.get("lastBookmarkHash");

    if (cfg.bookmarksOnlyOnChange && hash === lastBookmarkHash) {
      info.bookmarksUnchanged = true;
    } else {
      // Handed back so the caller can store it once the write actually succeeded -
      // remembering it here would skip tomorrow's write after a failed one.
      info.bookmarkHash = hash;
      files.push({ folder: FOLDERS.bookmarks, name: `bookmarks-${today}.json`, content: json });
      files.push({ folder: FOLDERS.bookmarks, name: `bookmarks-${today}.html`, content: html });
    }
  }

  if (cfg.history || cfg.index) {
    const indexRows = [];
    const visitRows = [];

    for (const dayStart of await pendingDays()) {
      const from = dayStart.getTime();
      const to = Math.min(from + 86400000, Date.now());
      if (to <= from) continue;

      const { visits, index, allVisits } = await collectHistory(from, to);
      indexRows.push(...index);
      visitRows.push(...allVisits);
      info.visits += visits.length;
      info.days.push(dateKey(dayStart));

      if (cfg.history) {
        files.push({
          folder: FOLDERS.history,
          name: `history-${dateKey(dayStart)}.txt`,
          content: historyToText(dateKey(dayStart), visits)
        });
      }
    }

    if (cfg.index) {
      if (indexRows.length) info.indexAdded = (await mergePages(indexRows)).added;

      // Only the years that received rows get rewritten - normally just this one.
      const years = visitRows.length ? await mergeVisits(visitRows) : new Set();
      for (const year of years) {
        files.push({
          folder: FOLDERS.index,
          name: `visits-${year}.jsonl`,
          content: visitsToJsonl(await visitsInYear(year))
        });
      }

      const all = await allPages();
      info.indexTotal = all.length;
      info.visitsTotal = await countVisits();
      files.push({ folder: FOLDERS.index, name: "page-index.csv", content: indexToCsv(all) });
      files.push({ folder: FOLDERS.index, name: "page-index.jsonl", content: indexToJsonl(all) });
    }
  }

  return { files, info, day: today };
}

// Which calendar days still need to be written?
// The last one written is redone, because it may have been captured mid-day.
async function pendingDays() {
  const { historyCoveredThrough } = await chrome.storage.local.get("historyCoveredThrough");
  const today = new Date(); today.setHours(0, 0, 0, 0);

  let start = new Date(today.getTime() - 86400000);   // first ever run: yesterday + today
  if (historyCoveredThrough) {
    const d = new Date(`${historyCoveredThrough}T00:00:00`);
    if (!isNaN(d.getTime())) start = d;
  }
  const oldest = today.getTime() - MAX_CATCHUP_DAYS * 86400000;
  if (start.getTime() < oldest) start = new Date(oldest);

  const days = [];
  for (let d = new Date(start); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
    const t = new Date(d); t.setHours(0, 0, 0, 0);
    days.push(t);
  }
  return days;
}

/* ---------------- Writing ---------------- */

export async function getGrantedDir() {
  const dir = await loadDirHandle();
  if (!dir) {
    const e = new Error("No target folder has been chosen yet.");
    e.code = "NO_DIR";
    throw e;
  }
  // The state goes into the message rather than a guess at what caused it. The
  // usual reason is a grant of "Allow this time", which lapses once no page of
  // the extension is open and on every restart; "Allow on every visit" does not.
  const state = await dir.queryPermission({ mode: "readwrite" });
  if (state !== "granted") {
    const e = new Error(`Folder permission is "${state}" - it takes one click to confirm.`);
    e.code = "NO_PERMISSION";
    throw e;
  }
  return dir;
}

// retention: { [folderName]: days }. 0 or missing means keep everything.
export async function writeAll(dir, files, retention = {}) {
  const subdirs = new Map();
  for (const f of files) {
    if (!subdirs.has(f.folder)) {
      subdirs.set(f.folder, await dir.getDirectoryHandle(f.folder, { create: true }));
    }
    const fh = await subdirs.get(f.folder).getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    await w.write(f.content);
    await w.close();
  }

  let deleted = 0;
  for (const [name, h] of subdirs) {
    if (name === FOLDERS.index) continue;            // the index is cumulative, never prune it
    const days = retention[name] || 0;
    if (days > 0) deleted += await prune(h, days);
  }
  return { written: files.length, deleted };
}

// Which of these files may be deleted? Split out from the file handling so the
// rule can be tested without a directory.
//
// The newest date is always spared, whatever the cutoff says. Otherwise a folder
// that only gets written when something actually changed would eventually lose
// its last remaining snapshot: leave your bookmarks alone for longer than the
// retention window and the one backup you have would be pruned away.
export function selectPrunable(names, cutoffMs, keepNewestDates = 1) {
  const dated = [];
  for (const name of names) {
    const m = name.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;                                 // no date in the name: not ours to delete
    dated.push({ name, t: new Date(+m[1], +m[2] - 1, +m[3]).getTime() });
  }

  const keep = new Set(
    [...new Set(dated.map(d => d.t))].sort((a, b) => b - a).slice(0, keepNewestDates)
  );
  return dated.filter(d => !keep.has(d.t) && d.t < cutoffMs).map(d => d.name);
}

async function prune(dir, days) {
  const names = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file") names.push(name);
  }
  let n = 0;
  for (const name of selectPrunable(names, Date.now() - days * 86400000)) {
    try { await dir.removeEntry(name); n++; } catch { /* not worth failing the run over */ }
  }
  return n;
}

/* ---------------- Queue for runs that could not be written ---------------- */

export async function queueFiles(files, day, error) {
  const { queue = [] } = await chrome.storage.local.get("queue");
  const rest = queue.filter(e => e.day !== day);
  rest.push({ day, createdAt: Date.now(), error: String(error || ""), files });
  while (rest.length > MAX_QUEUE) rest.shift();
  await chrome.storage.local.set({ queue: rest });
}

export async function flushQueue(dir) {
  const cfg = await getSettings();
  const { queue = [] } = await chrome.storage.local.get("queue");
  if (!queue.length) return 0;
  let n = 0;
  for (const entry of queue) {
    await writeAll(dir, entry.files, retentionFor(cfg));
    n += entry.files.length;
  }
  await chrome.storage.local.set({ queue: [] });
  return n;
}

/* ---------------- Full run ---------------- */

export async function runBackup(reason = "alarm") {
  const cfg = await getSettings();
  const { files, info, day } = await buildFiles(cfg);
  if (!files.length) {
    return { ok: true, note: "Nothing enabled - there is nothing to back up." };
  }

  try {
    const dir = await getGrantedDir();
    const flushed = await flushQueue(dir);
    const res = await writeAll(dir, files, retentionFor(cfg));
    if (info.bookmarkHash) await chrome.storage.local.set({ lastBookmarkHash: info.bookmarkHash });
    const lastRun = {
      at: Date.now(), day, ok: true, reason,
      written: res.written + flushed, deleted: res.deleted, info
    };
    // lastOkAt is kept apart from lastRun, which a later failure overwrites. The
    // question "when did this last actually work" has to survive that.
    await chrome.storage.local.set({ lastRun, lastOkAt: lastRun.at, historyCoveredThrough: day });
    await badge("");
    await record({
      kind: reason, ok: true, files: lastRun.written,
      pages: info.indexTotal, visits: info.visitsTotal,
      note: info.bookmarksUnchanged ? "bookmarks unchanged" : ""
    }, dir);
    return { ok: true, lastRun };
  } catch (e) {
    await queueFiles(files, day, e.message);
    const lastRun = {
      at: Date.now(), day, ok: false, reason,
      error: e.message, code: e.code || "", info
    };
    // Deliberately NOT advancing historyCoveredThrough: nothing was written, so
    // those days are still pending. Marking them done would leave the queue as
    // the only copy, and the queue is a bounded buffer that drops its oldest
    // entry. Left pending, the next run that succeeds rebuilds them from the
    // browser - up to MAX_CATCHUP_DAYS back.
    await chrome.storage.local.set({ lastRun });
    await badge("!");
    // The kind says which run it was, not just that something was queued: a
    // failed 03:00 and a failed click are very different findings, and the log
    // could not tell them apart.
    await record({ kind: reason, ok: false, note: `queued - ${e.message}` });
    return { ok: false, lastRun };
  }
}

// A backup tool fails quietly: the alarm does not fire, the browser stays closed,
// an error repeats - and nobody notices until the day the files are needed. Three
// days is late enough not to nag over a long weekend away from the machine, and
// early enough that a fortnight of silence cannot pass unseen.
export const STALE_DAYS = 3;

// Days since the last run that actually wrote something, or null if there has
// never been one. Reading storage only - no database, nothing to wait for.
export async function staleness() {
  const { lastOkAt, lastRun } = await chrome.storage.local.get(["lastOkAt", "lastRun"]);
  // Installs from before this field existed still have a successful lastRun.
  const at = lastOkAt || (lastRun?.ok ? lastRun.at : null);
  if (!at) return { at: null, days: null, stale: false, never: true };
  const days = Math.floor((Date.now() - at) / 864e5);
  return { at, days, stale: days >= STALE_DAYS, never: false };
}

// Moves whatever a schema migration parked in storage into the log. Called before
// every recorded run, and by the options page when it draws the log - otherwise an
// upgrade would sit there unexplained until the next backup happens to run.
export async function flushMigrationNotes() {
  for (const note of await takeMigrationNotes()) {
    await addLog({ kind: KINDS.migrated, note });
  }
}

// Records one run and mirrors the log into the backup folder. The log file is
// written after the run rather than as part of it, so it can describe the run it
// belongs to instead of always lagging one behind.
export async function record(entry, dir = null) {
  await flushMigrationNotes();
  const entries = await addLog(entry);
  if (!dir) return entries;
  try {
    const idx = await dir.getDirectoryHandle(FOLDERS.index, { create: true });
    const fh = await idx.getFileHandle(LOG_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(logToText(entries));
    await w.close();
    // The same log under its old name - carried over above, so it only confuses.
    try { await idx.removeEntry(OLD_LOG_FILE); } catch { /* never existed */ }
  } catch { /* the run itself matters more than its footnote */ }
  return entries;
}

export async function badge(text) {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
  } catch { /* no action API in this context */ }
}

/* ---------------- One-off backfill ---------------- */

// Writes a daily log for every day the browser still covers and fills the database
// with the matching timestamps. Meant to be run once, shortly after installing:
// whatever is inside the browser's rolling window today is gone in three months.
export async function backfillAll(dir, onProgress = () => {}) {
  const cfg = await getSettings();
  const { byDay, index, allVisits, urls } = await collectAllHistory({ onProgress });

  const files = [];
  if (cfg.history) {
    for (const [day, visits] of [...byDay].sort()) {
      files.push({
        folder: FOLDERS.history,
        name: `history-${day}.txt`,
        content: historyToText(day, visits)
      });
    }
  }

  let added = 0;
  if (cfg.index) {
    if (index.length) added = (await mergePages(index)).added;
    const years = allVisits.length ? await mergeVisits(allVisits) : new Set();
    for (const year of years) {
      files.push({
        folder: FOLDERS.index,
        name: `visits-${year}.jsonl`,
        content: visitsToJsonl(await visitsInYear(year))
      });
    }
    const all = await allPages();
    files.push({ folder: FOLDERS.index, name: "page-index.csv", content: indexToCsv(all) });
    files.push({ folder: FOLDERS.index, name: "page-index.jsonl", content: indexToJsonl(all) });
  }

  onProgress({ phase: "write", done: 0, total: files.length });
  // No pruning here: retention is the scheduled run's job, and deleting a file
  // we just recovered would be an unpleasant surprise.
  await writeAll(dir, files, {});

  const today = dateKey();
  await chrome.storage.local.set({ historyCoveredThrough: today });

  const pagesTotal = await countPages();
  const visitsTotal = await countVisits();
  await record({
    kind: KINDS.imported, ok: true, files: files.length,
    pages: pagesTotal, visits: visitsTotal,
    note: `${byDay.size} days recovered from the browser`
  }, dir);

  return {
    days: byDay.size,
    urls,
    visits: allVisits.length,
    added,
    files: files.length,
    pagesTotal,
    visitsTotal
  };
}

/* ---------------- Rebuilding the index ---------------- */

async function readTextFile(dir, name) {
  const fh = await dir.getFileHandle(name, { create: false });
  return (await fh.getFile()).text();
}

// Reads the index back out of the backup folder, so it survives a reinstall of
// the extension or a wiped browser profile. page-index.jsonl carries the summary,
// visits-<year>.jsonl the individual timestamps.
export async function importIndex(dir) {
  const idx = await dir.getDirectoryHandle(FOLDERS.index, { create: false });

  const rows = [];
  for (const line of (await readTextFile(idx, "page-index.jsonl")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!o.url) continue;
      const first = Date.parse(o.firstVisit) || Date.now();
      rows.push({
        url: o.url,
        host: o.host || "",
        title: o.title || "",
        first,
        last: Date.parse(o.lastVisit) || first,
        count: o.visits || 0
      });
    } catch { /* skip a broken line rather than abort the import */ }
  }
  const pageStats = rows.length ? await mergePages(rows) : { added: 0 };

  // Pick up every visits-<year>.jsonl the folder happens to contain.
  const yearFiles = [];
  for await (const [name, h] of idx.entries()) {
    if (h.kind === "file" && /^visits-\d{4}\.jsonl$/.test(name)) yearFiles.push(name);
  }
  let visitRows = 0;
  for (const name of yearFiles.sort()) {
    const batch = [];
    for (const line of (await readTextFile(idx, name)).split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        const t = Date.parse(o.at);
        if (o.url && t) batch.push({ url: o.url, t });
      } catch { /* skip a broken line */ }
    }
    if (batch.length) await mergeVisits(batch);
    visitRows += batch.length;
  }

  return {
    read: rows.length,
    added: pageStats.added,
    total: await countPages(),
    visitsRead: visitRows,
    visitsTotal: await countVisits()
  };
}
