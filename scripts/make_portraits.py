"""Crop a head-and-shoulders portrait (3:4) from frame 1 of each role sprite, for the
lobby role-select tiles. Starts at the top of the character so the face is never
lost when the sprite canvas has empty headroom (e.g. the bias monitor).
"""
from pathlib import Path

from PIL import Image

DIR = Path(__file__).resolve().parent.parent / "public" / "game-assets" / "sprites"
KEYS = ["facilitator", "patient-mystery", "doctor", "scribe", "bias", "observer"]
PAD = 12
# key -> (fraction of body height that counts as "head", head width as a share of the tile).
# The mannequin's head is tall, so it gets a looser fit; the bias monitor's canvas is small.
HEAD_FIT = {"patient-mystery": (1 / 5, 0.76), "bias": (1 / 4, 0.90)}

for key in KEYS:
    im = Image.open(DIR / f"{key}-1.png").convert("RGBA")
    x0, y0, x1, y1 = im.getchannel("A").getbbox()
    if key in HEAD_FIT:
        # Size the crop to the head instead of the whole body, so the face fills the tile like
        # everyone else's (props like the magnifier sit lower and are ignored).
        frac, share = HEAD_FIT[key]
        head = im.getchannel("A").crop((0, y0, im.width, y0 + round((y1 - y0) * frac))).getbbox()
        x0, x1 = head[0], head[2]
        w = round((x1 - x0) / share)
    else:
        w = x1 - x0 + PAD * 2
    h = round(w * 4 / 3)
    left = max(0, (x0 + x1) // 2 - w // 2)
    top = max(0, y0 - PAD)
    crop = im.crop((left, top, left + w, min(im.height, top + h)))
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(crop, (0, 0), crop)
    canvas.save(DIR / f"{key}-portrait.png")
    print(key, canvas.size)
