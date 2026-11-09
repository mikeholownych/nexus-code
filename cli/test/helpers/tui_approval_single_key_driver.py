#!/usr/bin/env python3
"""Typing with ordinary thinking pauses across an approval panel's appearance (independent re-acceptance P1).

In review mode the operator starts typing a steering message; the approval appears ~1.2 s in. They keep typing at
120 ms per key with 800 ms pauses, then press Enter. Nothing of that may decide. Then a deliberate Esc denies.
Prints a JSON summary; tui_approval_input_e2e.test.ts asserts on it and on the sidecar's command log.

Usage: tui_approval_typing_driver.py PLAN.json
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tui_diff_driver import DiffSession, has  # noqa: E402
from tui_pty_driver import count_events, pty_env, wait_events  # noqa: E402


def decisions(path):
    try:
        with open(path) as f:
            return [json.loads(line)["type"] for line in f if '"type":"approve"' in line or '"type":"deny"' in line]
    except FileNotFoundError:
        return []


def main():
    plan = json.load(open(sys.argv[1]))
    env = pty_env(plan["env"])
    events, commands = plan["env"]["NEXUS_RECORD_EVENTS"], plan["env"]["NEXUS_RECORD_COMMANDS"]
    argv = [plan["tui"], "--live", "--sidecar", plan["recorder"], "--node", plan["node"], "--"] + plan["sidecar_args"]
    s = DiffSession(argv, env, 100, 30, None)
    s.wait_text("enter send", 30)
    s.pump(0.3)
    s.send("Write the first file.\r", settle=0.1)
    keys = [(c, 0.12) for c in "please make sure you "] + [("a", 0.8)] + [(c, 0.12) for c in "dd tests"] + [("\r", 0.8)]
    shown_during = False
    for ch, before in keys:
        s.pump(before)
        shown_during = shown_during or has(s.color.lines(), "Approval needed")
        s.send(ch, settle=0.0)
    s.pump(1.5)
    result = {
        "approval_arrived": count_events(events, "approval.request") >= 1,
        "panel_seen_while_typing": shown_during,
        "after_typing": {"decisions": decisions(commands), "panel_open": has(s.color.lines(), "Approval needed")},
        "hint": next((l for l in s.color.lines() if "typing ignored" in l), ""),
    }
    # Composer editing habits after a pause (re-acceptance round 3): cursor keys then Enter, Ctrl+A then Enter.
    s.pump(0.8)
    s.send("\x1b[C", settle=0.08)
    s.send("\x1b[C", settle=0.08)
    s.send("\r", settle=0.6)
    s.pump(0.8)
    s.send("\x01", settle=0.7)
    s.send("\r", settle=0.6)
    # Round 4: the same with thinking pauses: → → (0.6 s) Enter (0.6 s) Enter.
    s.pump(0.8)
    s.send("\x1b[C", settle=0.1)
    s.send("\x1b[C", settle=0.6)
    s.send("\r", settle=0.6)
    s.send("\r", settle=0.6)
    result["after_editing_keys"] = {"decisions": decisions(commands), "panel_open": has(s.color.lines(), "Approval needed")}
    s.pump(0.8)
    s.send("\x1b", settle=0.6)
    result["after_esc"] = decisions(commands)
    wait_events(events, "turn.result", 1, 30, s)
    s.wait_idle()
    s.send("\x03", settle=0.1)
    result["exit"] = s.wait_exit(20)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
