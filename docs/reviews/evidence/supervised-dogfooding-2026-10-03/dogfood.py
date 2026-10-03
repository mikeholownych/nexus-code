import pexpect, sys, os, re, time, subprocess, json
S = "/tmp/claude-1000/-home-mike-nexus-code/f49bb728-a69a-48c0-89ef-013caf5b0791/scratchpad"
N = "/home/mike/nexus-code/cli/dist/index.js"
ansi = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
PRM = r"❯(\x1b\[[0-9;]*m)* "
def clean(s): return ansi.sub("", s)

def spawn(extra=(), env_extra=None, cwd=f"{S}/proj"):
    env = dict(os.environ, HOME=f"{S}/rhome", TERM="xterm", COLUMNS="140", LINES="50")
    if env_extra: env.update(env_extra)
    p = pexpect.spawn("node", [N, "repl", *extra], cwd=cwd, env=env, encoding="utf-8", timeout=300, dimensions=(50, 140))
    p.logfile_read = open(f"{S}/dogfood-transcript.txt", "a")
    return p

def turn(p, text, timeout=300, label=None):
    t0 = time.time()
    p.sendline(text)
    idx = p.expect([PRM, pexpect.EOF, pexpect.TIMEOUT], timeout=timeout)
    dur = time.time() - t0
    out = clean(p.before)
    m = re.search(r"═+ (TASK COMPLETED[^═]*|TURN [A-Z ]+[^═]*|STEP LIMIT REACHED) ═+", out)
    line = re.search(r"execution=\S+ outcome=\S+[^\n]*", out)
    print(f"[{label or text[:40]}] {dur:.0f}s heading={m.group(1).strip() if m else None} | {line.group(0).strip() if line else None}")
    return out

def sh(cmd):
    return subprocess.run(cmd, shell=True, cwd=f"{S}/proj", capture_output=True, text=True).stdout

if __name__ == "__main__":
    open(f"{S}/dogfood-transcript.txt", "w").close()
    p = spawn()
    p.expect(PRM, timeout=30)
    o = turn(p, "The test suite is failing. Find the cause(s) in src/ and fix them without changing the tests. Run the tests to confirm.", label="T1 fix failing tests")
    print(sh("git diff --stat; npm test 2>&1 | grep -E '^# (pass|fail)'"))
    o = turn(p, "Add a function clamp(x, lo, hi) to src/math.js with tests in test/math.test.js, and make sure all tests pass.", label="T2 add feature")
    print(sh("git status --short; npm test 2>&1 | grep -E '^# (pass|fail)'"))
    o = turn(p, "Without changing anything, which functions does src/math.js export and which of them have tests? Be brief.", label="T3 read-only question")
    p.sendline("/status"); p.expect(PRM, timeout=20)
    p.sendline("/exit"); p.expect(pexpect.EOF, timeout=20)
    print("S1 done; exit", p.exitstatus)
