import sys; sys.path.insert(0, "."); from ptylib import *
env, ws, home = make_env("s1b_default_endpoint_rc10", "")
del env["LOCAL_LLM_ENDPOINT"]
s = Session([TUI, "--live", "-w", ws], env, 100, 30, ws, "s1b_default_endpoint_rc10")
try:
    s.pump(5)
    screen=s.dump("default-endpoint-startup")
    helpful=any(x in screen.lower() for x in ["endpoint","connect","model"])
    print("helpful_endpoint_or_model_guidance:",helpful)
    print(screen)
    assert helpful, "default endpoint startup produced no endpoint/model guidance"
finally:
    s.close()
