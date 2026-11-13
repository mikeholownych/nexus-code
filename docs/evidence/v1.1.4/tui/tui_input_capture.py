#!/usr/bin/env python3
"""Captures for TUI audit defects D-09 (newline key per terminal) and D-10 (mouse).

Drives a real `nexus-tui --live` binary through a pseudo-terminal (the Screen class of
cli/test/helpers/tui_pty_driver.py reads what is on screen) with a fake sidecar, a shell script that logs every
command the TUI sends it. The pty can play two kinds of terminal: one that answers the kitty keyboard-protocol query
(`kitty`) and one that does not (`plain`, as tmux without extended keys or most terminals).

Usage: tui_input_capture.py D-09|D-10 TUI_BINARY LABEL
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "cli", "test", "helpers"))
from tui_pty_driver import Screen  # noqa: E402

HELLO = '{"v":1,"type":"hello","protocol":1,"pid":1}'
STATE = '{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"review","git":null,"busy":%s}'
APPROVAL = '{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}","review":{"kind":"change","path":"x.txt","before":null,"after":"hi\\n","created":true,"truncated":false}}'


def tool(i):
    return (
        '{"v":1,"type":"tool.start","turn_id":"t1","call_id":"c%d","tool":"read_file","subject":"file%02d.ts","evidence":"ev%d"}\n'
        '{"v":1,"type":"tool.end","turn_id":"t1","call_id":"c%d","tool":"read_file","success":true,"summary":"ok","lines":1,"evidence":"ev%d"}'
    ) % (i, i, i, i, i)


class Term:
    def __init__(self, binary, script_body, log, kitty, env_extra=None, cols=100, rows=30, shell_tail=False):
        self.cols, self.rows, self.kitty = cols, rows, kitty
        self.screen = Screen(cols, rows)
        self.raw = b""
        sidecar = tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False)
        sidecar.write(script_body)
        sidecar.close()
        env = {k: v for k, v in os.environ.items() if not k.startswith("NEXUS_")}
        env.update({"TERM": "xterm-256color", "LOG": log})
        env.update(env_extra or {})
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            if shell_tail:
                # The shell that started the TUI reads whatever input is left once it exits.
                tail = '"$0" --live --node sh --sidecar "$1"; read -t 1 -n 300 -r left; printf "LEFTOVER=[%s]\\n" "$left" | cat -v'
                os.execvpe("bash", ["bash", "-c", tail, binary, sidecar.name], env)
            os.execvpe(binary, [binary, "--live", "--node", "sh", "--sidecar", sidecar.name], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.answered = 0

    def pump(self, seconds):
        deadline = time.monotonic() + seconds
        while (left := deadline - time.monotonic()) > 0:
            ready, _, _ = select.select([self.fd], [], [], left)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.raw += chunk
            self.screen.feed(chunk.decode("utf-8", "replace"))
            # Capability queries: the kitty keyboard query is `CSI ? u` followed by a primary device attributes
            # request `CSI c`. A kitty-protocol terminal answers both (flags first); any other answers only the latter.
            text = self.raw.decode("utf-8", "replace")
            while self.answered < text.count("\x1b[c"):
                os.write(self.fd, (b"\x1b[?0u" if self.kitty else b"") + b"\x1b[?62c")
                self.answered += 1

    def send(self, data, settle=0.25):
        os.write(self.fd, data.encode())
        self.pump(settle)

    def lines(self):
        return [line for line in self.screen.lines()]

    def wait(self, text, timeout=8):
        deadline = time.monotonic() + timeout
        while not any(text in line for line in self.lines()):
            if time.monotonic() > deadline:
                raise TimeoutError(f"never saw {text!r}:\n" + "\n".join(self.lines()))
            self.pump(0.05)

    def modes(self, start=0):
        """The terminal modes the process switched, in order: `?1000h` is mouse reporting on, `?1000l` off."""
        found = re.findall(r"\x1b\[\?(100[0-6]|2004|1049)([hl])|\x1b\[(<1u|>1u|\?u)", self.raw[start:].decode("utf-8", "replace"))
        return [f"{a}{b}" if a else c for a, b, c in found]

    def finish(self):
        self.pump(0.3)
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        end = time.monotonic() + 8
        while time.monotonic() < end:
            self.pump(0.1)
            try:
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    break
            except ChildProcessError:
                break


def sidecar(*events, hold=True):
    # printf, not echo: some shells' echo expands the `\\n` inside a JSON string
    lines = ["printf '%%s\\n' '%s'" % HELLO, "printf '%%s\\n' '%s'" % (STATE % "false")]
    lines += ["printf '%%s\\n' '%s'" % e for e in events]
    lines.append('while IFS= read -r line; do printf "%s\\n" "$line" >> "$LOG"; done')
    return "\n".join(lines) + "\n"


def sent(log):
    try:
        return [line for line in open(log).read().splitlines() if line]
    except FileNotFoundError:
        return []


def show(out, title, term, region=None):
    out.append(f"--- {title}")
    lines = term.lines()
    for line in (lines[region[0]:region[1]] if region else lines):
        out.append(line)


def footer(term):
    return [line for line in term.lines() if "newline" in line or "ask Nexus" in line]


def draft(term):
    """The composer: the rows under the footer hint line."""
    lines = term.lines()
    at = next((i for i, l in enumerate(lines) if "newline" in l and "enter send" in l), None)
    return [l.strip() for l in lines[at + 1:] if l.strip()] if at is not None else []


def prompts(log):
    return [line for line in sent(log) if '"prompt.submit"' in line]


def text_of(line):
    m = re.search(r'"text":"((?:[^"\\]|\\.)*)"', line)
    return m.group(1) if m else line


def d09(binary, label):
    out = [f"# D-09 capture, binary: {label}", ""]
    for kitty in (True, False):
        name = "terminal that answers the kitty keyboard query" if kitty else "terminal that does not (tmux without extended keys, most others)"
        out += [f"## {name}", ""]
        log = tempfile.mktemp()
        t = Term(binary, sidecar(), log, kitty)
        t.wait("enter send")
        out.append("footer: " + " | ".join(s.strip() for s in footer(t)))
        t.send("?")
        help_rows = [l.strip() for l in t.lines() if "new line" in l or "shift+enter" in l or "sends a plain" in l or "would send" in l]
        out.append("help rows about newline: " + " | ".join(help_rows))
        t.send("\x1b")
        if kitty:
            t.send("first")
            t.send("\x1b[13;2u")  # Shift+Enter as a kitty-protocol terminal sends it
            t.send("second")
            out.append(f"`first`, Shift+Enter (ESC[13;2u), `second`: draft = {draft(t)}; prompts sent: {len(prompts(log))}")
            t.send("\x0c")  # ctrl+l clears the draft
        t.send("a")
        t.send("\x1b\r")  # Alt+Enter
        t.send("b")
        t.send("\n")  # Ctrl+J (LF)
        t.send("c")
        out.append(f"`a`, Alt+Enter, `b`, Ctrl+J, `c`: draft = {draft(t)}; prompts sent: {len(prompts(log))}")
        t.send("\r")
        t.pump(0.5)
        out.append(f"after Enter, the sidecar received: {[text_of(p) for p in prompts(log)]}")
        t.finish()
        out.append("")
        # A terminal that cannot report Shift+Enter sends plain CR for it: that submits, so it must not be advertised.
        if not kitty:
            log = tempfile.mktemp()
            t = Term(binary, sidecar(), log, kitty)
            t.wait("enter send")
            t.send("half a prompt")
            t.send("\r")  # what Shift+Enter is on such a terminal
            t.pump(0.5)
            out.append(f"Shift+Enter on this terminal is a plain CR; the sidecar received: {[text_of(p) for p in prompts(log)]}")
            out.append("(the footer above is what tells the user not to rely on it)")
            t.finish()
            out.append("")
    return out


def d10(binary, label):
    out = [f"# D-10 capture, binary: {label}", ""]
    events = [tool(i) for i in range(40)]
    # startup and exit bytes, mouse on (default) and off
    for env_extra, name in (({}, "default"), ({"NEXUS_TUI_MOUSE": "off"}, "NEXUS_TUI_MOUSE=off")):
        log = tempfile.mktemp()
        t = Term(binary, sidecar(), log, False, env_extra)
        t.wait("enter send")
        start = t.modes()
        t.send("\x03")  # ctrl+c on an idle, empty composer quits
        t.pump(1.0)
        out.append(f"## terminal modes written ({name}), in order, whole run to a normal quit: {t.modes()}")
        t.finish()
        out.append(f"   (start {start}; at exit the rest)")
        log = tempfile.mktemp()
        t = Term(binary, sidecar(), log, False, env_extra)
        t.wait("enter send")
        before = len(t.raw)
        os.kill(t.pid, signal.SIGTERM)
        t.pump(2.0)
        out.append(f"## SIGTERM ({name}): modes written after the signal: {t.modes(before)}")
        t.finish()
        out.append("")
    # wheel and click on a transcript
    log = tempfile.mktemp()
    t = Term(binary, sidecar(*events), log, False)
    t.wait("file39.ts")
    t.send("\x1b[<64;20;10M\x1b[<64;20;10M\x1b[<64;20;10M")  # three wheel-up notches (SGR report)
    t.pump(0.4)
    show(out, "## after three wheel-up notches (ESC[<64;20;10M x3)", t, (0, 30))
    t.send("\x1b[<65;20;10M" * 10)
    t.pump(0.4)
    row = next((i for i, l in enumerate(t.lines()) if "file37.ts" in l), None)
    out.append(f"--- after ten wheel-down notches the newest card is on row {row}")
    t.send(f"\x1b[<0;12;{row + 1}M\x1b[<0;12;{row + 1}m" if row is not None else "")
    show(out, f"## after a left click on row {row} (ESC[<0;12;{row + 1}M / m)", t, (0, 30))
    t.finish()
    out.append("")
    # wheel reports flooding in while quitting must not reach the shell that started the TUI
    log = tempfile.mktemp()
    t = Term(binary, sidecar(), log, False, shell_tail=True)
    t.wait("enter send")
    t.send("\x03", 0.0)
    for _ in range(60):
        t.send("\x1b[<64;20;10M" * 3, 0.004)
    t.pump(2.5)
    left = re.search(r"LEFTOVER=\[(.*?)\]", t.raw.decode("utf-8", "replace"))
    out.append(f"## 180 wheel reports sent over ~0.4 s while quitting; what the parent shell then read as typed input: {left.group(1) if left else 'no shell output seen'!r}")
    t.finish()
    out.append("")
    # approvals are keyboard-only
    log = tempfile.mktemp()
    t = Term(binary, sidecar(*events[:6], APPROVAL), log, False)
    t.wait("Approval needed")
    t.pump(1.5)
    rows = t.lines()
    buttons = next(i for i, l in enumerate(rows) if "Approve" in l and "Deny" in l)
    cols = [m.start() for m in re.finditer("Approve|Deny", rows[buttons])]
    for col in cols + [cols[0] + 2, cols[-1] + 1]:
        t.send(f"\x1b[<0;{col + 1};{buttons + 1}M\x1b[<0;{col + 1};{buttons + 1}m", 0.2)
    t.send("\x1b[<64;20;10M\x1b[<65;20;10M\x1b[<2;20;10M\x1b[<2;20;10m", 0.2)
    t.pump(1.0)
    still = any("Approval needed" in l for l in t.lines())
    out.append(f"## clicks on the Approve and Deny buttons (row {buttons}, columns {cols}) plus wheel and right-click")
    out.append(f"approval panel still on screen: {still}; decisions sent to the sidecar: {[l for l in sent(log) if 'approve' in l or 'deny' in l] or 'none'}")
    t.send("n")
    t.pump(1.0)
    out.append(f"then the keyboard `n` (after the guard): decisions sent: {[l[:60] for l in sent(log) if 'approve' in l or 'deny' in l] or 'none (guard still holding or not yet read)'}")
    t.finish()
    return out


if __name__ == "__main__":
    which, binary, label = sys.argv[1:4]
    print("\n".join({"D-09": d09, "D-10": d10}[which](binary, label)))
