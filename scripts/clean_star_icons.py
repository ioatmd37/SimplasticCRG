"""Clean the rating-star sprites: drop the fragment of the neighbouring icon that came along with
each star, remove the magenta fringe left by the chroma key, and re-cut them onto square canvases
of the same size (the originals were 222x178 and got squashed when shown in a square box).
Usage: python3 scripts/clean_star_icons.py
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from clean_sprite_islands import dilate, largest_blob  # noqa: E402

DIR = Path(__file__).resolve().parent.parent / "public" / "game-assets" / "icons"
SIZE, PAD = 128, 6

for name in ("star-filled", "star-outline"):
    im = Image.open(DIR / f"{name}.png").convert("RGBA")
    a = np.array(im)
    solid = a[..., 3] > 0
    keep = largest_blob(dilate(solid, 3)) & solid
    a[~keep] = 0
    # Magenta-tinted edge pixels (red and blue both well above green) become part of the black outline.
    r, g, b = (a[..., i].astype(int) for i in range(3))
    fringe = keep & (r > g + 40) & (b > g + 40)
    a[fringe, :3] = (12, 8, 14)
    ys, xs = np.nonzero(a[..., 3] > 0)
    crop = Image.fromarray(a).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    scale = (SIZE - 2 * PAD) / max(crop.size)
    crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.alpha_composite(crop, ((SIZE - crop.width) // 2, (SIZE - crop.height) // 2))
    out.save(DIR / f"{name}.png")
    print(name, "->", out.size, "star", crop.size)
