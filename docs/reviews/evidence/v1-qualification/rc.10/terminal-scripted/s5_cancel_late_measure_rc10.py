import os, sys, time; sys.path.insert(0, "."); from ptylib import *
tag="s5_cancel_late_rc10"
gw, ep, log=start_gw("slowstream",tag)
env,ws,home=make_env(tag,ep)
s=Session(tui_argv(ws,ep),env,100,30,ws,tag)
accepted=False
try:
    assert s.wait("enter send",15,"idle")
    s.send(b"talk slowly\r")
    assert s.wait("Thinking about it",15,"streaming")
    s.pump(3.0)
    start=time.monotonic(); offset=len(s.raw); os.write(s.fd,b"\\x03")
    ack=None; deadline=start+1.0
    while time.monotonic()<deadline:
        s.pump(0.002)
        delta=s.raw[offset:].lower()
        if b"cancelling" in delta or b"cancelled" in delta:
            ack=time.monotonic()-start; break
    idle_5=s.wait("enter send",5,"idle-within-5s")
    elapsed_5=time.monotonic()-start
    if not idle_5:
        idle_35=s.wait("enter send",35,"eventual-idle-after-acceptance-window")
    else:
        idle_35=True
    print("late_stream_cancel_ack_seconds:",None if ack is None else round(ack,5))
    print("late_stream_cancel_ack_within_one_frame:",ack is not None and ack<=1/60)
    print("idle_within_5s:",idle_5,"observed_after_seconds:",round(elapsed_5,3))
    print("eventual_idle:",idle_35,"total_seconds:",round(time.monotonic()-start,3))
    s.dump("late-stream-cancel-final")
    accepted=ack is not None and ack<=1/60 and idle_5
finally:
    s.close(); gw.terminate()
if not accepted: sys.exit(1)
