import json, os, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ptylib import *

FRAME = 1 / 60
results = []
for tag, key, steer in [('s4-esc', b'\x1b', False), ('s5-ctrl-c', b'\x03', False), ('s6-queued-steer-then-cancel', b'\x03', True)]:
    gw, ep, log = start_gw('slowstream', tag)
    env, ws, home = make_env(tag, ep)
    s = Session(tui_argv(ws, ep), env, 100, 30, ws, tag)
    rec = {'scenario': tag, 'frameBudgetSeconds': FRAME, 'key': 'Esc' if key == b'\x1b' else 'Ctrl-C', 'steerQueued': steer}
    try:
        s.wait('enter send', 15, 'idle')
        s.send(b'talk slowly\r', settle=0.2)
        s.wait('Thinking about it', 10, 'streaming')
        s.pump(0.15)
        if steer:
            s.type('also mention cats\r', gap=0.01, label='queue steering during active stream')
            rec['steerVisibleBeforeCancel'] = 'also mention cats' in s.text()
        t0 = time.monotonic()
        os.write(s.fd, key)
        rec['cancelKeySentAtMonotonic'] = t0
        deadline = t0 + 0.3
        ack = None
        seen = []
        while time.monotonic() < deadline:
            s.pump(0.002)
            screen = s.text()
            low = screen.lower()
            if 'cancelling' in low or 'cancelled' in low:
                ack = time.monotonic() - t0
                seen.append(screen)
                break
        rec['firstVisibleAckSeconds'] = ack
        rec['firstVisibleAckText'] = seen[0] if seen else None
        rec['ackWithinOne60HzFrame'] = ack is not None and ack <= FRAME
        idle = s.wait('enter send', 5, 'idle after cancel')
        rec['idleWithinFiveSeconds'] = idle
        rec['idleSecondsFromKey'] = time.monotonic() - t0 if idle else None
        rec['composerAfterCancel'] = s.text().splitlines()[-1] if s.text().splitlines() else ''
        s.dump('cancel-ack-review')
    finally:
        s.close()
        gw.terminate()
        gw.wait(timeout=3)
    results.append(rec)

out = {'artifact': 'v1.0.0-rc.14 (16eeb6eeffe7)', 'archiveSha256': '52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7', 'node': os.popen('node --version').read().strip(), 'results': results}
Path('cancel-ack-frame-status.json').write_text(json.dumps(out, indent=2) + '\n')
print(json.dumps(out, indent=2))
