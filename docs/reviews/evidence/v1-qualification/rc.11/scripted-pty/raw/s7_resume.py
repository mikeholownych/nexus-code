import sys, os, time; sys.path.insert(0, "."); from ptylib import *
gw, ep, log = start_gw("unicode", "s7")
env, ws, home = make_env("s7", ep)
s = Session(tui_argv(ws, ep), env, 40, 20, ws, "s7a")
try:
    s.wait("enter send", 15, "idle")
    s.send("remember the word 宽字符 please\r".encode()); s.wait("enter send", 20, "turn-done"); s.dump("unicode-40x20")
    s.resize(100, 30); s.pump(1); s.dump("unicode-100x30")
    s.send(b"/quit\r"); s.pump(4); print("alive after /quit", s.alive())
finally:
    s.close()
s = Session(tui_argv(ws, ep, extra=["-r"]), env, 100, 30, ws, "s7b")
try:
    s.wait("enter send", 15, "idle"); s.pump(1); s.dump("resumed-start")
    s.send(b"/sessions\r"); s.pump(3); s.dump("sessions")
    s.send(b"\x03"); s.pump(3); print("alive after idle Ctrl-C", s.alive())
finally:
    s.close(); gw.terminate()
