#!/usr/bin/env python3
"""Paired-experiment harness (B1/B2). Frozen rules - classification and acceptance are defined here BEFORE any run.
usage: nxbench2.py <arm-label> <B1|B2>
 B1: single model (config default engineering/b0).  B2: PLANNER=engineering/deep, CODER=engineering/lead.
Refuses to run unless the frozen manifest matches the live state (Nexus dist hash, harness hashes)."""
import os, sys, json, time, shutil, subprocess, tempfile, re, hashlib, glob
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import engx
from engx_tasks import TASKS
label, arm = sys.argv[1], sys.argv[2]
assert arm in ("B1", "B2")
MANIFEST = json.load(open(os.path.join(HERE, "evidence", "FROZEN_MANIFEST.json")))
def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()
def dist_hash():
    h = hashlib.sha256()
    for p in sorted(glob.glob(os.path.expanduser("~/nexus-code/cli/dist/*.js"))): h.update(os.path.basename(p).encode() + sha(p).encode())
    return h.hexdigest()
live = {"nexus_dist_sha256": dist_hash(), "harness": {f: sha(os.path.join(HERE, f)) for f in ("nxbench2.py", "engx.py", "engx_tasks.py")}}
assert live["nexus_dist_sha256"] == MANIFEST["nexus"]["dist_sha256"], "Nexus dist differs from frozen manifest - refusing to run"
assert all(MANIFEST["harness"][f] == h for f, h in live["harness"].items()), "harness files differ from frozen manifest - refusing to run"

_SP = [os.path.expanduser("~/.local/lib/python3.12/site-packages")]
def _sb(root, target, timeout=90):
    mounts = (["--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64"] if os.path.islink("/bin") else ["--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64"])
    ro = sum([["--ro-bind", p, p] for p in _SP], [])
    cmd = ["bwrap", "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc/alternatives", "/etc/alternatives", *mounts, *ro, "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
           "--bind", root, root, "--chdir", root, "--unshare-all", "--die-with-parent", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
           "--setenv", "PYTHONPATH", ":".join([root] + _SP), "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
           "timeout", str(timeout), "python3", "-m", "pytest", "-q", "-x", "--no-header", "-p", "no:cacheprovider", "-rN", "--tb=short", target]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 15); return r.returncode == 0, r.stdout + r.stderr
    except Exception as e: return False, repr(e)
engx.sandbox_pytest = _sb

HARNESS = os.path.expanduser("~/nexus-code/cli/dist/index.js")
OUTDIR = os.path.join(HERE, "evidence", label); os.makedirs(OUTDIR, exist_ok=True)
env = {**os.environ, "NO_COLOR": "1"}
for k in ("PLANNER_LLM_MODEL", "CODER_LLM_MODEL", "NEXUS_TASK_CLASS", "PLANNER_TASK_CLASS"): env.pop(k, None)
if arm == "B2": env.update(PLANNER_LLM_MODEL="engineering/deep", CODER_LLM_MODEL="engineering/lead")
MAX_STEPS, TIMEOUT = 25, 900

def classify(ok, out, steps, done, timed_out):
    """Fixed rules, applied mechanically."""
    if ok: return "validated"
    if timed_out: return "timeout"
    m = re.search(r"Fatal error communicating with LLM server: (.{0,80})", out)
    if m: return "inference_error"
    if done: return "false_completion"          # agent declared TASK COMPLETED but hidden/visible validation fails
    if steps >= MAX_STEPS: return "step_limit_not_done"
    return "stopped_not_done"

rows = []
for task in TASKS:
    if task.get("mutation"): continue                      # T11 excluded (previously established reason)
    d = tempfile.mkdtemp(prefix="nx_", dir="/tmp"); engx.write_tree(d, task["files"]); engx.write_tree(d, task["visible"])
    subprocess.run(["git", "init", "-q", d]); subprocess.run(["git", "-C", d, "add", "-A"]); subprocess.run(["git", "-C", d, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"])
    cmd = ["node", HARNESS, "run", "--max-steps", str(MAX_STEPS), "--workspace", d, task["instruction"] + " Run the tests under tests/ with pytest to verify before finishing."]
    t0 = time.time(); t0_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t0))
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT, cwd=d, env=env); out = r.stdout + r.stderr; to = False
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or ""); to = True
    secs = time.time() - t0
    open(os.path.join(OUTDIR, f"{task['id']}.transcript.txt"), "w").write(out)
    files = {}
    for root, dirs, fs in os.walk(d):
        dirs[:] = [x for x in dirs if x not in (".git", "__pycache__", ".nexus", "tests", "hidden")]
        for f in fs:
            if f.endswith(".py"): files[os.path.relpath(os.path.join(root, f), d)] = open(os.path.join(root, f)).read()
    ok, stage, msg = engx.validate(task, d, files)
    clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", out)
    steps = len(re.findall(r"STEP \d+/\d+", clean)); done = "TASK COMPLETED" in clean
    req_ids = re.findall(r"request_id=([0-9a-f-]{36})", clean)
    row = {"task": task["id"], "arm": arm, "label": label, "start_utc": t0_iso, "secs": round(secs, 1), "steps": steps, "declared_done": done, "validated": ok, "stage": stage,
           "classification": classify(ok, clean, steps, done, to), "request_ids": req_ids, "validation_msg": msg[:300]}
    rows.append(row); json.dump(rows, open(os.path.join(OUTDIR, "results.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in row.items() if k != "request_ids"}), flush=True)
    shutil.rmtree(d, ignore_errors=True)
n = len(rows); print("SUMMARY", label, arm, f"validated {sum(r['validated'] for r in rows)}/{n}")
