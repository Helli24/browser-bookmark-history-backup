// Background service worker: schedule, catch-up for missed runs, UI requests.
import { getSettings, setSettings, runBackup, badge, staleness } from "./lib/run.js";
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

// Machine was off or the browser was closed? Run the missed backup now.
async function catchUpIfDue(reason) {
  const cfg = await getSettings();
  const { lastRun } = await chrome.storage.local.get("lastRun");
  if (lastRun?.ok && lastRun.day === dateKey()) return;

  const [h, m] = String(cfg.time || "03:00").split(":").map(Number);
  const dueAt = new Date();
  dueAt.setHours(h || 0, m || 0, 0, 0);
  if (Date.now() >= dueAt.getTime()) await runBackup(reason);
}

// Anything that wants attention shows the same mark; the popup says which it is.
// Checked wherever the worker happens to wake up, because the case worth catching
// - the schedule silently not running at all - is exactly the one where nothing
// else would set it.
async function restoreBadge() {
  const { queue = [] } = await chrome.storage.local.get("queue");
  if (queue.length) return badge("!");
  const { stale } = await staleness();
  await badge(stale ? "!" : "");
}

/* ---------------- Context menu ---------------- */

const MENU = "lookup";

// Opens the settings page with the address already in the search box, quoted, so
// the answer is about that one page and not the thousands below it. Works on a
// link too: the question is often "have I been there" before clicking, not after.
function installMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU,
      title: "When was I first here?",
      contexts: ["page", "link"]
    });
  });
}

chrome.contextMenus.onClicked.addListener(async info => {
  if (info.menuItemId !== MENU) return;
  const url = info.linkUrl || info.pageUrl;
  if (!url) return;
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`options.html?q=${encodeURIComponent(`"${url}"`)}`)
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  installMenu();
  await schedule();
  await restoreBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  installMenu();                        // menus do not survive a browser restart
  await schedule();
  await restoreBadge();
  await catchUpIfDue("catch-up");
});

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== ALARM) return;
  await runBackup("schedule");
  await schedule();                     // recompute so the wall-clock time survives DST
  await restoreBadge();
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
