// Orchestration: settings, build the files, write them, prune old ones.
import { loadDirHandle, mergePages, allPages, countPages } from "./db.js";
import {
  dateKey, collectBookmarks, collectHistory, historyToText,
  indexToCsv, indexToJsonl
} from "./collect.js";

export const DEFAULTS = {
  zeit: "03:00",
  lesezeichen: true,
  verlauf: true,
  index: true,
  aufbewahrungTage: 365,   // 0 = keep forever; only applies to the per-day files
  ordnerName: ""
};

export const ORDNER = { lesezeichen: "Lesezeichen", verlauf: "Verlauf", index: "Index" };
const MAX_NACHHOLTAGE = 14;
const MAX_WARTESCHLANGE = 10;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const neu = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: neu });
  return neu;
}

/* ---------------- Building the files ---------------- */

export async function buildFiles(s = null) {
  const cfg = s || await getSettings();
  const heute = dateKey();
  const dateien = [];
  const info = { lesezeichen: 0, besuche: 0, indexNeu: 0, indexGesamt: 0, tage: [] };

  if (cfg.lesezeichen) {
    const { json, html, stats } = await collectBookmarks();
    info.lesezeichen = stats.links;
    dateien.push({ ordner: ORDNER.lesezeichen, name: `lesezeichen-${heute}.json`, inhalt: json });
    dateien.push({ ordner: ORDNER.lesezeichen, name: `lesezeichen-${heute}.html`, inhalt: html });
  }

  if (cfg.verlauf || cfg.index) {
    const indexZeilen = [];

    for (const tagStart of await offeneTage()) {
      const von = tagStart.getTime();
      const bis = Math.min(von + 86400000, Date.now());
      if (bis <= von) continue;

      const { besuche, index } = await collectHistory(von, bis);
      indexZeilen.push(...index);
      info.besuche += besuche.length;
      info.tage.push(dateKey(tagStart));

      if (cfg.verlauf) {
        dateien.push({
          ordner: ORDNER.verlauf,
          name: `verlauf-${dateKey(tagStart)}.txt`,
          inhalt: historyToText(dateKey(tagStart), besuche)
        });
      }
    }

    if (cfg.index) {
      if (indexZeilen.length) info.indexNeu = (await mergePages(indexZeilen)).neu;
      const alle = await allPages();
      info.indexGesamt = alle.length;
      dateien.push({ ordner: ORDNER.index, name: "seiten-index.csv", inhalt: indexToCsv(alle) });
      dateien.push({ ordner: ORDNER.index, name: "seiten-index.jsonl", inhalt: indexToJsonl(alle) });
    }
  }

  return { dateien, info, tag: heute };
}

// Which calendar days still need to be written?
// The last one written is redone, because it may have been captured mid-day.
async function offeneTage() {
  const { verlaufBis } = await chrome.storage.local.get("verlaufBis");
  const heute = new Date(); heute.setHours(0, 0, 0, 0);

  let start = new Date(heute.getTime() - 86400000);   // first ever run: yesterday + today
  if (verlaufBis) {
    const d = new Date(`${verlaufBis}T00:00:00`);
    if (!isNaN(d.getTime())) start = d;
  }
  const aeltestes = heute.getTime() - MAX_NACHHOLTAGE * 86400000;
  if (start.getTime() < aeltestes) start = new Date(aeltestes);

  const tage = [];
  for (let d = new Date(start); d.getTime() <= heute.getTime(); d.setDate(d.getDate() + 1)) {
    const t = new Date(d); t.setHours(0, 0, 0, 0);
    tage.push(t);
  }
  return tage;
}

/* ---------------- Writing ---------------- */

export async function getGrantedDir() {
  const dir = await loadDirHandle();
  if (!dir) {
    const e = new Error("Es ist noch kein Zielordner ausgewaehlt.");
    e.code = "NO_DIR";
    throw e;
  }
  if (await dir.queryPermission({ mode: "readwrite" }) !== "granted") {
    const e = new Error("Die Ordnerfreigabe muss nach dem Chrome-Neustart einmal bestaetigt werden.");
    e.code = "NO_PERMISSION";
    throw e;
  }
  return dir;
}

export async function writeAll(dir, dateien, aufbewahrungTage = 0) {
  const unterordner = new Map();
  for (const f of dateien) {
    if (!unterordner.has(f.ordner)) {
      unterordner.set(f.ordner, await dir.getDirectoryHandle(f.ordner, { create: true }));
    }
    const fh = await unterordner.get(f.ordner).getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    await w.write(f.inhalt);
    await w.close();
  }

  let geloescht = 0;
  if (aufbewahrungTage > 0) {
    for (const [name, h] of unterordner) {
      if (name === ORDNER.index) continue;          // the index is cumulative, never prune it
      geloescht += await prune(h, aufbewahrungTage);
    }
  }
  return { geschrieben: dateien.length, geloescht };
}

async function prune(dir, tage) {
  const grenze = Date.now() - tage * 86400000;
  let n = 0;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "file") continue;
    const m = name.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    if (new Date(+m[1], +m[2] - 1, +m[3]).getTime() < grenze) {
      try { await dir.removeEntry(name); n++; } catch { /* not worth failing the run over */ }
    }
  }
  return n;
}

/* ---------------- Queue for runs that could not be written ---------------- */

export async function queueFiles(dateien, tag, fehler) {
  const { warteschlange = [] } = await chrome.storage.local.get("warteschlange");
  const rest = warteschlange.filter(e => e.tag !== tag);
  rest.push({ tag, erzeugt: Date.now(), fehler: String(fehler || ""), dateien });
  while (rest.length > MAX_WARTESCHLANGE) rest.shift();
  await chrome.storage.local.set({ warteschlange: rest });
}

export async function flushQueue(dir) {
  const cfg = await getSettings();
  const { warteschlange = [] } = await chrome.storage.local.get("warteschlange");
  if (!warteschlange.length) return 0;
  let n = 0;
  for (const eintrag of warteschlange) {
    await writeAll(dir, eintrag.dateien, cfg.aufbewahrungTage);
    n += eintrag.dateien.length;
  }
  await chrome.storage.local.set({ warteschlange: [] });
  return n;
}

/* ---------------- Full run ---------------- */

export async function runBackup(grund = "alarm") {
  const cfg = await getSettings();
  const { dateien, info, tag } = await buildFiles(cfg);
  if (!dateien.length) {
    return { ok: true, hinweis: "Nichts aktiviert - es gibt nichts zu sichern." };
  }

  try {
    const dir = await getGrantedDir();
    const nachgeholt = await flushQueue(dir);
    const res = await writeAll(dir, dateien, cfg.aufbewahrungTage);
    const lauf = {
      zeit: Date.now(), tag, ok: true, grund,
      geschrieben: res.geschrieben + nachgeholt, geloescht: res.geloescht, info
    };
    await chrome.storage.local.set({ letzterLauf: lauf, verlaufBis: tag });
    await badge("");
    return { ok: true, lauf };
  } catch (e) {
    await queueFiles(dateien, tag, e.message);
    const lauf = {
      zeit: Date.now(), tag, ok: false, grund,
      fehler: e.message, code: e.code || "", info
    };
    await chrome.storage.local.set({ letzterLauf: lauf, verlaufBis: tag });
    await badge("!");
    return { ok: false, lauf };
  }
}

export async function badge(text) {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
  } catch { /* no action API in this context */ }
}

/* ---------------- Rebuilding the index ---------------- */

// Reads seiten-index.jsonl from the backup folder back into the database, so the
// index survives a reinstall of the extension or a wiped Chrome profile.
export async function importIndex(dir) {
  const idx = await dir.getDirectoryHandle(ORDNER.index, { create: false });
  const fh = await idx.getFileHandle("seiten-index.jsonl", { create: false });
  const text = await (await fh.getFile()).text();

  const rows = [];
  for (const zeile of text.split("\n")) {
    if (!zeile.trim()) continue;
    try {
      const o = JSON.parse(zeile);
      if (!o.url) continue;
      const erst = Date.parse(o.erstbesuch) || Date.now();
      rows.push({
        url: o.url,
        host: o.host || "",
        title: o.titel || "",
        first: erst,
        last: Date.parse(o.letzterBesuch) || erst,
        count: o.aufrufe || 0
      });
    } catch { /* skip a broken line rather than abort the import */ }
  }
  if (!rows.length) return { gelesen: 0, neu: 0, gesamt: await countPages() };
  const stats = await mergePages(rows);
  return { gelesen: rows.length, neu: stats.neu, gesamt: await countPages() };
}
