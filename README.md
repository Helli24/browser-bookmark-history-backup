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

The folder can be anywhere, including a second partition, e.g. `D:\Chrome Backup`.
Chrome will ask for permission once.

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
| `github.com/anthropics` | `https://github.com/anthropics/claude-code` |
| `/pull/` | every pull request page you ever had open |
| `jira` | hits in the host, in the path, or in the title |

Results are sorted oldest first visit first — usually the answer you came for.
Click the visit count to expand a row into the individual timestamps.

Chrome keeps counting visits after it has discarded the underlying timestamps, so
its total can exceed the number of timestamps anyone still has. When that happens
the expanded row says so rather than quietly showing fewer.

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
- Every run rewrites the complete page index, plus the visit file of any year
  that got new rows — in practice only the current one. With a very large archive
  that is a few tens of MB per day.

## Self-test

`extension/selftest.html` imports every module against a stubbed Chrome API and
asserts the parts that are easy to break silently — HTML escaping in the Netscape
export, the CSV/JSONL field names the importer depends on, search-key
normalisation, and that a first visit is backdated beyond the requested window.

```bash
cd extension && python -m http.server 8731
```

Then open `http://127.0.0.1:8731/selftest.html`. It does not need Chrome's
extension APIs, so it runs in any browser.
