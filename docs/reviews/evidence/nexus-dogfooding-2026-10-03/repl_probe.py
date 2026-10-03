import pexpect, sys, os, re, time, subprocess, signal
S = "/tmp/claude-1000/-home-mike-nexus-code/f49bb728-a69a-48c0-89ef-013caf5b0791/scratchpad"
N = "/home/mike/nexus-code/cli/dist/index.js"
ansi = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")

def start(scenario, port, extra_args=(), env_extra=None):
    log = f"{S}/gw-{scenario}.log"
    if os.path.exists(log): os.remove(log)
    gw = subprocess.Popen(["node", f"{S}/fakegw.mjs", str(port), scenario, log], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.7)
    subprocess.run("git checkout -q . && git clean -fdq", shell=True, cwd=f"{S}/ws")
    for f in (f"{S}/home/.nexus_history",):
        if os.path.exists(f): os.remove(f)
    env = dict(os.environ, HOME=f"{S}/home", LOCAL_LLM_ENDPOINT=f"http://127.0.0.1:{port}/v1", TERM="xterm", COLUMNS="120", LINES="40")
    if env_extra: env.update(env_extra)
    p = pexpect.spawn("node", [N, "repl", "-m", "engineering/b0", *extra_args], cwd=f"{S}/ws", env=env, encoding="utf-8", timeout=20, dimensions=(40, 120))
    return gw, p, log

def clean(s): return ansi.sub("", s)

PRM = r"❯(\x1b\[[0-9;]*m)* "
PROMPT = r"nexus \(engineering/b0\) ws:?\S* ❯"
def wait_prompt(p, t=20):
    p.expect(PRM, timeout=t)

def scen_multi():
    gw, p, log = start("echo", 19201)
    wait_prompt(p)
    for i in (1, 2, 3):
        p.sendline(f"task number {i}")
        wait_prompt(p, 30)
        print(f"[multi] prompt {i} returned OK")
    p.sendline("/exit"); p.expect(pexpect.EOF, timeout=10)
    gw.kill()
    for l in open(log):
        import json; j = json.loads(l); print("  req", j["n"], "msgs", j["msgs"], "last", j["last"])

def scen_typeahead():
    gw, p, log = start("slow", 19202)
    wait_prompt(p)
    p.sendline("first slow task")
    time.sleep(1.5)
    p.sendline("second typed during run")   # typed while agent is running
    wait_prompt(p, 30)                      # prompt after first
    time.sleep(1.0)
    out_before = len(open(log).readlines())
    # does the typed-ahead line get consumed as a prompt?
    try:
        p.expect(r"SLOW-DONE for: second", timeout=10)
        print("[typeahead] second line WAS processed (queued)")
    except pexpect.TIMEOUT:
        print("[typeahead] second line NOT processed within 10s; gateway requests so far:", len(open(log).readlines()))
    p.sendline("/exit");
    try: p.expect(pexpect.EOF, timeout=10)
    except Exception: pass
    gw.kill()

def scen_ctrlc_run():
    gw, p, log = start("slow", 19203)
    wait_prompt(p)
    p.sendline("slow task to interrupt")
    time.sleep(1.5)
    p.sendintr()          # Ctrl-C while agent run in flight
    t0 = time.time()
    idx = p.expect([PRM, pexpect.EOF, pexpect.TIMEOUT], timeout=15)
    print(f"[ctrlc-run] result={['prompt','EOF','TIMEOUT'][idx]} after {time.time()-t0:.1f}s; alive={p.isalive()}")
    if p.isalive():
        p.sendline("/exit")
        try: p.expect(pexpect.EOF, timeout=10)
        except Exception: pass
    print("[ctrlc-run] exitstatus", p.exitstatus, "signalstatus", p.signalstatus)
    gw.kill()

def scen_ctrlc_idle():
    gw, p, log = start("echo", 19204)
    wait_prompt(p)
    p.sendintr()
    idx = p.expect([PRM, pexpect.EOF, pexpect.TIMEOUT], timeout=5)
    print(f"[ctrlc-idle] result={['prompt','EOF','TIMEOUT'][idx]}; alive={p.isalive()}")
    gw.kill()

def scen_crash_history_run():
    gw, p, log = start("echo", 19205, extra_args=("--context-limit", "300"))
    wait_prompt(p)
    p.sendline("hello there")
    wait_prompt(p, 30)
    print("[crash] first prompt returned to prompt (tiny context limit)")
    p.sendline("/history run 1")
    idx = p.expect([PRM, pexpect.EOF, pexpect.TIMEOUT], timeout=20)
    print(f"[crash] after '/history run 1': {['prompt','EOF','TIMEOUT'][idx]}")
    time.sleep(0.5)
    tail = clean(p.before or "")[-600:]
    print("  tail:", tail.replace("\n", " | ")[-500:])
    gw.kill()

def scen_tui():
    gw, p, log = start("echo", 19206)
    wait_prompt(p)
    p.sendline("/tui")
    time.sleep(1.0)
    p.send("q")
    time.sleep(0.8)
    # now type a command and see what the prompt line contains
    p.send("/status")
    time.sleep(0.5)
    p.send("\r")
    time.sleep(1.0)
    out = clean(p.read_nonblocking(20000, timeout=2))
    m = re.search(r"Unknown command: /(\S+)", out)
    print("[tui] after /tui + 'q' then '/status': unknown-command=", m.group(0) if m else None, "| status-shown=", "Session Status" in out)
    p.sendline("/exit");
    try: p.expect(pexpect.EOF, timeout=5)
    except Exception: pass
    gw.kill()

def scen_http500_recover():
    gw, p, log = start("http500", 19207)
    wait_prompt(p)
    p.sendline("do thing one"); wait_prompt(p, 20)
    p.sendline("do thing two"); wait_prompt(p, 20)
    print("[500] REPL survived two failed turns")
    p.sendline("/exit")
    try: p.expect(pexpect.EOF, timeout=5)
    except Exception: pass
    gw.kill()
    import json
    for l in open(log):
        j = json.loads(l); print("  req", j["n"], "msgs", j["msgs"], "last", j["last"])

def scen_ctrlc_slowloop():
    gw, p, log = start("slowloop", 19208, extra_args=("-s", "8"))
    wait_prompt(p)
    p.sendline("write files forever")
    time.sleep(3.0)
    files0 = sorted(f for f in os.listdir(f"{S}/ws") if f.startswith("loop_"))
    p.sendintr()
    print("[slowloop] files at Ctrl-C:", files0)
    time.sleep(7.0)
    files1 = sorted(f for f in os.listdir(f"{S}/ws") if f.startswith("loop_"))
    print("[slowloop] 7s after Ctrl-C: files:", files1, "| process alive:", p.isalive())
    if p.isalive():
        p.sendintr()   # second Ctrl-C
        time.sleep(2)
        print("[slowloop] after 2nd Ctrl-C alive:", p.isalive(), "signalstatus", p.signalstatus, "exit", p.exitstatus)
    files2 = sorted(f for f in os.listdir(f"{S}/ws") if f.startswith("loop_"))
    print("[slowloop] final files:", files2)
    gw.kill()

def scen_crash_image():
    gw, p, log = start("echo", 19209, extra_args=("--context-limit", "300"))
    wait_prompt(p)
    p.sendline("/image pic.png describe")
    idx = p.expect([PRM, pexpect.EOF, pexpect.TIMEOUT], timeout=20)
    print("[crash-image] /image with tiny context limit ->", ['prompt','EOF (REPL process ended)','TIMEOUT'][idx])
    time.sleep(0.5)
    print("  tail:", clean(p.before or "")[-700:].replace("\n"," | "))
    if p.isalive(): p.close(force=True)
    else: p.close(); print("  exitstatus", p.exitstatus, "signalstatus", p.signalstatus)
    gw.kill()

def scen_crash_compact():
    gw, p, log = start("http500", 19210)
    wait_prompt(p)
    p.sendline("a"); wait_prompt(p, 20)
    p.sendline("/compact --llm")
    idx = p.expect([PRM, pexpect.EOF, pexpect.TIMEOUT], timeout=20)
    print("[crash-compact] /compact --llm on failing endpoint ->", ['prompt','EOF (REPL process ended)','TIMEOUT'][idx])
    print("  tail:", clean(p.before or "")[-500:].replace("\n"," | "))
    gw.kill()

if __name__ == "__main__":
    globals()["scen_" + sys.argv[1]]()
