import json,os,time,subprocess
from ptylib import Session,make_env,start_gw,gw_log,tui_argv
name='steer-approved-tool'; gw,ep,log=start_gw('slowtool',name); env,ws,home=make_env(name,ep); s=Session(tui_argv(ws,ep),env,100,30,ws,name)
start=time.monotonic(); result={'limitSeconds':60,'homeIsolated':os.path.commonpath([home,os.path.join(os.path.dirname(__file__),'runs')])==os.path.join(os.path.dirname(__file__),'runs')}
def proc_lines():
    return subprocess.run(['ps','-eo','pid,ppid,lstart,etimes,args'],capture_output=True,text=True,check=True).stdout.splitlines()
try:
    result['idle']=s.wait('enter send',15,'idle')
    s.send('run it\r',label='request synthetic command')
    result['approvalPanel']=s.wait('Approval needed',15,'approval-panel')
    s.pump(2.5); result['beforeApproval']=s.dump('before-deliberate-approval')
    s.send(b'\x1b[C',label='select Approve')
    s.pump(0.8)
    s.send(b'\r',label='confirm deliberate Approve')
    if 'Approval needed' in s.text():
        s.pump(0.8); s.send(b'\r',label='confirm explicit approval choice')
    deadline=time.monotonic()+15
    process=''
    while time.monotonic()<deadline:
        rows=proc_lines()
        matches=[x for x in rows if 'sleep 23.7' in x and 'approved_tool_steer' not in x]
        if matches and 'Approval needed' not in s.text(): process='\n'.join(matches); break
        s.pump(0.1)
    result['runningProcessObserved']=bool(process); result['runningProcessSnapshot']=process
    if process:
        result['steerKeySeconds']=round(time.monotonic()-start,3)
        s.type('also mention cats\r',gap=0.05,label='steer while child process is running')
        result['steerVisibleOrQueued']='also mention cats' in s.text().lower() or 'steering' in s.text().lower()
        result['finished']=s.wait(lambda text:'Done' in text or 'TURN ENDED' in text,35,'turn-complete')
    result['elapsedSeconds']=round(time.monotonic()-start,3)
    result['gatewayRecords']=gw_log(log)
    result['steerInFollowup']=any(any('also mention cats' in str(m).lower() for m in row.get('user_messages',[])) for row in result['gatewayRecords'][1:])
    result['finalScreen']=s.dump('final')
finally:
    s.close(); gw.terminate(); gw.wait(timeout=5)
with open('approved-tool-steer-status.json','x') as f: json.dump(result,f,indent=2)
print(json.dumps({k:v for k,v in result.items() if k not in ('finalScreen','gatewayRecords','runningProcessSnapshot')},sort_keys=True))
