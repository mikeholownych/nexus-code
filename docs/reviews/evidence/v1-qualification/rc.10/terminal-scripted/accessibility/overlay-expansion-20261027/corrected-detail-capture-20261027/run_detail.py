import sys,subprocess,time,pathlib
sys.path.insert(0,str(pathlib.Path(__file__).parent)); from ptylib import Session,make_env,tui_argv
root=pathlib.Path(__file__).parent; port=root/'gw.port'; gwlog=root/'gw.log'
gw=subprocess.Popen([sys.executable,str(root/'mockgw_overlay.py'),str(port),str(gwlog)])
try:
  for _ in range(100):
    if port.exists() and port.read_text(): break
    time.sleep(.05)
  endpoint='http://127.0.0.1:'+port.read_text()+'/v1'; env,ws,home=make_env('detail_overlay',endpoint,{'TERM':'dumb'})
  session=Session(tui_argv(ws,endpoint),env,40,14,ws,'detail_overlay')
  try:
    assert session.wait('enter send',15,'idle'); session.dump('idle')
    session.send(b'run harmless command\r'); assert session.wait('Approval needed',10,'approval'); session.dump('approval-unselected')
    session.pump(2.6); session.send(b'\x1b[D',settle=.1,label='left: choose approve'); session.pump(2.1); session.dump('approval-focused')
    session.send(b'\r',settle=.1,label='enter: request confirmation'); session.pump(.6); session.send(b'\r',settle=.1,label='enter: confirm approval')
    assert session.wait('Done',15,'tool completion'); session.dump('tool-completion'); assert session.wait('enter send',10,'idle after completion')
    session.send(b'\t',label='focus transcript'); session.send(b']',label='select latest tool call'); session.send(b'\r',label='open tool detail'); assert session.wait('Tool call',10,'detail overlay'); session.dump('detail-overlay'); session.send(b'\x1b',label='close detail'); assert session.wait('enter send',5,'detail closed')
  finally: session.close()
finally: gw.terminate(); gw.wait(timeout=5)
print('PASS: synthetic approval flow completed and Detail overlay rendered')
