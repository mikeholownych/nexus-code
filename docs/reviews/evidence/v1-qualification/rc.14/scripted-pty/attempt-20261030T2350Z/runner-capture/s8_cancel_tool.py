import sys, os, time, subprocess; sys.path.insert(0, "."); from ptylib import *
def procs():
    return subprocess.run("ps -eo pid,ppid,etimes,args | grep 'sleep 23.7' | grep -v grep", shell=True, capture_output=True, text=True).stdout.strip()
gw, ep, log = start_gw("slowtool", "s8")
env, ws, home = make_env("s8", ep)
s = Session(tui_argv(ws, ep), env, 100, 30, ws, "s8")
try:
    s.wait("enter send", 15, "idle")
    s.send(b"run it\r"); s.wait("sleep 23.7", 10, "tool-running"); s.pump(1.5)
    print("before Esc:\n" + procs())
    t = time.monotonic(); s.send(b"\x1b", label="Esc during tool"); s.pump(3); s.dump("3s-after-esc")
    print("3s after Esc:\n" + procs())
    s.send(b"\x03", label="Ctrl-C (second request: quit)"); s.pump(5)
    print("alive after 2nd ctrl-c:", s.alive()); print("after quit:\n" + procs())
    time.sleep(3); print("8s after quit:\n" + procs())
finally:
    s.close(); gw.terminate()
