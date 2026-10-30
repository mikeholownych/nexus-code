import os, sys; sys.path.insert(0, "."); from ptylib import *
gw, ep, log = start_gw("write", "r1a_rc9")
env, ws, home = make_env("r1a_rc9", ep)
s = Session([TUI, "repl", "--approve", "-w", ws, "-e", ep, "-m", "m"], env, 100, 30, ws, "r1a_rc9")
try:
    assert s.wait("nexus ws:master", 20, "repl-prompt"), "REPL prompt missing"
    s.send(b"create hello.txt\r")
    assert s.wait("Approve [y]es", 20, "approval-prompt"), "approval prompt missing"
    s.pump(3.0)  # wait for the intentional approval grace window to finish
    s.send(b"\r", label="lone Enter defaults to deny")
    s.pump(1.0)
    cancelled = b"Tool execution cancelled by user." in s.raw
    print("tool_cancellation_visible_in_raw:", cancelled)
    assert cancelled, "lone Enter did not produce the expected denial"
    created = os.path.exists(ws + "/hello.txt")
    print("lone_enter_created_file:", created)
    assert not created, "lone Enter authorized a write"
finally:
    s.close(); gw.terminate()
