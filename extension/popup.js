// Popup: status at a glance, backup now, quick lookup in the index.
import { searchPages, countPages } from "./lib/db.js";
import { freigabeZustand, sichernJetzt, zeitpunkt, datumKurz, jahreSeit } from "./lib/ui.js";

const $ = id => document.getElementById(id);
const el = {
  punkt: $("punkt"), statusText: $("statusText"), statusUnter: $("statusUnter"),
  btnSichern: $("btnSichern"), meldung: $("meldung"),
  suche: $("suche"), liste: $("liste"), linkOptionen: $("linkOptionen")
};

// A permission dialog would close the popup, so anything needing one is handed
// over to the options page instead.
let brauchtOptionen = false;

async function zeichnen() {
  const { dir, zustand } = await freigabeZustand();
  const { letzterLauf, warteschlange = [] } = await chrome.storage.local.get(
    ["letzterLauf", "warteschlange"]
  );
  const alarm = await chrome.alarms.get("taeglich");
  const anzahl = await countPages();

  brauchtOptionen = !dir || zustand !== "granted";

  if (!dir) {
    el.punkt.className = "punkt warn";
    el.statusText.textContent = "Noch kein Zielordner ausgewählt";
    el.statusUnter.textContent = "In den Einstellungen einen Ordner festlegen.";
    el.btnSichern.textContent = "Ordner auswählen";
  } else if (zustand !== "granted") {
    el.punkt.className = "punkt warn";
    el.statusText.textContent = "Ordnerfreigabe bestätigen";
    el.statusUnter.textContent = warteschlange.length
      ? `${warteschlange.length} Sicherung(en) warten – ein Klick genügt.`
      : "Chrome hat die Freigabe seit dem Neustart vergessen.";
    el.btnSichern.textContent = "Freigeben und sichern";
  } else {
    const gut = letzterLauf?.ok;
    el.punkt.className = `punkt ${gut ? "ok" : letzterLauf ? "fehler" : ""}`;
    el.statusText.textContent = letzterLauf
      ? (gut ? `Zuletzt gesichert ${zeitpunkt(letzterLauf.zeit)}` : `Letzter Lauf fehlgeschlagen`)
      : "Noch nichts gesichert";
    const teile = [];
    if (letzterLauf && !gut) teile.push(letzterLauf.fehler);
    if (alarm) teile.push(`nächster Lauf ${zeitpunkt(alarm.scheduledTime)}`);
    if (anzahl) teile.push(`${anzahl.toLocaleString("de-DE")} Seiten im Index`);
    el.statusUnter.textContent = teile.join(" · ");
    el.btnSichern.textContent = "Jetzt sichern";
  }
}

el.btnSichern.addEventListener("click", async () => {
  if (brauchtOptionen) {
    chrome.runtime.openOptionsPage();
    window.close();
    return;
  }
  el.btnSichern.disabled = true;
  el.meldung.textContent = "läuft…";
  el.meldung.className = "meldung";
  try {
    const lauf = await sichernJetzt("popup");
    el.meldung.textContent = `${lauf.geschrieben} Dateien geschrieben.`;
    el.meldung.className = "meldung m-ok";
  } catch (e) {
    el.meldung.textContent = `Fehler: ${e.message}`;
    el.meldung.className = "meldung m-fehler";
  } finally {
    el.btnSichern.disabled = false;
    await zeichnen();
  }
});

el.linkOptionen.addEventListener("click", e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});

let timer = null;
el.suche.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(suchen, 180);
});

async function suchen() {
  const q = el.suche.value.trim();
  if (!q) return el.liste.replaceChildren();

  const { treffer, gesamt } = await searchPages(q, 25);
  if (!treffer.length) {
    const leer = document.createElement("div");
    leer.className = "treffer gedimmt";
    leer.textContent = "Keine Treffer.";
    el.liste.replaceChildren(leer);
    return;
  }

  const knoten = treffer.map(r => {
    const d = document.createElement("div");
    d.className = "treffer";

    const kopf = document.createElement("div");
    const wann = document.createElement("span");
    wann.className = "wann";
    wann.textContent = datumKurz(r.first);
    const seit = document.createElement("span");
    seit.className = "gedimmt";
    seit.textContent = `  ${jahreSeit(r.first)} · ${(r.count || 0).toLocaleString("de-DE")}×`;
    kopf.append(wann, seit);

    const url = document.createElement("div");
    url.className = "url";
    const a = document.createElement("a");
    a.href = r.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = r.title || r.url;
    a.title = r.url;
    url.appendChild(a);

    d.append(kopf, url);
    return d;
  });

  if (gesamt > treffer.length) {
    const mehr = document.createElement("div");
    mehr.className = "treffer gedimmt";
    mehr.textContent = `… ${(gesamt - treffer.length).toLocaleString("de-DE")} weitere – vollständig in den Einstellungen.`;
    knoten.push(mehr);
  }
  el.liste.replaceChildren(...knoten);
}

await zeichnen();
