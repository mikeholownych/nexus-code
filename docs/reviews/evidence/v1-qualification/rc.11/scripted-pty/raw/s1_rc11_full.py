import sys, time
sys.path.insert(0, ".")
from ptylib import *
env, ws, home = make_env("s1_rc11_full", "http://127.0.0.1:9/v1")
s = Session(tui_argv(ws, "http://127.0.0.1:9/v1"), env, 100, 30, ws, "s1_rc11_full")
try:
    s.pump(4)
    before = s.dump("startup-unreachable")
    started = time.monotonic()
    s.type("say hello\r", gap=0.05)
    ended = s.wait("enter send", 150, "turn-returned-to-idle")
    elapsed = time.monotonic() - started
    after = s.dump("after-full-window")
    guidance = any(x in after.lower() for x in ("provider", "endpoint", "connect", "doctor", "unavailable", "error"))
    print("turn_returned_to_idle:", ended, "elapsed_seconds:", round(elapsed, 2), "guidance_visible:", guidance)
    print("initial_endpoint_guidance:", "http://127.0.0.1:9/v1" in before and "LOCAL_LLM_ENDPOINT" in before)
    if not ended or not guidance:
        raise SystemExit(2)
finally:
    s.close()
