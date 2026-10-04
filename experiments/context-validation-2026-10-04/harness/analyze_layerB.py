#!/usr/bin/env python3
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
print("| cond | seed | execution/outcome | steps | requests | peak est ctx | cum est ctx | tests pass | tests untouched | api untouched | notes | modules fixed | duration s |"); print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
agg = collections.defaultdict(list)
for r in rows:
    if r.get("skipped"): print(f"| {r['cond']} | {r['seed']} | SKIPPED: {r['skipped']} |"); continue
    s = r["score"]; t = r["turn"]; st = r.get("steps") or {}
    print(f"| {r['cond']} | {r['seed']} | {t.get('execution')}/{t.get('outcome')} | {st.get('used')} | {r['requests']} | {r['peak_est_ctx']} | {r['cum_est_ctx']} | {s.get('tests_pass')} | {s.get('tests_untouched')} | {s.get('api_untouched')} | {s.get('notes_specific_both_files')} | {s.get('modules_fixed', '-')}/{s.get('modules_total', '-')} | {r['duration_s']} |")
    agg[r["cond"]].append(r)
print()
for c, rs in agg.items():
    n = len(rs); ok = sum(1 for r in rs if r["score"].get("tests_pass") and r["score"].get("tests_untouched") and r["score"].get("api_untouched") and r["score"].get("notes_specific_both_files"))
    print(f"{c}: full success {ok}/{n}; mean peak est ctx {sum(r['peak_est_ctx'] for r in rs)/n:.0f}; mean cumulative est ctx {sum(r['cum_est_ctx'] for r in rs)/n:.0f}; mean requests {sum(r['requests'] for r in rs)/n:.1f}; mean duration {sum(r['duration_s'] for r in rs)/n:.0f}s")
