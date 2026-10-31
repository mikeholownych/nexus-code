import sys, os, time; sys.path.insert(0, "."); from ptylib import *
gw, ep, log = start_gw("slowstream", "s6n")
env, ws, home = make_env("s6n", ep, {"NO_COLOR": "1"})
s = Session(tui_argv(ws, ep), env, 40, 20, ws, "s6n")
try:
    s.wait("enter send", 15, "idle")
    s.send(b"talk slowly\r"); s.pump(3)
    s.type("also mention cats\r", gap=0.05); s.pump(1.5)
    t = time.monotonic(); s.send(b"\x03", label="Ctrl-C with queued steer")
    s.wait("enter send", 60, "idle"); print("ctrl-c -> idle secs", round(time.monotonic() - t, 2)); s.dump("idle")
    print("gw requests", len(gw_log(log)))
finally:
    s.close(); gw.terminate()
