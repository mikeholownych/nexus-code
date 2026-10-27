import sys,subprocess,time,pathlib,os
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from ptylib import *
root=pathlib.Path(__file__).parent; port=root/'gw.port'; gwlog=root/'gw.log'
gw=subprocess.Popen([sys.executable,str(root/'mockgw_overlay.py'),str(port),str(gwlog)])
try:
  for _ in range(100):
    if port.exists() and port.read_text(): break
    time.sleep(.05)
  ep='http://127.0.0.1:'+port.read_text()+'/v1'; env,ws,home=make_env('detail_dumb40',ep,{'TERM':'dumb'})
  s=Session(tui_argv(ws,ep),env,40,14,ws,'detail_dumb40')
  try:
    assert s.wait('enter send',15,'idle'); s.dump('idle')
    s.send(b'run harmless command\r'); assert s.wait('Approval needed',10,'command approval'); s.dump('command-approval')
    s.send(b'y'); assert s.wait('Done',20,'command completion'); s.dump('command-completion')
    assert s.wait('enter send',10,'command idle')
    s.send(b'\t'); s.send(b']'); s.send(b'\r'); assert s.wait('Tool call',10,'detail'); s.dump('detail'); s.send(b'\x1b'); assert s.wait('enter send',5,'detail closed')
  finally:s.close()
finally:gw.terminate();gw.wait(timeout=5)
print('detail probe finished')
