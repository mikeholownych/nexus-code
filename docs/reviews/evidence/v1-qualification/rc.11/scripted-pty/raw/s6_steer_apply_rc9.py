import json, os, sys, time; sys.path.insert(0, "."); from ptylib import *
gw, ep, log = start_gw("write2", "s6_apply_rc9")
env, ws, home = make_env("s6_apply_rc9", ep)
s = Session(tui_argv(ws, ep, extra=["--yes"]), env, 100, 30, ws, "s6_apply_rc9")
try:
    assert s.wait("enter send", 20, "idle")
    s.send(b"write two files\r", settle=0.2)
    s.type("also mention cats\r", gap=0.05, label="steering during first model step")
    done = s.wait("Done.", 30, "turn-complete")
    s.dump("after-steer-turn")
    rows = gw_log(log)
    observed = [entry.get("user_messages", []) for entry in rows]
    applied = any("also mention cats" in message for group in observed for message in group)
    print("turn_completed:", done)
    print("gateway_requests:", len(rows))
    print("steering_found_in_user_messages:", applied)
    print("files_created:", os.path.exists(ws + "/a.txt"), os.path.exists(ws + "/b.txt"))
    print("gateway_user_messages:", json.dumps(observed, ensure_ascii=False))
    assert done and len(rows) >= 2 and applied and "steering · applied" in s.text(), "steering was not applied at a subsequent request boundary"
finally:
    s.close(); gw.terminate()
