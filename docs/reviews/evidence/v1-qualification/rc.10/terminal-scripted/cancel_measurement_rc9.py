import os, subprocess, sys, time
sys.path.insert(0, ".")
from ptylib import *

def group_rows(pgid):
    raw=subprocess.run(["ps","-eo","pid=,pgid=,args="],capture_output=True,text=True,check=True).stdout
    rows=[]
    for line in raw.splitlines():
        parts=line.strip().split(None,2)
        if len(parts)==3 and parts[1].isdigit() and int(parts[1])==pgid:
            rows.append(line.strip())
    return rows

def scoped_rows(home, workspace):
    table=subprocess.run(["ps","-eo","pid=,uid=,args="],capture_output=True,text=True,check=True).stdout
    rows=[]
    for line in table.splitlines():
        parts=line.strip().split(None,2)
        if len(parts)!=3 or not parts[0].isdigit() or int(parts[1])!=os.getuid(): continue
        pid=int(parts[0]); in_scope=False
        try:
            env=open(f"/proc/{pid}/environ","rb").read().split(b"\0")
            in_scope=any(item==("HOME="+home).encode() for item in env)
        except (OSError,PermissionError): pass
        if not in_scope:
            try: in_scope=os.path.realpath(f"/proc/{pid}/cwd").startswith(os.path.realpath(workspace)+os.sep)
            except (OSError,PermissionError): pass
        if in_scope: rows.append(line.strip())
    return rows

latencies=[]
for i in range(3):
    tag=f"s5_cancel_measure_{i}"
    gw, ep, log=start_gw("slowstream",tag)
    env,ws,home=make_env(tag,ep)
    s=Session(tui_argv(ws,ep),env,100,30,ws,tag)
    try:
        assert s.wait("enter send",15,"idle")
        s.send(b"talk slowly\r")
        assert s.wait("Thinking",15,"streaming")
        pgid=os.getpgid(s.pid)
        start=time.monotonic(); offset=len(s.raw); os.write(s.fd,b"\x03")
        ack=None; deadline=start+1
        while time.monotonic()<deadline:
            s.pump(0.002)
            delta=s.raw[offset:].lower()
            if b"cancelling" in delta or b"cancelled" in delta:
                ack=time.monotonic()-start; break
        idle=s.wait("ask Nexus",5,"idle-after-cancel")
        print(tag,"ack_seconds=",None if ack is None else round(ack,5),"ack_1frame=",ack is not None and ack<=1/60,"idle=",idle)
        latencies.append(ack)
    finally:
        s.close(); gw.terminate()

# Esc during an actual running command. Track only this PTY process group.
tag="s8_cancel_measure"
gw,ep,log=start_gw("slowtool",tag)
env,ws,home=make_env(tag,ep)
s=Session(tui_argv(ws,ep,extra=["--yes"]),env,100,30,ws,tag)
try:
    assert s.wait("enter send",15,"idle")
    s.send(b"run it\r")
    assert s.wait("sleep 23.7",15,"tool-running")
    before=scoped_rows(home,ws)
    assert any("sleep 23.7" in row for row in before),before
    start=time.monotonic(); offset=len(s.raw); os.write(s.fd,b"\x1b")
    ack=None; deadline=start+2
    while time.monotonic()<deadline:
        s.pump(0.002)
        delta=s.raw[offset:].lower()
        if b"cancelling" in delta or b"cancelled" in delta:
            ack=time.monotonic()-start; break
    idle=s.wait("ask Nexus",5,"idle-after-esc")
    after_esc=scoped_rows(home,ws)
    sleep_survivors=[row for row in after_esc if "sleep 23.7" in row]
    print(tag,"ack_seconds=",None if ack is None else round(ack,5),"ack_1frame=",ack is not None and ack<=1/60,"idle=",idle,"sleep_survivors=",sleep_survivors)
    assert idle and not sleep_survivors
    os.write(s.fd,b"\x03"); s.pump(0.2); os.write(s.fd,b"\x03")
    for _ in range(100):
        s.pump(0.02)
        if not s.alive(): break
    after_quit=scoped_rows(home,ws)
    print(tag,"tui_exited=",not s.alive(),"scoped_processes_after_quit=",after_quit)
    assert not s.alive() and not after_quit
finally:
    s.close(); gw.terminate()
