import sys; sys.path.insert(0, "."); from ptylib import *
# A: unreachable endpoint, empty HOME
env, ws, home = make_env("s1a", "http://127.0.0.1:9/v1")
s = Session(tui_argv(ws, "http://127.0.0.1:9/v1"), env, 100, 30, ws, "s1a")
s.pump(4); s.dump("startup-unreachable")
s.type("say hello\r", gap=0.05); s.pump(8); s.dump("after-prompt-unreachable")
s.pump(20); s.dump("after-prompt-unreachable-28s")
s.send(b"\x03"); s.pump(1); s.send(b"\x03"); s.pump(3); s.dump("after-ctrl-c"); print("alive", s.alive()); s.close()
# B: no args at all (default endpoint), HOME empty
env, ws, home = make_env("s1b", "")
del env["LOCAL_LLM_ENDPOINT"]
s = Session([TUI, "--live", "--sidecar", SIDECAR, "--node", "node", "--", "-w", ws], env, 100, 30, ws, "s1b")
s.pump(5); s.dump("startup-default-endpoint"); s.close()
