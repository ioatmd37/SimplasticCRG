"""Remove the Gemini sparkle watermark from the floor near the bottom-right corner (left of the
plant) of the room backgrounds.

The sparkle is a translucent white overlay: pixel = floor * (1 - a) + white * a. A large median
filter estimates the smooth floor; where a pixel is lighter than that, the excess is the overlay,
so it is solved for and undone per pixel. Unlike painting over it, this keeps the tile lines
that run under the sparkle. Only a diamond around the sparkle is touched, so the plant beside it
is never affected. Usage: python3 scripts/remove_bg_watermark.py [file ...]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

DIR = Path(__file__).resolve().parent.parent / "public" / "game-assets"
CENTER = (1254, 648)  # sparkle centre, in image pixels
RADIUS = 27  # diamond half-diagonal covering the sparkle and its soft edge
BOX = (CENTER[0] - 60, CENTER[1] - 60, CENTER[0] + 60, CENTER[1] + 60)


def clean(name):
    path = DIR / name
    im = Image.open(path).convert("RGB")
    crop = im.crop(BOX)
    px = np.array(crop).astype(float)
    lum = px.mean(axis=2)
    bg = np.array(crop.convert("L").filter(ImageFilter.MedianFilter(45))).astype(float)
    yy, xx = np.mgrid[0 : px.shape[0], 0 : px.shape[1]]
    cy, cx = CENTER[1] - BOX[1], CENTER[0] - BOX[0]
    inside = (np.abs(yy - cy) + np.abs(xx - cx)) <= RADIUS
    sat = px.max(axis=2) - px.min(axis=2)
    alpha = np.clip((lum - bg) / np.maximum(255 - bg, 1), 0, 0.6)
    alpha[~inside | (sat > 45)] = 0
    # Undo the overlay: floor = (pixel - white * a) / (1 - a)
    fixed = (px - 255 * alpha[..., None]) / (1 - alpha[..., None])
    im.paste(Image.fromarray(np.clip(fixed, 0, 255).astype(np.uint8)), BOX[:2])
    im.save(path, quality=92, method=6)
    return int((alpha > 0.01).sum()), float(alpha.max())


if __name__ == "__main__":
    for n in sys.argv[1:] or ["room-night.webp"]:
        print(n, "overlay px, max alpha:", clean(n))
