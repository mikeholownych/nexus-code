#!/usr/bin/env python3
"""Captures for TUI audit defects D-05 (context indicator, header across widths) and D-27 (timers in the status bar).

Drives a real `nexus-tui --live` binary through a pseudo-terminal (the Term class of tui_input_capture.py) with a fake
sidecar that prints a fixed event script. Real time passes (a phase needs more than 2 s to show its old second timer).

Usage: tui_status_capture.py d05|d27 TUI_BINARY LABEL
"""
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tui_input_capture import HELLO, Term  # noqa: E402

SESSION = "session_20261112_143012_abcd1234"
FIRST = '{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"engineering/b0","mode":"review","git":{"branch":"main","dirty":0},"busy":false,"session":"%s","posture":{"mode":"review","sandbox":"off","trusted":true},"read_only":false,"context_tokens":0,"context_limit":65536,"endpoint_kind":"local"}' % SESSION
AFTER_TURN = FIRST.replace('"dirty":0', '"dirty":2').replace('"context_tokens":0', '"context_tokens":11381')
BUSY = AFTER_TURN.replace('"busy":false', '"busy":true')


def script(*lines):
    out = ["printf '%%s\\n' '%s'" % HELLO]
    out += ["printf '%%s\\n' '%s'" % line for line in lines]
    out.append('while IFS= read -r line; do printf "%s\\n" "$line" >> "$LOG"; done')
    return "\n".join(out) + "\n"


def open_term(binary, body, cols, rows):
    t = Term(binary, body, tempfile.mktemp(), False, cols=cols, rows=rows)
    t.wait("NEXUS", 10)
    t.pump(0.6)
    return t


def d05(binary, label):
    out = [f"# D-05 capture, binary: {label}", "", "Row 1 of the screen (the status bar) after the first frame and after the first turn.", ""]
    for cols, rows in ((160, 30), (100, 30), (80, 24), (50, 15)):
        for name, state in (("first frame (no changes yet, context 0)", FIRST), ("after the first turn (2 changed, 11381 of 65536 context)", AFTER_TURN)):
            t = open_term(binary, script(state), cols, rows)
            out.append(f"{cols}x{rows}  {name}")
            out.append("  |" + t.lines()[0].rstrip() + "|")
            t.finish()
        out.append("")
    return out


def d27(binary, label):
    out = [f"# D-27 capture, binary: {label}", "", "Status bar (row 1) and the busy line, 3.5 s into each phase of a turn.", ""]
    clock = re.compile(r"\d+:\d\d")
    phases = [
        ("inference", ""),
        ("tool", ',"tool":"run_command","subject":"make test"'),
        ("approval", ',"tool":"write_file","subject":"x.txt"'),
        ("provider_wait", ""),
        ("verifying", ',"tool":"npm test"'),
        ("compacting", ""),
    ]
    for phase, extra in phases:
        activity = '{"v":1,"type":"activity","turn_id":"t1","phase":"%s","step":2,"segment":1%s}' % (phase, extra)
        t = open_term(binary, script(BUSY, activity), 100, 30)
        t.pump(3.5)
        lines = t.lines()
        busy = next((l.strip() for l in lines if "esc cancels" in l or "your approval" in l), "(no busy line found)")
        status = lines[0].rstrip()
        out.append(f"{phase:14} busy line: |{busy}|  clocks in it: {len(clock.findall(busy))}; clocks in status bar: {len(clock.findall(status))}")
        t.finish()
    return out


if __name__ == "__main__":
    which, binary, label = sys.argv[1:4]
    print("\n".join({"d05": d05, "d27": d27}[which](binary, label)))
