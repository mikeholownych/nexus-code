import sys, os, time; sys.path.insert(0, "."); from ptylib import *
gw, ep, log = start_gw("write", "r1d")
env, ws, home = make_env("r1d", ep)
s = Session(["node", INDEX, "repl", "--approve", "-w", ws, "-e", ep, "-m", "m"], env, 100, 30, ws, "r1d")
try:
    s.wait("❯", 20, "prompt")
    s.send(b"create hello.txt\r", settle=0.5)
    s.send(b"y", label="'y' typed mid-turn (e.g. answering the model) before approval prompt", settle=1.6)
    print("prompt visible before Enter:", "[Y/n/d/a]" in s.text())
    s.send(b"\r", label="Enter"); s.pump(6); s.dump("after")
    print("D file:", os.path.exists(ws + "/hello.txt"))
finally:
    s.close(); gw.terminate()
