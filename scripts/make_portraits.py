"""Crop a head-and-shoulders portrait (3:4) from frame 1 of each role sprite, for the
lobby role-select tiles. Starts at the top of the character so the face is never
lost when the sprite canvas has empty headroom (e.g. the bias monitor).
"""
from pathlib import Path

from PIL import Image

DIR = Path(__file__).resolve().parent.parent / "public" / "game-assets" / "sprites"
KEYS = ["facilitator", "patient-mystery", "doctor", "scribe", "bias", "observer"]
PAD = 12

for key in KEYS:
    im = Image.open(DIR / f"{key}-1.png").convert("RGBA")
    x0, y0, x1, y1 = im.getchannel("A").getbbox()
    w = x1 - x0 + PAD * 2
    h = round(w * 4 / 3)
    left = max(0, (x0 + x1) // 2 - w // 2)
    top = max(0, y0 - PAD)
    crop = im.crop((left, top, left + w, min(im.height, top + h)))
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(crop, (0, 0), crop)
    canvas.save(DIR / f"{key}-portrait.png")
    print(key, canvas.size)
