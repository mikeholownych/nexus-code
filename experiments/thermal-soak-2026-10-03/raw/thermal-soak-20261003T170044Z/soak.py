#!/usr/bin/env python3
"""Sustained-inference thermal soak. Normal workload characterisation only: it never drives toward the reported
critical limits, and it stops generating load if any GPU sensor reaches the existing 90 C guardrail.

  Phases (seconds scaled by SOAK_SCALE):  baseline idle 120 | decode-heavy 1320 | prefill-heavy 1320 | cooldown 480
  Both GPUs are loaded the whole time through the gateway aliases engineering/lead (GPU0) and engineering/deep (GPU1).
Evidence goes to /var/lib/local-ai/evidence/thermal-soak-<utc>/ (samples.jsonl at 1 Hz, requests.jsonl, engine.jsonl,
events.jsonl, meta.json, soak.py)."""
import glob, hashlib, json, os, platform, random, re, subprocess, sys, threading, time, urllib.request
SCALE = float(os.environ.get("SOAK_SCALE", "1"))
PHASES = [("baseline", 120, None), ("decode", 1320, "decode"), ("prefill", 1320, "prefill"), ("cooldown", 480, None)]
SAFETY_C = 90.0
STAMP = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
OUT = os.environ.get("SOAK_OUT") or f"/var/lib/local-ai/evidence/thermal-soak-{STAMP}"
os.makedirs(OUT, exist_ok=True)
TOKEN = open("/etc/local-ai/orchestrator/client-token").read().strip()
GW = "http://127.0.0.1:8010"
def rd(p):
    try: return open(p).read().strip()
    except Exception: return None
def num(v):
    try: return float(v)
    except Exception: return None
# ---------------------------------------------------------------- topology
gpus = {}
for h in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
    if rd(h + "/name") == "xe":
        gpus[os.path.basename(os.path.realpath(h + "/device"))] = h
ORDER = sorted(gpus)
def gt_dirs(bdf): return sorted(glob.glob(f"/sys/bus/pci/devices/{bdf}/tile0/gt*"))
def meta():
    m = {"started_utc": STAMP, "scale": SCALE, "phases": PHASES, "safety_stop_c": SAFETY_C, "kernel": platform.release(),
         "script_sha256": hashlib.sha256(open(__file__, "rb").read()).hexdigest(),
         "dmi": {k: rd(f"/sys/devices/virtual/dmi/id/{k}") for k in ("product_name", "bios_version", "bios_date")},
         "gateway_release": os.path.realpath("/proc/%s/cwd" % subprocess.run(["systemctl", "show", "aihost-orchestrator-gateway", "-p", "MainPID", "--value"], capture_output=True, text=True).stdout.strip()),
         "gpus": {}}
    for i, bdf in enumerate(ORDER):
        h = gpus[bdf]; g = {"ordinal": i, "hwmon": os.path.basename(h), "limits": {}, "power_cap_uw": rd(h + "/power1_cap"), "power_crit_uw": rd(h + "/power1_crit"), "gt": {}}
        for t in sorted(glob.glob(h + "/temp*_input")):
            b = t[:-6]; lab = rd(b + "_label")
            g["limits"][lab] = {k: num(rd(f"{b}_{k}")) for k in ("crit", "emergency", "max") if rd(f"{b}_{k}") is not None}
        for gt in gt_dirs(bdf):
            g["gt"][os.path.basename(gt)] = {k: rd(f"{gt}/freq0/{k}") for k in ("rp0_freq", "rpn_freq", "max_freq", "min_freq")}
        m["gpus"][bdf] = g
    m["dell_smm_temp_inputs_unlabeled"] = sorted(os.path.basename(p) for p in glob.glob("/sys/class/hwmon/hwmon*/temp*_input") if rd(os.path.dirname(p) + "/name") == "dell_smm")
    return m
json.dump(meta(), open(OUT + "/meta.json", "w"), indent=1)
open(OUT + "/soak.py", "w").write(open(__file__).read())
ev = open(OUT + "/events.jsonl", "a", buffering=1)
def event(kind, **kw): ev.write(json.dumps({"t": round(time.time() - T0, 3), "ts": time.time(), "event": kind, **kw}) + "\n")
# ---------------------------------------------------------------- sampler
T0 = time.time(); phase = {"name": "init"}; stop_load = threading.Event(); stop_all = threading.Event(); safety = {"tripped": False}
_last_cpu = {}
def cpu_busy():
    out = {}
    for line in (rd("/proc/stat") or "").splitlines():
        if line.startswith("cpu") and line[3:4].isdigit():
            f = line.split(); name = f[0]; vals = [int(x) for x in f[1:9]]; idle = vals[3] + vals[4]; tot = sum(vals)
            p = _last_cpu.get(name); _last_cpu[name] = (tot, idle)
            if p and tot > p[0]: out[name] = round(100 * (1 - (idle - p[1]) / (tot - p[0])), 1)
    return out
def sample():
    row = {"t": round(time.time() - T0, 3), "ts": time.time(), "phase": phase["name"], "gpu": {}, "host": {}}
    for i, bdf in enumerate(ORDER):
        h = gpus[bdf]; g = {"temps": {}, "energy_uj": {}, "fan_rpm": num(rd(h + "/fan1_input")), "gt": {}}
        for t in glob.glob(h + "/temp*_input"):
            v = num(rd(t)); lab = rd(t[:-6] + "_label")
            if v is not None and lab: g["temps"][lab] = v / 1000
        for e in glob.glob(h + "/energy*_input"):
            lab = rd(e[:-6] + "_label"); v = num(rd(e))
            if lab and v is not None: g["energy_uj"][lab] = v
        for gt in gt_dirs(bdf):
            th = f"{gt}/freq0/throttle"
            g["gt"][os.path.basename(gt)] = {"idle_ms": num(rd(gt + "/gtidle/idle_residency_ms")), "act_mhz": num(rd(gt + "/freq0/act_freq")), "cur_mhz": num(rd(gt + "/freq0/cur_freq")),
                "throttle_status": rd(th + "/status"), "reasons": rd(th + "/reasons"),
                "flags": {r: rd(f"{th}/reason_{r}") for r in ("thermal", "pl1", "pl2", "pl4", "prochot", "ratl", "vr_thermalert", "vr_tdc")}}
        row["gpu"][bdf] = g
    for h in glob.glob("/sys/class/hwmon/hwmon*"):
        n = rd(h + "/name")
        if n == "coretemp":
            row["host"]["cpu_temps"] = {rd(t[:-6] + "_label"): num(rd(t)) / 1000 for t in glob.glob(h + "/temp*_input") if num(rd(t)) is not None}
        elif n == "dell_smm":
            row["host"]["dell_smm_temps"] = {os.path.basename(t)[:-6]: num(rd(t)) / 1000 for t in sorted(glob.glob(h + "/temp*_input")) if num(rd(t)) is not None}
            row["host"]["chassis_fan_rpm"] = {os.path.basename(f)[:-6]: num(rd(f)) for f in sorted(glob.glob(h + "/fan*_input"))}
        elif n == "nvme":
            row["host"].setdefault("nvme_composite_c", []).append(num(rd(h + "/temp1_input")) / 1000)
    row["host"]["cpu_busy_pct"] = cpu_busy()
    hot = max((v for g in row["gpu"].values() for v in g["temps"].values()), default=0)
    row["hottest_gpu_sensor_c"] = hot
    if hot >= SAFETY_C and not safety["tripped"]:
        safety["tripped"] = True; stop_load.set(); event("safety_stop", hottest_c=hot, guardrail_c=SAFETY_C)
    return row
def sampler():
    f = open(OUT + "/samples.jsonl", "a", buffering=1); nxt = time.time()
    while not stop_all.is_set():
        f.write(json.dumps(sample()) + "\n"); nxt += 1.0
        time.sleep(max(0.0, nxt - time.time()))
def engine_poller():
    f = open(OUT + "/engine.jsonl", "a", buffering=1)
    while not stop_all.is_set():
        try:
            txt = urllib.request.urlopen(GW + "/metrics", timeout=5).read().decode(); d = {}
            for l in txt.splitlines():
                if l.startswith("aihost_engine_") or l.startswith("aihost_worker_inflight") or l.startswith("aihost_inference_completions_total"):
                    k, v = l.rsplit(" ", 1); d[k] = float(v)
            f.write(json.dumps({"t": round(time.time() - T0, 3), "phase": phase["name"], "metrics": d}) + "\n")
        except Exception as e: f.write(json.dumps({"t": round(time.time() - T0, 3), "error": str(e)}) + "\n")
        stop_all.wait(10)
# ---------------------------------------------------------------- load
TOPICS = ["the history of the telescope", "how transistors work", "the economics of renewable energy", "the Roman road network", "plate tectonics", "the development of the printing press", "cryptography from Caesar to elliptic curves", "the human immune system"]
WORDS = open("/usr/share/dict/words").read().split()[:20000] if os.path.exists("/usr/share/dict/words") else [f"term{i}" for i in range(4000)]
reqlog = open(OUT + "/requests.jsonl", "a", buffering=1); reqlock = threading.Lock(); counter = {"n": 0}
def post(model, content, max_tokens, kind):
    body = {"model": model, "messages": [{"role": "user", "content": content}], "max_tokens": max_tokens, "temperature": 0.7, "chat_template_kwargs": {"enable_thinking": False}}
    t1 = time.time(); rec = {"model": model, "kind": kind, "phase": phase["name"], "t_start": round(t1 - T0, 3)}
    try:
        r = json.loads(urllib.request.urlopen(urllib.request.Request(GW + "/v1/chat/completions", json.dumps(body).encode(), {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}), timeout=600).read())
        rec.update(status=200, prompt_tokens=r["usage"]["prompt_tokens"], completion_tokens=r["usage"]["completion_tokens"])
    except Exception as e: rec.update(status=0, error=str(e)[:120])
    rec["t_end"] = round(time.time() - T0, 3); rec["secs"] = round(time.time() - t1, 2)
    with reqlock: reqlog.write(json.dumps(rec) + "\n")
def worker(model, decode_tokens):
    rng = random.Random(hash(model) & 0xffff)
    while not (stop_load.is_set() or stop_all.is_set()):
        kind = phase.get("load")
        if kind == "decode":
            post(model, f"Write a comprehensive, very detailed essay on {rng.choice(TOPICS)}, with many sections and examples.", decode_tokens, "decode")
        elif kind == "prefill":
            counter["n"] += 1; r2 = random.Random(counter["n"] * 7919)
            text = " ".join(r2.choice(WORDS) for _ in range(3000))     # ~14k tokens: the mean agent context on this host
            post(model, text + "\n\nIgnore the text above and answer: what is 2+2? Reply with one short sentence.", 48, "prefill")
        else: time.sleep(0.5)
def main():
    event("start", out=OUT); threading.Thread(target=sampler, daemon=True).start(); threading.Thread(target=engine_poller, daemon=True).start()
    ws = [threading.Thread(target=worker, args=("engineering/lead", 1500), daemon=True), threading.Thread(target=worker, args=("engineering/deep", 700), daemon=True)]
    [w.start() for w in ws]
    for name, secs, load in PHASES:
        phase["name"] = name; phase["load"] = None if safety["tripped"] else load; event("phase", name=name, planned_secs=secs * SCALE, load=load)
        end = time.time() + secs * SCALE
        while time.time() < end and not stop_all.is_set():
            if safety["tripped"]: phase["load"] = None
            time.sleep(0.5)
    phase["name"] = "done"; phase["load"] = None; event("finished", safety_tripped=safety["tripped"])
    time.sleep(3); stop_all.set(); stop_load.set(); time.sleep(2)
    print("soak finished; evidence:", OUT, "| safety tripped:", safety["tripped"])
main()
