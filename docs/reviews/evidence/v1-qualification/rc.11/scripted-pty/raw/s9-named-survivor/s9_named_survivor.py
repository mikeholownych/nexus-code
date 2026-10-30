import sys, time, subprocess; sys.path.insert(0, "."); from ptylib import *
def sleepers():
    raw = subprocess.run(['ps', '-eo', 'pid=,pgid=,args='], capture_output=True, text=True, check=True).stdout
    return [l.strip() for l in raw.splitlines() if l.split(None, 2)[2:] == ['sleep 23.7']]
assert not sleepers(), "pre-existing sleep 23.7 process; refusing ambiguous probe"
gw, ep, log = start_gw("slowtool", "s9n")
env, ws, home = make_env("s9n", ep)
s = Session(tui_argv(ws, ep, extra=["--yes"]), env, 100, 30, ws, "s9n")
try:
    s.wait("enter send", 15, "idle")
    s.send(b"run it\r"); s.wait("sleep 23.7", 10, "tool-running"); s.pump(1.5)
    before = sleepers(); print("tool processes before quit:", before)
    assert before, "probe is vacuous: tool process not observed before quit"
    t0 = time.monotonic()
    s.send(b"\x03", label="Ctrl-C"); s.pump(0.5); s.send(b"\x03", label="Ctrl-C again -> quit")
    survivors = before
    while survivors and time.monotonic() - t0 < 6: time.sleep(0.1); survivors = sleepers()
    s.pump(max(0.0, 6 - (time.monotonic() - t0)))
    print("tui alive:", s.alive(), "elapsed_s=%.2f" % (time.monotonic() - t0), "survivors:", survivors)
    assert not s.alive(), "TUI did not exit"
    assert not survivors, "tool process survived quit"
    print("S9_NAMED_SURVIVOR=PASS")
finally:
    s.close(); gw.terminate()
