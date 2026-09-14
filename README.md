# Bookmark & History Backup

A Manifest V3 extension for **Chrome and Edge** that writes your bookmarks and
browsing history into a folder of your choice once a day — and answers the one
question the browser's own history cannot:

> "When was I first on `github.com/xyz`?"

Both browsers discard visit data after roughly 90 days. The **page index** this
extension keeps does not: one row per URL with first visit, last visit and visit
count, growing for as long as the extension is installed.

Everything runs locally. The extension has no network access and talks to no
server.

## Browsers

Tested in **Chrome** and **Edge**. Other Chromium browsers — Brave, Vivaldi, Opera —
use the same APIs and will very likely work, but have not been tried.

**Firefox will not work**, and not for want of a few tweaks: it deliberately does
not implement `showDirectoryPicker()`, so writing into a folder you choose — the
whole point of this — is not available there at all.

Chrome and Edge keep separate bookmarks and separate history, and an extension only
ever sees the browser it runs in. Installing it in both is fine; give each its own
target folder, or they will overwrite each other's index files.

## Install

No Web Store, no account, no installer — you point the browser at a folder.

1. Download the ZIP from [Releases](../../releases), or clone this repository
2. **Extract it somewhere permanent** — not your Downloads folder. The browser
   reads the files from wherever you put them, every day, so that folder has to
   stay put.
3. Open `chrome://extensions` — in Edge, `edge://extensions`
4. Turn on **Developer mode** (top right)
5. **Load unpacked** → select the extracted `bookmark-history-backup` folder (the
   one containing `manifest.json`); from a clone, select `extension/`
6. Click the icon → **Settings** → **Choose folder…**

The browser will warn that the extension can read your browsing history. It can —
that is the entire job. Nothing leaves your machine.

**To update:** download the new ZIP, extract it over the same folder, then press
the reload arrow on the extension's card. Do **not** press Remove and add it
again: removing deletes the extension's storage, which is where your settings and
the whole page index live. Overwrite-and-reload keeps everything.

The folder can be anywhere, including a second partition, e.g. `D:\Chrome Backup`.
The browser will ask for permission once.

Only the folder's name is shown afterwards, never its full path — the File System
Access API deliberately withholds that from extensions, and there is no way around
it. The line underneath is a free-text note; put the path there yourself if you
want to see at a glance which folder is configured.

## What ends up in the folder

```
D:\Chrome Backup\
├── Bookmarks\
│   ├── bookmarks-2026-09-13.json     full tree, easy to diff
│   └── bookmarks-2026-09-13.html     Netscape format, re-importable
├── History\
│   └── history-2026-09-13.txt        time, title and URL of every visit
└── Index\
    ├── page-index.csv                one row per URL, cumulative, opens in Excel
    ├── page-index.jsonl              same, machine-readable
    └── visits-2026.jsonl             every individual visit, one file per year
```

## Retention

Bookmarks and history are kept on separate clocks, because they are not the same
kind of thing.

A **bookmark** file is a complete snapshot of a slowly changing state — today's is
almost always identical to yesterday's. Default: keep 30 days, and *only write when
something actually changed*, so the folder becomes a record of when you edited your
bookmarks rather than a pile of duplicates.

A **history** log is unique. Delete it and that day is gone, since the browser forgot it
long ago. Default: `0`, keep everything.

`0` is available for both. Whatever the setting, **the most recent snapshot is never
deleted** — otherwise leaving your bookmarks untouched for longer than the retention
window would quietly remove the last backup you had.

The index is never pruned at all.

## Search

In the popup, and in more detail in the settings page. Searching covers the
**whole URL including the path** as well as the page title. Scheme and `www.`
are ignored:

| Query | matches, among others |
|---|---|
| `github.com/torvalds` | `https://github.com/torvalds/linux` |
| `/pull/` | every pull request page you ever had open |
| `jira` | hits in the host, in the path, or in the title |

Results are sorted oldest first visit first — usually the answer you came for.
Click the visit count to expand a row into the individual timestamps.

Browsers keep counting visits after discarding the underlying timestamps, so that
total can exceed the number of timestamps anyone still has. When that happens the
expanded row says so rather than quietly showing fewer.

## Import from the browser once

Settings → Maintenance → **Import from the browser's history**.

The browser's history is a rolling ~90-day window; what is in it today is gone in three
months. This makes one pass over the whole window, writes a daily log for every day
it covers, and fills the index with the matching timestamps. A minute or two, and
worth doing on the day you install.

Afterwards the daily run takes over and only looks at the last few days.

The other button in that section, **Restore from your backup folder**, goes the
opposite way — see [Restoring](#restoring).

## The one caveat

The browser forgets the folder permission when it **restarts**. The scheduled
run then cannot write to disk without asking.

Nothing is lost when that happens: the finished backup goes into a queue, the icon
gets a `!`, and the next click writes everything out. If your browser stays open for
days at a time you will never see it.

Getting rid of this entirely would require a native messaging host — a small local
script the browser launches. That is deliberately *not* part of this project,
because it needs setup on every machine.

## Restoring

**Bookmarks:** `chrome://bookmarks` (Edge: `edge://favorites`) → ⋮ menu →
*Import bookmarks* → pick the `.html` from `Bookmarks\`.

**The index after a reinstall:** Settings → Maintenance → *Restore from your backup
folder*. Reads `Index\page-index.jsonl` and every `Index\visits-<year>.jsonl`
back in, so both the summary and the individual timestamps survive.

You rarely need to press it: pointing the extension at a folder that already holds
a backup restores it automatically, before anything is written. That order matters —
the first backup would otherwise export the empty database straight over the files
it was supposed to read.

## Layout

| File | Purpose |
|---|---|
| `sw.js` | Service worker: schedule, catch-up for missed runs, messaging |
| `lib/collect.js` | Reads the browser APIs, produces the file formats |
| `lib/db.js` | IndexedDB: directory handle and page index |
| `lib/run.js` | Orchestration: build, write, prune, queue |
| `lib/ui.js` | Shared between popup and options page |
| `options.*` | Settings, search, maintenance |
| `popup.*` | Status, quick search, back up now |

Permissions: `bookmarks`, `history`, `storage`, `alarms`, `unlimitedStorage`.

## Known limits

- The index can only backfill what the browser still holds on the first run (~90 days).
  From then on it is gapless. The same applies to the individual timestamps.
- Local history only. History synced from other devices is not exposed to
  extensions.
- Incognito sessions never appear.

## File sizes

Rough numbers for heavy use — 300 visits a day, so about 110,000 a year:

| File | Size | Rewritten |
|---|---|---|
| `history-<date>.txt` | ~40 KB per day | once, on the day it covers |
| `visits-<year>.jsonl` | ~11 MB per year | daily, current year only |
| `page-index.csv` / `.jsonl` | ~150 bytes per unique URL | daily, in full |

The per-year split keeps the visit archive flat: a daily run rewrites this year's
file, never the whole history. The page index is the only file that grows without
bound, and it grows slowly — after ten years of heavy browsing expect a few tens
of MB, which is a second of disk I/O once a day. If it ever does become annoying,
the same trick applies: split it by first-visit year.

## Self-test

`test/selftest.html` imports every module against a stubbed browser API and asserts
the parts that are easy to break silently — HTML escaping in the Netscape export,
the CSV/JSONL field names the importer depends on, search-key normalisation, that
a first visit is backdated beyond the requested window, and that backing up twice
in a day does not duplicate visit rows.

```bash
python -m http.server 8731
```

Then open `http://127.0.0.1:8731/test/selftest.html`. It needs no extension APIs,
so it runs in any browser. `extension/` contains only what actually ships.

## Extension ID

Pinned to `pmdngebjilnkobcgdkhnioojcifdkipl` by the `key` field in the manifest.

Chrome normally derives an unpacked extension's ID from its folder path, and the
ID is what `chrome.storage` and IndexedDB hang off — so moving or renaming the
folder would silently orphan every setting and the whole index. The `key` field
is the public half of an RSA keypair; Chrome takes the first 16 bytes of its
SHA-256 and maps each hex digit onto `a`–`p`. Same key, same ID, on any path and
any machine.

Only the public half is needed, and it is meant to be public — it sits in this
repository. The private key is not used anywhere and is not committed.

If this is ever uploaded to the Chrome Web Store, **remove the `key` field
first**: the store issues its own key and its own ID, and a mismatching one is
rejected.

## Versioning

Calendar versions, `YYYY.M.D` — the version Chrome shows on the extension card
tells you at a glance how old your loaded copy is, which a semantic version never
would for a tool with no API to keep stable.

Two caveats from Chrome's manifest rules: each component must be an integer
between 0 and 65535, and leading zeros are rejected. So `2026.9.13`, never
`2026.09.13`. For a second release on the same day, append a fourth component:
`2026.9.13.1`.
