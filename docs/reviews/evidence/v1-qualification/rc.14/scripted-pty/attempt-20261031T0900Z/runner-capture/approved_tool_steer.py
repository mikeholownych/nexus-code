import json,os,time,subprocess
from ptylib import Session,make_env,start_gw,gw_log,tui_argv
name='steer-approved-tool'; gw,ep,log=start_gw('slowtool',name); env,ws,home=make_env(name,ep); s=Session(tui_argv(ws,ep,extra=('--yes',)),env,100,30,ws,name)
start=time.monotonic(); result={'limitSeconds':60,'homeIsolated':os.path.commonpath([home,os.path.join(os.path.dirname(__file__),'runs')])==os.path.join(os.path.dirname(__file__),'runs')}
def proc_lines(): return subprocess.run(['ps','-eo','pid,ppid,lstart,etimes,args'],capture_output=True,text=True,check=True).stdout.splitlines()
try:
    result['initialPrompt']=s.wait('enter send',15,'idle'); s.send('run it\r',label='start synthetic command')
    deadline=time.monotonic()+15; matches=[]
    while time.monotonic()<deadline:
        rows=proc_lines(); matches=[x for x in rows if 'sleep 23.7' in x and 'approved_tool_steer' not in x]
        if matches: break
        s.pump(0.1)
    result['runningProcessObserved']=bool(matches); result['runningProcessSnapshot']=matches
    if matches:
        s.type('also mention cats\r',gap=0.05,label='steer while child process is running')
        result['steerVisibleOrQueued']='also mention cats' in s.text().lower() or 'steering' in s.text().lower()
        result['finished']=s.wait(lambda text:'Done' in text or 'TURN ENDED' in text,45,'turn-complete')
    result['elapsedSeconds']=round(time.monotonic()-start,3); result['gatewayRecords']=gw_log(log)
    result['steerInFollowup']=any(any('also mention cats' in str(m).lower() for m in row.get('user_messages',[])) for row in result['gatewayRecords'][1:])
    result['finalScreen']=s.dump('final')
finally:
    s.close(); gw.terminate(); gw.wait(timeout=5)
with open('approved-tool-steer-status.json','x') as f: json.dump(result,f,indent=2)
print(json.dumps({k:v for k,v in result.items() if k not in ('finalScreen','gatewayRecords')},sort_keys=True))
