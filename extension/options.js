// Options page: target folder, what to back up, schedule, search, maintenance.
import { getSettings, setSettings, importIndex, backfillAll, DEFAULTS } from "./lib/run.js";
import { searchPages, countPages, countVisits, visitsForUrl } from "./lib/db.js";
import {
  permissionState, pickFolder, regrantPermission, backupNow,
  formatWhen, formatDate, timeAgo
} from "./lib/ui.js";

const $ = id => document.getElementById(id);
const el = {
  permBanner: $("permBanner"), permBannerText: $("permBannerText"), btnRegrant: $("btnRegrant"),
  folderName: $("folderName"), folderNote: $("folderNote"),
  permBadge: $("permBadge"), btnFolder: $("btnFolder"),
  cbBookmarks: $("cbBookmarks"), cbHistory: $("cbHistory"), cbIndex: $("cbIndex"),
  time: $("time"), nextRun: $("nextRun"),
  cbOnlyOnChange: $("cbOnlyOnChange"),
  bookmarksRetention: $("bookmarksRetention"), historyRetention: $("historyRetention"),
  btnBackup: $("btnBackup"), backupMsg: $("backupMsg"),
  search: $("search"), searchInfo: $("searchInfo"), table: $("table"), hits: $("hits"),
  btnImport: $("btnImport"), importMsg: $("importMsg"), statusLine: $("statusLine"),
  btnBackfill: $("btnBackfill"), backfillMsg: $("backfillMsg")
};

const n = x => (x || 0).toLocaleString("en-US");

function setMsg(node, text, kind = "") {
  node.textContent = text;
  node.className = "msg" + (kind ? ` m-${kind}` : "");
}

/* ---------------- Rendering ---------------- */

async function render() {
  const cfg = await getSettings();
  el.cbBookmarks.checked = cfg.bookmarks;
  el.cbHistory.checked = cfg.history;
  el.cbIndex.checked = cfg.index;
  el.time.value = cfg.time || DEFAULTS.time;
  el.cbOnlyOnChange.checked = cfg.bookmarksOnlyOnChange;
  el.bookmarksRetention.value = cfg.bookmarksRetentionDays ?? DEFAULTS.bookmarksRetentionDays;
  el.historyRetention.value = cfg.historyRetentionDays ?? DEFAULTS.historyRetentionDays;
  // Only overwrite while the field is idle, so typing is never interrupted.
  if (document.activeElement !== el.folderNote) el.folderNote.value = cfg.folderNote || "";

  const { dir, state } = await permissionState();
  el.folderName.textContent = "";
  if (dir) {
    const strong = document.createElement("strong");
    strong.textContent = dir.name;
    el.folderName.appendChild(strong);
  } else {
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = "No folder chosen yet";
    el.folderName.appendChild(span);
  }

  const badge = { granted: ["b-ok", "granted"], prompt: ["b-warn", "needs permission"],
                  denied: ["b-err", "denied"], none: ["", ""] }[state] || ["", ""];
  el.permBadge.className = badge[0] ? `badge ${badge[0]}` : "";
  el.permBadge.textContent = badge[1];

  const { queue = [], lastRun } = await chrome.storage.local.get(["queue", "lastRun"]);
  const needsClick = dir && state !== "granted";
  el.permBanner.hidden = !needsClick;
  if (needsClick) {
    el.permBannerText.textContent = queue.length
      ? `${queue.length} backup(s) are waiting to be written.`
      : "Chrome forgot the permission after the restart.";
  }

  const alarm = await chrome.alarms.get("daily");
  el.nextRun.textContent = alarm ? `next run: ${formatWhen(alarm.scheduledTime)}` : "";

  const parts = [`${n(await countPages())} pages indexed`, `${n(await countVisits())} visits recorded`];
  if (lastRun) {
    parts.push(lastRun.ok
      ? `last backup ${formatWhen(lastRun.at)}, ${lastRun.written} files`
      : `last attempt ${formatWhen(lastRun.at)} failed: ${lastRun.error}`);
  }
  el.statusLine.textContent = parts.join(" · ");
}

/* ---------------- Target folder ---------------- */

el.btnFolder.addEventListener("click", async () => {
  try {
    const dir = await pickFolder();
    // Drop the old note - it would now point at the wrong folder.
    await setSettings({ folderName: dir.name, folderNote: "" });
    await render();
    // Write straight away so the folders show up and the choice is visibly confirmed.
    setMsg(el.backupMsg, "Folder set, running the first backup…");
    await doBackup();
  } catch (e) {
    if (e?.name !== "AbortError") setMsg(el.backupMsg, `Error: ${e.message}`, "err");
  }
});

el.btnRegrant.addEventListener("click", async () => {
  try {
    await regrantPermission();
    await doBackup();
  } catch (e) {
    setMsg(el.backupMsg, `Error: ${e.message}`, "err");
    await render();
  }
});

/* ---------------- Settings ---------------- */

async function save(patch) {
  await setSettings(patch);
  await chrome.runtime.sendMessage({ cmd: "reschedule" }).catch(() => {});
  await render();
}

el.cbBookmarks.addEventListener("change", () => save({ bookmarks: el.cbBookmarks.checked }));
el.cbHistory.addEventListener("change", () => save({ history: el.cbHistory.checked }));
el.cbIndex.addEventListener("change", () => save({ index: el.cbIndex.checked }));
el.time.addEventListener("change", () => el.time.value && save({ time: el.time.value }));
el.cbOnlyOnChange.addEventListener("change", () =>
  save({ bookmarksOnlyOnChange: el.cbOnlyOnChange.checked })
);

const days = input => Math.max(0, parseInt(input.value, 10) || 0);
el.bookmarksRetention.addEventListener("change", () =>
  save({ bookmarksRetentionDays: days(el.bookmarksRetention) })
);
el.historyRetention.addEventListener("change", () =>
  save({ historyRetentionDays: days(el.historyRetention) })
);
el.folderNote.addEventListener("change", () => save({ folderNote: el.folderNote.value.trim() }));

/* ---------------- Back up now ---------------- */

async function doBackup() {
  el.btnBackup.disabled = true;
  setMsg(el.backupMsg, "running…");
  try {
    const run = await backupNow("manual");
    const t = [`${run.written} files written`];
    if (run.info.bookmarksUnchanged) t.push("bookmarks unchanged, not rewritten");
    else if (run.info.bookmarks) t.push(`${n(run.info.bookmarks)} bookmarks`);
    if (run.info.visits) t.push(`${n(run.info.visits)} visits`);
    if (run.info.indexAdded) t.push(`${n(run.info.indexAdded)} new pages indexed`);
    if (run.info.visitsTotal) t.push(`${n(run.info.visitsTotal)} visits recorded`);
    if (run.deleted) t.push(`${run.deleted} old files removed`);
    setMsg(el.backupMsg, t.join(", "), "ok");
  } catch (e) {
    setMsg(el.backupMsg, `Error: ${e.message}`, "err");
  } finally {
    el.btnBackup.disabled = false;
    await render();
    await doSearch();
  }
}

el.btnBackup.addEventListener("click", doBackup);

/* ---------------- Search ---------------- */

let searchTimer = null;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 180);
});

async function doSearch() {
  const q = el.search.value.trim();
  if (!q) {
    el.table.hidden = true;
    el.hits.replaceChildren();
    const count = await countPages();
    el.searchInfo.textContent = count
      ? `${n(count)} pages searchable.`
      : "The index is still empty – run one backup and it will be there.";
    return;
  }

  const { hits, total } = await searchPages(q, 300);
  el.searchInfo.textContent = total
    ? `${n(total)} matches${total > hits.length ? `, showing the ${hits.length} oldest` : ""}`
    : "No matches.";

  el.table.hidden = hits.length === 0;
  el.hits.replaceChildren(...hits.map(r => {
    const tr = document.createElement("tr");

    const when = document.createElement("td");
    when.className = "when";
    when.textContent = formatDate(r.first);

    const ago = document.createElement("td");
    ago.className = "when muted";
    ago.textContent = timeAgo(r.first);

    const count = document.createElement("td");
    count.className = "num";
    const toggle = document.createElement("button");
    toggle.className = "count";
    toggle.type = "button";
    toggle.textContent = n(r.count);
    toggle.setAttribute("aria-expanded", "false");
    toggle.title = "Show the individual visits";
    toggle.addEventListener("click", () => toggleDetail(tr, toggle, r));
    count.appendChild(toggle);

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
      t.className = "title";
      t.textContent = r.title;
      url.appendChild(t);
    }

    tr.append(when, ago, count, url);
    return tr;
  }));
}

// Expands one result row into the individual visit timestamps.
async function toggleDetail(tr, toggle, row) {
  const open = toggle.getAttribute("aria-expanded") === "true";
  if (open) {
    toggle.setAttribute("aria-expanded", "false");
    tr.nextElementSibling?.classList.contains("detail") && tr.nextElementSibling.remove();
    return;
  }
  toggle.setAttribute("aria-expanded", "true");

  const detail = document.createElement("tr");
  detail.className = "detail";
  const cell = document.createElement("td");
  cell.colSpan = 4;
  cell.textContent = "loading…";
  detail.appendChild(cell);
  tr.after(detail);

  const times = await visitsForUrl(row.url);
  cell.textContent = "";

  if (!times.length) {
    cell.className = "muted";
    cell.textContent = "No individual timestamps stored for this page yet.";
    return;
  }

  const box = document.createElement("div");
  box.className = "times";
  for (const t of times) {
    const chip = document.createElement("span");
    chip.className = "time";
    const d = new Date(t);
    const p = x => String(x).padStart(2, "0");
    chip.textContent = formatDate(t);
    const clock = document.createElement("span");
    clock.className = "clock";
    clock.textContent = `  ${p(d.getHours())}:${p(d.getMinutes())}`;
    chip.appendChild(clock);
    box.appendChild(chip);
  }
  cell.appendChild(box);

  // Chrome drops visit rows after ~90 days but keeps counting, so its total can
  // exceed the timestamps anyone still has. Say so instead of looking wrong.
  const missing = (row.count || 0) - times.length;
  if (missing > 0) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent =
      `Chrome counts ${n(row.count)} visits in total; the ${n(missing)} oldest no longer have ` +
      `a timestamp. Everything from here on is recorded in full.`;
    cell.appendChild(note);
  }
}

/* ---------------- Maintenance ---------------- */

el.btnBackfill.addEventListener("click", async () => {
  el.btnBackfill.disabled = true;
  el.btnBackup.disabled = true;
  setMsg(el.backfillMsg, "starting…");
  try {
    let { dir, state } = await permissionState();
    if (!dir) throw new Error("No target folder has been chosen yet.");
    if (state !== "granted") dir = await regrantPermission();

    const r = await backfillAll(dir, p => {
      if (p.phase === "scan") {
        setMsg(el.backfillMsg, `Scanning history… ${p.done}/${p.total}, ${n(p.urls)} pages so far`);
      } else if (p.phase === "visits") {
        setMsg(el.backfillMsg,
          `Reading timestamps… ${n(p.done)}/${n(p.total)} pages, ${n(p.visits)} visits found`);
      } else {
        setMsg(el.backfillMsg, `Writing ${n(p.total)} files…`);
      }
    });

    setMsg(el.backfillMsg,
      `Done: ${n(r.visits)} visits across ${n(r.days)} days recovered from ${n(r.urls)} pages, ` +
      `${n(r.files)} files written. The database now holds ${n(r.pagesTotal)} pages ` +
      `and ${n(r.visitsTotal)} visits.`, "ok");
    await doSearch();
  } catch (e) {
    setMsg(el.backfillMsg, `Error: ${e.message}`, "err");
  } finally {
    el.btnBackfill.disabled = false;
    el.btnBackup.disabled = false;
    await render();
  }
});

el.btnImport.addEventListener("click", async () => {
  el.btnImport.disabled = true;
  setMsg(el.importMsg, "running…");
  try {
    let { dir, state } = await permissionState();
    if (!dir) throw new Error("No target folder has been chosen yet.");
    if (state !== "granted") dir = await regrantPermission();

    const r = await importIndex(dir);
    setMsg(el.importMsg,
      `Read ${n(r.read)} index rows (${n(r.added)} new) and ${n(r.visitsRead)} visits – ` +
      `the database now holds ${n(r.total)} pages and ${n(r.visitsTotal)} visits.`,
      "ok");
    await doSearch();
  } catch (e) {
    setMsg(el.importMsg, e?.name === "NotFoundError"
      ? "There is no Index\\page-index.jsonl in that folder yet."
      : `Error: ${e.message}`, "err");
  } finally {
    el.btnImport.disabled = false;
    await render();
  }
});

/* ---------------- Start ---------------- */

await render();
await doSearch();
