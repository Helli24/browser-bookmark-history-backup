// Helpers for the popup and the options page. Manual backups run here in the page
// rather than in the service worker: re-granting the directory permission requires a
// user gesture, and only a page has one.
import { loadDirHandle, saveDirHandle } from "./db.js";
import { buildFiles, writeAll, flushQueue, getSettings, badge } from "./run.js";
import { dateKey } from "./collect.js";

export async function freigabeZustand() {
  const dir = await loadDirHandle();
  if (!dir) return { dir: null, zustand: "keiner" };
  return { dir, zustand: await dir.queryPermission({ mode: "readwrite" }) };
}

// Call from a click handler only.
export async function ordnerWaehlen() {
  const dir = await window.showDirectoryPicker({
    mode: "readwrite",
    id: "chrome-backup",
    startIn: "documents"
  });
  await saveDirHandle(dir);
  return dir;
}

// Call from a click handler only.
export async function freigabeErneuern() {
  const dir = await loadDirHandle();
  if (!dir) throw new Error("Es ist noch kein Zielordner ausgewaehlt.");
  const p = await dir.requestPermission({ mode: "readwrite" });
  if (p !== "granted") throw new Error("Die Freigabe wurde abgelehnt.");
  return dir;
}

// Full run from the page, flushing anything the scheduler could not write earlier.
export async function sichernJetzt(grund = "manuell") {
  const cfg = await getSettings();
  let { dir, zustand } = await freigabeZustand();
  if (!dir) throw new Error("Es ist noch kein Zielordner ausgewaehlt.");
  if (zustand !== "granted") dir = await freigabeErneuern();

  const nachgeholt = await flushQueue(dir);
  const { dateien, info, tag } = await buildFiles(cfg);
  const res = dateien.length
    ? await writeAll(dir, dateien, cfg.aufbewahrungTage)
    : { geschrieben: 0, geloescht: 0 };

  const lauf = {
    zeit: Date.now(), tag, ok: true, grund,
    geschrieben: res.geschrieben + nachgeholt,
    geloescht: res.geloescht,
    info
  };
  await chrome.storage.local.set({ letzterLauf: lauf, verlaufBis: tag });
  await badge("");
  return lauf;
}

/* ---------------- Formatting ---------------- */

export function zeitpunkt(ms) {
  if (!ms) return "noch nie";
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  const heute = dateKey();
  const tag = dateKey(d);
  const uhr = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (tag === heute) return `heute ${uhr}`;
  const gestern = dateKey(new Date(Date.now() - 86400000));
  if (tag === gestern) return `gestern ${uhr}`;
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${uhr}`;
}

export function datumKurz(ms) {
  if (!ms) return "?";
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function jahreSeit(ms) {
  if (!ms) return "";
  const tage = Math.floor((Date.now() - ms) / 86400000);
  if (tage < 1) return "heute";
  if (tage === 1) return "gestern";
  if (tage < 60) return `vor ${tage} Tagen`;
  const monate = Math.round(tage / 30.44);
  if (monate < 24) return `vor ${monate} Monaten`;
  return `vor ${(tage / 365.25).toFixed(1).replace(".", ",")} Jahren`;
}
