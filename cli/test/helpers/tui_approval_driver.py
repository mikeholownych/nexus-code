#!/usr/bin/env python3
"""Approval input safety in the real `nexus-tui --live` (review mode, real sidecar). Prints a JSON summary of which
inputs reached the sidecar as decisions; the node test (tui_approval_input_e2e.test.ts) asserts on it and on the
sidecar's command log.

1. Queued input: the TUI is frozen (SIGSTOP) while the approval request arrives and `y⏎` is typed; it is resumed
   after the grace period has passed. The queued keys must not decide.
2. A burst `yyy` typed at once, long after the panel appeared, must not decide.
3. A bracketed paste of `y⏎` must not decide.
4. After keys were typed into that panel, `n` is text; Esc denies. The next approval appears to an operator who is
   not typing, and one deliberate `y` approves it.
5. Typing that continues across the third panel's appearance never decides, nor does `n` after a pause; Esc denies.

Usage: tui_approval_driver.py PLAN.json
"""
import json
import os
import signal
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tui_diff_driver import DiffSession, has  # noqa: E402
from tui_pty_driver import count_events, wait_events  # noqa: E402


def decisions(path):
    try:
        with open(path) as f:
            return [json.loads(line)["type"] for line in f if '"type":"approve"' in line or '"type":"deny"' in line]
    except FileNotFoundError:
        return []


def main():
    plan = json.load(open(sys.argv[1]))
    env = dict(os.environ, **plan["env"])
    events, commands = plan["env"]["NEXUS_RECORD_EVENTS"], plan["env"]["NEXUS_RECORD_COMMANDS"]
    argv = [plan["tui"], "--live", "--sidecar", plan["recorder"], "--node", plan["node"], "--"] + plan["sidecar_args"]
    result = {}
    s = DiffSession(argv, env, 100, 30, None)
    s.wait_text("enter send", 30)
    s.pump(0.3)

    # 1. Freeze the TUI, let the approval arrive and type into the frozen terminal, resume after the grace period.
    s.send("Write the first file.\r", settle=0.2)
    os.kill(s.pid, signal.SIGSTOP)
    deadline = time.monotonic() + 20
    while count_events(events, "approval.request") < 1 and time.monotonic() < deadline:
        time.sleep(0.05)
    result["approval_arrived_while_frozen"] = count_events(events, "approval.request") >= 1
    os.write(s.fd, b"y\r")
    time.sleep(1.2)
    os.kill(s.pid, signal.SIGCONT)
    s.wait_screen(lambda lines: has(lines, "Approval needed"), 10, "the approval panel")
    s.pump(1.0)
    result["after_queued_keys"] = {"decisions": decisions(commands), "panel_open": has(s.color.lines(), "Approval needed")}

    # 2. A burst long after the panel appeared.
    s.send("yyy", settle=0.8)
    result["after_burst"] = {"decisions": decisions(commands), "panel_open": has(s.color.lines(), "Approval needed")}

    # 3. A bracketed paste.
    s.send("\x1b[200~y\r\x1b[201~", settle=0.8)
    result["after_paste"] = {"decisions": decisions(commands), "panel_open": has(s.color.lines(), "Approval needed")}

    # 4. Keys were typed into this panel (the burst), so its letters are not answers: Esc denies. The pause lets the
    # next approval appear to an operator who is not typing, where one deliberate `y` approves.
    s.send("n", settle=0.3)
    result["n_after_typing"] = decisions(commands)
    s.pump(2.2)
    s.send("\x1b", settle=0.5)
    result["after_deny"] = decisions(commands)
    wait_events(events, "approval.request", 2, 20, s)
    s.wait_screen(lambda lines: has(lines, "Approval needed"), 10, "the second approval panel")
    s.pump(0.8)
    s.send("y", settle=0.5)
    result["after_approve"] = decisions(commands)

    # 5. Typing that continues across the third approval panel's appearance never decides.
    typed = "please add tests and then run them now"
    for ch in typed:
        s.send(ch, settle=0.1)
    s.pump(0.2)
    result["after_typing_across"] = {"decisions": decisions(commands), "panel_open": has(s.color.lines(), "Approval needed")}
    s.pump(1.0)
    s.send("n", settle=0.5)
    result["n_after_typing_across"] = decisions(commands)
    s.send("\x1b", settle=0.5)
    result["after_typing_then_deny"] = decisions(commands)
    wait_events(events, "turn.result", 1, 30, s)
    s.wait_idle()
    result["transcript"] = s.color.lines()
    s.send("\x03", settle=0.1)
    result["exit"] = s.wait_exit(20)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
