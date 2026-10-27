import sys, os, time; sys.path.insert(0, "."); from ptylib import *
gw, ep, log = start_gw("slowstream", "s5_retry_rc10")
env, ws, home = make_env("s5_retry_rc10", ep)
s = Session(tui_argv(ws, ep), env, 100, 30, ws, "s5_retry_rc10")
try:
    s.wait("enter send", 15, "idle")
    s.send(b"talk slowly\r"); s.pump(3)
    t = time.monotonic(); s.send(b"\x03", label="Ctrl-C mid-stream")
    n0 = s.text().count("Thinking")
    s.pump(2); s.dump("2s-after-ctrl-c")
    ok = s.wait("enter send", 45, "idle-after-ctrl-c"); print("ctrl-c -> idle secs", round(time.monotonic() - t, 2)); s.dump("idle-after-ctrl-c")
finally:
    s.close(); gw.terminate()
