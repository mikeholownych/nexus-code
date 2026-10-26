#!/usr/bin/env python3
"""Validate archived installed-RC9 NO_COLOR and TERM=dumb captures."""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
COLOR_SGR = re.compile(rb"\x1b\[([0-9;]*)m")
CASES = (
    ("no-color-xterm-40x14", set(), 40, ("Approval needed", "Approve", "All later", "Deny", "y or n, or ←→ then enter")),
    ("no-color-xterm-100x30", set(), 100, ("Approval needed", "Approve", "Deny")),
    ("term-dumb-40x14", {39, 49, 59}, 40, ("Approval needed", "Approve", "All later", "Deny", "y or n, or ←→ then enter")),
    ("term-dumb-100x30", {39, 49, 59}, 100, ("Approval needed", "Approve", "Deny")),
)


def color_params(raw: bytes) -> list[int]:
    found = []
    for match in COLOR_SGR.finditer(raw):
        params = [int(value) for value in match.group(1).split(b";") if value]
        found.extend(value for value in params if value in range(30, 40) or value in range(40, 50) or value in range(90, 108) or value in (58, 59))
    return found


def main() -> int:
    for name, expected_colors, width, required in CASES:
        raw = (ROOT / f"{name}.raw.b64").read_bytes().strip()
        raw = base64.b64decode(raw, validate=True)
        screens = (ROOT / f"{name}.screens.txt").read_text(encoding="utf-8")
        colors = color_params(raw)
        if set(colors) != expected_colors:
            raise SystemExit(f"{name}: color SGR expectation mismatch: {colors}")
        if f"({width}x{14 if width == 40 else 30})" not in screens:
            raise SystemExit(f"{name}: missing terminal dimensions")
        if any(text not in screens for text in required):
            raise SystemExit(f"{name}: expected approval text missing")
        verdict = "FAIL as expected" if expected_colors else "PASS subcase"
        print(f"{name}: {verdict}; color SGR params={sorted(set(colors))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
