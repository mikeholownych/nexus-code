import sys, os, time; sys.path.insert(0, "."); from ptylib import *
# A: lone Enter at approval prompt
gw, ep, log = start_gw("write", "r1a")
env, ws, home = make_env("r1a", ep)
s = Session(["node", INDEX, "repl", "--approve", "-w", ws, "-e", ep, "-m", "m"], env, 100, 30, ws, "r1a")
try:
    s.wait("❯", 20, "prompt"); s.dump("repl-start")
    s.send(b"create hello.txt\r"); s.wait("[Y/n/d/a]", 15, "approval-prompt"); s.dump("approval")
    s.send(b"\r", label="lone Enter"); s.pump(6); s.dump("after-enter")
    print("A file after lone Enter:", os.path.exists(ws + "/hello.txt"))
finally:
    s.close(); gw.terminate()
# B: user types a multi-line message during the turn; the blank line lands on the approval prompt
gw, ep, log = start_gw("write", "r1b")
env, ws, home = make_env("r1b", ep)
s = Session(["node", INDEX, "repl", "--approve", "-w", ws, "-e", ep, "-m", "m"], env, 100, 30, ws, "r1b")
try:
    s.wait("❯", 20, "prompt")
    s.send(b"create hello.txt\r", settle=0.3)
    s.type("wait, actually call it greeting.txt\r\r", gap=0.1, label="typing during turn: text, Enter, Enter")
    s.wait("[Y/n/d/a]", 15, "approval-prompt"); s.pump(1)
    s.send(b"\r", label="Enter (user thinks it's a newline)"); s.pump(6); s.dump("after")
    print("B file:", os.path.exists(ws + "/hello.txt"))
finally:
    s.close(); gw.terminate()
# C: paste with blank lines arriving at the approval prompt (no bracketed paste)
gw, ep, log = start_gw("write", "r1c")
env, ws, home = make_env("r1c", ep)
s = Session(["node", INDEX, "repl", "--approve", "-w", ws, "-e", ep, "-m", "m"], env, 100, 30, ws, "r1c")
try:
    s.wait("❯", 20, "prompt")
    s.send(b"create hello.txt\r", settle=0.3)
    s.wait("[Y/n/d/a]", 15, "approval-prompt")
    s.send(b"\x1b[200~notes:\n\nmore\n\x1b[201~", label="bracketed paste 'notes:\\n\\nmore\\n'"); s.pump(6); s.dump("after-paste")
    print("C file:", os.path.exists(ws + "/hello.txt"))
finally:
    s.close(); gw.terminate()
