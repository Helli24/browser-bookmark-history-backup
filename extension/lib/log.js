// A rolling record of what the extension did, and when.
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
  migrated: "migrated"       // database schema change
};

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
    "Run log - newest first",
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
    if (e.note) parts.push(e.note);
    return parts.join("  ");
  });
  return header.concat(lines, [""]).join("\r\n");
}
