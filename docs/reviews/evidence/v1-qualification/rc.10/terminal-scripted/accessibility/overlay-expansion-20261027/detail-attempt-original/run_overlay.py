import sys,subprocess,time,pathlib,json,os
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from ptylib import *
root=pathlib.Path(__file__).parent; port=root/'gw.port'; gwlog=root/'gw.log'
gw=subprocess.Popen([sys.executable,str(root/'mockgw_overlay.py'),str(port),str(gwlog)])
try:
  for _ in range(100):
    if port.exists() and port.read_text(): break
    time.sleep(.05)
  ep='http://127.0.0.1:'+port.read_text()+'/v1'; env,ws,home=make_env('overlay_dumb40',ep,{'TERM':'dumb'})
  s=Session(tui_argv(ws,ep),env,40,14,ws,'overlay_dumb40')
  try:
    assert s.wait('enter send',15,'idle'); s.dump('idle')
    s.send(b'?'); assert s.wait('Help',5,'help'); s.dump('help'); s.send(b'\x1b'); assert s.wait('enter send',5,'help closed')
    s.send(b'/model\r'); assert s.wait('Select model',10,'models'); s.dump('models'); s.send(b'\x1b'); assert s.wait('enter send',5,'models closed')
    s.send(b'/connect\r'); assert s.wait('Connect',10,'connect'); s.dump('connect'); s.send(b'\x1b'); assert s.wait('Select model',5,'connect back to model picker'); s.send(b'\x1b'); assert s.wait('enter send',5,'connect closed')
    s.send(b'\x1b[200~first line\nsecond line\nthird line\x1b[201~'); s.pump(.5); s.send(b'\x0f'); assert s.wait('Paste',5,'paste'); s.dump('paste'); s.send(b'\x1b'); assert s.wait('ctrl+o view paste',5,'paste closed'); s.send(b'\x0c'); assert s.wait('enter send',5,'paste cleared')
    # Synthetic scanner canary from the public sidecar test contract; never a live credential.
    (pathlib.Path(ws)/'base.txt').write_text('synthetic canary ghp_'+'A'*36+'\n')
    s.send(b'review the sensitive workspace\r'); assert s.wait('Checkpoint',10,'checkpoint choice'); s.dump('checkpoint-choice'); s.send(b'4'); s.send(b'\r'); assert s.wait('INTERNAL: This turn was cancelled',10,'checkpoint choice cancelled'); assert s.wait('enter send',10,'checkpoint choice closed')
    (pathlib.Path(ws)/'base.txt').write_text('base\n')
    s.send(b'create a11y.txt\r'); assert s.wait('Approval needed',10,'approval'); s.dump('approval')
    s.pump(2.5); s.send(b'y'); s.pump(1); s.send(b'\x1b[D'); s.pump(2.3); s.send(b'\r'); s.pump(.6); s.send(b'\r'); assert s.wait('Done',15,'completion'); s.dump('completion')
    assert s.wait('enter send',10,'post-completion idle'); s.send(b'\x04'); assert s.wait('Edit diff',5,'review'); s.dump('review'); s.send(b'\x1b'); assert s.wait('enter send',5,'review closed')
    s.send(b'/receipt\r'); assert s.wait('Receipt',10,'receipt'); s.dump('receipt'); s.send(b'\x1b'); assert s.wait('enter send',5,'receipt closed')
    s.send(b'run harmless command\r'); assert s.wait('Approval needed',10,'harmless command approval'); s.dump('command-approval')
    s.pump(2.5); s.send(b'y'); s.pump(1); s.send(b'\x1b[D'); s.pump(2.3); s.send(b'\r'); s.pump(.6); s.send(b'\r'); assert s.wait('Done',15,'harmless command completion'); s.dump('command-completion'); assert s.wait('enter send',10,'command idle')
    s.send(b'\t'); s.send(b']'); s.send(b'\r'); assert s.wait('Tool call',10,'detail'); s.dump('detail'); s.send(b'\x1b'); assert s.wait('enter send',5,'detail closed')
  finally:s.close()
finally:gw.terminate();gw.wait(timeout=5)
print('dry-run finished')
