// Helpers for the popup and the options page. Manual backups run here in the page
// rather than in the service worker: re-granting the directory permission requires a
// user gesture, and only a page has one.
import { loadDirHandle, saveDirHandle } from "./db.js";
import { buildFiles, writeAll, flushQueue, getSettings, badge, record, FOLDERS } from "./run.js";
import { dateKey } from "./collect.js";
import { bookmarksDone } from "./log.js";

export async function permissionState() {
  const dir = await loadDirHandle();
  if (!dir) return { dir: null, state: "none" };
  return { dir, state: await dir.queryPermission({ mode: "readwrite" }) };
}

// Call from a click handler only.
export async function pickFolder() {
  const dir = await window.showDirectoryPicker({
    mode: "readwrite",
    id: "chrome-backup",
    startIn: "documents"
  });
  await saveDirHandle(dir);
  return dir;
}

// Call from a click handler only.
export async function regrantPermission() {
  const dir = await loadDirHandle();
  if (!dir) throw new Error("No target folder has been chosen yet.");
  const p = await dir.requestPermission({ mode: "readwrite" });
  if (p !== "granted") throw new Error("Access was denied.");
  return dir;
}

// Full run from the page, flushing anything the scheduler could not write earlier.
export async function backupNow(reason = "manual") {
  const cfg = await getSettings();
  let { dir, state } = await permissionState();
  if (!dir) throw new Error("No target folder has been chosen yet.");
  if (state !== "granted") dir = await regrantPermission();

  const flushed = await flushQueue(dir);
  const { files, info, day } = await buildFiles(cfg);
  const retention = {
    [FOLDERS.bookmarks]: cfg.bookmarksRetentionDays || 0,
    [FOLDERS.history]: cfg.historyRetentionDays || 0
  };
  const res = files.length
    ? await writeAll(dir, files, retention)
    : { written: 0, deleted: 0 };
  if (info.bookmarkHash) await chrome.storage.local.set({ lastBookmarkHash: info.bookmarkHash });

  const lastRun = {
    at: Date.now(), day, ok: true, reason,
    written: res.written + flushed,
    deleted: res.deleted,
    info
  };
  await chrome.storage.local.set({ lastRun, historyCoveredThrough: day });
  await badge("");
  await record({
    kind: reason, ok: true, files: lastRun.written,
    pages: info.indexTotal, visits: info.visitsTotal,
    bookmarks: bookmarksDone(info)
  }, dir);
  return lastRun;
}

/* ---------------- Formatting ---------------- */

export function formatWhen(ms) {
  if (!ms) return "never";
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  const day = dateKey(d);
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (day === dateKey()) return `today ${clock}`;
  if (day === dateKey(new Date(Date.now() - 86400000))) return `yesterday ${clock}`;
  if (day === dateKey(new Date(Date.now() + 86400000))) return `tomorrow ${clock}`;
  return `${formatDate(ms)} ${clock}`;
}

export function formatDate(ms) {
  if (!ms) return "?";
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function timeAgo(ms) {
  if (!ms) return "";
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months ago`;
  return `${(days / 365.25).toFixed(1)} years ago`;
}
