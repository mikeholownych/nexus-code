import sys, subprocess, time, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from ptylib import Session, make_env, tui_argv
root = pathlib.Path(__file__).parent
port = root / 'gw.port'
gwlog = root / 'gw.log'
for stale in (port, gwlog):
    if stale.exists():
        stale.unlink()
gw = subprocess.Popen([sys.executable, str(root / 'mockgw_overlay.py'), str(port), str(gwlog)])
try:
    for _ in range(100):
        if port.exists() and port.read_text():
            break
        time.sleep(.05)
    endpoint = 'http://127.0.0.1:' + port.read_text() + '/v1'
    env, ws, home = make_env('approval_timing', endpoint, {'TERM':'dumb'})
    session = Session(tui_argv(ws, endpoint), env, 40, 14, ws, 'approval_timing')
    try:
        assert session.wait('enter send', 15, 'idle')
        session.send(b'run harmless command\r')
        assert session.wait('Approval needed', 10, 'approval panel')
        session.dump('approval-unselected')
        # RC10 approval requires a settled panel, a focused choice, then the confirmation dwell.
        session.pump(2.6)
        session.send(b'\x1b[D', settle=.1, label='left: choose approve')
        session.pump(2.1)
        session.dump('approval-focused')
        session.send(b'\r', settle=.1, label='enter: request confirmation')
        session.pump(.6)
        session.send(b'\r', settle=.1, label='enter: confirm approval')
        assert session.wait('Done', 15, 'tool completion')
        session.dump('tool-completion')
        assert session.wait('enter send', 10, 'idle after completion')
    finally:
        session.close()
finally:
    gw.terminate()
    gw.wait(timeout=5)
print('PASS: synthetic harmless command approval completed with documented settle/confirm timing')
