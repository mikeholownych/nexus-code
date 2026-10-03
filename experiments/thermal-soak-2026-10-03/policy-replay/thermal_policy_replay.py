#!/usr/bin/env python3
"""Offline thermal-policy replay: evaluate EXPLICIT candidate policies against preserved 1 Hz GPU temperature traces.

Strictly analytical and read-only. It never reads or writes hardware, services, alerting rules or benchmark guardrails; it opens
the raw evidence read-only, verifies its SHA-256 before and after, and refuses to write outputs inside the raw directory. It does not
choose, rank or recommend thresholds: every number comes from the policy file you pass in.

Definitions (also in README.md)
  sample          one record of samples.jsonl; `sample_index` is its 0-based line number (raw line = sample_index + 1).
  sensor class    package | vram (the firmware's VRAM sensor) | vram_hottest_channel (max over vram_ch_*, never averaged) |
                  memory_controller | pcie | any_sensor (hottest of every GPU temperature sensor = the benchmark harness' semantics).
  rule            state (warning|critical|abort), sensor_class, gpus, threshold_c, persistence_s, hysteresis_c,
                  clear_persistence_s, missing (hold|clear|fail_closed). Rules are evaluated independently per GPU.
  at/above        value >= threshold_c. Below clear level: value < threshold_c - hysteresis_c.
  persistence     the rule activates when it has seen `ceil(persistence_s / dt)` CONSECUTIVE at/above samples (dt = nominal sample period,
                  1 s here). persistence_s <= dt is therefore instantaneous. Clearing needs `ceil(clear_persistence_s / dt)` consecutive
                  below-clear-level samples; samples inside the hysteresis band neither clear nor re-arm.
  missing sample  value None. hold = neither counts toward activation/clearing nor resets either run; clear = treated as below clear level
                  and not at/above; fail_closed = treated as at/above and not below clear level.
  trip            one activation of a rule (instantaneous or persistent per its settings). re-trips = trips - 1.
  state time      each sample i contributes dt_i (t[i+1]-t[i]; the last sample the nominal dt) to the state in force after processing it.
  combined state  per GPU (and "system" = any GPU) the highest active rule state: ok < warning < critical < abort.
  flap            an escalation of the combined state followed by a de-escalation less than 60 s later."""
from __future__ import annotations

import argparse, bisect, collections, hashlib, json, math, os, statistics as st, sys
from dataclasses import dataclass, field

VERSION = "1.0"
STATES = ["ok", "warning", "critical", "abort"]
RANK = {s: i for i, s in enumerate(STATES)}
CLASSES = ["package", "vram", "vram_hottest_channel", "memory_controller", "pcie", "any_sensor"]
MISSING = ("hold", "clear", "fail_closed")
STATUSES = ("reference_current_configuration", "illustrative_example", "candidate_under_evaluation")
LOADED = ("decode", "prefill")


class PolicyError(ValueError):
    pass


# ----------------------------------------------------------------------------------------------- trace
@dataclass
class Trace:
    t: list                      # seconds
    phase: list                  # phase label per sample
    gpus: list                   # ["gpu0", "gpu1", ...] (ordinal by sorted PCI address)
    temps: list                  # per sample: {gpu: {sensor_label: float|None}}
    raw_file: str = ""
    raw_sha256: str = ""
    injections: list = field(default_factory=list)

    def __len__(self): return len(self.t)

    @property
    def dt(self):
        d = [b - a for a, b in zip(self.t, self.t[1:]) if b > a]
        return st.median(d) if d else 1.0

    def weights(self):
        w = [self.t[i + 1] - self.t[i] for i in range(len(self.t) - 1)]
        return w + [self.dt]

    @staticmethod
    def synthetic(series: dict, phases=None, dt=1.0):
        """series = {"gpu0": {"pkg": [...], "vram": [...], "vram_ch_0": [...]}, ...}; None = missing."""
        gpus = sorted(series); n = max(len(v) for g in series.values() for v in g.values())
        temps = [{g: {k: (v[i] if i < len(v) else None) for k, v in series[g].items()} for g in gpus} for i in range(n)]
        return Trace(t=[i * dt for i in range(n)], phase=phases or ["decode"] * n, gpus=gpus, temps=temps)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    return h.hexdigest()


def load_trace(raw_dir: str) -> Trace:
    path = os.path.join(raw_dir, "samples.jsonl")
    with open(path, "rb") as f: rows = [json.loads(l) for l in f.read().decode().splitlines() if l.strip()]
    bdfs = sorted(rows[0]["gpu"]); names = {b: f"gpu{i}" for i, b in enumerate(bdfs)}
    return Trace(t=[r["t"] for r in rows], phase=[r["phase"] for r in rows], gpus=[names[b] for b in bdfs],
                 temps=[{names[b]: dict(r["gpu"][b]["temps"]) for b in bdfs} for r in rows], raw_file=path, raw_sha256=sha256_file(path))


# ----------------------------------------------------------------------------------------------- sensor classes
def class_value(temps: dict, cls: str):
    """-> (value|None, source_label|None, coverage_text). Never averages."""
    if cls == "package": v = temps.get("pkg"); return v, ("pkg" if v is not None else None), ""
    if cls == "vram": v = temps.get("vram"); return v, ("vram" if v is not None else None), ""
    if cls == "memory_controller": v = temps.get("mctrl"); return v, ("mctrl" if v is not None else None), ""
    if cls == "pcie": v = temps.get("pcie"); return v, ("pcie" if v is not None else None), ""
    pool = {k: v for k, v in temps.items() if (k.startswith("vram_ch") if cls == "vram_hottest_channel" else True)}
    if not pool: return None, None, ""
    present = {k: v for k, v in pool.items() if v is not None}
    if not present: return None, None, f"0/{len(pool)}"
    src = max(sorted(present), key=lambda k: present[k])      # ties: first by sorted label
    return present[src], src, (f"{len(present)}/{len(pool)}" if len(present) != len(pool) else "")


def class_series(trace: Trace, gpu: str, cls: str):
    if cls not in CLASSES: raise PolicyError(f"unknown sensor_class {cls!r}; expected one of {CLASSES}")
    return [class_value(trace.temps[i][gpu], cls) for i in range(len(trace))]


# ----------------------------------------------------------------------------------------------- policy
@dataclass(frozen=True)
class Rule:
    id: str; sensor_class: str; state: str; threshold_c: float
    persistence_s: float = 1.0; hysteresis_c: float = 0.0; clear_persistence_s: float = 1.0
    missing: str = "hold"; gpus: object = "all"


def parse_policy(doc: dict) -> dict:
    for k in ("name", "status", "rules"):
        if k not in doc: raise PolicyError(f"policy is missing required field {k!r}")
    if doc["status"] not in STATUSES: raise PolicyError(f"status must be one of {STATUSES} (every policy must say what it is)")
    rules, seen = [], set()
    for r in doc["rules"]:
        for k in ("id", "sensor_class", "state", "threshold_c"):
            if k not in r: raise PolicyError(f"rule is missing {k!r}: {r}")
        if ":" in str(r["id"]): raise PolicyError(f"rule id {r['id']!r} must not contain ':'")
        if r["id"] in seen: raise PolicyError(f"duplicate rule id {r['id']!r}")
        seen.add(r["id"])
        if r["sensor_class"] not in CLASSES: raise PolicyError(f"rule {r['id']}: unknown sensor_class {r['sensor_class']!r}")
        if r["state"] not in STATES[1:]: raise PolicyError(f"rule {r['id']}: state must be warning|critical|abort")
        if r.get("missing", "hold") not in MISSING: raise PolicyError(f"rule {r['id']}: missing must be one of {MISSING}")
        for k in ("threshold_c", "persistence_s", "hysteresis_c", "clear_persistence_s"):
            if k in r and (not isinstance(r[k], (int, float)) or isinstance(r[k], bool) or not math.isfinite(r[k])): raise PolicyError(f"rule {r['id']}: {k} must be a finite number")
        for k in ("persistence_s", "hysteresis_c", "clear_persistence_s"):
            if r.get(k, 0) < 0: raise PolicyError(f"rule {r['id']}: {k} must be >= 0")
        g = r.get("gpus", "all")
        if g != "all" and not (isinstance(g, list) and g and all(isinstance(x, int) for x in g)): raise PolicyError(f"rule {r['id']}: gpus must be 'all' or a list of GPU ordinals")
        rules.append(Rule(**{k: r[k] for k in r if k in Rule.__dataclass_fields__}))
    return {"name": doc["name"], "status": doc["status"], "description": doc.get("description", ""), "rules": rules}


# ----------------------------------------------------------------------------------------------- rule evaluation
def run_rule(series, times, phases, rule: Rule, dt: float):
    """Evaluate one rule on one GPU's class series. Returns (episodes, active_after[bool per sample])."""
    need_on = max(1, math.ceil(rule.persistence_s / dt - 1e-9)); need_off = max(1, math.ceil(rule.clear_persistence_s / dt - 1e-9))
    clear_level = rule.threshold_c - rule.hysteresis_c
    active = False; above = []; below = []; episodes = []; cur = None; after = [False] * len(series)
    for i, (v, src, cov) in enumerate(series):
        if v is None:
            if rule.missing == "hold": after[i] = active; continue
            is_above, is_below = (rule.missing == "fail_closed"), (rule.missing == "clear")
        else:
            is_above, is_below = v >= rule.threshold_c, v < clear_level
        if not active:
            above = above + [i] if is_above else []
            if len(above) >= need_on:
                active = True; run = above[-need_on:]; above = []; below = []
                cur = {"activated_index": i, "activated_t": times[i], "activated_phase": phases[i], "condition_started_index": run[0], "condition_started_t": times[run[0]],
                       "trigger": {"sample_index": i, "raw_line": i + 1, "t": times[i], "phase": phases[i], "value": v, "source": src, "coverage": cov or None},
                       "condition_run": _run_view(series, times, run), "sources_during_episode": collections.Counter(), "peak": None, "peak_index": None}
        else:
            below = below + [i] if is_below else []
            if len(below) >= need_off:
                cur.update(cleared_index=i, cleared_t=times[i], clear_trigger={"sample_index": i, "raw_line": i + 1, "t": times[i], "phase": phases[i], "value": v, "source": src, "clear_level_c": clear_level},
                           clear_run=_run_view(series, times, below[-need_off:]))
                episodes.append(cur); cur = None; active = False; above = []; below = []
        after[i] = active
        if active and v is not None:
            cur["sources_during_episode"][src] += 1
            if cur["peak"] is None or v > cur["peak"]: cur["peak"], cur["peak_index"] = v, i
    if cur is not None: cur.update(cleared_index=None, cleared_t=None, clear_trigger=None, clear_run=None); episodes.append(cur)
    return episodes, after


def _run_view(series, times, idx):
    full = [{"sample_index": i, "raw_line": i + 1, "t": times[i], "value": series[i][0], "source": series[i][1]} for i in idx]
    if len(full) <= 6: return {"count": len(full), "first_index": idx[0], "last_index": idx[-1], "samples": full}
    return {"count": len(full), "first_index": idx[0], "last_index": idx[-1], "samples": full[:3] + full[-3:], "samples_elided": len(full) - 6}


# ----------------------------------------------------------------------------------------------- replay
def phase_split(weights, phases, mask):
    out = collections.Counter()
    for w, p, m in zip(weights, phases, mask):
        if m: out[p] += w
    return {k: round(v, 3) for k, v in sorted(out.items())}


def replay(trace: Trace, policy: dict, short_episode_s: float = 10.0) -> dict:
    n = len(trace); dt = trace.dt; w = trace.weights(); gpu_list = trace.gpus
    rule_results = []; active_by = {g: {} for g in gpu_list}
    for rule in policy["rules"]:
        targets = gpu_list if rule.gpus == "all" else [f"gpu{i}" for i in rule.gpus if f"gpu{i}" in gpu_list]
        for g in targets:
            series = class_series(trace, g, rule.sensor_class)
            eps, after = run_rule(series, trace.t, trace.phase, rule, dt); active_by[g][rule.id] = after
            for e in eps:
                last = e["cleared_index"] if e["cleared_index"] is not None else n
                e["duration_s"] = round(sum(w[e["activated_index"]:last]), 3); e["sources_during_episode"] = dict(e["sources_during_episode"])
                e["activated_to_condition_start_latency_s"] = round(e["activated_t"] - e["condition_started_t"], 3)
            durs = [e["duration_s"] for e in eps]
            rule_results.append({"rule": rule.__dict__ | {"gpus": rule.gpus}, "gpu": g, "trips": len(eps), "re_trips": max(0, len(eps) - 1),
                "transitions": len(eps) + sum(1 for e in eps if e["cleared_index"] is not None), "active_seconds": round(sum(w[i] for i in range(n) if after[i]), 3),
                "active_seconds_by_phase": phase_split(w, trace.phase, after), "first_activation_t": eps[0]["activated_t"] if eps else None, "last_activation_t": eps[-1]["activated_t"] if eps else None,
                "last_clear_t": next((e["cleared_t"] for e in reversed(eps) if e["cleared_t"] is not None), None), "open_at_end_of_trace": bool(eps and eps[-1]["cleared_index"] is None),
                "short_episodes": sum(1 for d in durs if d < short_episode_s), "short_episode_s": short_episode_s, "longest_episode_s": max(durs) if durs else 0, "shortest_episode_s": min(durs) if durs else 0,
                "mean_episode_s": round(sum(durs) / len(durs), 2) if durs else 0, "episodes": eps})
    combined = {}
    for g in gpu_list:
        combined[g] = _combine([(rid, a) for rid, a in active_by[g].items()], policy, trace, w, rule_results, g)
    sysr = _combine([(f"{g}:{rid}", a) for g in gpu_list for rid, a in active_by[g].items()], policy, trace, w, rule_results, None)
    combined["system"] = sysr
    return {"tool": {"name": "thermal_policy_replay", "version": VERSION, "dt_s": dt, "definitions": __doc__.split("Definitions", 1)[1].strip()},
            "input": {"raw_file": trace.raw_file, "raw_sha256": trace.raw_sha256, "samples": n, "duration_s": round(sum(w), 3), "phases": dict(collections.Counter(trace.phase)), "gpus": gpu_list,
                      "injections": trace.injections},
            "policy": {"name": policy["name"], "status": policy["status"], "description": policy["description"], "rules": [r.__dict__ for r in policy["rules"]]},
            "rules": rule_results, "combined": combined, "class_profile": class_profile(trace, policy)}


def _combine(active_pairs, policy, trace, w, rule_results, gpu):
    n = len(trace); rank_of = {r.id: RANK[r.state] for r in policy["rules"]}
    sev = [0] * n; changed_by = collections.defaultdict(list)
    for rid, after in active_pairs:
        base = rid.split(":")[-1]; prev = False
        for i in range(n):
            if after[i]:
                sev[i] = max(sev[i], rank_of[base])
            if after[i] != prev: changed_by[i].append(f"{rid}:{'activated' if after[i] else 'cleared'}")
            prev = after[i]
    transitions = []; prev = 0
    for i in range(n):
        if sev[i] != prev:
            ev = {"sample_index": i, "raw_line": i + 1, "t": trace.t[i], "phase": trace.phase[i], "from": STATES[prev], "to": STATES[sev[i]], "rule_events": changed_by.get(i, [])}
            # raw observation(s) behind the change: the trigger recorded by each rule episode that changed at this sample
            obs = []
            for rr in rule_results:
                if gpu is not None and rr["gpu"] != gpu: continue
                for e in rr["episodes"]:
                    if e["activated_index"] == i: obs.append({"rule": rr["rule"]["id"], "gpu": rr["gpu"], "event": "activated", **e["trigger"], "condition_run": e["condition_run"]})
                    if e["cleared_index"] == i: obs.append({"rule": rr["rule"]["id"], "gpu": rr["gpu"], "event": "cleared", **e["clear_trigger"], "clear_run": e["clear_run"]})
            ev["raw_observations"] = obs; transitions.append(ev); prev = sev[i]
    tis = {s: 0.0 for s in STATES}; by_phase = {s: collections.Counter() for s in STATES}
    for i in range(n): tis[STATES[sev[i]]] += w[i]; by_phase[STATES[sev[i]]][trace.phase[i]] += w[i]
    return {"time_in_state_s": {k: round(v, 3) for k, v in tis.items()}, "time_in_state_by_phase_s": {s: {p: round(v, 3) for p, v in sorted(c.items())} for s, c in by_phase.items()},
            "transitions": transitions, "transition_count": len(transitions), "first_transition_t": transitions[0]["t"] if transitions else None, "last_transition_t": transitions[-1]["t"] if transitions else None,
            "flaps": sum(1 for a, b in zip(transitions, transitions[1:]) if RANK[a["to"]] > RANK[a["from"]] and RANK[b["to"]] < RANK[b["from"]] and b["t"] - a["t"] < 60) if transitions else 0}


def class_profile(trace: Trace, policy: dict) -> dict:
    """Policy-independent view of each class during loaded phases, with the raw run structure at each rule threshold (instantaneous)."""
    idx = [i for i, p in enumerate(trace.phase) if p in LOADED]
    if not idx: return {}
    thresholds = sorted({r.threshold_c for r in policy["rules"]}); out = {}
    for g in trace.gpus:
        for cls in CLASSES:
            ser = class_series(trace, g, cls); vals = [ser[i][0] for i in idx if ser[i][0] is not None]
            if not vals: continue
            d = {"loaded_samples": len(idx), "present_samples": len(vals), "min": min(vals), "mean": round(st.mean(vals), 2), "max": max(vals), "p50": st.median(vals), "p99": sorted(vals)[int(0.99 * (len(vals) - 1))], "by_threshold": {}}
            for thr in thresholds:
                runs, cur = [], 0
                for i in idx:
                    v = ser[i][0]
                    if v is not None and v >= thr: cur += 1
                    elif v is not None:
                        if cur: runs.append(cur)
                        cur = 0
                if cur: runs.append(cur)
                d["by_threshold"][str(thr)] = {"samples_at_or_above": sum(runs), "share_of_loaded_pct": round(100 * sum(runs) / len(idx), 2), "runs": len(runs), "run_length_buckets": _buckets(runs)}
            out[f"{g}.{cls}"] = d
    return out


def _buckets(runs):
    b = collections.OrderedDict([("1", 0), ("2-4", 0), ("5-29", 0), ("30-59", 0), (">=60", 0)])
    for r in runs: b["1" if r == 1 else "2-4" if r < 5 else "5-29" if r < 30 else "30-59" if r < 60 else ">=60"] += 1
    return dict(b)


# ----------------------------------------------------------------------------------------------- injection (synthetic, in memory only)
def inject_dropout(trace: Trace, spec: str) -> None:
    """spec 'gpu1:vram:1200:1205' -> samples with 1200 <= t < 1205 lose that class's source sensors. SYNTHETIC; recorded in the report."""
    g, cls, a, b = spec.split(":"); a, b = float(a), float(b)
    keys = {"package": ["pkg"], "vram": ["vram"], "memory_controller": ["mctrl"], "pcie": ["pcie"]}
    n = 0
    for i, tt in enumerate(trace.t):
        if a <= tt < b:
            ks = keys.get(cls) or [k for k in trace.temps[i][g] if (cls == "any_sensor" or k.startswith("vram_ch"))]
            for k in ks: trace.temps[i][g][k] = None
            n += 1
    trace.injections.append({"spec": spec, "samples_affected": n, "note": "SYNTHETIC dropout injected in memory for demonstration; raw evidence unchanged"})


# ----------------------------------------------------------------------------------------------- text report
def render_text(res: dict, max_printed: int = 8) -> str:
    L = []; p = res["policy"]; i = res["input"]
    L += ["=" * 110, f"POLICY REPLAY  {p['name']}   [{p['status'].upper()}]", f"  {p['description']}",
          "  This is an offline replay of the preserved soak. It is NOT a recommendation and changes nothing.", "=" * 110,
          f"  raw: {i['raw_file']}  sha256 {i['raw_sha256'][:16]}...  samples {i['samples']}  duration {i['duration_s']} s  dt {res['tool']['dt_s']} s  phases {i['phases']}"]
    for inj in i["injections"]: L.append(f"  !! {inj['note']}: {inj['spec']} ({inj['samples_affected']} samples)")
    L += ["", "RULES"]
    for r in p["rules"]: L.append(f"  {r['id']:28s} {r['state']:8s} {r['sensor_class']:22s} >= {r['threshold_c']:g} C  persistence {r['persistence_s']:g}s  hysteresis {r['hysteresis_c']:g} C  clear-persistence {r['clear_persistence_s']:g}s  missing={r['missing']}  gpus={r['gpus']}")
    L += ["", "PER-RULE RESULTS (per GPU)", f"  {'rule':26s}{'gpu':5s}{'trips':>6s}{'re-trips':>9s}{'trans.':>7s}{'active s':>10s}{'short<' + format(res['rules'][0]['short_episode_s'], 'g') + 's':>10s}{'longest s':>10s}{'first act. t':>13s}{'last act. t':>12s}{'last clear t':>13s}"] if res["rules"] else []
    f = lambda v: "-" if v is None else f"{v:g}"
    for rr in res["rules"]:
        L.append(f"  {rr['rule']['id']:26s}{rr['gpu']:5s}{rr['trips']:6d}{rr['re_trips']:9d}{rr['transitions']:7d}{rr['active_seconds']:10.0f}{rr['short_episodes']:10d}{rr['longest_episode_s']:10.0f}{f(rr['first_activation_t']):>13s}{f(rr['last_activation_t']):>12s}{f(rr['last_clear_t']):>13s}" + ("  (still active at end of trace)" if rr["open_at_end_of_trace"] else ""))
    L += ["", "COMBINED STATE (highest active rule state)"]
    for g, c in res["combined"].items():
        t = c["time_in_state_s"]
        L.append(f"  {g:7s} time in state (s): " + "  ".join(f"{s}={t[s]:.0f}" for s in STATES) + f"   transitions {c['transition_count']}  first {f(c['first_transition_t'])}  last {f(c['last_transition_t'])}  flaps(<60s up->down) {c['flaps']}")
    L += ["", f"RAW OBSERVATIONS BEHIND TRANSITIONS (first {max_printed} activations per rule/GPU; every one is in result.json; raw line = line number in samples.jsonl)"]
    for rr in res["rules"]:
        for e in rr["episodes"][:max_printed]:
            run = e["condition_run"]; vals = ",".join(f"{s['value']:g}" if s["value"] is not None else "missing" for s in run["samples"]) + (f" (+{run['samples_elided']} elided)" if run.get("samples_elided") else "")
            clr = f"cleared t={e['cleared_t']:g} value {e['clear_trigger']['value']} (<{e['clear_trigger']['clear_level_c']:g})" if e["cleared_index"] is not None else "still active at end"
            L.append(f"  {rr['rule']['id']:24s}{rr['gpu']} t={e['activated_t']:<7g} line {e['trigger']['raw_line']:<5d} {e['activated_phase']:8s} value {e['trigger']['value']} from {e['trigger']['source']}  run[{run['count']}]={vals}  peak {e['peak']}  dur {e['duration_s']:g}s  {clr}")
        if len(rr["episodes"]) > max_printed: L.append(f"  {rr['rule']['id']:24s}{rr['gpu']} ... {len(rr['episodes']) - max_printed} more episodes in result.json")
    L += ["", "SENSOR-CLASS BEHAVIOUR DURING LOADED PHASES (instantaneous run structure at each rule threshold; independent of persistence)"]
    for key, d in res["class_profile"].items():
        L.append(f"  {key:30s} min/mean/p99/max {d['min']:g}/{d['mean']:g}/{d['p99']:g}/{d['max']:g} C")
        for thr, b in d["by_threshold"].items():
            if b["samples_at_or_above"]: L.append(f"      >= {thr:>5s} C: {b['share_of_loaded_pct']:5.1f}% of loaded samples in {b['runs']} runs, run lengths {b['run_length_buckets']}")
    return "\n".join(L) + "\n"


def compare_persistence(trace: Trace, policy: dict, values: list) -> str:
    """Same policy, only persistence changed, side by side: trips / active seconds / re-trips per rule and GPU."""
    rows = {}
    for pv in values:
        variant = dict(policy); variant["rules"] = [Rule(**{**r.__dict__, "persistence_s": pv}) for r in policy["rules"]]
        res = replay(trace, variant)
        for rr in res["rules"]: rows.setdefault((rr["rule"]["id"], rr["gpu"]), {})[pv] = (rr["trips"], rr["active_seconds"], rr["short_episodes"])
    L = [f"INSTANTANEOUS vs PERSISTENT: policy '{policy['name']}' [{policy['status']}], persistence overridden on every rule (1 s = instantaneous). Cells: trips / active seconds / episodes shorter than 10 s.", "  " + f"{'rule':26s}{'gpu':5s}" + "".join(f"{'N=' + format(v, 'g') + 's':>18s}" for v in values)]
    for (rid, g), d in rows.items(): L.append("  " + f"{rid:26s}{g:5s}" + "".join(f"{str(d[v][0]) + ' / ' + format(d[v][1], '.0f') + ' / ' + str(d[v][2]):>18s}" for v in values))
    return "\n".join(L) + "\n"


# ----------------------------------------------------------------------------------------------- CLI
def main(argv=None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Offline thermal-policy replay (analytical, read-only).")
    ap.add_argument("--raw", default=os.path.join(here, "..", "raw", "thermal-soak-20261003T170044Z")); ap.add_argument("--policy", action="append", required=True)
    ap.add_argument("--out", default=os.path.join(here, "output")); ap.add_argument("--compare-persistence", default=""); ap.add_argument("--drop", action="append", default=[])
    ap.add_argument("--max-printed", type=int, default=8); ap.add_argument("--short-episode-s", type=float, default=10.0); ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    raw = os.path.realpath(a.raw); out = os.path.realpath(a.out)
    if out == raw or out.startswith(raw + os.sep): print("refusing to write results inside the raw evidence directory", file=sys.stderr); return 2
    before = sha256_file(os.path.join(raw, "samples.jsonl")); os.makedirs(out, exist_ok=True)
    for pf in a.policy:
        with open(pf) as f: policy = parse_policy(json.load(f))
        trace = load_trace(raw)
        for spec in a.drop: inject_dropout(trace, spec)
        res = replay(trace, policy, a.short_episode_s); text = render_text(res, a.max_printed)
        if a.compare_persistence: text += "\n" + compare_persistence(trace, policy, [float(x) for x in a.compare_persistence.split(",")])
        d = os.path.join(out, os.path.splitext(os.path.basename(pf))[0]); os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "report.txt"), "w") as f: f.write(text)
        with open(os.path.join(d, "result.json"), "w") as f: f.write(json.dumps(res, indent=1, sort_keys=True) + "\n")
        if not a.quiet: print(text)
    after = sha256_file(os.path.join(raw, "samples.jsonl"))
    if before != after: print("RAW EVIDENCE CHANGED DURING REPLAY (this must never happen)", file=sys.stderr); return 3
    if not a.quiet: print(f"raw samples.jsonl sha256 unchanged: {after}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
