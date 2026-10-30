import os, sys, time
from ptylib import *
env, ws, home = make_env("s1-natural", "http://127.0.0.1:9/v1")
s = Session(tui_argv(ws, "http://127.0.0.1:9/v1"), env, 100, 30, ws, "s1-natural")
s.pump(4); s.dump("startup")
s.type("say hello\r", gap=0.05)
deadline = time.monotonic() + 150
finished = False
while time.monotonic() < deadline:
    if not s.pump(min(1, deadline - time.monotonic())):
        finished = True
        break
    if not s.alive():
        finished = True
        break
s.dump("natural-completion-deadline")
text = s.text()
print("natural_process_exit=", finished)
print("guidance_visible=", any(token in text.lower() for token in ("nexus doctor", "local_llm_endpoint", "/connect", "temporarily unavailable", "provider recovery")))
print("idle_or_turn_finished=", any(token in text.lower() for token in ("done", "cancelled", "turn complete", "press enter to continue")))
print("elapsed_seconds=", round(time.monotonic() - s.t0, 2))
if not finished:
    s.send(b"\x03"); s.pump(1); s.send(b"\x03"); s.pump(2)
s.close()
