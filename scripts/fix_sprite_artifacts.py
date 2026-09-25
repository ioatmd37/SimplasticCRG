"""Hand-tuned cleanups for artifacts baked into AI-generated sprite sheets
(speech bubbles, Gemini sparkle watermark, stray marks). Run after process_sprites.py.
Coordinates are in the processed frame's pixel space.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from clean_sprite_islands import dilate, largest_blob  # noqa: E402

DIR = Path(__file__).resolve().parent.parent / "public" / "game-assets" / "sprites"


def load(role, i):
    return np.array(Image.open(DIR / f"{role}-{i}.png").convert("RGBA"))


def save(role, i, a):
    Image.fromarray(a).save(DIR / f"{role}-{i}.png")


def keep_main_blob(a, gap):
    solid = a[..., 3] > 0
    keep = largest_blob(dilate(solid, gap)) & solid
    a[~keep] = 0


def inpaint_bright(a, box, margin, passes=6, ceiling=255):
    """Replace watermark pixels (a bit lighter than the flat colour around them) using
    the median colour of nearby non-watermark pixels, working inwards pass by pass."""
    y0, y1, x0, x1 = box
    reg = a[y0:y1, x0:x1].copy()
    lum = reg[..., :3].astype(int).mean(axis=2)
    solid = reg[..., 3] > 0
    ref = np.median(lum[solid & (lum <= np.percentile(lum[solid], 40))])
    bad = solid & (lum > ref + margin) & (lum < ceiling)
    total = int(bad.sum())
    h, w = bad.shape
    for _ in range(passes):
        if not bad.any():
            break
        nxt = bad.copy()
        for y, x in zip(*np.nonzero(bad)):
            ys, xs = slice(max(0, y - 2), y + 3), slice(max(0, x - 2), x + 3)
            good = solid[ys, xs] & ~bad[ys, xs]
            if good.sum() >= 3:
                reg[y, x, :3] = np.median(reg[ys, xs][good][:, :3], axis=0).astype(np.uint8)
                nxt[y, x] = False
        bad = nxt
    a[y0:y1, x0:x1] = reg
    return total


def observer():
    a = load("observer", 3)
    keep_main_blob(a, 2)  # the speech bubble is a separate blob a couple of px away from the cap
    save("observer", 3, a)
    a = load("observer", 4)
    a[335:405, 292:] = 0  # stray dash marks beside the notepad
    print("observer watermark px:", inpaint_bright(a, (600, 680, 220, 272), 10))
    save("observer", 4, a)


def facilitator():
    a = load("facilitator", 4)
    a[270:340, :40] = 0  # sliver of the previous frame's hand
    print("facilitator watermark px:", inpaint_bright(a, (595, 668, 190, 255), 18, ceiling=175))
    save("facilitator", 4, a)


if __name__ == "__main__":
    for role in sys.argv[1:] or ["observer", "facilitator"]:
        globals()[role]()
