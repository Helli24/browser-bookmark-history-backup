// Background service worker: schedule, catch-up for missed runs, UI requests.
import { getSettings, setSettings, runBackup, badge } from "./lib/run.js";
import { searchPages, countPages, loadDirHandle } from "./lib/db.js";
import { dateKey } from "./lib/collect.js";

const ALARM = "daily";

/* ---------------- Schedule ---------------- */

async function schedule() {
  const { time } = await getSettings();
  const [h, m] = String(time || "03:00").split(":").map(Number);
  const next = new Date();
  next.setHours(h || 0, m || 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);

  // periodInMinutes is a safety net in case rescheduling after a run never happens.
  await chrome.alarms.create(ALARM, { when: next.getTime(), periodInMinutes: 1440 });
  return next.getTime();
}

// Machine was off or Chrome was closed? Run the missed backup now.
async function catchUpIfDue(reason) {
  const cfg = await getSettings();
  const { lastRun } = await chrome.storage.local.get("lastRun");
  if (lastRun?.ok && lastRun.day === dateKey()) return;

  const [h, m] = String(cfg.time || "03:00").split(":").map(Number);
  const dueAt = new Date();
  dueAt.setHours(h || 0, m || 0, 0, 0);
  if (Date.now() >= dueAt.getTime()) await runBackup(reason);
}

async function restoreBadge() {
  const { queue = [] } = await chrome.storage.local.get("queue");
  if (queue.length) await badge("!");
}

chrome.runtime.onInstalled.addListener(async () => {
  await schedule();
  await restoreBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await schedule();
  await restoreBadge();
  await catchUpIfDue("catch-up");
});

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== ALARM) return;
  await runBackup("schedule");
  await schedule();                     // recompute so the wall-clock time survives DST
});

/* ---------------- Requests from popup and options page ---------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.cmd) {
        case "status": {
          const cfg = await getSettings();
          const { lastRun, queue = [] } = await chrome.storage.local.get(["lastRun", "queue"]);
          const alarm = await chrome.alarms.get(ALARM);
          const dir = await loadDirHandle();
          sendResponse({
            ok: true,
            cfg,
            lastRun: lastRun || null,
            queued: queue.length,
            nextRun: alarm?.scheduledTime || null,
            indexCount: await countPages(),
            permission: dir ? await dir.queryPermission({ mode: "readwrite" }) : "none"
          });
          break;
        }

        case "run":
          sendResponse(await runBackup(msg.reason || "manual"));
          break;

        case "search":
          sendResponse({ ok: true, ...(await searchPages(msg.q, msg.limit || 300)) });
          break;

        case "settings": {
          const cfg = await setSettings(msg.patch || {});
          sendResponse({ ok: true, cfg, nextRun: await schedule() });
          break;
        }

        case "reschedule":
          sendResponse({ ok: true, nextRun: await schedule() });
          break;

        default:
          sendResponse({ ok: false, error: `Unknown command: ${msg?.cmd}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;      // response is sent asynchronously
});
