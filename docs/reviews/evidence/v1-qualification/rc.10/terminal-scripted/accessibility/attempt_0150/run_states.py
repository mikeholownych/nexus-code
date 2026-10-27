import os,re,subprocess,sys,time,pathlib,json
sys.path.insert(0,".")
from ptylib import *
root=pathlib.Path(__file__).parent
def color_codes(raw):
  out=[]
  for m in re.finditer(rb"\x1b\[([0-9;]*)m",raw):
    ps=[int(x) for x in m.group(1).split(b";") if x]
    if any(p in range(30,50) or p in range(90,108) for p in ps): out.append(m.group(0))
  return out
summary=[]
for i,(term,cols,rows) in enumerate((("xterm-256color",40,14),("xterm-256color",100,30),("dumb",40,14),("dumb",100,30))):
  tag=f"states_{i}"
  portfile=root/f"gw_{tag}.port"; gwlog=root/f"gw_{tag}.log"
  for p in (portfile,gwlog):
    if p.exists(): p.unlink()
  gw=subprocess.Popen([sys.executable,str(root/"mockgw_states.py"),str(portfile),str(gwlog)])
  try:
    for _ in range(100):
      if portfile.exists() and portfile.read_text(): break
      time.sleep(.05)
    ep=f"http://127.0.0.1:{portfile.read_text()}/v1"
    extra={"TERM":term}
    if term!="dumb": extra["NO_COLOR"]="1"
    env,ws,home=make_env(tag,ep,extra)
    s=Session(tui_argv(ws,ep),env,cols,rows,ws,tag)
    states={}
    try:
      assert s.wait("enter send",15,"idle")
      states["idle"]=s.dump("idle")
      s.send(b"?")
      assert s.wait("Help",5,"help")
      states["help"]=s.dump("help")
      s.send(b"\x1b"); assert s.wait("enter send",5,"help closed")
      s.send(b"/model\r")
      assert s.wait("Select model",10,"model picker")
      states["model_picker"]=s.dump("model-picker")
      s.send(b"\x1b"); assert s.wait("enter send",5,"model picker closed")
      s.send(b"talk slowly\r")
      assert s.wait("Thinking about accessibility state",10,"streaming")
      s.pump(1)
      states["streaming"]=s.dump("streaming")
      s.send(b"\x03",label="Ctrl-C")
      assert s.wait("Cancelled",5,"cancelled outcome")
      states["cancelled"]=s.dump("cancelled")
      s.send(b"create a11y.txt\r")
      assert s.wait("Approval needed",10,"approval")
      states["approval"]=s.dump("approval")
      if cols==40:
        hint=any(x in states["approval"] for x in ["←→ choose, enter","y or n, or ←→"])
        assert hint,"narrow approval hint incomplete"
      s.pump(2.5); s.send(b"y"); s.pump(1)
      s.send(b"\x1b[D"); s.pump(2.3); s.send(b"\r"); s.pump(.6); s.send(b"\r")
      assert s.wait("Done",15,"completion")
      states["completion"]=s.dump("completion")
      bad=color_codes(s.raw)
      assert not bad,(term,cols,rows,bad)
    finally:
      s.close()
    # Exercise a tool-running state through an isolated auto-approve TUI.
    s2=Session(tui_argv(ws,ep,extra=["--yes"]),env,cols,rows,ws,tag+"_tool")
    try:
      assert s2.wait("enter send",15,"tool-session idle")
      s2.send(b"run it\r")
      assert s2.wait("sleep 20",10,"tool running")
      states["tool_running"]=s2.dump("tool-running")
      s2.send(b"\x1b"); assert s2.wait("enter send",5,"tool cancelled idle")
      states["tool_cancelled"]=s2.dump("tool-cancelled")
      bad=color_codes(s2.raw)
      assert not bad,(term,cols,rows,bad)
    finally:
      s2.close()
    # Include endpoint-error state in the same terminal/color configuration.
    env_err,ws_err,home_err=make_env(tag+"_error","http://127.0.0.1:9/v1",extra)
    se=Session(tui_argv(ws_err,"http://127.0.0.1:9/v1"),env_err,cols,rows,ws_err,tag+"_error")
    try:
      assert se.wait("Endpoint",10,"unreachable endpoint")
      states["endpoint_error"]=se.dump("endpoint-error")
      assert not color_codes(se.raw),(term,cols,rows,color_codes(se.raw))
    finally:
      se.close()
    required={"idle":"NEXUS","help":"Help","model_picker":"Select model","streaming":"Thinking about accessibility state","cancelled":"Cancelled","approval":"Approval needed","completion":"Done","tool_running":"sleep 20","tool_cancelled":"Cancelled","endpoint_error":"Endpoint"}
    for name,needle in required.items():
      assert needle.lower() in states[name].lower(),(term,cols,rows,name,needle,states[name])
    summary.append({"term":term,"size":f"{cols}x{rows}","states":sorted(states),"color_sgr":0,"result":"PASS"})
    print("PASS",term,f"{cols}x{rows}",",".join(sorted(states)),flush=True)
  finally:
    gw.terminate(); gw.wait(timeout=5)
print(json.dumps(summary,indent=2),flush=True)
