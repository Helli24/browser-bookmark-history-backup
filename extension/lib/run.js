// Orchestration: settings, build the files, write them, prune old ones.
import { loadDirHandle, mergePages, allPages, countPages } from "./db.js";
import {
  dateKey, collectBookmarks, collectHistory, historyToText,
  indexToCsv, indexToJsonl
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
  const info = { bookmarks: 0, visits: 0, indexAdded: 0, indexTotal: 0, days: [] };

  if (cfg.bookmarks) {
    const { json, html, stats } = await collectBookmarks();
    info.bookmarks = stats.links;
    files.push({ folder: FOLDERS.bookmarks, name: `bookmarks-${today}.json`, content: json });
    files.push({ folder: FOLDERS.bookmarks, name: `bookmarks-${today}.html`, content: html });
  }

  if (cfg.history || cfg.index) {
    const indexRows = [];

    for (const dayStart of await pendingDays()) {
      const from = dayStart.getTime();
      const to = Math.min(from + 86400000, Date.now());
      if (to <= from) continue;

      const { visits, index } = await collectHistory(from, to);
      indexRows.push(...index);
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
      const all = await allPages();
      info.indexTotal = all.length;
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

/* ---------------- Rebuilding the index ---------------- */

// Reads page-index.jsonl from the backup folder back into the database, so the
// index survives a reinstall of the extension or a wiped Chrome profile.
export async function importIndex(dir) {
  const idx = await dir.getDirectoryHandle(FOLDERS.index, { create: false });
  const fh = await idx.getFileHandle("page-index.jsonl", { create: false });
  const text = await (await fh.getFile()).text();

  const rows = [];
  for (const line of text.split("\n")) {
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
  if (!rows.length) return { read: 0, added: 0, total: await countPages() };
  const stats = await mergePages(rows);
  return { read: rows.length, added: stats.added, total: await countPages() };
}
