#!/usr/bin/env python3
"""Layer B: controlled engineering-task runs of UNMODIFIED Nexus under context conditions, via the experiment-only policy proxy.

For each (condition, seed): generate the fixture, preflight (objective delivery + verifier budget), start the proxy (c0 pass-through | c2 A1+E),
run `harness run -j` with the objective delivered as argv (never a pasted REPL prompt), then score deterministically (score.py) and record
turn semantics, steps, estimated context per request (proxy manifest) and gateway-side counters for the serving worker.

usage: run_layerB.py --seeds 1,2,3,4 --conditions c0,c2 --model engineering/deep --worker b0-live-llama-deep-worker2 --out results/layerB.jsonl [--steps 40]
"""
import argparse, json, os, random, shutil, subprocess, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
NEXUS = os.environ.get("NEXUS_DIST", "/tmp/nexus-snap/cli/dist/index.js")   # snapshot of committed dist (operator may rebuild the working tree)

def sh(cmd, **kw): return subprocess.run(cmd, shell=True, capture_output=True, text=True, errors="replace", **kw)
def token(): return open(os.path.expanduser("~/.config/opencode/t5820-client-token")).read().strip()
def counters(base, worker):
    req = urllib.request.Request(base + "/metrics", headers={"Authorization": f"Bearer {token()}"})
    d = {}
    for l in urllib.request.urlopen(req, timeout=15).read().decode().splitlines():
        if worker in l and not l.startswith("#"):
            k, _, v = l.rpartition(" ")
            for name in ("aihost_inference_prompt_tokens_total", "aihost_engine_prompt_tokens_total", "aihost_engine_prompt_tokens_cached_total", "aihost_inference_completion_tokens_total", "aihost_inference_completions_total"):
                if k.startswith(name):
                    try: d[name] = d.get(name, 0) + float(v)
                    except ValueError: pass
    return d

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default="1,2,3,4"); ap.add_argument("--conditions", default="c0,c2"); ap.add_argument("--model", default="engineering/deep")
    ap.add_argument("--worker", default="b0-live-llama-deep-worker2"); ap.add_argument("--out", required=True); ap.add_argument("--steps", type=int, default=40)
    ap.add_argument("--base", default="http://127.0.0.1:18010"); ap.add_argument("--port", type=int, default=18111)
    ap.add_argument("--hard", action="store_true"); ap.add_argument("--window", type=int, default=32000, help="context window W used by the *w conditions (Nexus fixed overhead ~9.1k + reserves ~12k must fit)")
    a = ap.parse_args()
    # condition -> (proxy policy, nexus --context-limit, proxy budget)
    CONDS = {"c0large": ("c0", None, 0), "c0w": ("c0", a.window, 0), "c2w": ("c2", 400000, a.window - 17000), "c2": ("c2", None, 0), "c0": ("c0", None, 0)}
    runs = [(c, int(s)) for s in a.seeds.split(",") for c in a.conditions.split(",")]
    random.Random(7).shuffle(runs)                                   # interleaved, fixed order
    home = "/tmp/layerB-home"; shutil.rmtree(home, ignore_errors=True); os.makedirs(home + "/.config/opencode"); shutil.copy(os.path.expanduser("~/.config/opencode/t5820-client-token"), home + "/.config/opencode/")
    out = open(a.out, "a")
    try:
        for run_i, (cond, seed) in enumerate(runs):
            port = a.port + run_i
            work = f"/tmp/layerB/{cond}-seed{seed}"; shutil.rmtree(work, ignore_errors=True); os.makedirs(work)
            sh(f"python3 {HERE}/make_fixture.py {work} --seed {seed}{' --hard' if a.hard else ''}")
            ws = work + "/ledger"
            sh("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base && printf '.nexus/\\nNOTES_FIX.md\\n' >> .git/info/exclude", cwd=ws)
            pf = sh(f"python3 {HERE}/preflight.py {ws}")
            row = {"cond": cond, "seed": seed, "model": a.model, "preflight": pf.stdout.strip().splitlines()[-1] if pf.stdout else "none"}
            if "PASS" not in pf.stdout: row["skipped"] = "preflight failed"; out.write(json.dumps(row) + "\n"); out.flush(); continue
            manifest = f"{work}/manifest.jsonl"
            pol, climit, budget = CONDS[cond]
            proxy = subprocess.Popen([sys.executable, f"{HERE}/policy_proxy.py", "--policy", pol, "--listen", str(port), "--upstream", a.base, "--manifest", manifest, "--budget", str(budget)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(1.2)
            c0 = counters(a.base, a.worker); t0 = time.time()
            objective = open(ws + "/OBJECTIVE.md").read()
            r = subprocess.run(["node", NEXUS, "run", "-w", ws, "-e", f"http://127.0.0.1:{port}/v1", "-m", a.model, "-s", str(a.steps)] + (["--context-limit", str(climit)] if climit else []) + ["-j", objective],
                               env=dict(os.environ, HOME=home), capture_output=True, text=True, errors="replace", timeout=3600)
            dur = time.time() - t0; c1 = counters(a.base, a.worker); proxy.terminate()
            open(work + "/nexus.stdout", "w").write(r.stdout); open(work + "/nexus.stderr", "w").write(r.stderr[-4000:])
            try: res, _ = json.JSONDecoder().raw_decode(r.stdout[r.stdout.index("{"):])
            except Exception: res = {}
            sc = json.loads(sh(f"python3 {HERE}/score.py {work}").stdout or "{}")
            man = [json.loads(l) for l in open(manifest)] if os.path.exists(manifest) else []
            row.update(duration_s=round(dur, 1), exit=r.returncode, turn={k: (res.get("turn") or {}).get(k) for k in ("execution", "outcome", "reason", "modelStop")},
                       steps=(res.get("turn") or {}).get("steps"), requests=len(man), peak_est_ctx=max([m["msgs_est_after"] for m in man] or [0]), cum_est_ctx=sum(m["msgs_est_after"] for m in man if m["msgs_est_after"] > 0),
                       cum_est_before=sum(m["msgs_est_before"] for m in man if m["msgs_est_before"] > 0), score=sc,
                       gateway_delta={k: c1.get(k, 0) - c0.get(k, 0) for k in c1}, evicted=sum(m.get("evicted", 0) for m in man), deduped=sum(m.get("deduped", 0) for m in man), capped=sum(m.get("capped", 0) for m in man))
            out.write(json.dumps(row) + "\n"); out.flush()
            print(cond, seed, row["turn"], sc, f"{dur:.0f}s", flush=True)
    finally:
        shutil.rmtree(home, ignore_errors=True)               # remove the copied credential

if __name__ == "__main__": main()
