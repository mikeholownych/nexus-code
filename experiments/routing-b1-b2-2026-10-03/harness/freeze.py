#!/usr/bin/env python3
"""freeze.py snapshot <out.json>  |  freeze.py verify   (compares live state to evidence/FROZEN_MANIFEST.json)"""
import json, sys, os, hashlib, glob, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); EV = os.path.join(HERE, "evidence")
def sh(c, cwd=None): return subprocess.run(c, shell=True, capture_output=True, text=True, cwd=cwd).stdout.strip()
def fh(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()
def snapshot():
    nx = os.path.expanduser("~/nexus-code"); dist = sorted(glob.glob(nx + "/cli/dist/*.js"))
    h = hashlib.sha256()
    for p in dist: h.update(os.path.basename(p).encode() + fh(p).encode())
    cfg = {}
    for l in open(os.path.expanduser("~/.config/nexus/config.env")).read().splitlines():
        k, _, v = l.partition("=")
        if k in ("LOCAL_LLM_ENDPOINT", "LOCAL_LLM_MODEL", "LOCAL_HARNESS_SHELL"): cfg[k] = v
    ah = os.path.expanduser("~/Projects/aihost")
    remote = json.loads(subprocess.run(["ssh", "10.0.8.5", "sudo python3 -"], input=open(os.path.join(HERE, "remote_snapshot.py")).read(), capture_output=True, text=True).stdout)
    return {"nexus": {"repo_head": sh("git rev-parse HEAD", nx), "src_fix_commit": sh("git rev-parse 01727b6", nx), "cli_src_clean": sh("git status --short cli/src cli/test cli/dist", nx) == "",
                      "dist_sha256": h.hexdigest(), "dist_files": {os.path.basename(p): fh(p) for p in dist}, "node": sh("node --version"), "config_env_nonsecret": cfg,
                      "default_temperature": 0.2, "max_steps": 25, "per_task_timeout_s": 900},
            "aihost_repo": {"head": sh("git rev-parse HEAD", ah), "gateway_code_commit": sh("git rev-parse 2d75d4c", ah)},
            "harness": {f: fh(os.path.join(HERE, f)) for f in ("nxbench2.py", "engx.py", "engx_tasks.py", "freeze.py", "remote_snapshot.py", "qualify.mjs")},
            "remote": remote}
VOLATILE = ("main_pid",)
def strip(d):
    if isinstance(d, dict): return {k: strip(v) for k, v in d.items() if k not in VOLATILE}
    return d
if sys.argv[1] == "snapshot":
    s = snapshot(); json.dump(s, open(sys.argv[2], "w"), indent=1, sort_keys=True); print("wrote", sys.argv[2])
else:
    m = json.load(open(os.path.join(EV, "FROZEN_MANIFEST.json"))); s = snapshot()
    diffs = []
    def cmp(a, b, path=""):
        if isinstance(a, dict) and isinstance(b, dict):
            for k in set(a) | set(b):
                if k in VOLATILE: continue
                cmp(a.get(k), b.get(k), f"{path}/{k}")
        elif a != b: diffs.append((path, a, b))
    cmp(m, s)
    print("FROZEN_STATE_MATCH" if not diffs else "FROZEN_STATE_DRIFT"); [print("  drift:", p, "| frozen:", str(a)[:80], "| live:", str(b)[:80]) for p, a, b in diffs]
    sys.exit(0 if not diffs else 1)
