"""Turn a raw 4-frame sprite sheet (magenta #FF00FF chroma-key background, from
public/game-assets/sprites-src/<key>-raw.png) into 4 aligned transparent PNGs at
public/game-assets/sprites/<key>-1..4.png (idle A, idle B, talk, action).

Usage: python3 scripts/process_sprites.py [key ...]   (no args = process everything found)
"""
import glob
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "public", "game-assets", "sprites-src")
OUT_DIR = os.path.join(ROOT, "public", "game-assets", "sprites")
MAGENTA = (255, 0, 255)
N_FRAMES = 4
PAD = 14  # transparent margin left around the tightest crop, in source pixels


def dist2(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2


def chroma_key(im):
    """Magenta -> transparent, with a soft edge band to avoid a hard purple fringe."""
    im = im.convert("RGBA")
    px = im.load()
    hard, soft = 70 * 70, 170 * 170
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            d = dist2((r, g, b), MAGENTA)
            if d <= hard:
                px[x, y] = (r, g, b, 0)
            elif d <= soft:
                # Linear falloff across the band, and desaturate toward gray to kill the fringe.
                t = (d - hard) / (soft - hard)
                px[x, y] = (r, g, b, int(255 * (1 - t) * 0.6))
    return im


def bbox_union(boxes):
    xs0 = min(b[0] for b in boxes)
    ys0 = min(b[1] for b in boxes)
    xs1 = max(b[2] for b in boxes)
    ys1 = max(b[3] for b in boxes)
    return (xs0, ys0, xs1, ys1)


def process(key):
    src_path = os.path.join(SRC_DIR, f"{key}-raw.png")
    if not os.path.exists(src_path):
        print(f"skip {key}: no {src_path}")
        return
    im = chroma_key(Image.open(src_path))
    w, h = im.size
    step = w // N_FRAMES
    # Inset each slice slightly so a stray pixel (e.g. a sparkle effect) from the
    # neighboring frame can't bleed across an imprecise column boundary.
    inset = max(2, int(step * 0.025))
    cells = [
        im.crop((i * step + (inset if i > 0 else 0), 0, (i + 1) * step - (inset if i < N_FRAMES - 1 else 0), h))
        for i in range(N_FRAMES)
    ]

    # Tight bbox per cell (non-transparent pixels only), then a shared canvas
    # sized to the widest/tallest frame so all 4 share one footprint and baseline.
    boxes = []
    for c in cells:
        b = c.getbbox()
        boxes.append(b if b else (0, 0, c.width, c.height))
    ux0, uy0, ux1, uy1 = bbox_union(boxes)
    cw, ch = ux1 - ux0 + PAD * 2, uy1 - uy0 + PAD * 2

    os.makedirs(OUT_DIR, exist_ok=True)
    for i, c in enumerate(cells, start=1):
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        # Anchor by the shared bbox origin so feet/bottom line up across frames.
        canvas.paste(c, (PAD - ux0, PAD - uy0), c)
        out = os.path.join(OUT_DIR, f"{key}-{i}.png")
        canvas.save(out)
    print(f"{key}: {cw}x{ch} x{N_FRAMES} frames -> {OUT_DIR}")


def main():
    keys = sys.argv[1:]
    if not keys:
        keys = sorted(
            os.path.basename(p)[: -len("-raw.png")]
            for p in glob.glob(os.path.join(SRC_DIR, "*-raw.png"))
        )
    if not keys:
        print("No *-raw.png found in", SRC_DIR)
        return
    for k in keys:
        process(k)


if __name__ == "__main__":
    main()
