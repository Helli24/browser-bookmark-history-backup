// Orchestration: settings, build the files, write them, prune old ones.
import {
  loadDirHandle, mergePages, allPages, countPages,
  mergeVisits, visitsInYear, countVisits
} from "./db.js";
import {
  dateKey, collectBookmarks, collectHistory, collectAllHistory, historyToText,
  indexToCsv, indexToJsonl, visitsToJsonl
} from "./collect.js";

export const DEFAULTS = {
  time: "03:00",
  bookmarks: true,
  history: true,
  index: true,
  retentionDays: 365,   // 0 = keep forever; only applies to the per-day files
  folderName: ""
};

export const FOLDERS = { bookmarks: "Bookmarks", history: "History", index: "Index" };
const MAX_CATCHUP_DAYS = 14;
const MAX_QUEUE = 10;

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
    files.push({ folder: FOLDERS.bookmarks, name: `bookmarks-${today}.json`, content: json });
    files.push({ folder: FOLDERS.bookmarks, name: `bookmarks-${today}.html`, content: html });
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
          content: visitsToJsonl(await visitsInYear(year)),
          keep: true
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
  if (await dir.queryPermission({ mode: "readwrite" }) !== "granted") {
    const e = new Error("Folder access has to be confirmed once after a Chrome restart.");
    e.code = "NO_PERMISSION";
    throw e;
  }
  return dir;
}

export async function writeAll(dir, files, retentionDays = 0) {
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
  if (retentionDays > 0) {
    for (const [name, h] of subdirs) {
      if (name === FOLDERS.index) continue;          // the index is cumulative, never prune it
      deleted += await prune(h, retentionDays);
    }
  }
  return { written: files.length, deleted };
}

async function prune(dir, days) {
  const cutoff = Date.now() - days * 86400000;
  let n = 0;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "file") continue;
    const m = name.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    if (new Date(+m[1], +m[2] - 1, +m[3]).getTime() < cutoff) {
      try { await dir.removeEntry(name); n++; } catch { /* not worth failing the run over */ }
    }
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
    await writeAll(dir, entry.files, cfg.retentionDays);
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
    const res = await writeAll(dir, files, cfg.retentionDays);
    const lastRun = {
      at: Date.now(), day, ok: true, reason,
      written: res.written + flushed, deleted: res.deleted, info
    };
    await chrome.storage.local.set({ lastRun, historyCoveredThrough: day });
    await badge("");
    return { ok: true, lastRun };
  } catch (e) {
    await queueFiles(files, day, e.message);
    const lastRun = {
      at: Date.now(), day, ok: false, reason,
      error: e.message, code: e.code || "", info
    };
    await chrome.storage.local.set({ lastRun, historyCoveredThrough: day });
    await badge("!");
    return { ok: false, lastRun };
  }
}

export async function badge(text) {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
  } catch { /* no action API in this context */ }
}

/* ---------------- One-off backfill ---------------- */

// Writes a daily log for every day Chrome still covers and fills the database
// with the matching timestamps. Meant to be run once, shortly after installing:
// whatever is inside Chrome's rolling window today is gone in three months.
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
  await writeAll(dir, files, 0);

  const today = dateKey();
  await chrome.storage.local.set({ historyCoveredThrough: today });

  return {
    days: byDay.size,
    urls,
    visits: allVisits.length,
    added,
    files: files.length,
    pagesTotal: await countPages(),
    visitsTotal: await countVisits()
  };
}

/* ---------------- Rebuilding the index ---------------- */

async function readTextFile(dir, name) {
  const fh = await dir.getFileHandle(name, { create: false });
  return (await fh.getFile()).text();
}

// Reads the index back out of the backup folder, so it survives a reinstall of
// the extension or a wiped Chrome profile. page-index.jsonl carries the summary,
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
