#!/usr/bin/env python3
"""Drive the actual `nexus` and `nexus repl` launchers through trust and permission decisions."""
import json
import os
import sys
import time

from repl_approval_driver import ReplSession


def pids_with_argv_token(token):
    if not os.path.isdir("/proc"):
        raise AssertionError("host /proc is unavailable; cannot verify verifier child cleanup")
    matches = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(os.path.join("/proc", name, "cmdline"), "rb") as cmdline:
                argv = [item.decode("utf-8", errors="replace") for item in cmdline.read().split(b"\0") if item]
            with open(os.path.join("/proc", name, "comm"), "rb") as comm:
                process_name = comm.read().strip()
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError as error:
            raise AssertionError(f"cannot inspect host process {name}; child cleanup is unverified") from error
        if argv[:2] == [token, "30"] and process_name == b"sleep":
            matches.append(int(name))
    return matches


def main():
    plan = json.load(open(sys.argv[1], encoding="utf-8"))
    argv = [plan["node"], plan["index"]] + plan["args"]
    env = {
        **os.environ,
        "HOME": plan["home"],
        "XDG_CONFIG_HOME": os.path.join(plan["home"], ".config"),
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "C.UTF-8",
        "NEXUS_DEBUG": "0",
    }
    session = ReplSession(argv, env, plan["cwd"])
    result = {"surface": plan["surface"], "trusted": plan["trusted"], "mode": plan["mode"]}
    try:
        if not plan["trusted"]:
            session.wait_text("Trust this folder?", timeout=20)
            # Explicitly continue without adding this workspace to the trust store.
            session.send(b"\x1b[B\r", settle=0.5)

        ready = "enter send" if plan["surface"] == "tui" else "❯"
        session.wait_text(ready, timeout=30)
        if plan.get("kind") == "verifier":
            session.send(b"/test\r", settle=0.2)
            if plan["mode"] != "auto":
                session.wait_text("Approval needed", timeout=20)
                result["approvalPrompt"] = True
                visible = "".join(session.clean_text().split())
                if "npmtest" not in visible or "nodetest.js" not in visible:
                    raise AssertionError(f"verifier approval did not show the command and script body: {session.clean_text()[-2000:]}")
                if os.path.exists(os.path.join(plan["cwd"], "started")):
                    raise AssertionError("verifier began before approval")
                # Select Approve after recent typing has disarmed letter shortcuts, then confirm twice.
                session.pump(2.5)  # Let the panel render and settle before its navigation keys arrive.
                session.send(b"\x1b[D", settle=2.2)
                session.send(b"\r", settle=0.6)
                session.send(b"\r", settle=0.2)
                if plan.get("cancel"):
                    deadline = time.monotonic() + 15
                    started = os.path.join(plan["cwd"], "started")
                    while not os.path.exists(started) and time.monotonic() < deadline:
                        session.pump(0.05)
                    if not os.path.exists(started):
                        raise AssertionError("approved verifier did not start")
                    spawn_error = os.path.join(plan["cwd"], "spawn-error")
                    if os.path.exists(spawn_error):
                        raise AssertionError(f"verifier child failed to spawn: {open(spawn_error, encoding='utf-8').read()}")
                    canary_deadline = time.monotonic() + 3
                    canary_pids = []
                    while not canary_pids and time.monotonic() < canary_deadline:
                        canary_pids = pids_with_argv_token(plan["canary"])
                        if not canary_pids:
                            session.pump(0.05)
                    if not canary_pids:
                        raise AssertionError("unique verifier child was not observable in host /proc before cancellation")
                    if "Testsuitefailed." in session.clean_text():
                        raise AssertionError("verifier had already failed before Escape was sent")
                    result["canaryVisibleBeforeCancel"] = True
                    cancelled_at = time.monotonic()
                    session.send(b"\x1b", settle=0.1)
                    session.wait_text("Testsuitefailed.", timeout=5)
                    result["cancelSeconds"] = time.monotonic() - cancelled_at
                else:
                    session.wait_text("Testsuitepassed.", timeout=30)
            else:
                result["approvalPrompt"] = False
                session.wait_text("Testsuitepassed.", timeout=30)
            print(json.dumps(result))
            return

        session.send(b"Run the requested command now\r", settle=0.2)

        if plan["mode"] != "auto":
            prompt = "Approval needed" if plan["surface"] == "tui" else "[y/N/d/a]"
            session.wait_text(prompt, timeout=30)
            result["approvalPrompt"] = True
            time.sleep(0.65)
            # The live TUI's Escape and the REPL's n are explicit denials.
            session.send(b"\x1b" if plan["surface"] == "tui" else b"n\r", settle=0.4)
        else:
            result["approvalPrompt"] = False

        session.wait_text("COMMAND_FINISHED", timeout=60)
        print(json.dumps(result))
    finally:
        session.close()


if __name__ == "__main__":
    main()
