import sys, os, time, subprocess; sys.path.insert(0, "."); from ptylib import *
def procs():
    return subprocess.run("ps -eo pid,ppid,etimes,args | grep -E '/var/tmp/nexus-rc10-install-home.*(sleep 23.7|harness-core|sidecar.js|nexus-tui)' | grep -v grep | grep -v ps", shell=True, capture_output=True, text=True).stdout.strip()
gw, ep, log = start_gw("slowtool", "s9")
env, ws, home = make_env("s9", ep)
s = Session(tui_argv(ws, ep, extra=["--yes"]), env, 100, 30, ws, "s9")
try:
    s.wait("enter send", 15, "idle")
    s.send(b"run it\r"); s.wait("sleep 23.7", 10, "tool-running"); s.pump(1.5)
    print("tui pid", s.pid); print("before:\n" + procs())
    s.send(b"\x03", label="Ctrl-C"); s.pump(0.5); s.send(b"\x03", label="Ctrl-C again -> quit"); s.pump(6)
    print("tui alive:", s.alive()); print("after quit +6s:\n" + procs())
finally:
    s.close(); gw.terminate()
