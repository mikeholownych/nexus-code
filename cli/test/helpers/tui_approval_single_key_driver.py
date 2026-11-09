#!/usr/bin/env python3
"""One key answers an approval (WP-1317 D-01): in review mode the model proposes two writes back to back; each panel
is answered by a single `y` pressed shortly after it appears, with no arrow, pause or second key. Prints a JSON summary
with the panel's text before the first `y`; tui_approval_input_e2e.test.ts asserts on it and on the sidecar's command
log.

Usage: tui_approval_single_key_driver.py PLAN.json
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tui_diff_driver import DiffSession, has  # noqa: E402
from tui_pty_driver import pty_env, wait_events  # noqa: E402


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
    s.send("Write the two files.\r", settle=0.1)
    wait_events(events, "approval.request", 1, 20, s)
    s.wait_screen(lambda lines: has(lines, "Approval needed"), 10, "the first approval panel")
    s.pump(0.4)
    result = {"panel": [line for line in s.color.lines() if line.strip()]}
    s.send("y", settle=0.5)
    result["after_first_y"] = decisions(commands)
    wait_events(events, "approval.request", 2, 20, s)
    s.wait_screen(lambda lines: has(lines, "Approval needed"), 10, "the second approval panel")
    s.pump(0.4)
    s.send("y", settle=0.5)
    result["after_second_y"] = decisions(commands)
    wait_events(events, "turn.result", 1, 30, s)
    s.wait_idle()
    result["transcript"] = s.color.lines()
    s.send("\x03", settle=0.1)
    result["exit"] = s.wait_exit(20)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
