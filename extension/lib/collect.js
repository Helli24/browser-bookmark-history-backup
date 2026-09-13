// Reads bookmarks and history from the Chrome APIs and turns them into files.

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
  const stats = { ordner: 0, links: 0 };
  // depth 0 is the invisible root Chrome wraps everything in - not a real folder.
  (function count(nodes, depth) {
    for (const n of nodes || []) {
      if (n.url) stats.links++;
      else { if (depth > 0) stats.ordner++; count(n.children, depth + 1); }
    }
  })(tree, 0);

  const json = JSON.stringify(
    { exportiertAm: new Date().toISOString(), statistik: stats, baum: tree },
    null, 2
  );
  return { json, html: toNetscape(tree[0]?.children || []), stats };
}

// Netscape bookmark format - the only one Chrome can import back in.
function toNetscape(roots) {
  const sec = ms => Math.floor((ms || Date.now()) / 1000);
  const out = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- Automatisch erzeugt. Import via chrome://bookmarks -> Menue -> Lesezeichen importieren -->",
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
        // Node id "1" is the bookmarks bar; Chrome needs the flag to restore it there.
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

  const besuche = [];
  const index = [];

  for (const it of items) {
    // search() only reports the LAST visit per URL, so ask for the individual ones.
    let visits = [];
    try { visits = await chrome.history.getVisits({ url: it.url }); } catch { /* URL gone meanwhile */ }

    for (const v of visits) {
      if (v.visitTime >= startTime && v.visitTime < endTime) {
        besuche.push({ t: v.visitTime, title: it.title || "", url: it.url });
      }
    }

    // For the index the earliest timestamp Chrome still knows about counts - not just
    // the one inside the window. That backdates the first visit as far as possible on
    // the very first run. Chrome drops visit rows after ~90 days, so from then on our
    // own index is the only place that remembers.
    let first = it.lastVisitTime || Date.now();
    for (const v of visits) if (v.visitTime && v.visitTime < first) first = v.visitTime;

    index.push({
      url: it.url,
      host: hostOf(it.url),
      title: it.title || "",
      first,
      last: it.lastVisitTime || first,
      count: it.visitCount || 1
    });
  }

  besuche.sort((a, b) => a.t - b.t);
  return { besuche, index };
}

// One plain-text log per day.
export function historyToText(tag, besuche) {
  const uhr = ms => {
    const d = new Date(ms), p = n => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const seiten = new Set(besuche.map(b => b.url)).size;
  const kopf = [
    `Browserverlauf  ${tag}`,
    `${besuche.length} Aufrufe, ${seiten} verschiedene Seiten`,
    `erzeugt am ${fmtDateTime(Date.now())}`,
    "=".repeat(78),
    ""
  ];
  const zeilen = besuche.map(b => {
    const titel = (b.title || "(ohne Titel)").replace(/\s+/g, " ").slice(0, 90);
    return `${uhr(b.t)}  ${titel.padEnd(90)}  ${b.url}`;
  });
  // CRLF so the files look right in Notepad.
  return kopf.concat(zeilen, [""]).join("\r\n");
}

/* ---------------- Index export ---------------- */

export function indexToCsv(rows) {
  const q = s => `"${String(s || "").replace(/"/g, '""')}"`;
  const head = "erstbesuch;letzter_besuch;aufrufe;host;titel;url";
  const body = rows.map(r =>
    [fmtDateTime(r.first), fmtDateTime(r.last), r.count || 0, q(r.host), q(r.title), q(r.url)].join(";")
  );
  // Leading BOM so Excel picks up UTF-8 and shows umlauts correctly.
  return "﻿" + [head, ...body].join("\r\n") + "\r\n";
}

// Machine-readable twin of the CSV - this is what importIndex() reads back.
export function indexToJsonl(rows) {
  return rows.map(r => JSON.stringify({
    url: r.url, host: r.host, titel: r.title,
    erstbesuch: new Date(r.first).toISOString(),
    letzterBesuch: new Date(r.last).toISOString(),
    aufrufe: r.count || 0
  })).join("\n") + "\n";
}
