# Chrome Backup – Bookmarks & History

A Manifest V3 Chrome extension that writes your bookmarks and browsing history
into a folder of your choice once a day — and answers the one question Chrome's
own history cannot:

> "When was I first on `github.com/xyz`?"

Chrome discards visit data after roughly 90 days. The **page index** this
extension keeps does not: one row per URL with first visit, last visit and visit
count, growing for as long as the extension is installed.

Everything runs locally. The extension has no network access and talks to no
server.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Click the icon → **Settings** → **Choose folder…**

The folder can be anywhere, including a second partition, e.g. `F:\Chrome_Backup`.
Chrome will ask for permission once.

Only the folder's name is shown afterwards, never its full path — the File System
Access API deliberately withholds that from extensions, and there is no way around
it. The line underneath is a free-text note; put the path there yourself if you
want to see at a glance which folder is configured.

## What ends up in the folder

```
D:\Chrome Backup\
├── Bookmarks\
│   ├── bookmarks-2026-09-13.json     full tree, easy to diff
│   └── bookmarks-2026-09-13.html     Netscape format, importable into Chrome
├── History\
│   └── history-2026-09-13.txt        time, title and URL of every visit
└── Index\
    ├── page-index.csv                one row per URL, cumulative, opens in Excel
    ├── page-index.jsonl              same, machine-readable
    └── visits-2026.jsonl             every individual visit, one file per year
```

Daily files are subject to the retention setting (365 days by default, `0` means
never delete). The index is never pruned.

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

Chrome keeps counting visits after it has discarded the underlying timestamps, so
its total can exceed the number of timestamps anyone still has. When that happens
the expanded row says so rather than quietly showing fewer.

## Run the recovery once

Settings → Maintenance → **Recover everything Chrome still remembers**.

Chrome's history is a rolling ~90-day window. Everything in it right now can still
be rescued; in three months it is gone for good. The recovery makes one pass over
that whole window, writes a daily log for every day it covers, and fills the index
with the matching timestamps. It takes a minute or two and is worth doing on the
day you install.

Afterwards the daily run takes over and only looks at the last few days.

## The one caveat

Chrome forgets the folder permission when the **browser restarts**. The scheduled
run then cannot write to disk without asking.

Nothing is lost when that happens: the finished backup goes into a queue, the icon
gets a `!`, and the next click writes everything out. If your Chrome stays open for
days at a time you will never see it.

Getting rid of this entirely would require a native messaging host — a small local
script that Chrome launches. That is deliberately *not* part of this project,
because it needs setup on every machine.

## Restoring

**Bookmarks:** `chrome://bookmarks` → ⋮ menu → *Import bookmarks* → pick the
`.html` from `Bookmarks\`.

**The index after a reinstall:** Settings → *Import the index from the backup
folder*. Reads `Index\page-index.jsonl` and every `Indexisits-<year>.jsonl`
back in, so both the summary and the individual timestamps survive.

## Layout

| File | Purpose |
|---|---|
| `sw.js` | Service worker: schedule, catch-up for missed runs, messaging |
| `lib/collect.js` | Reads the Chrome APIs, produces the file formats |
| `lib/db.js` | IndexedDB: directory handle and page index |
| `lib/run.js` | Orchestration: build, write, prune, queue |
| `lib/ui.js` | Shared between popup and options page |
| `options.*` | Settings, search, maintenance |
| `popup.*` | Status, quick search, back up now |

Permissions: `bookmarks`, `history`, `storage`, `alarms`, `unlimitedStorage`.

## Known limits

- The index can only backfill what Chrome still holds on the first run (~90 days).
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

`test/selftest.html` imports every module against a stubbed Chrome API and asserts
the parts that are easy to break silently — HTML escaping in the Netscape export,
the CSV/JSONL field names the importer depends on, search-key normalisation, that
a first visit is backdated beyond the requested window, and that backing up twice
in a day does not duplicate visit rows.

```bash
python -m http.server 8731
```

Then open `http://127.0.0.1:8731/test/selftest.html`. It needs no extension APIs,
so it runs in any browser. `extension/` contains only what actually ships.

## Versioning

Calendar versions, `YYYY.M.D` — the version Chrome shows on the extension card
tells you at a glance how old your loaded copy is, which a semantic version never
would for a tool with no API to keep stable.

Two caveats from Chrome's manifest rules: each component must be an integer
between 0 and 65535, and leading zeros are rejected. So `2026.9.13`, never
`2026.09.13`. For a second release on the same day, append a fourth component:
`2026.9.13.1`.
