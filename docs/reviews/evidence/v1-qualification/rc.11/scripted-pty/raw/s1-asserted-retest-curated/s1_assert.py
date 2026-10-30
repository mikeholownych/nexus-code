import os, sys, time
from ptylib import *
env, ws, home = make_env("s1-asserted", "http://127.0.0.1:9/v1")
s = Session(tui_argv(ws, "http://127.0.0.1:9/v1"), env, 100, 30, ws, "s1-asserted")
s.pump(4); s.dump("startup")
prompt_at = time.monotonic()
s.type("say hello\r")
deadline = prompt_at + 145
finished_at = None
while time.monotonic() < deadline:
    screen = s.text()
    if "Model request failed" in screen and "did not recover within 120s" in screen and "nexus doctor" in screen and "LOCAL_LLM_ENDPOINT" in screen and "/connect" in screen:
        finished_at = time.monotonic()
        s.dump("turn-finished-with-guidance")
        break
    if not s.pump(min(0.5, max(0, deadline-time.monotonic()))):
        break
if finished_at is None:
    s.dump("turn-guidance-deadline-failed")
print("turn_finished_with_guidance=", finished_at is not None)
print("turn_elapsed_seconds=", round(finished_at-prompt_at, 2) if finished_at else None)
print("tui_remained_available=", s.alive())
assert finished_at is not None, "s1 turn did not finish with full endpoint guidance within 145 seconds"
assert finished_at-prompt_at <= 150, "s1 exceeded §5.2 2.5 minute bound"
s.send(b"/quit\r"); s.pump(2)
print("tui_exited_after_quit=", not s.alive())
s.close()
