import json,os,time
from ptylib import Session,make_env,start_gw,gw_log,tui_argv
scenario='steer-tool'; gateway,endpoint,request_log=start_gw('slowtool',scenario)
env,workspace,home=make_env(scenario,endpoint)
s=Session(tui_argv(workspace,endpoint),env,100,30,workspace,scenario)
start=time.monotonic(); result={'limit_seconds':60,'isolatedHome':os.path.commonpath([home,os.path.join(os.path.dirname(__file__),'runs')])==os.path.join(os.path.dirname(__file__),'runs')}
try:
    result['initialPrompt']=s.wait('enter send',15,'idle')
    s.send('run it\r',label='start synthetic tool')
    result['toolRunning']=s.wait('sleep 23.7',10,'tool-running')
    s.pump(0.5)
    t=time.monotonic(); s.type('also mention cats\r',gap=0.05,label='steer during running tool'); result['steerInputSeconds']=round(time.monotonic()-t,3)
    result['steerQueued']='also mention cats' in s.text() or 'steering' in s.text().lower()
    deadline=start+60
    result['naturalCompletion']=s.wait(lambda text:'Done' in text or 'TURN ENDED' in text, max(0,deadline-time.monotonic()),'completion')
    result['elapsedSeconds']=round(time.monotonic()-start,3)
    records=gw_log(request_log); result['gatewayRequests']=records
    result['steerInFollowup']=len(records)>=2 and any('also mention cats' in str(row.get('last','')).lower() for row in records[1:])
    result['finalScreen']=s.dump('final')
finally:
    s.close(); gateway.terminate(); gateway.wait(timeout=5)
with open('steer-tool-status.json','x') as f: json.dump(result,f,indent=2)
print(json.dumps({k:v for k,v in result.items() if k not in ('finalScreen','gatewayRequests')},sort_keys=True))
