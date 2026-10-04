import os, subprocess, time, pexpect, re, sys
sys.path.insert(0,'/tmp/inv'); import gw
N="/tmp/inv/cli/dist/index.js"; ws="/tmp/inv/ws1"; os.makedirs(ws,exist_ok=True); subprocess.run("git init -q",shell=True,cwd=ws)
env=dict(os.environ,HOME="/tmp/inv/home1",TERM="xterm"); os.makedirs("/tmp/inv/home1",exist_ok=True)
PRM=r"❯(\x1b\[[0-9;]*m)* "
def case(name, fn):
    gw.log.clear(); s=gw.start(); port=s.server_address[1]; fn(port); time.sleep(1.5); print(f"{name:46s} prompts reaching model: {gw.log}"); s.shutdown()
def pty(payload, delay=0):
    def f(port):
        p=pexpect.spawn("node",[N,"repl","-e",f"http://127.0.0.1:{port}/v1","-m","m"],cwd=ws,env=env,encoding="utf-8",timeout=30); p.expect(PRM)
        if delay:
            for ln in payload.split("\n"): p.send(ln+"\n"); time.sleep(delay)
        else: p.send(payload)
        time.sleep(6); p.send("/exit\n"); time.sleep(.5); p.close(force=True)
    return f
def piped(payload):
    def f(port):
        subprocess.run(["node",N,"repl","-e",f"http://127.0.0.1:{port}/v1","-m","m"],cwd=ws,env=env,input=payload,text=True,capture_output=True,timeout=60)
    return f
M="alpha objective\nbeta constraint\ngamma success\n"
case("A pty: 3 lines in ONE write (paste)", pty(M))
case("B pty: 3 lines typed 1.5s apart", pty(M,1.5))
case("C pty: bracketed-paste markers + 3 lines", pty("\x1b[200~alpha objective\nbeta constraint\ngamma success\x1b[201~\n"))
case("D pty: first line then /exit pasted in 1 write", pty("do the work\n/exit\n"))
case("E pty: documented continuation (backslash)", pty("alpha \\\nbeta \\\ngamma\n"))
case("F piped stdin: 3 lines", piped(M))
case("G piped stdin: 3 lines + trailing /exit", piped(M+"/exit\n"))
