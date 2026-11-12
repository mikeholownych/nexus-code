#!/usr/bin/env python3
"""Captures for TUI audit defects D-12, D-13 and D-21, through a real pseudo-terminal.

  D-12 / D-13: the real `nexus-tui --live` binary, fed by a fake sidecar (a shell script) that sends the events the
               real TypeScript sidecar sends. D-13's approval request carries the review the real `approvalReview`
               returns (run with tsx), for the "before" side the `approval_review.ts` of the integration branch.
  D-21:        the real `promptWorkspaceTrust` (tsx) in a pty of 100, 60 and 40 columns, "before" being the
               `startup_trust.ts` of the integration branch.

Usage: tui_polish_capture.py D-12|D-13|D-21 before|after TUI_BINARY BASE_REF
(BASE_REF is the integration commit whose TypeScript is the "before"; the repo root is found from this file.)
"""
import fcntl
import json
import os
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, HERE)
from tui_input_capture import HELLO, STATE, Term  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "cli", "test", "helpers"))
from tui_pty_driver import Screen  # noqa: E402


def sh(events, after_command=None):
    """A sidecar script: hello, an idle-then-busy session, `events`, then (once the TUI sent a command) `after_command`."""
    lines = ["printf '%%s\\n' '%s'" % HELLO, "printf '%%s\\n' '%s'" % (STATE % "true")]
    lines += ["printf '%%s\\n' '%s'" % e for e in events]
    if after_command:
        lines += ['IFS= read -r line; printf "%s\\n" "$line" >> "$LOG"', "sleep 0.3"]
        lines += ["printf '%%s\\n' '%s'" % e for e in after_command]
    lines.append('while IFS= read -r line; do printf "%s\\n" "$line" >> "$LOG"; done')
    return "\n".join(lines) + "\n"


def j(**event):
    return json.dumps({"v": 1, **event}, separators=(",", ":")).replace("'", "'\\''")


def rows(term):
    out = [line.rstrip() for line in term.lines()]
    while out and not out[-1]:
        out.pop()
    return out


def write(out, name):
    print("\n".join(out))


def d12(side, binary, base):
    model = "Error: Execution was rejected by the user. Ask the user for clarification or proceed with an alternative approach."
    start = j(type="tool.start", turn_id="t1", call_id="c1", tool="delete_file", subject="base.txt", evidence="e1")
    ask = j(type="approval.request", id="approval-1", turn_id="t1", tool="delete_file", subject="base.txt", preview='{"path":"base.txt"}',
            review={"kind": "args", "text": '{\n  "path": "base.txt"\n}', "truncated": False})
    # The wait for the decision was 16.6 s in the audit. "before": what the integration branch's sidecar sent (the
    # model-facing sentence, no flag), whose duration the TUI shows. "after": what this branch's sidecar sends.
    if side == "before":
        end = j(type="tool.end", turn_id="t1", call_id="c1", tool="delete_file", success=False, summary=model, lines=1, evidence="e1", duration_ms=16600)
    else:
        end = j(type="tool.end", turn_id="t1", call_id="c1", tool="delete_file", success=False, summary="Denied by you", lines=1, evidence="e1", denied=True)
    out = [f"# D-12 {side}: deny a delete approval (the wait was 16.6 s), binary {binary}", ""]
    for cols in (100, 40):
        log = tempfile.mktemp()
        t = Term(binary, sh([start, ask], [end]), log, False, cols=cols, rows=24)
        t.wait("Approval needed")
        t.pump(1.5)
        t.send("n", 1.0)
        t.pump(0.5)
        out += [f"## {cols}x24 after pressing n", *rows(t), ""]
        t.finish()
    write(out, "d12")


def review_json(module, ws, args):
    script = f'import {{ approvalReview }} from "{module}"; console.log(JSON.stringify(approvalReview("delete_file", {json.dumps(args)}, {json.dumps(ws)})));'
    got = subprocess.run(["npx", "tsx", "-e", script], cwd=os.path.join(ROOT, "cli"), capture_output=True, text=True, check=True)
    return json.loads(got.stdout.strip().splitlines()[-1])


def d13(side, binary, base):
    ws = tempfile.mkdtemp(prefix="d13-ws-")
    os.makedirs(os.path.join(ws, "build", "sub"))
    for name, text in (("build/a.js", "const a = 1;\n"), ("build/b.js", "const b = 2;\n"), ("build/sub/c.js", "c\n"), ("notes.txt", "first line\nsecond line\nthird line\n")):
        with open(os.path.join(ws, name), "w") as f:
            f.write(text)
    os.symlink("/etc", os.path.join(ws, "build", "etc-link"))
    module = os.path.join(ROOT, "cli", "src", "approval_review.ts")
    before_copy = os.path.join(ROOT, "cli", "src", "_d13_before_approval_review.ts")
    try:
        if side == "before":
            source = subprocess.run(["git", "show", f"{base}:cli/src/approval_review.ts"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
            with open(before_copy, "w") as f:
                f.write(source)
            module = before_copy
        out = [f"# D-13 {side}: the approval for delete_file, binary {binary}", ""]
        for subject, args in (("notes.txt", {"path": "notes.txt"}), ("build", {"path": "build", "recursive": True})):
            review = review_json(module, ws, args)
            ask = j(type="approval.request", id="approval-1", turn_id="t1", tool="delete_file", subject=subject, preview=json.dumps(args), review=review)
            for cols, height in ((100, 26), (40, 30)):
                t = Term(binary, sh([ask]), tempfile.mktemp(), False, cols=cols, rows=height)
                t.wait("Approval needed")
                t.pump(1.0)
                out += [f"## delete {subject}, {cols}x{height}", *rows(t), ""]
                t.finish()
        print("\n".join(out))
    finally:
        if os.path.exists(before_copy):
            os.remove(before_copy)
        shutil.rmtree(ws, ignore_errors=True)


def d21(side, binary, base):
    parent = tempfile.mkdtemp(prefix="d21-")
    ws = os.path.join(parent, "an-example-project-with-a-fairly-long-directory-name")
    os.makedirs(ws)
    with open(os.path.join(ws, "AGENTS.md"), "w") as f:
        f.write("instructions\n")
    module = os.path.join(ROOT, "cli", "src", "startup_trust.ts")
    before_copy = os.path.join(ROOT, "cli", "src", "_d21_before_startup_trust.ts")
    try:
        if side == "before":
            source = subprocess.run(["git", "show", f"{base}:cli/src/startup_trust.ts"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
            with open(before_copy, "w") as f:
                f.write(source)
            module = before_copy
        demo = os.path.join(parent, "demo.mts")
        with open(demo, "w") as f:
            f.write(f'import {{ promptWorkspaceTrust }} from "{module}";\nconst d = await promptWorkspaceTrust(process.argv[2]);\nconsole.log("decision: " + d);\n')
        out = [f"# D-21 {side}: the trust prompt in a pty", ""]
        for cols in (100, 60, 40):
            screen = Screen(cols, 30)
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(os.path.join(ROOT, "cli"))
                env = {**os.environ, "TERM": "xterm-256color", "HOME": parent, "XDG_CONFIG_HOME": os.path.join(parent, ".config")}
                os.execvpe("npx", ["npx", "tsx", demo, ws], env)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, cols, 0, 0))
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline and not any("Trust" in line and "folder" in line for line in screen.lines()):
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        screen.feed(os.read(fd, 65536).decode("utf-8", "replace"))
                    except OSError:
                        break
            time.sleep(0.3)
            try:
                if select.select([fd], [], [], 0.2)[0]:
                    screen.feed(os.read(fd, 65536).decode("utf-8", "replace"))
            except OSError:
                pass
            lines = [line.rstrip() for line in screen.lines()]
            while lines and not lines[-1]:
                lines.pop()
            out += [f"## {cols}x30", *lines, ""]
            os.write(fd, b"\x1b")
            time.sleep(0.5)
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
        print("\n".join(out))
    finally:
        if os.path.exists(before_copy):
            os.remove(before_copy)
        shutil.rmtree(parent, ignore_errors=True)


if __name__ == "__main__":
    defect, side, binary, base = sys.argv[1:5]
    {"D-12": d12, "D-13": d13, "D-21": d21}[defect](side, binary, base)
