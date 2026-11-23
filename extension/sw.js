// Background service worker: schedule, catch-up for missed runs, UI requests.
import { getSettings, setSettings, runBackup, record, watch } from "./lib/run.js";
import { KINDS } from "./lib/log.js";
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

/* ---------------- Watchdog ---------------- */

const WATCH = "watchdog";
const WATCH_EVERY_MIN = 180;
const NOTICE = "stale";

// Created only when missing: re-creating it on every start would restart its
// period each time, and a browser restarted often enough would never reach it.
async function ensureWatch() {
  if (!await chrome.alarms.get(WATCH)) {
    await chrome.alarms.create(WATCH, { delayInMinutes: 1, periodInMinutes: WATCH_EVERY_MIN });
  }
}

// Anything that wants attention shows the same mark; the popup says which it is.
// Overdue gets more than the mark: a notification, once a day, because the mark
// sits on an icon that is easy to have tucked away in the extensions menu - and
// in November it went unseen for five days. The notification is the one part
// here that reaches someone who is not looking.
async function watchdog({ quiet = false } = {}) {
  if (!await chrome.alarms.get(ALARM)) {
    await schedule();
    await record({ kind: KINDS.watchdog, ok: false, note: "the daily schedule was missing - set again" });
  }
  const s = await watch({ quiet });
  if (!s.stale) return chrome.notifications.clear(NOTICE);
  if (!s.notify) return;
  chrome.notifications.create(NOTICE, {
    type: "basic",
    iconUrl: "notice.png",
    title: s.never ? "Nothing backed up yet" : `No backup for ${s.days} days`,
    message: s.never
      ? "Bookmark & History Backup has not written anything yet."
      : `Bookmark & History Backup last wrote to your folder on ${dateKey(new Date(s.at))}. ` +
        "Click to see why.",
    priority: 1
  });
}

chrome.notifications.onClicked.addListener(id => {
  if (id !== NOTICE) return;
  chrome.notifications.clear(id);
  chrome.runtime.openOptionsPage();
});

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
  await ensureWatch();
  await watchdog({ quiet: true });
});

// The mark comes first, from storage alone: everything after it touches the
// database, and if that stops answering, the mark must already be up.
chrome.runtime.onStartup.addListener(async () => {
  installMenu();                        // cheap, and queued behind onInstalled if both fire
  await schedule();
  await ensureWatch();
  await watchdog({ quiet: true });      // the catch-up below may still fix it
  await noteStart();
  await catchUpIfDue(KINDS.catchup);
  await watchdog();
});

// A line for a browser start that finds the folder out of reach - the one case
// where the start explains what follows: the next run will fail, and it is not
// the run's fault. Access that is simply still there is not news, and a line
// saying "granted" read as if something had just been clicked.
async function noteStart() {
  let note;
  try {
    const dir = await loadDirHandle();
    const state = dir && await dir.queryPermission({ mode: "readwrite" });
    if (state === "granted") return;
    note = !dir ? "no folder chosen"
      : state === "prompt" ? `folder access lapsed - last answer was "Allow this time"`
      : `folder access: ${state}`;
  } catch (e) {
    note = `folder access could not be read: ${e.message}`;
  }
  await record({ kind: KINDS.started, note });
}

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === WATCH) return watchdog();
  if (a.name !== ALARM) return;
  // Before anything else: a start with no result is how a hung run shows up.
  await chrome.storage.local.set({ lastAlarmAt: Date.now() });
  await runBackup(KINDS.scheduled);
  await schedule();                     // recompute so the wall-clock time survives DST
  await watchdog();
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
