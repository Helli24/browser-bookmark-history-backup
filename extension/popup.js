// Popup: status at a glance, back up now, quick lookup in the index.
import { searchPages, countPages } from "./lib/db.js";
import { permissionState, backupNow, formatWhen, formatDate, timeAgo } from "./lib/ui.js";

const $ = id => document.getElementById(id);
const el = {
  dot: $("dot"), statusText: $("statusText"), statusSub: $("statusSub"),
  btnBackup: $("btnBackup"), msg: $("msg"),
  search: $("search"), list: $("list"), linkOptions: $("linkOptions")
};

const n = x => (x || 0).toLocaleString("en-US");

// A permission dialog would close the popup, so anything needing one is handed
// over to the options page instead.
let needsOptionsPage = false;

async function render() {
  const { dir, state } = await permissionState();
  const { lastRun, queue = [] } = await chrome.storage.local.get(["lastRun", "queue"]);
  const alarm = await chrome.alarms.get("daily");
  const indexed = await countPages();

  needsOptionsPage = !dir || state !== "granted";

  if (!dir) {
    el.dot.className = "dot warn";
    el.statusText.textContent = "No target folder chosen yet";
    el.statusSub.textContent = "Pick a folder in the settings.";
    el.btnBackup.textContent = "Choose folder";
  } else if (state !== "granted") {
    el.dot.className = "dot warn";
    el.statusText.textContent = "Confirm folder access";
    el.statusSub.textContent = queue.length
      ? `${queue.length} backup(s) waiting – one click is enough.`
      : "Chrome forgot the permission since the restart.";
    el.btnBackup.textContent = "Grant and back up";
  } else {
    const good = lastRun?.ok;
    el.dot.className = `dot ${good ? "ok" : lastRun ? "err" : ""}`;
    el.statusText.textContent = lastRun
      ? (good ? `Last backup ${formatWhen(lastRun.at)}` : "Last run failed")
      : "Nothing backed up yet";
    const parts = [];
    if (lastRun && !good) parts.push(lastRun.error);
    if (alarm) parts.push(`next run ${formatWhen(alarm.scheduledTime)}`);
    if (indexed) parts.push(`${n(indexed)} pages indexed`);
    el.statusSub.textContent = parts.join(" · ");
    el.btnBackup.textContent = "Back up now";
  }
}

el.btnBackup.addEventListener("click", async () => {
  if (needsOptionsPage) {
    chrome.runtime.openOptionsPage();
    window.close();
    return;
  }
  el.btnBackup.disabled = true;
  el.msg.textContent = "running…";
  el.msg.className = "msg";
  try {
    const run = await backupNow("popup");
    el.msg.textContent = `${run.written} files written.`;
    el.msg.className = "msg m-ok";
  } catch (e) {
    el.msg.textContent = `Error: ${e.message}`;
    el.msg.className = "msg m-err";
  } finally {
    el.btnBackup.disabled = false;
    await render();
  }
});

el.linkOptions.addEventListener("click", e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});

let timer = null;
el.search.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(doSearch, 180);
});

async function doSearch() {
  const q = el.search.value.trim();
  if (!q) return el.list.replaceChildren();

  const { hits, total } = await searchPages(q, 25);
  if (!hits.length) {
    const empty = document.createElement("div");
    empty.className = "hit muted";
    empty.textContent = "No matches.";
    el.list.replaceChildren(empty);
    return;
  }

  const nodes = hits.map(r => {
    const row = document.createElement("div");
    row.className = "hit";

    const head = document.createElement("div");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = formatDate(r.first);
    const ago = document.createElement("span");
    ago.className = "muted";
    ago.textContent = `  ${timeAgo(r.first)} · ${n(r.count)}×`;
    head.append(when, ago);

    const url = document.createElement("div");
    url.className = "url";
    const a = document.createElement("a");
    a.href = r.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = r.title || r.url;
    a.title = r.url;
    url.appendChild(a);

    row.append(head, url);
    return row;
  });

  if (total > hits.length) {
    const more = document.createElement("div");
    more.className = "hit muted";
    more.textContent = `… ${n(total - hits.length)} more – see the settings for the full list.`;
    nodes.push(more);
  }
  el.list.replaceChildren(...nodes);
}

await render();
