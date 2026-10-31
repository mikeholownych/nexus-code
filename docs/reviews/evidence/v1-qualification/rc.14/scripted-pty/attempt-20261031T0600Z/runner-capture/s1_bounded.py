import json, os, time
from ptylib import Session, make_env, tui_argv
endpoint="http://127.0.0.1:9/v1"
env, workspace, home = make_env("s1_bounded", endpoint)
s=Session(tui_argv(workspace, endpoint), env, 100, 30, workspace, "s1_bounded")
start=time.monotonic(); out={"limit_seconds":150,"endpoint":endpoint,"workspaceIsolated":os.path.commonpath([workspace,os.path.join(os.path.dirname(__file__),"runs")])==os.path.join(os.path.dirname(__file__),"runs")}
try:
    out["initialPrompt"]=s.wait("enter send",15,"startup-prompt")
    s.send("say hello\r",label="start unreachable endpoint scenario")
    deadline=start+150
    def terminal(screen):
        text=screen.lower()
        return ("turn ended" in text or "enter send" in text) and ("endpoint" in text or "temporarily unavailable" in text)
    out["naturalTurnEndWithinLimit"]=s.wait(terminal,max(0,deadline-time.monotonic()),"natural-end-guidance")
    out["elapsedSeconds"]=round(time.monotonic()-start,3)
    out["finalScreen"]=s.dump("bounded-final")
    lower=s.text().lower()
    out["endpointNamed"]=endpoint in lower
    out["fixHint"]=any(x in lower for x in ["check local_llm_endpoint","nexus doctor","/connect"])
finally:
    if s.alive():
        s.send(b"\x03",label="cancel after bounded observation")
        s.pump(1)
    s.close()
with open("s1-bounded-status.json","x") as f: json.dump(out,f,indent=2)
print(json.dumps({k:v for k,v in out.items() if k!="finalScreen"},sort_keys=True))
