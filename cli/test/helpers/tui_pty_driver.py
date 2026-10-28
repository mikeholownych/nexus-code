#!/usr/bin/env python3
"""Drives the real `nexus-tui --live` binary through a pseudo-terminal it controls (so it can resize the terminal and
read the process's CPU time), records the session as an asciicast v2 file, and prints a JSON summary of what it
measured. The node test (tui_maturity_e2e.test.ts) owns the mock gateway and asserts on this summary together with
the sidecar's command/event logs.

Usage: tui_pty_driver.py PLAN.json   (see the node test for the plan fields)
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

CSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]")
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


class Screen:
    """Just enough of a terminal to know what is visible: cursor positioning, erase, and text (SGR ignored)."""

    TOKEN = re.compile(r"\x1b\[([0-9;?<>=]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHM]|([\r\n\b])|([^\x1b\r\n\b]+)")

    def __init__(self, cols, rows):
        self.resize(cols, rows)

    def resize(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.row = self.col = 0

    def feed(self, text):
        for m in self.TOKEN.finditer(text):
            params, _, final, ctl, chars = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
            if final:
                nums = [int(n) if n.isdigit() else 0 for n in params.lstrip("?").split(";")] if params else []
                if final in "Hf":
                    self.row = max(0, min(self.rows - 1, (nums[0] if nums and nums[0] else 1) - 1))
                    self.col = max(0, min(self.cols - 1, (nums[1] if len(nums) > 1 and nums[1] else 1) - 1))
                elif final == "J" and (not nums or nums[0] in (2, 3)):
                    self.grid = [[" "] * self.cols for _ in range(self.rows)]
                elif final == "K":
                    mode = nums[0] if nums else 0
                    span = range(self.col, self.cols) if mode == 0 else range(0, self.col + 1) if mode == 1 else range(self.cols)
                    for c in span:
                        self.grid[self.row][c] = " "
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
                    if self.col < self.cols:
                        self.grid[self.row][self.col] = ch
                    self.col += 1

    def lines(self):
        return ["".join(row).rstrip() for row in self.grid]

    def text(self):
        return "\n".join(self.lines())


def clk_tck():
    return os.sysconf(os.sysconf_names["SC_CLK_TCK"])


def cpu_seconds(pid):
    with open(f"/proc/{pid}/stat") as f:
        fields = f.read().rsplit(")", 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / clk_tck()


# One clock for the whole recording: every terminal session's timestamps are offsets from the same start, so a
# resumed session continues the timeline instead of restarting at zero.
T0 = time.monotonic()


class Session:
    def __init__(self, argv, env, cols, rows, cast):
        self.cols, self.rows = cols, rows
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvpe(argv[0], argv, env)
        self.out = ""
        self.raw = b""
        self.start = T0
        self.cast = cast
        self.answered = 0
        self.screen = Screen(cols, rows)
        self.set_size(cols, rows, signal_child=False)

    def set_size(self, cols, rows, signal_child=True):
        self.cols, self.rows = cols, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        if hasattr(self, "screen"):
            self.screen.resize(cols, rows)
        if signal_child:
            os.kill(self.pid, signal.SIGWINCH)
        if self.cast is not None:
            self.cast.append([round(time.monotonic() - T0, 4), "r", f"{cols}x{rows}"])

    def pump(self, seconds):
        """Reads output for `seconds`; returns the bytes read. Answers terminal capability queries like a VT220."""
        deadline = time.monotonic() + seconds
        got = b""
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            ready, _, _ = select.select([self.fd], [], [], left)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            got += chunk
        if got:
            self.raw += got
            text = got.decode("utf-8", "replace")
            self.out += text
            self.screen.feed(text)
            if self.cast is not None:
                self.cast.append([round(time.monotonic() - self.start, 4), "o", text])
            queries = self.out.count("\x1b[c")
            while self.answered < queries:
                os.write(self.fd, b"\x1b[?62c")
                self.answered += 1
        return got

    def send(self, data, settle=0.15):
        if self.cast is not None:
            self.cast.append([round(time.monotonic() - self.start, 4), "i", data])
        os.write(self.fd, data.encode())
        self.pump(settle)

    def screen_text(self, since=0):
        return CSI.sub("", self.out[since:])

    def squeezed(self, since=0):
        """Screen text without whitespace: cells that did not change are skipped with cursor moves, not spaces."""
        return re.sub(r"\s", "", self.screen_text(since))

    def wait_text(self, text, timeout):
        deadline = time.monotonic() + timeout
        text = re.sub(r"\s", "", text)
        while text not in self.squeezed():
            if time.monotonic() > deadline:
                raise TimeoutError(f"never saw {text!r}; tail: {self.screen_text()[-1500:]!r}")
            self.pump(0.1)

    def wait_screen(self, text, timeout):
        deadline = time.monotonic() + timeout
        while text not in self.screen.text():
            if time.monotonic() > deadline:
                raise TimeoutError(f"never saw {text!r} on screen; screen: {self.screen.text()!r}")
            self.pump(0.05)

    def wait_idle(self, timeout=20):
        """Until the idle hint is on screen: the sidecar reported the turn over (typing earlier would steer)."""
        deadline = time.monotonic() + timeout
        while not any("enter send" in line for line in self.screen.lines()):
            if time.monotonic() > deadline:
                raise TimeoutError(f"never idle; screen: {self.screen.text()!r}")
            self.pump(0.05)

    def alive(self):
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            return pid == 0
        except ChildProcessError:
            return False

    def wait_exit(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(0.1)
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                return None
            if pid:
                return os.waitstatus_to_exitcode(status)
        return "timeout"


def tui_pid(session_pid):
    """The pty child execs nexus-tui directly, so its pid is the TUI's."""
    return session_pid


def count_events(path, kind):
    try:
        with open(path) as f:
            return sum(1 for line in f if f'"type":"{kind}"' in line)
    except FileNotFoundError:
        return 0


def wait_events(path, kind, count, timeout, session):
    deadline = time.monotonic() + timeout
    while count_events(path, kind) < count:
        if time.monotonic() > deadline:
            raise TimeoutError(f"expected {count} {kind} events; tail: {session.screen_text()[-1500:]!r}")
        session.pump(0.1)


# Colour choices inherited from the caller's shell (agent and CI shells often export NO_COLOR) would override the depth a
# scenario asks for; crossterm itself drops every colour when NO_COLOR is set.
COLOUR_OVERRIDES = ("NO_COLOR", "FORCE_COLOR", "NEXUS_COLOR")


def pty_env(plan_env):
    env = {k: v for k, v in os.environ.items() if k not in COLOUR_OVERRIDES}
    env.update(plan_env)
    return env


def main():
    plan = json.load(open(sys.argv[1]))
    env = pty_env(plan["env"])
    cast = []
    result = {"steps": []}
    events = plan["env"]["NEXUS_RECORD_EVENTS"]
    argv = [plan["tui"], "--live", "--sidecar", plan["recorder"], "--node", plan["node"], "--"] + plan["sidecar_args"]

    s = Session(argv, env, 120, 40, cast)
    s.wait_text("enter send", 30)
    s.pump(0.3)

    # 1. A slow inference step: the indicator animates with no model output arriving.
    s.send("Edit notes.txt, then write the batch files f4 to f34.\r", settle=0.1)
    mark = len(s.out)
    cpu0, t0 = cpu_seconds(s.pid), time.monotonic()
    s.wait_screen("thinking · 0:0", 5)
    # 2. Steering while the agent works (Enter while busy sends steering, not a second prompt).
    snapshot_a = s.screen.text()
    s.send("keep line 1 unchanged\r", settle=0.1)
    s.pump(0.6)
    snapshot_b = s.screen.text()
    s.pump(0.3)
    busy_cpu = (cpu_seconds(s.pid) - cpu0) / (time.monotonic() - t0)
    window = s.squeezed(mark)
    frames = sorted({c for c in window if c in SPINNER})
    result["slow_inference"] = {
        "spinner_frames_seen": frames,
        "thinking_shown": "thinking · 0:0" in snapshot_a,
        "elapsed_shown": bool(re.search(r"thinking · 0:0[1-9]", snapshot_b)),
        "busy_line": next((l for l in snapshot_b.split("\n") if "thinking" in l), ""),
        "status_line": snapshot_b.split("\n")[0],
        "busy_cpu_fraction": round(busy_cpu, 4),
        "steering_echoed": "↳keepline1unchanged" in window,
    }

    # 3. The long turn: edits (one failing), then more than 30 steps, continuing without the operator.
    # Normally ~20 s; generous so a host busy with other work does not fail the scenario (the test allows 240 s).
    wait_events(events, "turn.result", 1, 180, s)
    s.pump(0.5)
    whole = s.squeezed()
    result["long_turn"] = {
        "diff_shown": "Editednotes.txt+1−1" in whole,
        "diff_lines_shown": "−line2" in whole and "+linetwo" in whole,
        "failed_edit_marked": "×" in whole,
        "steering_applied_shown": "steering·applied" in whole,
        "segment_2_shown": "segment2" in whole,
    }

    # 4. Idle: no redraws and next to no CPU while nothing happens.
    s.pump(0.5)
    before = len(s.raw)
    cpu0, t0 = cpu_seconds(s.pid), time.monotonic()
    s.pump(3.0)
    result["idle"] = {
        "bytes_written": len(s.raw) - before,
        "cpu_fraction": round((cpu_seconds(s.pid) - cpu0) / (time.monotonic() - t0), 4),
    }

    # 5. Resize: narrower, then back; the frame is redrawn each time and the TUI keeps running.
    redraws = []
    composer_rows = []
    for cols, rows in [(70, 24), (120, 40)]:
        before = len(s.raw)
        s.set_size(cols, rows)
        s.pump(0.6)
        redraws.append(len(s.raw) - before)
        composer_rows.append(any("enter send" in line for line in s.screen.lines()))
    result["resize"] = {"redraw_bytes": redraws, "alive": s.alive(), "hint_visible_after_each": composer_rows, "last_frame_rows": len(s.screen.lines())}

    s.wait_idle()
    # 6. A multi-line bracketed paste: one buffer, shown compactly, submitted exactly; "/exit" inside is data.
    mark = len(s.out)
    s.send("\x1b[200~first line\r\n/exit\r\n  indented ünïcødé\x1b[201~", settle=0.4)
    result["paste"] = {"label_shown": "[Pastedtext#1:3lines]" in s.squeezed(mark)}
    s.send("\r", settle=0.2)
    wait_events(events, "turn.result", 2, 30, s)
    result["paste"]["alive_after"] = s.alive()
    s.wait_idle()

    # 7. Cancellation during a slow step: Esc cancels; the indicator stops.
    s.send("take your time\r", settle=0.1)
    s.pump(1.5)
    # Resize while busy: the animated frame keeps going at the new size.
    s.set_size(90, 30)
    s.pump(0.5)
    result["resize_busy"] = any("thinking" in line for line in s.screen.lines())
    s.set_size(120, 40)
    s.pump(0.3)
    s.send("\x1b", settle=0.1)
    wait_events(events, "turn.result", 3, 30, s)
    s.pump(0.6)
    before = len(s.raw)
    s.pump(1.5)
    result["cancel"] = {"bytes_after_settle": len(s.raw) - before, "idle_hint_back": any("enter send" in line for line in s.screen.lines())}

    # 8. Quit cleanly (ctrl-c on an idle, empty composer), then resume the saved session in a new TUI.
    s.send("\x03", settle=0.1)
    result["first_exit"] = s.wait_exit(20)
    cast.append([round(time.monotonic() - T0, 4), "m", "second TUI process: resume the saved session (-r latest)"])
    r = Session(argv + ["-r", "latest"], env, 100, 30, cast)
    r.wait_text("Resumed session", 30)
    r.wait_idle()
    r.send("are you still there?\r", settle=0.2)
    wait_events(events, "turn.result", 4, 30, r)
    r.pump(0.3)
    r.send("\x03", settle=0.1)
    result["second_exit"] = r.wait_exit(20)
    result["resumed_shown"] = "Resumedsession" in r.squeezed()

    times = [frame[0] for frame in cast]
    result["recording"] = {
        "frames": len(cast),
        "duration_s": times[-1] if times else 0,
        "monotonic": all(b >= a for a, b in zip(times, times[1:])),
        "sessions": 2,
    }
    with open(plan["cast"], "w") as f:
        f.write(json.dumps({"version": 2, "width": 120, "height": 40, "timestamp": int(time.time()), "title": "Nexus TUI maturity fixes (PTY e2e)", "env": {"TERM": "xterm-256color"}}) + "\n")
        for frame in cast:
            if frame[1] == "r":
                f.write(json.dumps(frame) + "\n")
            else:
                f.write(json.dumps(frame, ensure_ascii=False) + "\n")
    with open(plan["transcript"], "w") as f:
        f.write(CSI.sub("", s.out + "\n\n===== resumed session =====\n\n" + r.out))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
