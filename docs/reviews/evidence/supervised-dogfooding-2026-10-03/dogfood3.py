import repl_probe as r, time, pexpect, subprocess, os, re
S=r.S
def gw_start(scn, port):
    log=f"{S}/gw-{scn}.log"
    if os.path.exists(log): os.remove(log)
    return subprocess.Popen(["node", f"{S}/fakegw.mjs", str(port), scn, log], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# S5: gateway down at first prompt, then comes back
env = dict(os.environ, HOME=f"{S}/home", TERM="xterm", COLUMNS="140", LINES="50", LOCAL_LLM_ENDPOINT="http://127.0.0.1:19501/v1")
p = pexpect.spawn("node",[r.N,"repl","-e","http://127.0.0.1:19501/v1","-m","engineering/b0"],cwd=f"{S}/ws",env=env,encoding="utf-8",timeout=60)
r.wait_prompt(p)
p.sendline("hello while gateway is down"); r.wait_prompt(p,60)
o=r.clean(p.before); print("[S5 down] heading:", re.findall(r"═+ ([A-Z ]+[A-Z-]*) ═+", o), "| hint shown:", bool(re.search(r"endpoint|connect|refused|unreachable|fetch failed", o, re.I)))
print("   inference line:", re.findall(r"Inference [a-z_]+ \(origin[^\n]*", o)[:1])
gw=gw_start("echo",19501); time.sleep(0.8)
p.sendline("hello after gateway recovered"); r.wait_prompt(p,60)
o=r.clean(p.before); print("[S5 recovered] heading:", re.findall(r"═+ ([A-Z ]+[A-Z-]*) ═+", o))
p.sendline("/exit"); p.close(); gw.kill()
# S6: review mode + Ctrl-C at the approval prompt
subprocess.run("git checkout -q . && git clean -fdq -e .nexus", shell=True, cwd=f"{S}/ws")
gw=gw_start("noverify",19502); time.sleep(0.8)
env["LOCAL_LLM_ENDPOINT"]="http://127.0.0.1:19502/v1"
p = pexpect.spawn("node",[r.N,"repl","--approve","-e","http://127.0.0.1:19502/v1","-m","engineering/b0"],cwd=f"{S}/ws",env=env,encoding="utf-8",timeout=60)
r.wait_prompt(p)
p.sendline("create x.txt")
p.expect(r"Approve \[y\]es", timeout=30); print("[S6] approval prompt shown")
t=time.time(); p.sendintr()
idx=p.expect([r.PRM, pexpect.EOF, pexpect.TIMEOUT], timeout=20); o=r.clean(p.before)
print(f"[S6 ctrl-c at approval] -> {['prompt','EOF','TIMEOUT'][idx]} in {time.time()-t:.1f}s; x.txt exists: {os.path.exists(S+'/ws/x.txt')}; heading:", re.findall(r"═+ (TURN [A-Z ]+) ═+", o))
p.sendline("/exit"); p.close(); gw.kill()
# S7: review mode, answer 'n'
subprocess.run("git checkout -q . && git clean -fdq -e .nexus", shell=True, cwd=f"{S}/ws")
gw=gw_start("noverify",19503); time.sleep(0.8)
p = pexpect.spawn("node",[r.N,"repl","--approve","-e","http://127.0.0.1:19503/v1","-m","engineering/b0"],cwd=f"{S}/ws",env=env,encoding="utf-8",timeout=60)
r.wait_prompt(p); p.sendline("create x.txt"); p.expect(r"Approve \[y\]es", timeout=30); p.sendline("n")
r.wait_prompt(p,60); o=r.clean(p.before)
print("[S7 deny] x.txt exists:", os.path.exists(S+'/ws/x.txt'), "| headings:", re.findall(r"═+ ([A-Z][A-Z -]+[A-Z]) ═+", o), re.findall(r"execution=\S+ outcome=\S+[^\n]*", o))
p.sendline("/exit"); p.close(); gw.kill()
