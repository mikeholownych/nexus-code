#!/usr/bin/env python3
"""Renders the screens captured by tui_diff_driver.py (cells with characters, colours and attributes) to PNG files,
as a dark terminal with an xterm palette would show them. Needs Pillow; it is an evidence tool, not a test dependency.

Usage: render_screens.py SCREENS.json OUT_DIR
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

BG = (13, 17, 23)
FG = (201, 209, 217)
ANSI = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]
CUBE = [0, 95, 135, 175, 215, 255]
FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/unifont/unifont_jp.otf",
]
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SIZE = 15
CELL_W, CELL_H = 9, 19


def palette(index):
    if index < 16:
        return ANSI[index]
    if index < 232:
        i = index - 16
        return (CUBE[i // 36], CUBE[(i // 6) % 6], CUBE[i % 6])
    v = 8 + 10 * (index - 232)
    return (v, v, v)


def colour(value, default):
    if not value:
        return default
    if value[0] == "rgb":
        return tuple(value[1:4])
    if value[0] in ("idx", "ansi"):
        return palette(value[1])
    return default


def main():
    shots = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    fonts = [ImageFont.truetype(f, SIZE) for f in FONTS if os.path.exists(f)]
    bold = ImageFont.truetype(BOLD, SIZE) if os.path.exists(BOLD) else fonts[0]
    has_glyph = {}
    # What each font draws for a character it lacks (its .notdef box): a glyph that renders identically is missing.
    missing = {id(f): bytes(f.getmask("\U0010fffd")) for f in fonts + [bold]}

    def font_for(ch, is_bold):
        primary = bold if is_bold else fonts[0]
        for font in [primary] + fonts[1:]:
            key = (id(font), ch)
            if key not in has_glyph:
                try:
                    mask = font.getmask(ch)
                    has_glyph[key] = ch.isspace() or (mask.getbbox() is not None and bytes(mask) != missing[id(font)])
                except Exception:
                    has_glyph[key] = False
            if has_glyph[key]:
                return font
        return primary

    for shot in shots:
        cols, rows = shot["cols"], shot["rows"]
        image = Image.new("RGB", (cols * CELL_W + 16, rows * CELL_H + 16), BG)
        draw = ImageDraw.Draw(image)
        for y, row in enumerate(shot["cells"]):
            for x, (ch, fg, bg, attrs) in enumerate(row):
                fore, back = colour(fg, FG), colour(bg, BG)
                if attrs & 8:
                    fore, back = back, fore
                if attrs & 2:
                    fore = tuple((c + b) // 2 for c, b in zip(fore, back))
                left, top = 8 + x * CELL_W, 8 + y * CELL_H
                wide = x + 1 < cols and row[x + 1][0] == ""
                if back != BG:
                    draw.rectangle([left, top, left + CELL_W * (2 if wide else 1) - 1, top + CELL_H - 1], fill=back)
                if ch and not ch.isspace():
                    draw.text((left, top + 1), ch, font=font_for(ch[0], attrs & 1), fill=fore)
        image.save(os.path.join(out, f"{shot['name']}.png"))
        print(os.path.join(out, f"{shot['name']}.png"))


if __name__ == "__main__":
    main()
