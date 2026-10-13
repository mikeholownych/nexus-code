#!/usr/bin/env python3
"""Drives the real `nexus-tui --live` binary (with the real sidecar) through edits whose diffs must render well:
mixed additions and deletions, several hunks, a repeated edit, a failed edit, an addition, a deletion, a long path
with a long line and wide characters, a file without a final newline, a large change and terminal escapes in file
content. It resizes while the edits arrive, steers while busy, opens the full-diff review with a draft in the
composer, runs `/diff`, and repeats one edit at 256-colour, 16-colour and monochrome depth.

It keeps a colour-aware model of the screen (SGR colours and attributes, wide characters) so the node test can check
alignment and colour, and it writes the screens it was asked to capture as JSON (rendered to PNG separately by
render_screens.py). The node test (tui_diff_e2e.test.ts) owns the mock gateway and checks the sidecar logs.

Usage: tui_diff_driver.py PLAN.json
"""
import json
import os
import re
import sys
import time
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tui_pty_driver import T0, Session, count_events, pty_env, wait_events  # noqa: E402

DEFAULT = None


def char_width(ch):
    if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class ColorScreen:
    """A terminal model that keeps each cell's character, colours and attributes: cursor positioning, erase, SGR."""

    TOKEN = re.compile(r"\x1b\[([0-9;?<>=:]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHM]|([\r\n\b])|([^\x1b\r\n\b]+)")

    def __init__(self, cols, rows):
        self.resize(cols, rows)

    def blank(self):
        return [" ", DEFAULT, DEFAULT, 0]

    def resize(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.grid = [[self.blank() for _ in range(cols)] for _ in range(rows)]
        self.row = self.col = 0
        self.fg = self.bg = DEFAULT
        self.attrs = 0  # bit 1 bold, 2 dim, 4 italic, 8 reverse

    def sgr(self, params):
        nums = [int(n) if n.isdigit() else 0 for n in params.replace(":", ";").split(";")] if params else [0]
        i = 0
        while i < len(nums):
            n = nums[i]
            if n == 0:
                self.fg = self.bg = DEFAULT
                self.attrs = 0
            elif n == 1:
                self.attrs |= 1
            elif n == 2:
                self.attrs |= 2
            elif n == 3:
                self.attrs |= 4
            elif n == 7:
                self.attrs |= 8
            elif n == 22:
                self.attrs &= ~3
            elif n == 23:
                self.attrs &= ~4
            elif n == 27:
                self.attrs &= ~8
            elif 30 <= n <= 37 or 90 <= n <= 97:
                self.fg = ["ansi", n - 30 if n < 90 else n - 90 + 8]
            elif 40 <= n <= 47 or 100 <= n <= 107:
                self.bg = ["ansi", n - 40 if n < 100 else n - 100 + 8]
            elif n == 39:
                self.fg = DEFAULT
            elif n == 49:
                self.bg = DEFAULT
            elif n in (38, 48) and i + 1 < len(nums):
                if nums[i + 1] == 5 and i + 2 < len(nums):
                    value = ["idx", nums[i + 2]]
                    i += 2
                elif nums[i + 1] == 2 and i + 4 < len(nums):
                    value = ["rgb", nums[i + 2], nums[i + 3], nums[i + 4]]
                    i += 4
                else:
                    value = DEFAULT
                if n == 38:
                    self.fg = value
                else:
                    self.bg = value
            i += 1

    def put(self, ch):
        width = char_width(ch)
        if width == 0:
            if self.col > 0:
                self.grid[self.row][self.col - 1][0] += ch
            return
        if self.col + width > self.cols:
            return
        self.grid[self.row][self.col] = [ch, self.fg, self.bg, self.attrs]
        if width == 2 and self.col + 1 < self.cols:
            self.grid[self.row][self.col + 1] = ["", self.fg, self.bg, self.attrs]
        self.col += width

    def feed(self, text):
        for m in self.TOKEN.finditer(text):
            params, _, final, ctl, chars = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
            if final:
                if final == "m":
                    self.sgr(params)
                    continue
                nums = [int(n) if n.isdigit() else 0 for n in params.lstrip("?").split(";")] if params else []
                if final in "Hf":
                    self.row = max(0, min(self.rows - 1, (nums[0] if nums and nums[0] else 1) - 1))
                    self.col = max(0, min(self.cols - 1, (nums[1] if len(nums) > 1 and nums[1] else 1) - 1))
                elif final == "J" and (not nums or nums[0] in (2, 3)):
                    self.grid = [[self.blank() for _ in range(self.cols)] for _ in range(self.rows)]
                elif final == "K":
                    mode = nums[0] if nums else 0
                    span = range(self.col, self.cols) if mode == 0 else range(0, self.col + 1) if mode == 1 else range(self.cols)
                    for c in span:
                        self.grid[self.row][c] = [" ", DEFAULT, self.bg, 0]
                elif final == "C":
                    self.col = min(self.cols - 1, self.col + (nums[0] if nums and nums[0] else 1))
                elif final == "D":
                    self.col = max(0, self.col - (nums[0] if nums and nums[0] else 1))
                elif final == "G":
                    self.col = max(0, min(self.cols - 1, (nums[0] if nums and nums[0] else 1) - 1))
            elif ctl == "\r":
                self.col = 0
            elif ctl == "\n":
                self.row = min(self.rows - 1, self.row + 1)
            elif ctl == "\b":
                self.col = max(0, self.col - 1)
            elif chars:
                for ch in chars:
                    if ord(ch) < 32:
                        continue
                    self.put(ch)

    def lines(self):
        return ["".join(cell[0] for cell in row).rstrip() for row in self.grid]

    def snapshot(self, name):
        return {"name": name, "cols": self.cols, "rows": self.rows, "at": round(time.monotonic() - T0, 4), "cells": [[list(c) for c in row] for row in self.grid]}


class DiffSession(Session):
    """A Session that also feeds the colour-aware screen."""

    def __init__(self, argv, env, cols, rows, cast):
        self.color = ColorScreen(cols, rows)
        super().__init__(argv, env, cols, rows, cast)

    def set_size(self, cols, rows, signal_child=True):
        if hasattr(self, "color"):
            self.color.resize(cols, rows)
        super().set_size(cols, rows, signal_child)

    def pump(self, seconds):
        got = super().pump(seconds)
        if got:
            self.color.feed(got.decode("utf-8", "replace"))
        return got

    def wait_screen(self, predicate, timeout, what):
        deadline = time.monotonic() + timeout
        while not predicate(self.color.lines()):
            if time.monotonic() > deadline:
                raise TimeoutError(f"never saw {what}; screen:\n" + "\n".join(self.color.lines()))
            self.pump(0.05)


def has(lines, text):
    squeezed = re.sub(r"\s", "", text)
    return any(squeezed in re.sub(r"\s", "", line) for line in lines)


def main():
    plan = json.load(open(sys.argv[1]))
    env = pty_env(plan["env"])
    events = plan["env"]["NEXUS_RECORD_EVENTS"]
    cast = []
    shots = []
    result = {}
    argv = [plan["tui"], "--live", "--sidecar", plan["recorder"], "--node", plan["node"], "--"] + plan["sidecar_args"]

    s = DiffSession(argv, env, 120, 40, cast)
    s.wait_text("enter send", 30)
    s.pump(0.3)
    s.send("Apply the review fixes across the repository.\r", settle=0.1)

    # While the edits arrive: capture the first card, resize narrow mid-turn, steer, then resize back.
    wait_events(events, "file.diff", 1, 30, s)
    s.pump(0.4)
    shots.append(s.color.snapshot("01-first-edit-wide-active"))
    wait_events(events, "file.diff", 2, 30, s)
    s.set_size(72, 30)
    s.pump(0.6)
    shots.append(s.color.snapshot("02-narrow-during-editing"))
    result["narrow_rows_within_width"] = all(len(line) <= 72 for line in s.color.lines())
    s.send("keep the public API stable\r", settle=0.2)
    wait_events(events, "file.diff", 5, 40, s)
    s.set_size(120, 40)
    s.pump(0.6)
    result["busy_after_resize"] = has(s.color.lines(), "esc cancels")
    wait_events(events, "turn.result", 1, 90, s)
    s.wait_idle()
    s.pump(0.5)
    shots.append(s.color.snapshot("03-turn-complete-wide"))

    # Idle: nothing is redrawn while nothing happens.
    before = len(s.raw)
    s.pump(2.5)
    result["idle_bytes"] = len(s.raw) - before

    # Scroll back through the transcript, one page at a time, capturing what the operator sees.
    pages = []
    for i in range(6):
        s.send("\x1b[5~", settle=0.3)  # PageUp
        pages.append(s.color.lines())
        if i == 1:
            shots.append(s.color.snapshot("04-scrollback"))
    result["scrollback_pages"] = pages
    s.send("\x1b[6~" * 10, settle=0.4)  # back to the newest

    # The complete diff: a draft in the composer, ctrl+d, navigate, return.
    s.send("draft: compare with the spec", settle=0.3)
    s.pump(0.3)
    transcript_before = s.color.lines()[1:-3]
    s.send("\x04", settle=0.6)  # ctrl+d
    s.wait_screen(lambda lines: has(lines, "Edit diff · this operation only") and not has(lines, "Loading the complete diff"), 10, "the review panel")
    shots.append(s.color.snapshot("05-review-newest-edit"))
    result["review_newest"] = s.color.lines()
    # Back through the edits to the multi-hunk one.
    target = None
    for _ in range(12):
        s.send("[", settle=0.5)
        s.wait_screen(lambda lines: not has(lines, "Loading the complete diff"), 10, "the previous edit")
        if has(s.color.lines(), "Editedsrc/app.ts") and has(s.color.lines(), "edit1of"):
            target = s.color.lines()
            break
    result["review_first_edit"] = target or s.color.lines()
    shots.append(s.color.snapshot("06-review-multi-hunk"))
    s.send("n", settle=0.4)
    result["review_after_n"] = s.color.lines()
    shots.append(s.color.snapshot("07-review-next-hunk"))
    # The long-path edit: pan right, then wrap.
    for _ in range(12):
        s.send("]", settle=0.5)
        s.wait_screen(lambda lines: not has(lines, "Loading the complete diff"), 10, "the next edit")
        if has(s.color.lines(), "configuration_loader.rs"):
            break
    result["review_long_clipped"] = s.color.lines()
    shots.append(s.color.snapshot("08-review-long-line-clipped"))
    s.send("\x1b[C" * 30, settle=0.5)
    result["review_long_panned"] = s.color.lines()
    shots.append(s.color.snapshot("09-review-long-line-panned"))
    s.send("w", settle=0.5)
    result["review_long_wrapped"] = s.color.lines()
    shots.append(s.color.snapshot("10-review-long-line-wrapped"))
    s.set_size(72, 30)
    s.pump(0.6)
    result["review_narrow"] = s.color.lines()
    shots.append(s.color.snapshot("11-review-narrow"))
    s.set_size(120, 40)
    s.pump(0.6)
    s.send("\x1b", settle=0.6)  # esc: back to the transcript
    s.pump(0.3)
    result["after_review"] = {
        "draft_kept": has(s.color.lines()[-2:], "draft: compare with the spec"),
        "transcript_restored": s.color.lines()[1:-3] == transcript_before,
        "panel_closed": not has(s.color.lines(), "Edit diff · this operation only"),
    }
    # Clear the draft, then the cumulative workspace diff.
    s.send("\x0c", settle=0.3)  # ctrl+l clears the draft
    s.send("/diff\r", settle=0.3)
    s.wait_screen(lambda lines: has(lines, "Workspace diff (git diff"), 15, "the workspace diff")
    s.pump(0.4)
    shots.append(s.color.snapshot("12-workspace-diff-transcript"))
    result["workspace_transcript"] = s.color.lines()
    s.send("\x04", settle=0.6)
    s.wait_screen(lambda lines: has(lines, "Workspace diff · unstaged changes"), 10, "the workspace review")
    shots.append(s.color.snapshot("13-workspace-review"))
    result["workspace_review"] = s.color.lines()
    s.send("\x1b", settle=0.4)
    s.send("\x03", settle=0.1)
    result["first_exit"] = s.wait_exit(20)
    raw = s.raw.decode("utf-8", "replace")
    # The file's own escape sequences must reach the screen as visible text, never as terminal commands.
    result["raw_has_file_osc52"] = "\x1b]52;" in raw
    result["screen_shows_file_escapes"] = "␛]52;c;SGVsbG8=␇" in raw

    # The same small edit at lower colour depths.
    depths = {}
    for name, extra in plan["depth_sessions"]:
        cast.append([round(time.monotonic() - T0, 4), "m", f"new TUI process: {name}"])
        session_env = dict(env, **extra)
        if "COLORTERM" not in extra:
            session_env.pop("COLORTERM", None)
        d = DiffSession(argv, session_env, 100, 24, cast)
        d.wait_text("enter send", 30)
        d.pump(0.3)
        done = count_events(events, "turn.result")
        d.send("make the small edit\r", settle=0.2)
        wait_events(events, "turn.result", done + 1, 40, d)
        d.wait_idle()
        d.pump(0.4)
        shots.append(d.color.snapshot(f"14-depth-{name}"))
        depths[name] = {"lines": d.color.lines(), "cells": d.color.snapshot(name)["cells"]}
        d.send("\x03", settle=0.1)
        d.wait_exit(20)
    result["depths"] = depths

    times = [frame[0] for frame in cast]
    result["recording"] = {"frames": len(cast), "monotonic": all(b >= a for a, b in zip(times, times[1:])), "duration_s": times[-1] if times else 0}
    with open(plan["cast"], "w") as f:
        f.write(json.dumps({"version": 2, "width": 120, "height": 40, "timestamp": int(time.time()), "env": {"TERM": env.get("TERM", "")}}) + "\n")
        for frame in cast:
            f.write(json.dumps(frame) + "\n")
    with open(plan["screens"], "w") as f:
        json.dump(shots, f)
    result["main_screens"] = {shot["name"]: ColorScreenLines(shot) for shot in shots}
    print(json.dumps(result))


def ColorScreenLines(shot):  # noqa: N802 — a projection used only for the summary
    return ["".join(cell[0] for cell in row).rstrip() for row in shot["cells"]]


if __name__ == "__main__":
    main()
