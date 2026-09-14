// Reads bookmarks and history from the browser APIs and turns them into files.

export function dateKey(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${dateKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// visitTime arrives as a double: the browser counts in microseconds and the
// conversion to milliseconds leaves a fraction behind. Anything that ends up in a
// key has to be truncated first, or the same visit read back from an exported file
// - where Date.parse() yields whole milliseconds - becomes a second, distinct row.
const ms = t => Math.floor(t);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---------------- Bookmarks ---------------- */

export async function collectBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const stats = { folders: 0, links: 0 };
  // Depth 0 is the invisible root the browser wraps everything in - not a real folder.
  (function count(nodes, depth) {
    for (const n of nodes || []) {
      if (n.url) stats.links++;
      else { if (depth > 0) stats.folders++; count(n.children, depth + 1); }
    }
  })(tree, 0);

  const json = JSON.stringify(
    { exportedAt: new Date().toISOString(), stats, tree },
    null, 2
  );
  return { json, html: toNetscape(tree[0]?.children || []), stats };
}

// Netscape bookmark format - the only one the browser can import back in.
function toNetscape(roots) {
  const sec = ms => Math.floor((ms || Date.now()) / 1000);
  const out = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- Generated automatically. Import via chrome://bookmarks or edge://favorites -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>"
  ];
  (function walk(nodes, depth) {
    const pad = "    ".repeat(depth);
    for (const n of nodes || []) {
      if (n.url) {
        out.push(`${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${sec(n.dateAdded)}">${esc(n.title)}</A>`);
      } else {
        // Node id "1" is the bookmarks bar; the browser needs the flag to restore it there.
        const bar = n.id === "1" ? ' PERSONAL_TOOLBAR_FOLDER="true"' : "";
        out.push(`${pad}<DT><H3 ADD_DATE="${sec(n.dateAdded)}" LAST_MODIFIED="${sec(n.dateGroupModified)}"${bar}>${esc(n.title)}</H3>`);
        out.push(`${pad}<DL><p>`);
        walk(n.children, depth + 1);
        out.push(`${pad}</DL><p>`);
      }
    }
  })(roots, 1);
  out.push("</DL><p>");
  return out.join("\n");
}

/* ---------------- History ---------------- */

// Returns the individual visits inside the window plus index rows for the database.
export async function collectHistory(startTime, endTime) {
  const items = await chrome.history.search({
    text: "", startTime, endTime, maxResults: 100000
  });

  const visits = [];
  const index = [];
  const allVisits = [];

  for (const it of items) {
    // search() only reports the LAST visit per URL, so ask for the individual ones.
    let raw = [];
    try { raw = await chrome.history.getVisits({ url: it.url }); } catch { /* URL gone meanwhile */ }

    for (const v of raw) {
      if (!v.visitTime) continue;
      // Keep every timestamp the browser hands us, not just the ones inside the window.
      // On the first run that backfills months of visit history in one go.
      const t = ms(v.visitTime);
      allVisits.push({ url: it.url, t });
      if (t >= startTime && t < endTime) {
        visits.push({ t, title: it.title || "", url: it.url });
      }
    }

    // For the index the earliest timestamp the browser still knows about counts - not just
    // the one inside the window. That backdates the first visit as far as possible on
    // the very first run. Browsers drop visit rows after ~90 days, so from then on our
    // own index is the only place that remembers.
    let first = ms(it.lastVisitTime || Date.now());
    for (const v of raw) if (v.visitTime && ms(v.visitTime) < first) first = ms(v.visitTime);

    index.push({
      url: it.url,
      host: hostOf(it.url),
      title: it.title || "",
      first,
      last: ms(it.lastVisitTime || first),
      count: it.visitCount || 1
    });
  }

  visits.sort((a, b) => a.t - b.t);
  return { visits, index, allVisits };
}

// One plain-text log per day. Each line carries the full date even though the
// filename already has it - a line stays meaningful once it is grepped out of
// the folder or pasted somewhere else.
export function historyToText(day, visits) {
  const pages = new Set(visits.map(v => v.url)).size;
  const header = [
    `Browsing history  ${day}`,
    `${visits.length} visits, ${pages} distinct pages`,
    `generated ${fmtDateTime(Date.now())}`,
    "=".repeat(78),
    ""
  ];
  const lines = visits.map(v => {
    const title = (v.title || "(no title)").replace(/\s+/g, " ").slice(0, 80);
    return `${fmtDateTime(v.t)}  ${title.padEnd(80)}  ${v.url}`;
  });
  // CRLF so the files look right in Notepad.
  return header.concat(lines, [""]).join("\r\n");
}

/* ---------------- One-off backfill ---------------- */

// Everything the browser still remembers, in one pass. Used once, to rescue the
// rolling ~90-day window before it expires; the daily run only ever looks at
// the last few days.
//
// Two things make this cheap enough to run interactively: the window is scanned
// in chunks so no single search() hits an internal result cap, and getVisits()
// is called once per unique URL instead of once per URL per day.
export async function collectAllHistory({ days = 120, onProgress = () => {} } = {}) {
  const now = Date.now();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);

  const meta = new Map();   // url -> { title, count, last }
  const CHUNK = 15 * 86400000;
  let scanned = 0;
  const chunks = Math.ceil((now - start.getTime()) / CHUNK);

  for (let from = start.getTime(); from < now; from += CHUNK) {
    const to = Math.min(from + CHUNK, now);
    const items = await chrome.history.search({
      text: "", startTime: from, endTime: to, maxResults: 100000
    });
    for (const it of items) {
      const old = meta.get(it.url);
      meta.set(it.url, {
        title: it.title || old?.title || "",
        count: Math.max(it.visitCount || 0, old?.count || 0),
        last: Math.max(it.lastVisitTime || 0, old?.last || 0)
      });
    }
    onProgress({ phase: "scan", done: ++scanned, total: chunks, urls: meta.size });
  }

  const index = [];
  const allVisits = [];
  const byDay = new Map();
  let done = 0;

  for (const [url, m] of meta) {
    let raw = [];
    try { raw = await chrome.history.getVisits({ url }); } catch { /* URL gone meanwhile */ }

    let first = ms(m.last || now);
    for (const v of raw) {
      if (!v.visitTime) continue;
      const t = ms(v.visitTime);
      if (t < first) first = t;
      allVisits.push({ url, t });

      const key = dateKey(new Date(t));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({ t, title: m.title, url });
    }

    index.push({
      url,
      host: hostOf(url),
      title: m.title,
      first,
      last: ms(m.last || first),
      count: m.count || 1
    });

    if (++done % 200 === 0 || done === meta.size) {
      onProgress({ phase: "visits", done, total: meta.size, visits: allVisits.length });
    }
  }

  for (const list of byDay.values()) list.sort((a, b) => a.t - b.t);
  return { byDay, index, allVisits, urls: meta.size };
}

/* ---------------- Index export ---------------- */

export function indexToCsv(rows) {
  const q = s => `"${String(s || "").replace(/"/g, '""')}"`;
  const head = "first_visit;last_visit;visits;host;title;url";
  const body = rows.map(r =>
    [fmtDateTime(r.first), fmtDateTime(r.last), r.count || 0, q(r.host), q(r.title), q(r.url)].join(";")
  );
  // Leading BOM so Excel picks up UTF-8 and shows non-ASCII characters correctly.
  return "﻿" + [head, ...body].join("\r\n") + "\r\n";
}

// One line per visit, split into per-year files so a daily run only rewrites
// the current year instead of the whole archive.
export function visitsToJsonl(rows) {
  return rows
    .slice()
    .sort((a, b) => a.t - b.t)
    .map(r => JSON.stringify({ url: r.url, at: new Date(r.t).toISOString() }))
    .join("\n") + "\n";
}

// Machine-readable twin of the CSV - this is what importIndex() reads back.
export function indexToJsonl(rows) {
  return rows.map(r => JSON.stringify({
    url: r.url,
    host: r.host,
    title: r.title,
    firstVisit: new Date(r.first).toISOString(),
    lastVisit: new Date(r.last).toISOString(),
    visits: r.count || 0
  })).join("\n") + "\n";
}
