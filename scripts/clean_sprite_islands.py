"""Remove stray islands (speech bubbles, sparkle watermarks, stray bars) from processed sprite frames.

Keeps only the largest connected blob per frame (after a small dilation so a pencil,
notepad or other attached prop is not dropped), then leaves the frame canvas untouched.
Usage: python3 scripts/clean_sprite_islands.py observer [role ...]
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

DIR = Path(__file__).resolve().parent.parent / "public" / "game-assets" / "sprites"
GAP = 8  # px of transparent gap still treated as "attached"


def dilate(mask, r):
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def largest_blob(mask):
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    best = None
    for y in range(h):
        for x in range(w):
            if mask[y, x] and not seen[y, x]:
                q = deque([(y, x)])
                seen[y, x] = True
                pts = []
                while q:
                    cy, cx = q.popleft()
                    pts.append((cy, cx))
                    for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
                if best is None or len(pts) > len(best):
                    best = pts
    keep = np.zeros_like(mask)
    for y, x in best:
        keep[y, x] = True
    return keep


def clean(path):
    im = Image.open(path).convert("RGBA")
    a = np.array(im)
    solid = a[..., 3] > 0
    keep = largest_blob(dilate(solid, GAP)) & solid
    removed = int(solid.sum() - keep.sum())
    a[~keep] = 0
    Image.fromarray(a).save(path)
    return removed


if __name__ == "__main__":
    for role in sys.argv[1:]:
        for i in range(1, 5):
            p = DIR / f"{role}-{i}.png"
            print(p.name, "removed px:", clean(p))
