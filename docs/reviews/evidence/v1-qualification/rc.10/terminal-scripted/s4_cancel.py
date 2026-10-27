import sys, os, time, re; sys.path.insert(0, "."); from ptylib import *
# A: Ctrl-C mid-stream, then steering while streaming, Esc
gw, ep, log = start_gw("slowstream", "s4a")
env, ws, home = make_env("s4a", ep, {"NO_COLOR": "1"})
s = Session(tui_argv(ws, ep), env, 40, 20, ws, "s4a")
try:
    s.wait("enter send", 15, "idle"); s.dump("idle-40x20-nocolor")
    s.send(b"talk slowly\r"); s.pump(3); s.dump("streaming")
    s.type("also mention cats\r", gap=0.05); s.pump(1.5); s.dump("after-steer")
    s.send(b"\x03", label="Ctrl-C"); s.pump(3); s.dump("after-ctrl-c")
    s.send(b"again\r"); s.pump(2); s.send(b"\x1b", label="Esc"); s.pump(3); s.dump("after-esc")
    print("alive", s.alive())
    sgr = re.findall(rb"\x1b\[[0-9;]*m", s.raw)
    colors = [x for x in set(sgr) if re.search(rb"(3[0-9]|4[0-9]|9[0-7]|10[0-7]|38;|48;)", x)]
    print("SGR codes:", len(sgr), "color SGRs:", colors[:10])
finally:
    s.close(); gw.terminate()
# B: Esc during a running tool (auto mode)
gw, ep, log = start_gw("slowtool", "s4b")
env, ws, home = make_env("s4b", ep)
s = Session(tui_argv(ws, ep, extra=["--yes"]), env, 100, 30, ws, "s4b")
try:
    s.wait("enter send", 15, "idle")
    s.send(b"run it\r"); s.wait("sleep 23.7", 15, "tool-running"); s.pump(1.5); s.dump("tool-running")
    t = time.monotonic(); s.send(b"\x1b", label="Esc during tool")
    s.wait("enter send", 30, "idle-after-esc"); print("esc->idle secs", round(time.monotonic() - t, 2)); s.dump("after-esc-tool")
    os.system("pgrep -af 'sleep 23.7' | grep -v pgrep || echo no-leftover-sleep")
finally:
    s.close(); gw.terminate()
