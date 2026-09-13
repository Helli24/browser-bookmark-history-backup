// Options page: target folder, what to back up, schedule, search, maintenance.
import { getSettings, setSettings, importIndex, DEFAULTS } from "./lib/run.js";
import { searchPages, countPages } from "./lib/db.js";
import {
  freigabeZustand, ordnerWaehlen, freigabeErneuern, sichernJetzt,
  zeitpunkt, datumKurz, jahreSeit
} from "./lib/ui.js";

const $ = id => document.getElementById(id);
const el = {
  bannerFreigabe: $("bannerFreigabe"), bannerText: $("bannerText"), btnFreigabe: $("btnFreigabe"),
  ordnerName: $("ordnerName"), freigabePlakette: $("freigabePlakette"), btnOrdner: $("btnOrdner"),
  cbLesezeichen: $("cbLesezeichen"), cbVerlauf: $("cbVerlauf"), cbIndex: $("cbIndex"),
  zeit: $("zeit"), aufbewahrung: $("aufbewahrung"), naechsterLauf: $("naechsterLauf"),
  btnSichern: $("btnSichern"), sichernMeldung: $("sichernMeldung"),
  suche: $("suche"), sucheInfo: $("sucheInfo"), tabelle: $("tabelle"), treffer: $("treffer"),
  btnImport: $("btnImport"), importMeldung: $("importMeldung"), statusZeile: $("statusZeile")
};

function meldung(node, text, art = "") {
  node.textContent = text;
  node.className = "meldung" + (art ? ` m-${art}` : "");
}

/* ---------------- Rendering ---------------- */

async function zeichnen() {
  const cfg = await getSettings();
  el.cbLesezeichen.checked = cfg.lesezeichen;
  el.cbVerlauf.checked = cfg.verlauf;
  el.cbIndex.checked = cfg.index;
  el.zeit.value = cfg.zeit || DEFAULTS.zeit;
  el.aufbewahrung.value = cfg.aufbewahrungTage ?? DEFAULTS.aufbewahrungTage;

  const { dir, zustand } = await freigabeZustand();
  el.ordnerName.innerHTML = dir
    ? `<strong>${dir.name}</strong>`
    : `<span class="gedimmt">Noch kein Ordner ausgewählt</span>`;

  const plakette = { granted: ["p-ok", "freigegeben"], prompt: ["p-warn", "Freigabe nötig"],
                     denied: ["p-fehler", "abgelehnt"], keiner: ["", ""] }[zustand] || ["", ""];
  el.freigabePlakette.className = plakette[0] ? `plakette ${plakette[0]}` : "";
  el.freigabePlakette.textContent = plakette[1];

  const { warteschlange = [], letzterLauf } = await chrome.storage.local.get(
    ["warteschlange", "letzterLauf"]
  );
  const brauchtKlick = dir && zustand !== "granted";
  el.bannerFreigabe.hidden = !brauchtKlick;
  if (brauchtKlick) {
    el.bannerText.textContent = warteschlange.length
      ? `${warteschlange.length} Sicherung(en) warten darauf, geschrieben zu werden.`
      : "Chrome hat die Freigabe nach dem Neustart vergessen.";
  }

  const alarm = await chrome.alarms.get("taeglich");
  el.naechsterLauf.textContent = alarm ? `nächster Lauf: ${zeitpunkt(alarm.scheduledTime)}` : "";

  const anzahl = await countPages();
  const teile = [`${anzahl.toLocaleString("de-DE")} Seiten im Index`];
  if (letzterLauf) {
    teile.push(letzterLauf.ok
      ? `letzte Sicherung ${zeitpunkt(letzterLauf.zeit)}, ${letzterLauf.geschrieben} Dateien`
      : `letzter Versuch ${zeitpunkt(letzterLauf.zeit)} fehlgeschlagen: ${letzterLauf.fehler}`);
  }
  el.statusZeile.textContent = teile.join(" · ");
}

/* ---------------- Target folder ---------------- */

el.btnOrdner.addEventListener("click", async () => {
  try {
    const dir = await ordnerWaehlen();
    await setSettings({ ordnerName: dir.name });
    await zeichnen();
    // Write straight away so the folders show up and the choice is visibly confirmed.
    meldung(el.sichernMeldung, "Ordner gesetzt, erste Sicherung läuft…");
    await sichern();
  } catch (e) {
    if (e?.name !== "AbortError") meldung(el.sichernMeldung, `Fehler: ${e.message}`, "fehler");
  }
});

el.btnFreigabe.addEventListener("click", async () => {
  try {
    await freigabeErneuern();
    await sichern();
    await zeichnen();
  } catch (e) {
    meldung(el.sichernMeldung, `Fehler: ${e.message}`, "fehler");
  }
});

/* ---------------- Settings ---------------- */

async function speichern(patch) {
  await setSettings(patch);
  await chrome.runtime.sendMessage({ cmd: "reschedule" }).catch(() => {});
  await zeichnen();
}

el.cbLesezeichen.addEventListener("change", () => speichern({ lesezeichen: el.cbLesezeichen.checked }));
el.cbVerlauf.addEventListener("change", () => speichern({ verlauf: el.cbVerlauf.checked }));
el.cbIndex.addEventListener("change", () => speichern({ index: el.cbIndex.checked }));
el.zeit.addEventListener("change", () => el.zeit.value && speichern({ zeit: el.zeit.value }));
el.aufbewahrung.addEventListener("change", () =>
  speichern({ aufbewahrungTage: Math.max(0, parseInt(el.aufbewahrung.value, 10) || 0) })
);

/* ---------------- Backup now ---------------- */

async function sichern() {
  el.btnSichern.disabled = true;
  meldung(el.sichernMeldung, "läuft…");
  try {
    const lauf = await sichernJetzt("manuell");
    const t = [`${lauf.geschrieben} Dateien geschrieben`];
    if (lauf.info.lesezeichen) t.push(`${lauf.info.lesezeichen} Lesezeichen`);
    if (lauf.info.besuche) t.push(`${lauf.info.besuche} Aufrufe`);
    if (lauf.info.indexNeu) t.push(`${lauf.info.indexNeu} neue Seiten im Index`);
    if (lauf.geloescht) t.push(`${lauf.geloescht} alte Dateien entfernt`);
    meldung(el.sichernMeldung, t.join(", "), "ok");
  } catch (e) {
    meldung(el.sichernMeldung, `Fehler: ${e.message}`, "fehler");
  } finally {
    el.btnSichern.disabled = false;
    await zeichnen();
    await suchen();
  }
}

el.btnSichern.addEventListener("click", sichern);

/* ---------------- Search ---------------- */

let sucheTimer = null;
el.suche.addEventListener("input", () => {
  clearTimeout(sucheTimer);
  sucheTimer = setTimeout(suchen, 180);
});

async function suchen() {
  const q = el.suche.value.trim();
  if (!q) {
    el.tabelle.hidden = true;
    el.treffer.replaceChildren();
    const n = await countPages();
    el.sucheInfo.textContent = n
      ? `${n.toLocaleString("de-DE")} Seiten durchsuchbar.`
      : "Der Index ist noch leer – einmal sichern, dann steht er zur Verfügung.";
    return;
  }

  const { treffer, gesamt } = await searchPages(q, 300);
  el.sucheInfo.textContent = gesamt
    ? `${gesamt.toLocaleString("de-DE")} Treffer${gesamt > treffer.length ? `, die ${treffer.length} ältesten werden gezeigt` : ""}`
    : "Keine Treffer.";

  el.tabelle.hidden = treffer.length === 0;
  el.treffer.replaceChildren(...treffer.map(r => {
    const tr = document.createElement("tr");

    const wann = document.createElement("td");
    wann.className = "wann";
    wann.textContent = datumKurz(r.first);

    const seit = document.createElement("td");
    seit.className = "wann gedimmt";
    seit.textContent = jahreSeit(r.first);

    const n = document.createElement("td");
    n.className = "num";
    n.textContent = (r.count || 0).toLocaleString("de-DE");

    const url = document.createElement("td");
    url.className = "url";
    const a = document.createElement("a");
    a.href = r.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = r.url;
    url.appendChild(a);
    if (r.title) {
      const t = document.createElement("span");
      t.className = "titel";
      t.textContent = r.title;
      url.appendChild(t);
    }

    tr.append(wann, seit, n, url);
    return tr;
  }));
}

/* ---------------- Maintenance ---------------- */

el.btnImport.addEventListener("click", async () => {
  el.btnImport.disabled = true;
  meldung(el.importMeldung, "läuft…");
  try {
    let { dir, zustand } = await freigabeZustand();
    if (!dir) throw new Error("Es ist noch kein Zielordner ausgewählt.");
    if (zustand !== "granted") dir = await freigabeErneuern();

    const r = await importIndex(dir);
    meldung(el.importMeldung,
      `${r.gelesen.toLocaleString("de-DE")} Zeilen gelesen, ${r.neu.toLocaleString("de-DE")} davon neu – ` +
      `der Index umfasst jetzt ${r.gesamt.toLocaleString("de-DE")} Seiten.`, "ok");
    await suchen();
  } catch (e) {
    const text = e?.name === "NotFoundError"
      ? "Im Ordner liegt noch keine Index\\seiten-index.jsonl."
      : `Fehler: ${e.message}`;
    meldung(el.importMeldung, text, "fehler");
  } finally {
    el.btnImport.disabled = false;
    await zeichnen();
  }
});

/* ---------------- Start ---------------- */

await zeichnen();
await suchen();
