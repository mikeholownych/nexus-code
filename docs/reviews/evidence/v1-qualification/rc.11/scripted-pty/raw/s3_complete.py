import sys, os, time; sys.path.insert(0, "."); from ptylib import *
gw, ep, log = start_gw("write", "s3")
env, ws, home = make_env("s3", ep)
s = Session(tui_argv(ws, ep, approve=True), env, 80, 24, ws, "s3")
try:
    s.wait("enter send", 15, "idle")
    s.send(b"create hello.txt"); s.pump(0.3); s.send(b"\r")
    s.wait("Approval needed", 10, "panel"); s.pump(2.5); s.dump("panel-letters")
    s.send(b"y", label="y"); s.pump(0.5)
    print("file:", os.path.exists(ws + "/hello.txt"))
    ok = s.wait("enter send", 60, "idle-after-turn"); s.dump("after-turn")
    print("gw requests:", len(gw_log(log)))
finally:
    s.close(); gw.terminate()
