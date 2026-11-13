#!/usr/bin/env python3
"""Captures for TUI audit defects D-16 (OSC 52 clipboard write), D-17 (colour depth), D-19 (stopped-sidecar draft) and D-24 (markdown nits).

Same pattern as tui_input_capture.py: a real `nexus-tui --live` in a pseudo-terminal with a fake shell sidecar.

Usage: tui_polish_capture_g3.py D-16|D-17|D-19|D-24 TUI_BINARY LABEL
"""
import os
import re
import signal
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tui_input_capture import Term, sidecar, tool  # noqa: E402

MD = (
    "## Plan\\n\\nThe **cache** sits in `Loader`.\\n\\n```ts\\nexport class Cache {\\n\\tget(key: string) { return this.map.get(key); }\\n}\\n```\\n\\n"
    "### Notes\\n\\n- one\\n- two"
)
DELTA = '{"v":1,"type":"assistant.delta","turn_id":"t1","text":"%s"}' % MD
RESULT = '{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN COMPLETED","line":"Done","turn":{"execution":"COMPLETED","outcome":"VERIFIED"},"model_summary":null}'
CRASH = "kill -9 $$"


def sgr(raw):
    return re.findall(r"\x1b\[[0-9;]*m", raw.decode("utf-8", "replace"))


COPY = '{"v":1,"type":"slash.result","id":"s1","command":"copy","success":true,"output":"No clipboard tool was found, so Nexus asked your terminal to copy the last reply.","clipboard":"hello \\u001b]0;owned\\u0007 clip"}'


def sgr_kinds(seq):
    """What colour kinds one SGR sequence uses: '256' for 38;5;n / 48;5;n, 'rgb' for 38;2;r;g;b, 'basic' for 30-37 etc."""
    nums = [int(n) if n.isdigit() else 0 for n in seq[2:-1].split(";")]
    kinds, i = [], 0
    while i < len(nums):
        n = nums[i]
        if n in (38, 48) and i + 1 < len(nums):
            if nums[i + 1] == 5:
                kinds.append("256")
                i += 3
                continue
            if nums[i + 1] == 2:
                kinds.append("rgb")
                i += 5
                continue
        if 30 <= n <= 37 or 90 <= n <= 97 or 40 <= n <= 47 or 100 <= n <= 107:
            kinds.append("basic")
        i += 1
    return kinds


def d16(binary, label):
    out = [f"# D-16 capture, binary: {label}", "", "A fake sidecar answers a /copy that found no clipboard tool (`slash.result` with a `clipboard` field).", ""]
    for name, env in (("default", {}), ("NEXUS_OSC52=off", {"NEXUS_OSC52": "off"}), ("TERM=xterm, no COLORTERM (16-colour writer)", {"TERM": "xterm", "COLORTERM": ""})):
        t = Term(binary, sidecar(COPY), "/dev/null", False, env)
        t.wait("enter send")
        t.pump(1.0)
        found = re.findall(rb"\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)", t.raw)
        out.append(f"## {name}")
        out.append(f"   OSC 52 requests written to the terminal: {[f.decode() for f in found]}")
        out.append(f"   raw ESC ] 0 ; (title) sequences written: {t.raw.count(b'\x1b]0;')}")
        out += ["   screen: " + l.strip() for l in t.lines() if l.strip() and ("clipboard" in l or "terminal" in l)]
        t.finish()
        out.append("")
    return out


def d17(binary, label):
    out = [f"# D-17 capture, binary: {label}", "", "Raw SGR sequences the program wrote for the same screen (a tool card, a markdown reply with a code block).", ""]
    for name, env in (
        ("TERM=xterm (no COLORTERM)", {"TERM": "xterm", "COLORTERM": ""}),
        ("TERM=linux (the Linux console)", {"TERM": "linux", "COLORTERM": ""}),
        ("TERM=xterm-256color", {"TERM": "xterm-256color", "COLORTERM": ""}),
        ("TERM=xterm NO_COLOR=1", {"TERM": "xterm", "COLORTERM": "", "NO_COLOR": "1"}),
    ):
        t = Term(binary, sidecar(tool(1), DELTA, RESULT), "/dev/null", False, env)
        t.wait("enter send")
        t.pump(1.0)
        seqs = sgr(t.raw)
        distinct = sorted(set(seqs))
        kinds = [k for seq in seqs for k in sgr_kinds(seq)]
        out.append(f"## {name}: {len(seqs)} SGR sequences, {len(distinct)} distinct")
        out.append("   distinct: " + " ".join(repr(s[2:]) for s in distinct))
        out.append(f"   256-colour `38;5;n`/`48;5;n`: {any(k == '256' for k in kinds)}; 24-bit `38;2;`/`48;2;`: {any(k == 'rgb' for k in kinds)}; basic colour codes 30-37/90-97/40-47/100-107: {any(k == 'basic' for k in kinds)}")
        t.finish()
        out.append("")
    return out


def d19(binary, label):
    out = [f"# D-19 capture, binary: {label}", ""]
    # The first sidecar kills itself; the one started by the restart behaves (so the restart is visible).
    mark = tempfile.mktemp()
    dead = sidecar().replace("while IFS=", f'if [ ! -e "{mark}" ]; then touch "{mark}"; {CRASH}; fi\nwhile IFS=', 1)
    t = Term(binary, dead, "/dev/null", False)
    t.wait("agent sidecar stopped")
    t.pump(0.5)
    out.append("## the stopped-sidecar screen")
    out += [l for l in t.lines() if l.strip()]
    for step, keys in (("typed `hello`", "hello"), ("then typed ` r and q` (r and q inside a draft)", " r and q")):
        t.send(keys)
        out.append(f"## after {step}")
        out += [l for l in t.lines()[-4:] if l.strip()]
    t.send("\x12" if "after" in label else "")  # ctrl+r
    t.pump(1.5)
    out.append("## after ctrl+r (restart; the new sidecar stays up)")
    out += [l for l in t.lines() if l.strip()]
    t.finish()
    return out


def d24(binary, label):
    out = [f"# D-24 capture, binary: {label}", ""]
    for name, env in (("colour (TERM=xterm-256color)", {"COLORTERM": ""}), ("NO_COLOR=1", {"NO_COLOR": "1", "COLORTERM": ""})):
        for cols in (100, 40):
            t = Term(binary, sidecar(DELTA, RESULT), "/dev/null", False, env, cols=cols, rows=30)
            t.wait("send")
            t.pump(0.8)
            out.append(f"## {name}, {cols} columns")
            out += [l.rstrip() for l in t.lines() if l.strip()]
            out.append("")
            t.finish()
    return out


if __name__ == "__main__":
    which, binary, label = sys.argv[1:4]
    print("\n".join({"D-16": d16, "D-17": d17, "D-19": d19, "D-24": d24}[which](binary, label)))
