// Background service worker: schedule, catch-up for missed runs, UI requests.
import { getSettings, setSettings, runBackup, badge } from "./lib/run.js";
import { searchPages, countPages, loadDirHandle } from "./lib/db.js";
import { dateKey } from "./lib/collect.js";

const ALARM = "taeglich";

/* ---------------- Schedule ---------------- */

async function planen() {
  const { zeit } = await getSettings();
  const [h, m] = String(zeit || "03:00").split(":").map(Number);
  const naechste = new Date();
  naechste.setHours(h || 0, m || 0, 0, 0);
  if (naechste.getTime() <= Date.now()) naechste.setDate(naechste.getDate() + 1);

  // periodInMinutes is a safety net in case rescheduling after a run never happens.
  await chrome.alarms.create(ALARM, { when: naechste.getTime(), periodInMinutes: 1440 });
  return naechste.getTime();
}

// Machine was off or Chrome was closed? Run the missed backup now.
async function nachholenWennFaellig(grund) {
  const cfg = await getSettings();
  const { letzterLauf } = await chrome.storage.local.get("letzterLauf");
  if (letzterLauf?.ok && letzterLauf.tag === dateKey()) return;

  const [h, m] = String(cfg.zeit || "03:00").split(":").map(Number);
  const faelligAb = new Date();
  faelligAb.setHours(h || 0, m || 0, 0, 0);
  if (Date.now() >= faelligAb.getTime()) await runBackup(grund);
}

chrome.runtime.onInstalled.addListener(async () => {
  await planen();
  const { warteschlange = [] } = await chrome.storage.local.get("warteschlange");
  if (warteschlange.length) await badge("!");
});

chrome.runtime.onStartup.addListener(async () => {
  await planen();
  const { warteschlange = [] } = await chrome.storage.local.get("warteschlange");
  if (warteschlange.length) await badge("!");
  await nachholenWennFaellig("nachholen");
});

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== ALARM) return;
  await runBackup("zeitplan");
  await planen();                       // recompute so the wall-clock time survives DST
});

/* ---------------- Requests from popup and options page ---------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.cmd) {
        case "status": {
          const cfg = await getSettings();
          const { letzterLauf, warteschlange = [] } = await chrome.storage.local.get(
            ["letzterLauf", "warteschlange"]
          );
          const alarm = await chrome.alarms.get(ALARM);
          const dir = await loadDirHandle();
          let freigabe = "keiner";
          if (dir) freigabe = await dir.queryPermission({ mode: "readwrite" });
          sendResponse({
            ok: true,
            cfg,
            letzterLauf: letzterLauf || null,
            wartend: warteschlange.length,
            naechsterLauf: alarm?.scheduledTime || null,
            indexAnzahl: await countPages(),
            freigabe
          });
          break;
        }

        case "run":
          sendResponse(await runBackup(msg.grund || "manuell"));
          break;

        case "search":
          sendResponse({ ok: true, ...(await searchPages(msg.q, msg.limit || 300)) });
          break;

        case "settings": {
          const cfg = await setSettings(msg.patch || {});
          const wann = await planen();
          sendResponse({ ok: true, cfg, naechsterLauf: wann });
          break;
        }

        case "reschedule":
          sendResponse({ ok: true, naechsterLauf: await planen() });
          break;

        default:
          sendResponse({ ok: false, fehler: `Unbekannter Befehl: ${msg?.cmd}` });
      }
    } catch (e) {
      sendResponse({ ok: false, fehler: String(e?.message || e) });
    }
  })();
  return true;      // response is sent asynchronously
});
