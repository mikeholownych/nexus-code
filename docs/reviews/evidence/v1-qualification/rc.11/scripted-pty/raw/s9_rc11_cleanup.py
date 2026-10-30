import sys, os, time, subprocess; sys.path.insert(0, "."); from ptylib import *
def procs(pgid):
    raw = subprocess.run(['ps', '-eo', 'pid=,pgid=,args='], capture_output=True, text=True, check=True).stdout
    return '\n'.join(line.strip() for line in raw.splitlines() if len(line.split(None, 2)) == 3 and line.split(None, 2)[1] == str(pgid))
gw, ep, log = start_gw("slowtool", "s9")
env, ws, home = make_env("s9", ep)
s = Session(tui_argv(ws, ep, extra=["--yes"]), env, 100, 30, ws, "s9")
try:
    s.wait("enter send", 15, "idle")
    s.send(b"run it\r"); s.wait("sleep 23.7", 10, "tool-running"); s.pump(1.5)
    pgid = s.pid  # pty.fork creates a new session/process group for the TUI tree.
    print("tui pid", s.pid); print("before:\n" + procs(pgid))
    s.send(b"\x03", label="Ctrl-C"); s.pump(0.5); s.send(b"\x03", label="Ctrl-C again -> quit"); s.pump(6)
    alive = s.alive()
    deadline = time.monotonic() + 5
    survivors = procs(pgid)
    while survivors and time.monotonic() < deadline:
        time.sleep(0.1); survivors = procs(pgid)
    print("tui alive:", alive); print("after quit +6s:\n" + survivors)
    assert not alive, "TUI did not exit after second Ctrl-C"
    assert not survivors, "process group survived tool quit: " + survivors
finally:
    s.close(); gw.terminate()
