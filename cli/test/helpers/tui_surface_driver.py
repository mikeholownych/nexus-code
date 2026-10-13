#!/usr/bin/env python3
"""Drives the real `nexus-tui --live` (with the real sidecar) through the whole interface, not only diffs: startup,
streamed Markdown, slow inference, tool success and failure, large command output, an edit, steering, a multi-line
paste, an approval in review mode (with buffered keys), cancellation, compaction, a verification failure, incomplete
requirements, scroll preservation while output arrives, slash completion and help, narrow and short windows with
resizing during work, a sidecar crash and restart, and resuming the saved session.

It captures named screens (cells with colours, rendered to PNG by render_screens.py) and prints a JSON summary; the
node test (tui_surface_e2e.test.ts) owns the mock gateway and asserts on the summary and the sidecar logs.

Usage: tui_surface_driver.py PLAN.json
"""
import json
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tui_diff_driver import DiffSession, has  # noqa: E402
from tui_pty_driver import T0, count_events, pty_env, wait_events  # noqa: E402


def children(pid):
    try:
        out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout
        return [int(p) for p in out.split()]
    except Exception:
        return []


def main():
    plan = json.load(open(sys.argv[1]))
    env = pty_env(plan["env"])
    events = plan["env"]["NEXUS_RECORD_EVENTS"]
    cast, shots, result = [], [], {}
    argv = [plan["tui"], "--live", "--sidecar", plan["recorder"], "--node", plan["node"], "--"] + plan["sidecar_args"]
    turns = lambda: count_events(events, "turn.result")  # noqa: E731

    def shot(session, name):
        shots.append(session.color.snapshot(name))
        result.setdefault("screens", {})[name] = session.color.lines()

    s = DiffSession(argv, env, 120, 36, cast)
    s.wait_text("enter send", 30)
    s.pump(0.4)
    shot(s, "01-startup")

    # Streamed Markdown; scroll back while it streams, then return.
    s.send("Explain the plan for the cache layer.\r", settle=0.1)
    s.wait_screen(lambda lines: has(lines, "Cache layer plan"), 15, "streamed heading")
    s.pump(0.6)
    shot(s, "02-streaming")
    wait_events(events, "turn.result", 1, 30, s)
    s.wait_idle()
    s.pump(0.3)
    shot(s, "03-markdown-final")

    # Slow inference, then tools: read, failed read, large command output, an edit; steering while busy.
    s.send("Inspect the repository and add the cache module.\r", settle=0.1)
    s.pump(1.2)
    shot(s, "04-slow-inference")
    s.send("prefer an LRU policy\r", settle=0.2)
    s.pump(0.3)
    shot(s, "05-steering-queued")
    # Scroll back while output keeps arriving.
    s.send("\x1b[5~", settle=0.3)
    before_scroll = s.color.lines()[1:-3]
    wait_events(events, "tool.end", 3, 30, s)
    s.pump(0.5)
    result["scroll_kept"] = s.color.lines()[1:-3] == before_scroll
    shot(s, "06-scrolled-back-new-output")
    s.send("\x1b[6~" * 8, settle=0.3)
    wait_events(events, "turn.result", 2, 60, s)
    s.wait_idle()
    s.pump(0.3)
    shot(s, "07-tools-final")

    # A multi-line paste, inspected, then sent.
    s.send("\x1b[200~line one of the note\r\n\tindented line ✓ 字\r\nline three\x1b[201~", settle=0.4)
    shot(s, "08-paste-buffer")
    s.send("\x0f", settle=0.4)  # ctrl+o
    shot(s, "09-paste-view")
    s.send("\x1b", settle=0.3)
    s.send("\r", settle=0.2)
    wait_events(events, "turn.result", 3, 30, s)
    s.wait_idle()

    # Review mode: an approval; keys typed just before it opens must not answer it.
    s.send("/mode review\r", settle=0.5)
    s.send("Write the config file.\r", settle=0.05)
    s.send("yyy", settle=0.05)
    s.wait_screen(lambda lines: has(lines, "Approval needed"), 20, "the approval modal")
    s.pump(0.9)  # a pause in typing before the deliberate decision
    shot(s, "10-approval")
    result["approval_survived_buffered_keys"] = has(s.color.lines(), "Approval needed")
    # Keys were typed just before it opened, so its letters are not answers: → selects Approve, Enter confirms.
    result["letters_disarmed_hint"] = any("typing ignored" in l for l in s.color.lines())
    s.send("\x1b[C", settle=2.2)  # on a typed-into panel the choice stays on screen 2 s before Enter takes it
    s.send("\r", settle=0.4)
    wait_events(events, "turn.result", 4, 30, s)
    s.wait_idle()
    result["draft_after_approval"] = s.color.lines()[-1]
    s.send("\x0c", settle=0.2)  # the buffered keys stayed in the draft: clear it
    s.send("/mode auto\r", settle=0.5)

    # Cancellation during a slow step.
    s.send("Take a long time on this.\r", settle=0.1)
    s.pump(1.5)
    s.send("\x1b", settle=0.1)
    wait_events(events, "turn.result", 5, 30, s)
    s.wait_idle()
    s.pump(0.3)
    shot(s, "11-cancelled")

    # Compaction.
    s.send("/compact\r", settle=0.3)
    s.wait_screen(lambda lines: has(lines, "ompact"), 20, "compaction output")
    s.pump(0.6)
    s.wait_idle()
    shot(s, "12-compacted")

    # Incomplete requirements (numbered list typed with shift-less newlines via alt+enter).
    s.send("Do these:\x1b\r1. add a README section\x1b\r2. add a changelog entry", settle=0.3)
    s.send("\r", settle=0.2)
    wait_events(events, "turn.result", 6, 60, s)
    s.wait_idle()
    s.pump(0.4)
    shot(s, "14-requirements-incomplete")
    # Start a new objective, as an operator would before unrelated work.
    s.send("/requirements clear\r", settle=0.3)
    s.wait_screen(lambda lines: has(lines, "/requirements clear"), 10, "the clear command")
    s.pump(0.6)
    s.wait_idle()

    # A verification failure: an edit, then the repository's failing test command.
    s.send("Fix the parser bug.\r", settle=0.2)
    wait_events(events, "turn.result", 7, 120, s)
    s.wait_idle()
    s.pump(0.4)
    shot(s, "13-verification-failed")

    # Slash completion and help, with a draft kept.
    s.send("/re", settle=0.4)
    shot(s, "15-completion")
    s.send("\x1b", settle=0.2)
    s.send("\x0c", settle=0.2)  # ctrl+l clears the draft
    s.send("a draft I am keeping", settle=0.2)
    s.send("\t", settle=0.2)  # transcript focus
    s.send("[", settle=0.3)
    shot(s, "16-transcript-focus")
    s.send("\r", settle=0.6)
    shot(s, "17-entry-review")
    # From the edit's review, `i` opens the call record itself (tool, arguments, output).
    s.send("i", settle=0.2)
    s.wait_screen(lambda lines: has(lines, "Tool call") and not has(lines, "Loading the recorded call"), 10, "the tool detail panel")
    shot(s, "17b-tool-detail")
    s.send("\x1b", settle=0.3)
    s.send("\t", settle=0.2)
    s.send("\x1b", settle=0.2)
    s.send("\x15", settle=0.1)  # ctrl+u: clear the line so ? opens help
    s.send("?", settle=0.4)
    shot(s, "18-help")
    s.send("\x1b", settle=0.3)

    # Narrow and short windows; resize while a turn streams.
    s.set_size(60, 24)
    s.pump(0.5)
    shot(s, "19-narrow")
    s.set_size(80, 12)
    s.pump(0.5)
    shot(s, "20-short")
    s.set_size(120, 36)
    s.pump(0.4)
    s.send("Stream another answer.\r", settle=0.1)
    s.pump(0.6)
    s.set_size(64, 24)
    s.pump(0.5)
    shot(s, "21-resize-during-stream")
    s.set_size(120, 36)
    wait_events(events, "turn.result", 8, 30, s)
    s.wait_idle()
    s.pump(0.3)

    # Idle: nothing redrawn.
    before = len(s.raw)
    s.pump(2.0)
    result["idle_bytes"] = len(s.raw) - before

    # The sidecar dies: the crash screen, then restart.
    s.send("a draft before the crash", settle=0.2)
    for child in children(s.pid):
        os.kill(child, signal.SIGKILL)
    s.wait_screen(lambda lines: has(lines, "stopped"), 15, "the crash screen")
    s.pump(0.5)
    shot(s, "22-crashed")
    s.send("r", settle=0.3)
    # Wait on the current screen, not the output history (which still holds the hint from before the crash).
    s.wait_screen(lambda lines: has(lines, "enter send"), 30, "the restarted agent's idle hint")
    s.pump(0.5)
    shot(s, "23-restarted")
    # The recovery the crash screen names: /resume reloads the saved conversation in the new agent.
    s.send("\x0c", settle=0.2)
    s.send("/resume\r", settle=0.3)
    s.wait_screen(lambda lines: has(lines, "Resumed session"), 20, "the resumed conversation after restart")
    s.pump(0.5)
    shot(s, "23b-restart-then-resume")
    s.send("\x03", settle=0.1)
    s.send("\x03", settle=0.1)
    result["first_exit"] = s.wait_exit(20)

    # Resume the saved session.
    cast.append([round(time.monotonic() - T0, 4), "m", "new TUI process: resume the saved session (-r latest)"])
    r = DiffSession(argv + ["-r", "latest"], env, 120, 36, cast)
    r.wait_screen(lambda lines: has(lines, "Resumed session"), 30, "the resume notice")
    r.wait_idle()
    r.pump(0.4)
    shot(r, "24-resumed")
    r.send("\x03", settle=0.1)
    result["second_exit"] = r.wait_exit(20)

    times = [frame[0] for frame in cast]
    result["recording"] = {"frames": len(cast), "monotonic": all(b >= a for a, b in zip(times, times[1:])), "duration_s": times[-1] if times else 0}
    result["raw_has_file_escape"] = "\x1b]52;" in (s.raw + r.raw).decode("utf-8", "replace")
    with open(plan["cast"], "w") as f:
        f.write(json.dumps({"version": 2, "width": 120, "height": 36, "timestamp": int(time.time()), "env": {"TERM": env.get("TERM", "")}}) + "\n")
        for frame in cast:
            f.write(json.dumps(frame) + "\n")
    with open(plan["screens"], "w") as f:
        json.dump(shots, f)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
