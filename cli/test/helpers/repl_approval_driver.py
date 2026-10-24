#!/usr/bin/env python3
"""Approval input safety driver for the REPL (ACC-SAFE-03).
Runs node repl in a pseudo-terminal (PTY) and tests:
1. Lone Enter at approval prompt -> DENIED
2. Keystrokes typed ahead before approval prompt -> DISCARDED / DENIED
3. Paste within the 400ms grace window -> DISCARDED / DENIED
4. Deliberate 'y' after 500ms grace window -> APPROVED
5. Always allow ('a') requires explicit 'all' confirmation; unconfirmed cancels, confirmed enables auto-mode.

Usage: repl_approval_driver.py PLAN.json
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


class ReplSession:
    def __init__(self, argv, env, cwd, cols=100, rows=30):
        self.cols, self.rows = cols, rows
        self.pid, self.fd = pty.fork()
        self.reaped = False
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        self.out = ""
        self.raw = b""
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, seconds=0.2):
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
            self.out += got.decode("utf-8", "replace")
        return got

    def clean_text(self):
        return CSI.sub("", self.out)

    def wait_text(self, text, timeout=25):
        deadline = time.monotonic() + timeout
        while text not in self.clean_text():
            if time.monotonic() > deadline:
                raise TimeoutError(f"never saw {text!r}; clean text:\n{self.clean_text()[-1000:]}")
            self.pump(0.05)

    def send(self, data: bytes, settle=0.1):
        os.write(self.fd, data)
        if settle > 0:
            self.pump(settle)

    def close(self):
        try:
            # pty.fork makes the child a session/process-group leader. Stop the
            # whole REPL tree so a sidecar cannot keep writing session state
            # while the parent test removes its temporary HOME.
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

            if not self._wait_for_group_exit(10.0):
                try:
                    os.killpg(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if not self._wait_for_group_exit(5.0):
                    raise RuntimeError(f"REPL process group {self.pid} did not exit after SIGKILL")
        finally:
            try:
                os.close(self.fd)
            except OSError:
                pass

    def _wait_for_group_exit(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            if not self.reaped:
                try:
                    pid, _ = os.waitpid(self.pid, os.WNOHANG)
                    self.reaped = pid == self.pid
                except ChildProcessError:
                    self.reaped = True

            group_alive = False
            try:
                os.killpg(self.pid, 0)
                group_alive = True
            except ProcessLookupError:
                pass
            except PermissionError:
                group_alive = True

            if self.reaped and not group_alive:
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)


def main():
    if len(sys.argv) < 2:
        print("Usage: repl_approval_driver.py PLAN.json", file=sys.stderr)
        sys.exit(1)

    plan = json.load(open(sys.argv[1]))
    argv = [plan["node"], plan["index"]] + plan["args"]
    env = {
        **os.environ,
        **plan.get("env", {}),
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "C.UTF-8",
    }
    ws = plan["ws"]
    scenario = plan.get("scenario", "lone_enter")

    s = ReplSession(argv, env, ws)
    result = {}

    try:
        s.wait_text("❯", timeout=25)

        if scenario == "lone_enter":
            s.send(b"create lone_enter.txt\r", settle=0.3)
            s.wait_text("[y/N/d/a]", timeout=20)
            # Lone Enter at prompt
            s.send(b"\r", settle=2.5)
            created = os.path.exists(os.path.join(ws, "lone_enter.txt"))
            result = {
                "scenario": scenario,
                "file_created": created,
                "passed": not created,
            }

        elif scenario == "typed_ahead":
            s.send(b"create typed_ahead.txt\r", settle=0.2)
            # Send 'y\r' mid-turn while model is processing, before approval prompt appears
            s.send(b"y\r", settle=0.4)
            s.wait_text("[y/N/d/a]", timeout=20)
            # The typed ahead 'y\r' must have been cleared / discarded; send Enter
            s.send(b"\r", settle=2.5)
            created = os.path.exists(os.path.join(ws, "typed_ahead.txt"))
            result = {
                "scenario": scenario,
                "file_created": created,
                "passed": not created,
            }

        elif scenario == "paste":
            s.send(b"create paste.txt\r", settle=0.3)
            s.wait_text("[y/N/d/a]", timeout=20)
            # Immediately send burst / paste during grace window (<400ms)
            s.send(b"y\r", settle=1.2)
            created_during_grace = os.path.exists(os.path.join(ws, "paste.txt"))
            # Settle and deny with 'n'
            s.send(b"n\r", settle=2.0)
            created_after_deny = os.path.exists(os.path.join(ws, "paste.txt"))
            result = {
                "scenario": scenario,
                "created_during_grace": created_during_grace,
                "created_after_deny": created_after_deny,
                "passed": not created_during_grace and not created_after_deny,
            }

        elif scenario == "deliberate":
            s.send(b"create deliberate.txt\r", settle=0.3)
            s.wait_text("[y/N/d/a]", timeout=20)
            # Wait 600ms (> 400ms grace window)
            time.sleep(0.6)
            s.send(b"y\r", settle=2.5)
            created = os.path.exists(os.path.join(ws, "deliberate.txt"))
            result = {
                "scenario": scenario,
                "file_created": created,
                "passed": created,
            }

        elif scenario == "confirm_a":
            s.send(b"create auto1.txt\r", settle=0.3)
            s.wait_text("[y/N/d/a]", timeout=20)
            time.sleep(0.6)
            s.send(b"a\r", settle=0.3)
            s.wait_text("Type 'all' to confirm", timeout=15)
            time.sleep(0.6)
            # Send 'no' to cancel
            s.send(b"no\r", settle=1.0)
            s.wait_text("cancelled", timeout=15)
            auto1_cancelled = not os.path.exists(os.path.join(ws, "auto1.txt"))

            # Approval prompt appears again
            s.wait_text("[y/N/d/a]", timeout=15)
            time.sleep(0.6)
            s.send(b"a\r", settle=0.3)
            s.wait_text("Type 'all' to confirm", timeout=15)
            time.sleep(0.6)
            s.send(b"all\r", settle=1.0)
            s.wait_text("Finished handling auto1.txt", timeout=20)
            auto1_created = os.path.exists(os.path.join(ws, "auto1.txt"))

            # Next action should now auto-approve without prompt
            time.sleep(0.5)
            s.send(b"create auto2.txt\r", settle=1.0)
            s.wait_text("Finished handling auto2.txt", timeout=20)
            auto2_created = os.path.exists(os.path.join(ws, "auto2.txt"))

            result = {
                "scenario": scenario,
                "auto1_cancelled": auto1_cancelled,
                "auto1_created": auto1_created,
                "auto2_created": auto2_created,
                "passed": auto1_cancelled and auto1_created and auto2_created,
            }

        elif scenario == "readonly_slash":
            # A mode change is allowed but must not unlock direct slash scaffolding.
            s.send(b"/mode auto\r", settle=1.0)
            s.wait_text("❯", timeout=15)
            s.send(b"/skill init leaked\r", settle=1.5)
            s.wait_text("❯", timeout=15)
            skill_created = os.path.exists(os.path.join(ws, ".nexus", "skills", "leaked", "SKILL.md"))
            s.send(b"/init\r", settle=1.5)
            s.wait_text("❯", timeout=15)
            agents_created = os.path.exists(os.path.join(ws, "AGENTS.md"))
            result = {
                "scenario": scenario,
                "skill_created": skill_created,
                "agents_created": agents_created,
                "passed": not skill_created and not agents_created,
            }

        else:
            raise ValueError(f"Unknown scenario: {scenario}")

    finally:
        s.close()

    print(json.dumps(result))


if __name__ == "__main__":
    main()
