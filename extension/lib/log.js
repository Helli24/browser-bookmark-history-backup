// A rolling record of what the extension did, and when. Not only backup runs -
// restores, schema migrations and failed attempts belong here just as much.
//
// The point is not the individual line but the series: the counts should only
// ever grow, so a drop that nobody ordered becomes visible instead of being
// discovered months later by accident.
import { fmtDateTime } from "./collect.js";

// Roughly nine months at a few runs a day, about 120 KB. Old entries fall off
// the end - this is a window, not an archive.
export const MAX_ENTRIES = 1000;

export const KINDS = {
  scheduled: "scheduled",
  manual: "manual",
  popup: "popup",
  catchup: "catch-up",
  queued: "queued",
  failed: "failed",
  imported: "imported",      // one-off pull from the browser
  restored: "restored",      // read back from the backup folder
  adopted: "adopted",        // same, but triggered by picking the folder
  migrated: "migrated",      // database schema change
  started: "browser start"   // so a failure can be told apart from a restart
};

// What a run did with the bookmarks, as its own field: in the note it repeated
// every night and buried whatever the note had to say. Undefined when bookmarks
// are switched off, so the column stays empty rather than claiming something.
export function bookmarksDone(info) {
  if (info.bookmarksUnchanged) return "unchanged";
  if (info.bookmarkHash) return "saved";
  return undefined;
}

// Entries written before that field existed kept the same fact in the note.
const RUN_KINDS = new Set([KINDS.scheduled, KINDS.manual, KINDS.popup, KINDS.catchup]);
export function readBookmarks(e) {
  if (e.bookmarks) return { bookmarks: e.bookmarks, note: e.note || "" };
  if (e.note === "bookmarks unchanged") return { bookmarks: "unchanged", note: "" };
  const saved = RUN_KINDS.has(e.kind) && e.ok !== false && e.files > 0;
  return { bookmarks: saved ? "saved" : "", note: e.note || "" };
}

export async function addLog(entry) {
  const { runLog = [] } = await chrome.storage.local.get("runLog");
  runLog.push({ at: Date.now(), ...entry });
  while (runLog.length > MAX_ENTRIES) runLog.shift();
  await chrome.storage.local.set({ runLog });
  return runLog;
}

export async function getLog() {
  const { runLog = [] } = await chrome.storage.local.get("runLog");
  return runLog;
}

export const clearLog = () => chrome.storage.local.set({ runLog: [] });

// Newest first, so opening the file lands on what just happened.
export function logToText(entries) {
  const header = [
    "Activity log - newest first",
    `${entries.length} entries, oldest kept: ${MAX_ENTRIES}`,
    "=".repeat(78),
    ""
  ];
  const lines = [...entries].reverse().map(e => {
    const parts = [fmtDateTime(e.at), (e.kind || "?").padEnd(10)];
    if (e.ok === false) parts.push("FAILED");
    if (e.files != null) parts.push(`${e.files} files`);
    if (e.pages != null) parts.push(`${e.pages} pages`);
    if (e.visits != null) parts.push(`${e.visits} visits`);
    const { bookmarks, note } = readBookmarks(e);
    if (bookmarks) parts.push(`bookmarks ${bookmarks}`);
    if (note) parts.push(note);
    return parts.join("  ");
  });
  return header.concat(lines, [""]).join("\r\n");
}
