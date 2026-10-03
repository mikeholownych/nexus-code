#!/usr/bin/env python3
"""Reproducible analysis of the 2026-10-03 sustained-inference thermal soak (pure Python, no third-party packages).
    python analyze.py [raw_dir]  -> prints the tables and writes summary.json next to this file."""
import json, math, os, statistics as st, sys, collections
RAW = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "raw", "thermal-soak-20261003T170044Z")
rows = [json.loads(l) for l in open(os.path.join(RAW, "samples.jsonl"))]
reqs = [json.loads(l) for l in open(os.path.join(RAW, "requests.jsonl"))]
meta = json.load(open(os.path.join(RAW, "meta.json")))
BDF = sorted(rows[0]["gpu"]); NAME = {b: f"gpu{i}" for i, b in enumerate(BDF)}
WORKER = {BDF[0]: "lead (Qwen3-Coder-30B-A3B Q4_K_M)", BDF[1]: "deep (Qwen3.5-27B Q4_K_M)"}
PH = {"baseline": (0, 120), "decode": (120, 1440), "prefill": (1440, 2761), "cooldown": (2761, 3245)}
T = [r["t"] for r in rows]
def window(a, b): return [i for i, t in enumerate(T) if a <= t < b]
def classes(g):
    t = g["temps"]; ch = [v for k, v in t.items() if k.startswith("vram_ch")]
    return {"pkg": t["pkg"], "vram": t["vram"], "vram_ch_max": max(ch), "mctrl": t.get("mctrl"), "pcie": t.get("pcie"), "hottest": max(t.values())}
series = {b: {c: [] for c in ("pkg", "vram", "vram_ch_max", "mctrl", "pcie", "hottest")} for b in BDF}
for r in rows:
    for b in BDF:
        for c, v in classes(r["gpu"][b]).items(): series[b][c].append(v)
def slope_per_min(xs, ys):
    n = len(xs); mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs); return 60 * sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else 0.0
def roll_med(v, k=31):
    h = k // 2; return [st.median(v[max(0, i - h): i + h + 1]) for i in range(len(v))]
S = {}   # summary
# ---------------------------------------------------------------- 1. temperatures
print("=" * 100); print("1. TEMPERATURES per sensor class (C). Steady-state window = last 300 s of each load phase; sensor resolution is 1 C.")
print(f"{'gpu':5s}{'sensor':12s}{'idle':>6s}{'peak':>6s}{'@t(s)':>7s}{'decode':>22s}{'prefill':>22s}{'cooldown end':>14s}")
print(f"{'':17s}{'':>6s}{'':>6s}{'':>7s}{'mean (range) slope/min':>22s}{'mean (range) slope/min':>22s}")
S["temps"] = {}
for b in BDF:
    for c in ("pkg", "vram", "vram_ch_max", "mctrl", "pcie", "hottest"):
        y = series[b][c]; idle = st.mean(y[i] for i in window(60, 120))
        pk = max(y); tp = T[y.index(pk)]; out = {}
        for ph, (a, e) in (("decode", (1140, 1440)), ("prefill", (2461, 2761))):
            idx = window(a, e); yy = [y[i] for i in idx]; out[ph] = {"mean": round(st.mean(yy), 2), "min": min(yy), "max": max(yy), "slope_c_per_min": round(slope_per_min([T[i] for i in idx], yy), 3)}
        cd = st.mean(y[i] for i in window(3185, 3245))
        S["temps"].setdefault(NAME[b], {})[c] = {"idle_c": round(idle, 2), "peak_c": pk, "peak_at_s": tp, **out, "cooldown_end_c": round(cd, 2)}
        fmt = lambda o: f"{o['mean']:.1f} ({o['min']:.0f}-{o['max']:.0f}) {o['slope_c_per_min']:+.2f}"
        print(f"{NAME[b]:5s}{c:12s}{idle:6.1f}{pk:6.0f}{tp:7.0f}{fmt(out['decode']):>22s}{fmt(out['prefill']):>22s}{cd:14.1f}")
# warm-up time constants
print("\nWarm-up (decode phase, rolling-median 31 s): seconds after load start to reach 63% / 90% of the rise to steady state")
S["warmup_s"] = {}
for b in BDF:
    for c in ("pkg", "vram", "vram_ch_max", "hottest"):
        y = roll_med(series[b][c]); idle = st.mean(y[i] for i in window(60, 120)); plate = st.mean(y[i] for i in window(1140, 1440)); rise = plate - idle
        res = {}
        for frac in (0.63, 0.9):
            thr = idle + frac * rise; t_hit = next((T[i] - 120 for i in window(120, 1440) if y[i] >= thr), None); res[f"{int(frac*100)}%"] = None if t_hit is None else round(t_hit)
        S["warmup_s"][f"{NAME[b]}.{c}"] = {"rise_c": round(rise, 1), **res}
        print(f"  {NAME[b]} {c:12s} rise {rise:5.1f} C   63%: {res['63%']}s   90%: {res['90%']}s")
print("\nCooldown: time (s) after load stops for the hottest sensor to lose 50% / 90% of its excess over idle")
S["cooldown_s"] = {}
for b in BDF:
    y = roll_med(series[b]["hottest"], 15); idle = st.mean(y[i] for i in window(60, 120)); start = st.mean(y[i] for i in window(2741, 2761)); ex = start - idle
    res = {f"{int(f*100)}%": (lambda v: None if v is None else round(v))(next((T[i] - 2761 for i in window(2761, 3245) if y[i] <= start - f * ex), None)) for f in (0.5, 0.9)}
    S["cooldown_s"][NAME[b]] = {"excess_c": round(ex, 1), **res}; print(f"  {NAME[b]} excess {ex:.1f} C: 50% in {res['50%']}s, 90% in {res['90%']}s")
# ---------------------------------------------------------------- 2. power, utilisation, frequency, throttle
print("\n" + "=" * 100); print("2. POWER, UTILISATION, FREQUENCY, THROTTLE FLAGS (per phase). PL2 cap from meta.json = card burst limit.")
cap = {b: float(meta["gpus"][b]["power_cap_uw"]) / 1e6 for b in BDF}
S["power"] = {}
for b in BDF:
    for ph, (a, e) in PH.items():
        idx = window(a + 5, e)
        if len(idx) < 3: continue
        i0, i1 = idx[0], idx[-1]; dt = T[i1] - T[i0]
        card = (rows[i1]["gpu"][b]["energy_uj"]["card"] - rows[i0]["gpu"][b]["energy_uj"]["card"]) / 1e6 / dt
        pkg = (rows[i1]["gpu"][b]["energy_uj"]["pkg"] - rows[i0]["gpu"][b]["energy_uj"]["pkg"]) / 1e6 / dt
        inst = [(rows[i]["gpu"][b]["energy_uj"]["card"] - rows[i - 1]["gpu"][b]["energy_uj"]["card"]) / 1e6 / (T[i] - T[i - 1]) for i in idx[1:]]
        util = [1 - (rows[i]["gpu"][b]["gt"]["gt0"]["idle_ms"] - rows[i - 1]["gpu"][b]["gt"]["gt0"]["idle_ms"]) / ((T[i] - T[i - 1]) * 1000) for i in idx[1:]]
        act = [rows[i]["gpu"][b]["gt"]["gt0"]["act_mhz"] for i in idx]; busy = [a_ for a_, u in zip(act[1:], util) if u > 0.5]
        flags = collections.Counter(); n = len(idx)
        for i in idx:
            for gt in ("gt0", "gt1"):
                for k, v in rows[i]["gpu"][b]["gt"][gt]["flags"].items():
                    if v not in (None, "0"): flags[f"{gt}.{k}"] += 1
        fan_vals = [rows[i]["gpu"][b]["fan_rpm"] for i in idx if rows[i]["gpu"][b]["fan_rpm"] is not None]
        fan = st.median(fan_vals); fan_dropouts = sum(1 for v in fan_vals if v < 300) if ph in ("decode", "prefill") else None
        d = {"card_w_mean": round(card, 1), "card_w_p95": round(sorted(inst)[int(.95 * len(inst))], 1), "pkg_w_mean": round(pkg, 1), "pl2_cap_w": cap[b], "util_mean": round(st.mean(util), 3),
             "act_mhz_busy_min": min(busy) if busy else None, "act_mhz_busy_median": st.median(busy) if busy else None, "act_mhz_busy_max": max(busy) if busy else None,
             "frac_busy_below_rp0": round(sum(1 for x in busy if x < 2400) / len(busy), 3) if busy else None, "gpu_fan_rpm_median": round(fan), "gpu_fan_dropouts_lt300rpm_while_loaded": fan_dropouts, "flag_samples": dict(flags), "samples": n}
        S["power"][f"{NAME[b]}.{ph}"] = d
        print(f"{NAME[b]} {ph:9s} card {card:6.1f} W (p95 {d['card_w_p95']}, cap {cap[b]:.0f})  pkg {pkg:5.1f} W  util {d['util_mean']:.2f}  act MHz busy min/med/max {d['act_mhz_busy_min']}/{d['act_mhz_busy_median']}/{d['act_mhz_busy_max']}  below-rp0 {d['frac_busy_below_rp0']}  fan median {d['gpu_fan_rpm_median']} rpm (dropouts<300: {d['gpu_fan_dropouts_lt300rpm_while_loaded']})  flags {dict(flags) or 'none'} of {n}")
# throttle vs temperature: does any thermal flag ever appear, and where do power flags occur?
print("\nThrottle flags over the WHOLE run (samples raised / total):")
tot = collections.Counter()
for r in rows:
    for b in BDF:
        for gt in ("gt0", "gt1"):
            for k, v in r["gpu"][b]["gt"][gt]["flags"].items():
                if v not in (None, "0"): tot[f"{NAME[b]}.{gt}.{k}"] += 1
S["flags_whole_run"] = dict(tot); print("  ", dict(tot) or "none", "| thermal-related flags (thermal, prochot, vr_thermalert, ratl):", {k: v for k, v in tot.items() if any(s in k for s in ("thermal", "prochot", "vr_thermalert", "ratl"))} or "NONE")
# ---------------------------------------------------------------- 3. throughput vs temperature
print("\n" + "=" * 100); print("3. THROUGHPUT per request vs elapsed time and temperature")
def spearman(x, y):
    def rank(v):
        o = sorted(range(len(v)), key=lambda i: v[i]); r = [0.0] * len(v)
        for k, i in enumerate(o): r[i] = k
        return r
    rx, ry = rank(x), rank(y); mx, my = st.mean(rx), st.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry)); den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)); return num / den if den else float("nan")
S["throughput"] = {}
for kind, key in (("decode", "completion_tokens"), ("prefill", "prompt_tokens")):
    for model, b in (("engineering/lead", BDF[0]), ("engineering/deep", BDF[1])):
        rs = [q for q in reqs if q["kind"] == kind and q["model"] == model and q["status"] == 200]
        if len(rs) < 6: continue
        a0, a1 = PH[kind]; rate = [(q["t_start"] + q["t_end"]) / 2 for q in rs], [q[key] / q["secs"] for q in rs]
        first = [r_ for t_, r_ in zip(*rate) if t_ < a0 + 300]; last = [r_ for t_, r_ in zip(*rate) if t_ > a1 - 300]
        hot = [series[b]["hottest"][min(range(len(T)), key=lambda i: abs(T[i] - t_))] for t_ in rate[0]]
        d = {"n": len(rs), "tok_s_first5min_median": round(st.median(first), 1), "tok_s_last5min_median": round(st.median(last), 1),
             "change_pct": round(100 * (st.median(last) / st.median(first) - 1), 1), "tok_s_cv_pct": round(100 * st.pstdev(rate[1]) / st.mean(rate[1]), 1),
             "spearman_rate_vs_hottest_c": round(spearman(rate[1], hot), 2), "failed_requests": sum(1 for q in reqs if q["kind"] == kind and q["model"] == model and q["status"] != 200)}
        S["throughput"][f"{kind}.{model.split('/')[1]}"] = d
        print(f"  {kind:8s} {model.split('/')[1]:5s} n={d['n']:3d}  first 5 min {d['tok_s_first5min_median']:7.1f} tok/s -> last 5 min {d['tok_s_last5min_median']:7.1f} tok/s ({d['change_pct']:+.1f}%)  CV {d['tok_s_cv_pct']}%  Spearman(rate, hottest sensor) {d['spearman_rate_vs_hottest_c']:+.2f}  failed {d['failed_requests']}")
# ---------------------------------------------------------------- 4. alert burden against the current 75/85 policy
print("\n" + "=" * 100); print("4. TIME ABOVE THE CURRENT MONITORING THRESHOLDS during the two load phases (warn 75 C, crit 85 C)")
S["alert_burden"] = {}
load_idx = window(120, 2761)
for b in BDF:
    for c in ("pkg", "vram", "vram_ch_max", "mctrl", "pcie", "hottest"):
        y = series[b][c]
        for thr in (75, 85):
            above = [i for i in load_idx if y[i] >= thr]
            episodes = sum(1 for k, i in enumerate(above) if k == 0 or above[k - 1] != i - 1)
            if above or c in ("hottest",): S["alert_burden"][f"{NAME[b]}.{c}.>={thr}"] = {"seconds": len(above), "pct_of_load_time": round(100 * len(above) / len(load_idx), 1), "episodes": episodes}
            if above: print(f"  {NAME[b]} {c:12s} >= {thr} C: {len(above):4d} s ({100*len(above)/len(load_idx):4.1f}% of load time) in {episodes} episode(s)")
if not any(v["seconds"] for k, v in S["alert_burden"].items() if k.endswith(">=75")): print("  no sensor reached 75 C during this soak")
# ---------------------------------------------------------------- 5. measurement noise and the single-sample abort semantics
print("\n" + "=" * 100); print("5. SENSOR NOISE AND SINGLE-SAMPLE BEHAVIOUR (what a one-sample abort/alert would see)")
S["noise"] = {}
allsens = collections.defaultdict(list)
for b in BDF:
    for k in rows[0]["gpu"][b]["temps"]:
        cls = "vram_ch" if k.startswith("vram_ch") else k
        allsens[(NAME[b], cls)].append([r["gpu"][b]["temps"][k] for r in rows])
print(f"{'gpu':5s}{'class':9s}{'#sensors':>9s}{'p50|d|':>8s}{'p99|d|':>8s}{'max|d|':>8s}{'single-sample spikes>=2C':>26s}")
for (g, cls), lst in sorted(allsens.items()):
    deltas = [abs(s[i] - s[i - 1]) for s in lst for i in range(1, len(s))]
    spikes = 0
    for s in lst:
        for i in range(3, len(s) - 3):
            nb = [s[i - 3], s[i - 2], s[i - 1], s[i + 1], s[i + 2], s[i + 3]]
            if max(nb) - min(nb) <= 1 and abs(s[i] - st.median(nb)) >= 2: spikes += 1
    dd = sorted(deltas); S["noise"][f"{g}.{cls}"] = {"sensors": len(lst), "p50_abs_delta": dd[len(dd) // 2], "p99_abs_delta": dd[int(.99 * len(dd))], "max_abs_delta": dd[-1], "isolated_spikes_ge_2c": spikes}
    print(f"{g:5s}{cls:9s}{len(lst):9d}{dd[len(dd)//2]:8.0f}{dd[int(.99*len(dd))]:8.0f}{dd[-1]:8.0f}{spikes:26d}")
print("\nHypothetical-threshold episodes (hottest sensor per GPU): how long does an exceedance last? (1-sample = what a no-debounce policy would trip on)")
S["episodes"] = {}
for b in BDF:
    y = series[b]["hottest"]
    for thr in (60, 65, 70, 75):
        runs, cur = [], 0
        for i in window(120, 2761):
            if y[i] >= thr: cur += 1
            else:
                if cur: runs.append(cur)
                cur = 0
        if cur: runs.append(cur)
        S["episodes"][f"{NAME[b]}.>={thr}"] = {"episodes": len(runs), "single_sample": sum(1 for r in runs if r == 1), "ge_5s": sum(1 for r in runs if r >= 5), "longest_s": max(runs) if runs else 0}
        print(f"  {NAME[b]} >= {thr} C: {len(runs):3d} episodes, {sum(1 for r in runs if r == 1):3d} lasting a single sample, {sum(1 for r in runs if r >= 5):3d} lasting >= 5 s, longest {max(runs) if runs else 0} s")
print("\n5b. UPWARD ONE-SAMPLE EXCURSIONS and SELECTION BIAS of taking the maximum over sensors")
S["excursions"] = {}
for b in BDF:
    chans = [k for k in rows[0]["gpu"][b]["temps"] if k.startswith("vram_ch")]
    ser = {k: [r["gpu"][b]["temps"][k] for r in rows] for k in chans}
    ups = []
    for k, s_ in ser.items():
        for i in window(120, 2761):
            if i < 3 or i > len(s_) - 4: continue
            nb = [s_[i - 3], s_[i - 2], s_[i - 1], s_[i + 1], s_[i + 2], s_[i + 3]]
            if max(nb) - min(nb) <= 1 and s_[i] - st.median(nb) >= 2: ups.append(s_[i] - st.median(nb))
    cnt = collections.Counter(int(u) for u in ups); n_ch = len(chans) * len(window(120, 2761))
    S["excursions"][NAME[b]] = {"upward_isolated_ge2c": len(ups), "per_channel_sample_pct": round(100 * len(ups) / n_ch, 2), "by_size_c": dict(sorted(cnt.items())), "max_c": max(ups) if ups else 0}
    plateau = window(1140, 1440); med_of_channels = st.mean(st.median(ser[k][i] for k in chans) for i in plateau); hot = st.mean(max(ser[k][i] for k in chans) for i in plateau)
    S["excursions"][NAME[b]]["decode_plateau_median_channel_c"] = round(med_of_channels, 1); S["excursions"][NAME[b]]["decode_plateau_hottest_channel_c"] = round(hot, 1)
    print(f"  {NAME[b]} VRAM channels: isolated upward spikes >=2 C: {len(ups)} ({100*len(ups)/n_ch:.2f}% of channel-samples), sizes {dict(sorted(cnt.items()))}, largest +{max(ups) if ups else 0} C;  decode plateau: median channel {med_of_channels:.1f} C vs hottest channel {hot:.1f} C (selection bias of max-of-16 = {hot-med_of_channels:.1f} C)")
print("\n5c. WHAT-IF: how many separate trips would threshold T with persistence N seconds produce on this soak? (hottest sensor per GPU, load phases only; no thresholds are being changed)")
S["whatif"] = {}
print(f"  {'gpu':5s}{'T (C)':>6s}" + "".join(f"{'N='+str(n)+'s':>9s}" for n in (1, 3, 5, 10, 30, 60)))
for b in BDF:
    y = series[b]["hottest"]
    for thr in (75, 80, 85, 90):
        row_ = []
        for N in (1, 3, 5, 10, 30, 60):
            trips, cur = 0, 0
            for i in window(120, 2761):
                cur = cur + 1 if y[i] >= thr else 0
                if cur == N: trips += 1
            row_.append(trips)
        S["whatif"][f"{NAME[b]}.>={thr}"] = dict(zip(("N1", "N3", "N5", "N10", "N30", "N60"), row_))
        print(f"  {NAME[b]:5s}{thr:6d}" + "".join(f"{v:9d}" for v in row_))
# ---------------------------------------------------------------- 6. host context
print("\n" + "=" * 100); print("6. HOST CONTEXT (phase means): chassis fans, CPU, NVMe, unlabeled dell_smm temperatures (identity unverified)")
S["host"] = {}
for ph, (a, e) in PH.items():
    idx = window(a + 5, e)
    if not idx: continue
    h = [rows[i]["host"] for i in idx]
    def mean_present(vals):
        vals = list(vals); v = [x for x in vals if x is not None]; return (round(st.mean(v), 1) if v else None), len(vals) - len(v)
    fans = {k: mean_present(x["chassis_fan_rpm"][k] for x in h) for k in h[0]["chassis_fan_rpm"]}
    dell = {k: mean_present(x["dell_smm_temps"].get(k) for x in h) for k in h[0]["dell_smm_temps"]}
    d = {"cpu_pkg_c": round(st.mean(x["cpu_temps"]["Package id 0"] for x in h), 1), "cpu_busy_pct_mean": round(st.mean(st.mean(x["cpu_busy_pct"].values()) for x in h), 1),
         "cpu_busiest_core_pct_mean": round(st.mean(max(x["cpu_busy_pct"].values()) for x in h), 1), "nvme_c": round(st.mean(st.mean(x["nvme_composite_c"]) for x in h), 1),
         "chassis_fan_rpm": {k: v[0] for k, v in fans.items()}, "chassis_fan_missing_samples": {k: v[1] for k, v in fans.items() if v[1]},
         "dell_smm_c": {k: v[0] for k, v in dell.items()}, "dell_smm_missing_samples": {k: v[1] for k, v in dell.items() if v[1]}}
    S["host"][ph] = d; print(f"  {ph:9s} cpu pkg {d['cpu_pkg_c']} C, busy {d['cpu_busy_pct_mean']}% (busiest core {d['cpu_busiest_core_pct_mean']}%), nvme {d['nvme_c']} C, fans {d['chassis_fan_rpm']} (missing readings {d['chassis_fan_missing_samples'] or 0}), dell_smm {d['dell_smm_c']}")
json.dump(S, open(os.path.join(os.path.dirname(__file__), "summary.json"), "w"), indent=1, sort_keys=True)
print("\nwrote summary.json")
