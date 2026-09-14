"""Builds the release archive from extension/.

    python tools/build-release.py

Writes dist/bookmark-history-backup-<version>.zip, taking the version from the
manifest. The folder inside the archive deliberately carries no version: updating
then means extracting over the same folder and pressing reload, which keeps the
extension's storage. A versioned folder name would leave one directory per
release and push people towards Remove-and-re-add, and Remove deletes the
settings and the whole page index.

VERSION.txt is generated into the archive rather than committed, so a clone
never carries a stale copy - there, git is the source of truth.
"""

import io
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension")
FOLDER = "bookmark-history-backup"


def main():
    with io.open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    version = manifest["version"]

    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, f"{FOLDER}-{version}.zip")

    # Compare this against the version on the extension's card in
    # chrome://extensions: if they differ, the reload after extracting was missed.
    marker = (
        f"{manifest['name']}\n"
        f"version {version}\n\n"
        "This file is only here so you can see which version you extracted.\n"
        "Compare it with the version shown on the extension's card in\n"
        "chrome://extensions - if they differ, press the reload arrow there.\n\n"
        "https://github.com/Helli24/chrome-backup\n"
    )

    written = []
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, names in os.walk(SRC):
            for name in sorted(names):
                src = os.path.join(dirpath, name)
                rel = os.path.relpath(src, SRC).replace(os.sep, "/")
                z.write(src, f"{FOLDER}/{rel}")
                written.append(rel)
        z.writestr(f"{FOLDER}/VERSION.txt", marker)
        written.append("VERSION.txt")

    size = os.path.getsize(out) / 1024
    print(f"{os.path.relpath(out, ROOT)}  ({size:.0f} KB, {len(written)} files)")
    for rel in written:
        print(f"    {FOLDER}/{rel}")


if __name__ == "__main__":
    main()
