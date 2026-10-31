import json,os,time
from pathlib import Path
from ptylib import Session,make_env,start_gw,tui_argv
FRAME=1/60

def proc_table():
    out={}
    for p in Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            stat=(p/'stat').read_text(); close=stat.rfind(')'); fields=stat[close+2:].split(); ppid=int(fields[1]); cmd=(p/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace').strip()
            out[int(p.name)]={'ppid':ppid,'cmd':cmd}
        except (OSError,ValueError,IndexError): pass
    return out

def tree(root):
    table=proc_table(); result=[]; frontier={root}
    while frontier:
        found={pid for pid,v in table.items() if v['ppid'] in frontier and pid not in result}
        for pid in sorted(found): result.append(pid)
        frontier=found
    return [{'pid':pid,**table[pid]} for pid in [root,*result] if pid in table]

def run(tag,quit_during_tool):
    gw,ep,log=start_gw('slowtool',tag); env,ws,home=make_env(tag,ep); s=Session(tui_argv(ws,ep,extra=('--yes',)),env,100,30,ws,tag)
    result={'scenario':tag,'frameBudgetSeconds':FRAME,'idleBudgetSeconds':5,'isolatedHome':os.path.commonpath([home,os.path.join(os.path.dirname(__file__),'runs')])==os.path.join(os.path.dirname(__file__),'runs')}
    try:
        result['initialPrompt']=s.wait('enter send',15,'idle'); s.send('run it\r',label='start real synthetic command')
        deadline=time.monotonic()+12; snapshot=[]
        while time.monotonic()<deadline:
            snapshot=tree(s.pid)
            if any('sleep 23.7' in x['cmd'] for x in snapshot): break
            s.pump(0.02)
        result['toolProcessTreeBefore']=snapshot
        result['toolStarted']=any('sleep 23.7' in x['cmd'] for x in snapshot)
        result['tuiPid']=s.pid
        result['cancelKey']='Ctrl-C' if quit_during_tool else 'Esc'
        t=time.monotonic(); s.send(b'\x03' if quit_during_tool else b'\x1b',settle=0,label=result['cancelKey'])
        ack=False; ack_secs=None; deadline=t+2
        while time.monotonic()<deadline:
            if 'Cancelled' in s.text(): ack=True; ack_secs=time.monotonic()-t; break
            s.pump(0.005)
        result['cancelAcknowledged']=ack; result['cancelAckSeconds']=ack_secs
        if quit_during_tool:
            s.pump(0.5); s.send(b'\x03',settle=0,label='second Ctrl-C exits')
            idle=False; idle_secs=None
        else:
            idle=s.wait('enter send',5,'idle-after-escape'); idle_secs=time.monotonic()-t if idle else None
        result['idleAfterCancel']=idle; result['idleSeconds']=idle_secs
        time.sleep(0.25)
        after=proc_table(); before_ids={x['pid'] for x in snapshot}; result['survivingBeforeTreePids']=[{'pid':pid,**after[pid]} for pid in sorted(before_ids & after.keys())]
        if quit_during_tool:
            deadline=time.monotonic()+5
            while time.monotonic()<deadline and s.alive(): s.pump(0.02)
            time.sleep(0.25); after=proc_table()
            result['tuiExited']=not s.alive(); result['survivingBeforeTreePids']=[{'pid':pid,**after[pid]} for pid in sorted(before_ids & after.keys())]
        else:
            result['tuiStayedOpen']=s.alive()
        result['passed']=result['toolStarted'] and result['cancelAcknowledged'] and ack_secs is not None and ack_secs<=FRAME and (not quit_during_tool or result.get('tuiExited') and not result['survivingBeforeTreePids']) and (quit_during_tool or result['idleAfterCancel'] and idle_secs<=5 and result['tuiStayedOpen'] and not any('sleep 23.7' in x['cmd'] for x in result['survivingBeforeTreePids']))
        result['finalScreen']=s.dump('final')
    finally:
        s.close(); gw.terminate(); gw.wait(timeout=5)
    return result

results=[run('s8-cancel-tool',False),run('s9-quit-during-tool',True)]
with open('tool-lifecycle-status.json','x') as f: json.dump({'artifact':os.environ['NEXUS_PTY_ARTIFACT'],'results':results},f,indent=2)
print(json.dumps([{k:v for k,v in r.items() if k!='finalScreen'} for r in results],sort_keys=True))
if not all(r['passed'] for r in results): raise SystemExit(1)
