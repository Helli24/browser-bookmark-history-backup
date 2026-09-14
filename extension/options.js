// Options page: target folder, search, what to back up, schedule, maintenance,
// statistics and the activity log - in that order on screen.
import {
  getSettings, setSettings, importIndex, backfillAll, record, flushMigrationNotes, DEFAULTS
} from "./lib/run.js";
import { getLog, KINDS } from "./lib/log.js";
import {
  searchPages, countPages, countVisits, visitsForUrl, collectStats, bucketRange
} from "./lib/db.js";
import { dayNumber } from "./lib/collect.js";
import {
  permissionState, pickFolder, regrantPermission, backupNow,
  formatWhen, formatDate, timeAgo
} from "./lib/ui.js";

const $ = id => document.getElementById(id);
const el = {
  permBanner: $("permBanner"), permBannerText: $("permBannerText"), btnRegrant: $("btnRegrant"),
  folderName: $("folderName"), folderNote: $("folderNote"), folderMsg: $("folderMsg"),
  permBadge: $("permBadge"), btnFolder: $("btnFolder"),
  cbBookmarks: $("cbBookmarks"), cbHistory: $("cbHistory"), cbIndex: $("cbIndex"),
  time: $("time"), nextRun: $("nextRun"),
  cbOnlyOnChange: $("cbOnlyOnChange"),
  bookmarksRetention: $("bookmarksRetention"), historyRetention: $("historyRetention"),
  btnBackup: $("btnBackup"), backupMsg: $("backupMsg"),
  search: $("search"), searchInfo: $("searchInfo"), table: $("table"), hits: $("hits"),
  dateFrom: $("dateFrom"), dateTo: $("dateTo"), btnClearDates: $("btnClearDates"),
  dateField: $("dateField"),
  btnImport: $("btnImport"), importMsg: $("importMsg"), statusLine: $("statusLine"),
  btnBackfill: $("btnBackfill"), backfillMsg: $("backfillMsg"),
  logBox: $("logBox"), logCount: $("logCount"), logRows: $("logRows"),
  statsBox: $("statsBox"), statsHint: $("statsHint"), statsHead: $("statsHead"),
  statsWindows: $("statsWindows"), statsSeries: $("statsSeries"),
  chart: $("chart"), chartFrom: $("chartFrom"), chartTo: $("chartTo"),
  topHosts: $("topHosts")
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
      : "The browser forgot the permission after the restart.";
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
  await renderLog();
}

// Newest first. Only the last 200 are drawn; activity.log has the rest.
async function renderLog() {
  await flushMigrationNotes();
  const entries = await getLog();
  el.logCount.textContent = entries.length ? `· ${n(entries.length)}` : "· none yet";

  const rows = [...entries].reverse().slice(0, 200).map(e => {
    const tr = document.createElement("tr");
    const cell = (text, cls) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    };
    tr.append(
      cell(formatWhen(e.at)),
      cell(e.kind || "", e.ok === false ? "bad" : "kind"),
      cell(e.files != null ? `${n(e.files)} files` : ""),
      cell(e.pages != null ? `${n(e.pages)} pages` : ""),
      cell(e.visits != null ? `${n(e.visits)} visits` : ""),
      cell(e.note || "", "note")
    );
    return tr;
  });
  el.logRows.replaceChildren(...rows);
}

/* ---------------- Target folder ---------------- */

el.btnFolder.addEventListener("click", async () => {
  try {
    const dir = await pickFolder();
    // Drop the old note - it would now point at the wrong folder.
    await setSettings({ folderName: dir.name, folderNote: "" });
    await render();

    // If the folder already holds an index and ours is empty, adopt it before
    // writing anything. Otherwise the first backup would export our empty
    // database straight over the existing one - which is exactly what happens
    // when the extension is reinstalled and pointed back at its own backups.
    if (await countPages() === 0) {
      try {
        const r = await importIndex(dir);
        if (r.read) {
          await record({
            kind: KINDS.adopted, ok: true,
            pages: r.total, visits: r.visitsTotal,
            note: `picked up from ${dir.name}`
          }, dir);
          setMsg(el.folderMsg,
            `Found an existing backup in this folder and restored it: ` +
            `${n(r.total)} pages and ${n(r.visitsTotal)} visits are back in the database.`,
            "ok");
        }
      } catch (e) {
        // NotFoundError means there is simply no index here - a fresh folder.
        // Anything else means something IS there and we could not read it, so
        // stop: writing now would overwrite data we failed to rescue.
        if (e?.name !== "NotFoundError") {
          setMsg(el.folderMsg,
            `There is an index in this folder but it could not be read: ${e.message} — ` +
            `nothing has been written, so the existing data is untouched. ` +
            `Check the folder, then use Restore under Maintenance.`, "err");
          return;
        }
      }
    }

    // Write straight away so the folders show up and the choice is visibly confirmed.
    setMsg(el.backupMsg, "Folder set, running the first backup…");
    await doBackup();
  } catch (e) {
    if (e?.name !== "AbortError") setMsg(el.folderMsg, `Error: ${e.message}`, "err");
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
    if (run.info.bookmarksUnchanged) t.push("bookmarks unchanged");
    else if (run.info.bookmarks) t.push(`${n(run.info.bookmarks)} bookmarks`);
    if (run.info.visits) t.push(`${n(run.info.visits)} new visits logged`);
    if (run.info.indexAdded) t.push(`${n(run.info.indexAdded)} pages new to the index`);
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
let sortBy = "first";
let newestFirst = false;

el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 180);
});

// A partly typed date is meaningless, so wait for change rather than input.
el.dateFrom.addEventListener("change", doSearch);
el.dateTo.addEventListener("change", doSearch);
el.dateField.addEventListener("change", doSearch);

el.btnClearDates.addEventListener("click", () => {
  el.dateFrom.value = el.dateTo.value = "";
  doSearch();
});

// Clicking the column that is already sorted turns it around; clicking the other
// one switches to it and starts at the end people mean by it - the first time you
// saw something, the last time you were there.
for (const btn of document.querySelectorAll("th .sort")) {
  btn.addEventListener("click", () => {
    const field = btn.dataset.field;
    if (field === sortBy) newestFirst = !newestFirst;
    else { sortBy = field; newestFirst = field === "last"; }
    markSort();
    doSearch();
  });
}

function markSort() {
  for (const btn of document.querySelectorAll("th .sort")) {
    const on = btn.dataset.field === sortBy;
    btn.classList.toggle("active", on);
    btn.querySelector("span").textContent = on ? (newestFirst ? "↓" : "↑") : "";
    btn.title = on
      ? `Sorted ${newestFirst ? "newest" : "oldest"} first – click to turn around`
      : `Sort by ${btn.dataset.field === "first" ? "first" : "last"} visit`;
  }
}
markSort();

// The inputs hand over a plain YYYY-MM-DD, which both ends of the range have to
// grow into a whole local day: "until the 14th" has to include the 14th.
const dayStart = v => (v ? new Date(`${v}T00:00:00`).getTime() : null);
const dayEnd = v => (v ? new Date(`${v}T23:59:59.999`).getTime() : null);

async function doSearch() {
  const q = el.search.value.trim();
  const from = dayStart(el.dateFrom.value);
  const to = dayEnd(el.dateTo.value);
  el.btnClearDates.hidden = !el.dateFrom.value && !el.dateTo.value;

  // A date range is a search in its own right: it answers "what did I find that
  // week", which needs no search term at all.
  if (!q && from === null && to === null) {
    el.table.hidden = true;
    el.hits.replaceChildren();
    const count = await countPages();
    el.searchInfo.textContent = count
      ? `${n(count)} pages searchable. Quotes match the whole URL – "facebook.com" ` +
        "finds that one page instead of everything below it."
      : "The index is still empty – run one backup and it will be there.";
    return;
  }

  if (from !== null && to !== null && from > to) {
    el.table.hidden = true;
    el.hits.replaceChildren();
    el.searchInfo.textContent = "That range ends before it starts.";
    return;
  }

  const dateField = el.dateField.value;
  const { hits, total } = await searchPages(q, 300, { from, to, dateField, sortBy, newestFirst });
  const end = newestFirst ? "newest" : "oldest";
  el.searchInfo.textContent = total
    ? `${n(total)} matches${total > hits.length ? `, showing the ${hits.length} ${end}` : ""}`
    : "No matches.";

  el.table.hidden = hits.length === 0;
  el.hits.replaceChildren(...hits.map(r => {
    const tr = document.createElement("tr");

    const when = document.createElement("td");
    when.className = "when";
    when.textContent = formatDate(r.first);

    // The relative time sits on the last visit, where "yesterday" is the answer
    // to a question people actually ask.
    const ago = document.createElement("td");
    ago.className = "when";
    ago.textContent = formatDate(r.last);
    const rel = document.createElement("span");
    rel.className = "rel";
    rel.textContent = timeAgo(r.last);
    ago.appendChild(rel);

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

  // The browser drops visit rows after ~90 days but keeps counting, so its total can
  // exceed the timestamps anyone still has. Say so instead of looking wrong.
  const missing = (row.count || 0) - times.length;
  if (missing > 0) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent =
      `The browser counts ${n(row.count)} visits in total; the ${n(missing)} oldest no longer have ` +
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
    await record({
      kind: KINDS.restored, ok: true,
      pages: r.total, visits: r.visitsTotal,
      note: `${n(r.read)} index rows and ${n(r.visitsRead)} visits read from disk`
    }, dir);
    setMsg(el.importMsg,
      `Restored ${n(r.read)} index rows (${n(r.added)} new to this database) and ` +
      `${n(r.visitsRead)} visits – it now holds ${n(r.total)} pages and ${n(r.visitsTotal)} visits.`,
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

/* ---------------- Statistics ---------------- */

// Nothing here runs until the box is opened, and the result is kept for as long
// as the page stays open. The page load itself is untouched by any of it.
let statsDays = 30;
let statsSeries = "visits";
const statsCache = new Map();

el.statsBox.addEventListener("toggle", () => {
  if (el.statsBox.open) renderStats();
});

for (const btn of el.statsWindows.querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    statsDays = Number(btn.dataset.days);
    mark(el.statsWindows, "days", String(statsDays));
    renderStats();
  });
}

for (const btn of el.statsSeries.querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    statsSeries = btn.dataset.series;
    mark(el.statsSeries, "series", statsSeries);
    renderStats();
  });
}

function mark(group, attr, value) {
  for (const b of group.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset[attr] === value);
  }
}

async function renderStats() {
  el.statsHint.textContent = "— counting…";
  let stats = statsCache.get(statsDays);
  if (!stats) {
    // Days past 90 are drawn a week at a time: a year of daily bars is under three
    // pixels each, and "everything" only gets worse from here.
    const size = statsDays === 0 || statsDays > 90 ? 7 : 1;
    const from = statsDays === 0 ? null : startOfDay(Date.now() - (statsDays - 1) * 864e5);
    const t0 = performance.now();
    stats = await collectStats({ from, size });
    stats.took = Math.round(performance.now() - t0);
    statsCache.set(statsDays, stats);
  }
  el.statsHint.textContent = `— ${stats.took} ms`;

  if (!stats.visits && !stats.fresh) {
    el.statsHead.textContent = statsDays
      ? "Nothing in this window."
      : "No visits recorded yet – run one backup and they will be here.";
    el.chart.replaceChildren();
    el.chartFrom.textContent = el.chartTo.textContent = "";
    el.topHosts.replaceChildren();
    return;
  }

  const bars = bucketRange(
    dayNumber(stats.firstT ?? Date.now()), dayNumber(stats.lastT ?? Date.now()),
    stats.size, stats.anchor
  ).map(key => ({ key, ...(stats.buckets.get(key) || { visits: 0, pages: 0, fresh: 0 }) }));

  const per = stats.size === 7 ? "week" : "day";
  const busiest = bars.reduce((a, b) => (b[statsSeries] > a[statsSeries] ? b : a), bars[0]);
  el.statsHead.textContent = [
    `${formatDate(stats.firstT)} to ${formatDate(stats.lastT)}`,
    `${n(stats.visits)} visits`,
    `${n(stats.pages)} pages`,
    `${n(stats.fresh)} of them new`,
    // Naming a "busiest day" out of nothing but zeroes would be an invented fact.
    busiest[statsSeries] ? `busiest ${per}: ${busiest.key} with ${n(busiest[statsSeries])}` : ""
  ].filter(Boolean).join(" · ");

  const top = Math.max(...bars.map(b => b[statsSeries]), 1);
  const label = { visits: "visits", pages: "pages", fresh: "new pages" }[statsSeries];
  el.chart.replaceChildren(...bars.map(b => {
    const div = document.createElement("div");
    const value = b[statsSeries];
    div.className = value ? "bar" : "bar empty";
    div.style.height = `${Math.max(value / top * 100, value ? 2 : 0)}%`;
    div.title = `${b.key}${stats.size === 7 ? " (week)" : ""}: ${n(value)} ${label}`;
    return div;
  }));
  el.chartFrom.textContent = bars[0].key;
  el.chartTo.textContent = bars[bars.length - 1].key;

  el.topHosts.replaceChildren(...stats.hosts.slice(0, 25).map(h => {
    const tr = document.createElement("tr");
    for (const [text, cls] of [[h.host, "url"], [n(h.visits), "num"], [n(h.pages), "num"]]) {
      const td = document.createElement("td");
      td.textContent = text;
      td.className = cls;
      tr.appendChild(td);
    }
    return tr;
  }));
}

const startOfDay = t => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/* ---------------- Start ---------------- */

await render();
await doSearch();
