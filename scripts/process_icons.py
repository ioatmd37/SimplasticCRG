"""Slice the UI icon sheet (5 cols x 3 rows, magenta background) into named PNGs.

Usage: python3 scripts/process_icons.py
"""
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from process_sprites import chroma_key  # reuse the same soft chroma-key

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "game-assets", "sprites-src", "icons-raw.png")
OUT_DIR = os.path.join(ROOT, "public", "game-assets", "icons")
COLS, ROWS = 6, 3
PAD = 6
# Positional placeholder names; RENAME (filled in after a visual check) renames the real ones.
NAMES = [f"r{r}c{c}" for r in range(ROWS) for c in range(COLS)]
RENAME = {}


def main():
    if not os.path.exists(SRC):
        print("No icons-raw.png at", SRC)
        return
    # NAMES above matches the sheet as originally described; re-order to the actual
    # rows we received (mic replaced hourglass's slot visually) is handled by index.
    im = chroma_key(Image.open(SRC))
    w, h = im.size
    cw, ch = w // COLS, h // ROWS
    os.makedirs(OUT_DIR, exist_ok=True)
    i = 0
    for row in range(ROWS):
        for col in range(COLS):
            cell = im.crop((col * cw + PAD, row * ch + PAD, (col + 1) * cw - PAD, (row + 1) * ch - PAD))
            bbox = cell.getbbox()
            if bbox:
                cell = cell.crop(bbox)
            key = NAMES[i] if i < len(NAMES) else f"icon-{i}"
            name = RENAME.get(key, key)
            cell.save(os.path.join(OUT_DIR, f"{name}.png"))
            i += 1
    print(f"wrote {i} icons -> {OUT_DIR}")


if __name__ == "__main__":
    main()
