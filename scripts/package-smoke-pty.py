#!/usr/bin/env python3
"""Run a command inside a pseudo-terminal (PTY) with standard dimensions, capture output, and exit cleanly."""
import os
import sys
import pty
import select
import fcntl
import termios
import struct
import time
import signal
import re

if len(sys.argv) < 2:
    print("usage: package-smoke-pty.py COMMAND [ARGS...]", file=sys.stderr)
    sys.exit(2)

cmd = sys.argv[1:]

master, slave = pty.openpty()
# Set standard 80x24 window size so terminal layouts render properly in headless environments
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)

os.close(slave)
out = b""
start = time.time()
while time.time() - start < 15:
    r, _, _ = select.select([master], [], [], 0.1)
    if master in r:
        try:
            chunk = os.read(master, 4096)
            if not chunk:
                break
            out += chunk
            clean = re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", out)
            if re.search(rb"ask Nexus|enter send", clean):
                break
        except OSError:
            break

try:
    os.killpg(pid, signal.SIGTERM)
except ProcessLookupError:
    pass

try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", out.decode("utf-8", "ignore"))
sys.stdout.write(clean)
sys.stdout.flush()
