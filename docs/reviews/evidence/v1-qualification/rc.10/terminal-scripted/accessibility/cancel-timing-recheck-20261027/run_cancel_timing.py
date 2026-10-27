import sys,os,time,subprocess,pathlib,json
sys.path.insert(0,str(pathlib.Path(__file__).parent)); from ptylib import *
root=pathlib.Path(__file__).parent; port=root/'gw.port'; log=root/'gw.log'
gw=subprocess.Popen([sys.executable,str(root/'mockgw_states.py'),str(port),str(log)])
try:
  for _ in range(100):
    if port.exists() and port.read_text(): break
    time.sleep(.05)
  ep='http://127.0.0.1:'+port.read_text()+'/v1'; results=[]
  for idx,delay in enumerate([0.0,0.1,0.2,0.5,1.0],1):
    env,ws,home=make_env(f'trial_{idx}',ep,{'TERM':'dumb'})
    s=Session(tui_argv(ws,ep,extra=['--yes']),env,100,30,ws,f'trial_{idx}')
    try:
      assert s.wait('enter send',15,'startup idle')
      s.send(b'run it\r')
      assert s.wait('sleep 20; echo finished',10,'running synthetic command')
      if delay: s.pump(delay)
      cancel_at=time.monotonic(); s.send(b'\x1b',label=f'Esc delay={delay}')
      ok=s.wait('enter send',5,'cancelled idle')
      elapsed=time.monotonic()-cancel_at
      if not ok:
        s.send(b'\x03',label='Ctrl-C cleanup request'); s.pump(.5)
        s.send(b'\x03',label='second Ctrl-C cleanup quit'); s.pump(1)
      s.dump(f'trial-{idx}-final')
      results.append({'trial':idx,'delay_after_tool_render_s':delay,'idle_within_5s':ok,'cancel_to_idle_s':round(elapsed,3) if ok else None})
      print(json.dumps(results[-1]),flush=True)
    finally:s.close()
  (root/'results.json').write_text(json.dumps({'candidate':'v1.0.0-rc.10','sourceCommit':'16ee8ca3643824741b6da67936b41f262414fdf0','terminal':'TERM=dumb 100x30','results':results},indent=2)+'\n')
finally:
  gw.terminate(); gw.wait(timeout=5)
