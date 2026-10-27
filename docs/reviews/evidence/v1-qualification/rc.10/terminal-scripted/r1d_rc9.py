import os, sys; sys.path.insert(0, "."); from ptylib import *
gw, ep, log = start_gw("write", "r1d_rc9")
env, ws, home = make_env("r1d_rc9", ep)
s = Session([TUI, "repl", "--approve", "-w", ws, "-e", ep, "-m", "m"], env, 100, 30, ws, "r1d_rc9")
try:
    assert s.wait("nexus ws:master", 20, "repl-prompt"), "REPL prompt missing"
    s.send(b"create hello.txt\r", settle=0.2)
    s.send(b"y", settle=0.2, label="typed ahead before the approval prompt")
    assert s.wait("Approve [y]es", 20, "approval-prompt"), "approval prompt missing"
    typed_ahead_discarded = "typed-ahead input discarded" in s.text().lower()
    s.pump(3.0)  # wait for the intentional approval grace window to finish
    s.send(b"\r", label="Enter after prompt grace window")
    s.pump(1.0)
    cancelled = b"Tool execution cancelled by user." in s.raw
    typed_ahead_discarded = b"typed-ahead input discarded" in s.raw
    print("tool_cancellation_visible_in_raw:", cancelled)
    assert cancelled, "Enter after typed-ahead input did not produce the expected denial"
    created = os.path.exists(ws + "/hello.txt")
    print("typed_ahead_y_then_enter_created_file:", created)
    print("typed_ahead_discarded:", typed_ahead_discarded)
    assert not created, "typed-ahead y authorized a write"
    assert typed_ahead_discarded, "typed-ahead input was not visibly discarded"
finally:
    s.close(); gw.terminate()
