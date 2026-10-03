#!/usr/bin/env python3
"""Second, deliberately different implementation used to cross-check the published soak numbers.

Differences from analyze.py on purpose: generic recursive data walking (no hard-coded record layout), regex counting
of throttle flags straight from the raw text, Theil-Sen slopes on 10 s decimated points, rise time = first sustained
(5 consecutive samples) crossing of the *unsmoothed* signal, a different single-sample-spike definition (+-2 neighbours),
phase membership taken from each sample's own phase label, and request time assigned by completion time.
It does NOT reuse any code from analyze.py. Same author, so this is a second implementation, not third-party review."""
import hashlib, json, math, os, re, statistics as st, sys
RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw", "thermal-soak-20261003T170044Z")
SUM = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "summary.json")))
results = []
def check(name, published, recomputed, tol, unit=""):
    ok = abs(published - recomputed) <= tol
    results.append(ok); print(f"  [{'OK  ' if ok else 'DIFF'}] {name:58s} published {published:>9.2f}  recomputed {recomputed:>9.2f}  (tol {tol}{unit})")
def exact(name, published, recomputed):
    ok = published == recomputed; results.append(ok); print(f"  [{'OK  ' if ok else 'DIFF'}] {name:58s} published {published!s:>9}  recomputed {recomputed!s:>9}")
print("0. INTEGRITY: raw files against the hashes taken on the host")
host = dict(l.split()[::-1] for l in open(os.path.join(RAW, "..", "host-sha256.txt")).read().splitlines())
bad = [f for f, h in host.items() if hashlib.sha256(open(os.path.join(RAW, f), "rb").read()).hexdigest() != h]
exact("files whose hash differs from the host copy", 0, len(bad))
raw_lines = open(os.path.join(RAW, "samples.jsonl")).read().splitlines(); rows = [json.loads(l) for l in raw_lines]
def walk(o, path=()):
    if isinstance(o, dict):
        for k, v in o.items(): yield from walk(v, path + (k,))
    else: yield path, o
def per_gpu(row, key):          # all (gpu, subpath, value) whose path contains `key`
    return [(p[1], p[p.index(key) + 1:], v) for p, v in walk(row["gpu"], ("gpu",)) if key in p]
gpus = sorted(rows[0]["gpu"]); t = [r["t"] for r in rows]; phase = [r["phase"] for r in rows]
loaded = [i for i, p in enumerate(phase) if p in ("decode", "prefill")]
print("\n1. RUN SHAPE")
exact("samples", 3244, len(rows)); exact("loaded samples (decode+prefill, by each sample's own label)", 2640, len(loaded))
print("\n2. THROTTLE FLAGS, counted by regex on the raw text (independent of record layout)")
thermalish = sum(len(re.findall(r'"(?:thermal|prochot|vr_thermalert|ratl)": "(?!0")[^"]*"', l)) for l in raw_lines)
exact("non-zero thermal/prochot/vr_thermalert/ratl flags in whole run", 0, thermalish)
pl2_by_gpu = {g: 0 for g in gpus}; loaded_pl2 = {g: 0 for g in gpus}
for i, r in enumerate(rows):
    for g, sub, v in per_gpu(r, "flags"):
        if sub[0] if False else (sub and sub[-1] == "pl2") and v not in (None, "0"):
            pl2_by_gpu[g] += 1; loaded_pl2[g] += i in set(loaded)
exact("GPU0 PL2 samples (any phase)", 0, pl2_by_gpu[gpus[0]]); exact("GPU1 PL2 samples (any phase)", SUM["flags_whole_run"].get("gpu1.gt0.pl2", 0), pl2_by_gpu[gpus[1]])
check("GPU1 PL2 share of loaded samples (%)", 94.0, 100 * loaded_pl2[gpus[1]] / len(loaded), 0.2, " pp")
print("\n3. PLATEAUS AND SLOPES (last 300 s of each load phase)")
def series(g, name): return [r["gpu"][g]["temps"][name] for r in rows]
def window(p, a, b): return [i for i in range(len(rows)) if phase[i] == p and a <= t[i] < b]
def theil_sen(xs, ys):
    pts = list(zip(xs[::10], ys[::10])); sl = [(y2 - y1) / (x2 - x1) for k, (x1, y1) in enumerate(pts) for (x2, y2) in pts[k + 1:] if x2 > x1]
    return 60 * st.median(sl)
wins = {"decode": (1140, 1440), "prefill": (2461, 2761)}; worst_slope = 0
for gi, g in enumerate(gpus):
    for name, key in (("pkg", "pkg"), ("vram", "vram")):
        y = series(g, key)
        for p, (a, b) in wins.items():
            idx = window(p, a, b); yy = [y[i] for i in idx]; pub = SUM["temps"][f"gpu{gi}"][name][p]
            check(f"gpu{gi} {name} {p} steady-state mean (C)", pub["mean"], st.mean(yy), 0.15)
            exact(f"gpu{gi} {name} {p} steady-state min / max", f'{pub["min"]:.0f}/{pub["max"]:.0f}', f"{min(yy):.0f}/{max(yy):.0f}")
            sl = theil_sen([t[i] for i in idx], yy); worst_slope = max(worst_slope, abs(sl))
    exact(f"gpu{gi} peak VRAM over the whole run (C)", SUM["temps"][f"gpu{gi}"]["vram"]["peak_c"], max(series(g, "vram")))
    exact(f"gpu{gi} peak package over the whole run (C)", SUM["temps"][f"gpu{gi}"]["pkg"]["peak_c"], max(series(g, "pkg")))
print(f"  [info] Theil-Sen slopes are 0.000 C/min on every window (a median-based slope on 1 C-quantised flat data is always zero): consistent with no trend, but NOT a test of the published least-squares figures; see the next checks")
def ols(xs, ys):
    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n; return 60 * sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
for gi, g in enumerate(gpus):
    for name in ("pkg", "vram"):
        y = series(g, name)
        for p, (a, b) in wins.items():
            idx = window(p, a, b); pub = SUM["temps"][f"gpu{gi}"][name][p]["slope_c_per_min"]
            check(f"gpu{gi} {name} {p} least-squares slope (C/min)", pub, ols([t[i] for i in idx], [y[i] for i in idx]), 0.02)
            half = len(idx) // 2; drift = st.mean(y[i] for i in idx[half:]) - st.mean(y[i] for i in idx[:half])
            ok = abs(drift) <= 1.0; results.append(ok); print(f"  [{'OK  ' if ok else 'DIFF'}] gpu{gi} {name} {p}: mean of last 150 s minus first 150 s of the window = {drift:+.2f} C (no drift if |d| <= 1 C, the sensor resolution)")
print("\n4. WARM-UP: first SUSTAINED (5 consecutive samples) crossing of 90% of the rise, unsmoothed, seconds after load start")
for gi, g in enumerate(gpus):
    for name in ("pkg", "vram"):
        y = series(g, name); base = [y[i] for i in range(len(rows)) if phase[i] == "baseline" and t[i] >= 60]; idle = st.mean(base); plate = st.mean(y[i] for i in window("decode", 1140, 1440)); thr = idle + 0.9 * (plate - idle)
        dec = [i for i in range(len(rows)) if phase[i] == "decode"]; hit = next((t[i] - t[dec[0]] for k, i in enumerate(dec[:-5]) if all(y[j] >= thr for j in dec[k:k + 5])), None)
        check(f"gpu{gi} {name} time to 90% of rise (s)", SUM["warmup_s"][f"gpu{gi}.{name}"]["90%"], hit, 25, " s")
print("\n5. THROUGHPUT (per-request tokens/s, bucketed by completion time)")
reqs = [json.loads(l) for l in open(os.path.join(RAW, "requests.jsonl"))]
bounds = {"decode": (120, 1440), "prefill": (1440, 2761)}
for kind, field in (("decode", "completion_tokens"), ("prefill", "prompt_tokens")):
    a0, a1 = bounds[kind]
    for model, tag in (("engineering/lead", "lead"), ("engineering/deep", "deep")):
        rs = [q for q in reqs if q["kind"] == kind and q["model"] == model and q["status"] == 200]
        first = st.median(q[field] / q["secs"] for q in rs if q["t_end"] < a0 + 300); last = st.median(q[field] / q["secs"] for q in rs if q["t_end"] >= a1 - 300)
        pub = SUM["throughput"][f"{kind}.{tag}"]
        check(f"{kind} {tag} first-5-min median tok/s", pub["tok_s_first5min_median"], first, max(1.0, 0.01 * first), " tok/s"); check(f"{kind} {tag} last-5-min median tok/s", pub["tok_s_last5min_median"], last, max(1.0, 0.01 * last), " tok/s")
        exact(f"{kind} {tag} failed requests", pub["failed_requests"], sum(1 for q in reqs if q["kind"] == kind and q["model"] == model and q["status"] != 200))
print("\n6. TIME ABOVE THE CURRENT 75 C WARNING (VRAM, share of loaded samples)")
for gi, g in enumerate(gpus):
    y = series(g, "vram"); share = 100 * sum(1 for i in loaded if y[i] >= 75) / len(loaded)
    check(f"gpu{gi} vram >= 75 C share of loaded time (%)", SUM["alert_burden"][f"gpu{gi}.vram.>=75"]["pct_of_load_time"], share, 0.3, " pp")
print("\n7. WHAT-IF: separate trips = runs of >= N consecutive samples at/above T (hottest sensor)")
for gi, g in enumerate(gpus):
    hot = [max(r["gpu"][g]["temps"].values()) for r in rows]
    for thr in (75, 80, 85):
        for N in (1, 30, 60):
            runs, cur = [], 0
            for i in loaded:
                if hot[i] >= thr: cur += 1
                else:
                    if cur: runs.append(cur)
                    cur = 0
            if cur: runs.append(cur)
            exact(f"gpu{gi} T={thr} persistence N={N}s: trips", SUM["whatif"][f"gpu{gi}.>={thr}"][f"N{N}"], sum(1 for r_ in runs if r_ >= N))
print("\n8. SINGLE-SAMPLE SPIKES, different definition: +-2 neighbours, sample >= 2 C above the neighbours' mean, neighbours within 1 C")
for gi, g in enumerate(gpus):
    chans = [k for k in rows[0]["gpu"][g]["temps"] if k.startswith("vram_ch")]; n = mx = 0; total = 0
    for k in chans:
        y = [r["gpu"][g]["temps"][k] for r in rows]
        for i in loaded:
            if i < 2 or i > len(y) - 3: continue
            nb = [y[i - 2], y[i - 1], y[i + 1], y[i + 2]]; total += 1
            if max(nb) - min(nb) <= 1 and y[i] - st.mean(nb) >= 2: n += 1; mx = max(mx, y[i] - st.mean(nb))
    pct = 100 * n / total; ok = pct < 1.5 and mx <= 3.0; results.append(ok)
    print(f"  [{'OK  ' if ok else 'DIFF'}] gpu{gi} VRAM channels: {n} isolated upward spikes = {pct:.2f}% of channel-samples, largest +{mx:.2f} C   (claim: under 1%, never above +2 C; accepting <1.5% and <=3 C under this stricter-neighbourhood definition)")
print("\n9. HOST")
busiest = st.mean(max(rows[i]["host"]["cpu_busy_pct"].values()) for i in loaded); total_busy = st.mean(st.mean(rows[i]["host"]["cpu_busy_pct"].values()) for i in loaded)
check("busiest CPU core during load (%)", 98.3, busiest, 1.0); check("mean CPU busy during load (%)", 27.9, total_busy, 1.0)
for gi, g in enumerate(gpus):
    fan = st.median(rows[i]["gpu"][g]["fan_rpm"] for i in window("decode", 0, 1e9) if rows[i]["gpu"][g]["fan_rpm"] is not None)
    print(f"  [info] gpu{gi} median fan rpm in decode: {fan:.0f}")
print("\n9b. POWER, FREQUENCY AND COOLDOWN (not covered above)")
cap_w = {g: 200.0 for g in gpus}
for gi, g in enumerate(gpus):
    for p in ("decode", "prefill"):
        idx = [i for i in range(1, len(rows)) if phase[i] == p and phase[i - 1] == p]
        watts = [(rows[i]["gpu"][g]["energy_uj"]["card"] - rows[i - 1]["gpu"][g]["energy_uj"]["card"]) / 1e6 / (t[i] - t[i - 1]) for i in idx]
        pub = SUM["power"][f"gpu{gi}.{p}"]
        check(f"gpu{gi} {p} mean card power (W), mean of per-second deltas", pub["card_w_mean"], st.mean(watts), 3.0, " W")
        if gi == 1:
            freq = [rows[i]["gpu"][g]["gt"]["gt0"]["act_mhz"] for i, w in zip(idx, watts) if w > 100 and rows[i]["gpu"][g]["gt"]["gt0"]["act_mhz"] > 0]
            check(f"gpu{gi} {p} median actual frequency while drawing >100 W (MHz)", pub["act_mhz_busy_median"], st.median(freq), 60, " MHz")
for gi, g in enumerate(gpus):
    hot = [max(r["gpu"][g]["temps"].values()) for r in rows]; idle = st.mean(hot[i] for i in range(len(rows)) if phase[i] == "baseline" and t[i] >= 60)
    last_loaded = max(i for i in loaded); start = st.mean(hot[i] for i in range(last_loaded - 20, last_loaded)); ex = start - idle; cd = [i for i in range(len(rows)) if phase[i] == "cooldown"]
    for f in (0.5, 0.9):
        thr = start - f * ex; hit = next((t[i] - t[cd[0]] for k, i in enumerate(cd[:-5]) if all(hot[j] <= thr for j in cd[k:k + 5])), None)
        check(f"gpu{gi} cooldown: seconds to lose {int(f*100)}% of the excess over idle", SUM["cooldown_s"][f"gpu{gi}"][f"{int(f*100)}%"], hit, 30, " s")
print(f"\nSUMMARY: {sum(results)} of {len(results)} cross-checks agree within tolerance" + ("" if all(results) else "  <-- DIFFERENCES, see DIFF lines"))
sys.exit(0 if all(results) else 1)
