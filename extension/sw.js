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

const MENU_PAGE = "lookupPage";
const MENU_LINK = "lookupLink";

// Opens the settings page with the address already in the search box, quoted, so
// the answer is about that one page and not the thousands below it. Also on a
// link: the question is often "have I been there" before clicking, not after.
//
// The only string this extension puts inside the browser's own menus, between
// Back and Reload - so it is the only one that follows the browser's language
// rather than the extension's. _locales/ holds the wordings.
//
// Clearing and creating are separate asynchronous steps, so two calls that overlap
// interleave: both clear, then both create, and the second create of each id
// fails. That does happen - starting the browser after the extension's files have
// changed fires onStartup and onInstalled in the same worker. Each call is queued
// behind the previous one, so one finishes before the next begins.
let menuQueue = Promise.resolve();

export function installMenu() {
  menuQueue = menuQueue.then(() => new Promise(resolve => {
    chrome.contextMenus.removeAll(() => {
      // Read lastError in every callback: an unread one is reported as an error
      // against the extension, even when the menu ends up exactly as intended.
      const done = () => {
        if (chrome.runtime.lastError) console.warn("context menu:", chrome.runtime.lastError.message);
      };
      done();
      chrome.contextMenus.create({
        id: MENU_PAGE,
        title: chrome.i18n.getMessage("menuPage"),
        contexts: ["page"]
      }, done);
      chrome.contextMenus.create({
        id: MENU_LINK,
        title: chrome.i18n.getMessage("menuLink"),
        contexts: ["link"]
      }, () => { done(); resolve(); });
    });
  }));
  return menuQueue;
}

chrome.contextMenus.onClicked.addListener(async info => {
  if (info.menuItemId !== MENU_PAGE && info.menuItemId !== MENU_LINK) return;
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
  installMenu();                        // cheap, and queued behind onInstalled if both fire
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
