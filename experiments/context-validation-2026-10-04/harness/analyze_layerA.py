#!/usr/bin/env python3
"""Summarise Layer A results from replay_layouts.py output. Only blocks with no contaminated rows and all steps present are used."""
import json, sys, collections, statistics
rows = [json.loads(l) for l in open(sys.argv[1])]
blocks = collections.defaultdict(list)
for r in rows:
    if r.get("type") == "req": blocks[(r["rep"], r["layout"], r["attempt"])].append(r)
clean = {}
for (rep, lay, att), rs in blocks.items():
    if all(not x.get("contaminated") and x.get("prompt_tokens") for x in rs) and len(rs) >= 30:
        clean[(rep, lay)] = rs            # last clean attempt wins
by_layout = collections.defaultdict(list)
for (rep, lay), rs in clean.items(): by_layout[lay].append(rs)
order = ["L0", "L1", "L2", "L2b", "L3u", "L3s"]
print("| layout | reps | cumulative logical prompt tokens | cumulative UNCACHED tokens (prefill work) | cached share | mean wall/step s | total wall s | peak prompt tokens | est/provider ratio |")
print("|---|---|---|---|---|---|---|---|---|")
summary = {}
for lay in order:
    if lay not in by_layout: continue
    reps = by_layout[lay]; vals = []
    for rs in reps:
        cum = sum(x["prompt_tokens"] for x in rs); cached = sum(min(x["cached_tokens"] or 0, x["prompt_tokens"]) for x in rs)
        wall = sum(x["wall_s"] for x in rs); peak = max(x["prompt_tokens"] for x in rs)
        ratio = statistics.mean(x["est_tokens"] / x["prompt_tokens"] for x in rs)
        vals.append((cum, cum - cached, cached / cum, wall / len(rs), wall, peak, ratio))
    m = [statistics.mean(v[i] for v in vals) for i in range(7)]
    summary[lay] = dict(reps=len(reps), cum=m[0], uncached=m[1], cached_share=m[2], wall_step=m[3], wall_total=m[4], peak=m[5], est_ratio=m[6])
    print(f"| {lay} | {len(reps)} | {m[0]:.0f} | {m[1]:.0f} | {100*m[2]:.1f}% | {m[3]:.2f} | {m[4]:.1f} | {m[5]:.0f} | {m[6]:.3f} |")
gave = [r for r in rows if r.get("type") == "gave_up"]
cont = sum(1 for r in rows if r.get("contaminated"))
print(f"\ncontaminated rows (discarded): {cont}; gave-up blocks: {gave}")
if "L0" in summary:
    b = summary["L0"]
    print("\nrelative to L0 (recorded):")
    for lay, s in summary.items():
        print(f"  {lay:4s} logical tokens {100*s['cum']/b['cum']:6.1f}% | uncached (prefill) tokens {100*s['uncached']/max(1,b['uncached']):7.1f}% | total wall {100*s['wall_total']/b['wall_total']:6.1f}%")
json.dump(summary, open(sys.argv[1].replace(".jsonl", ".summary.json"), "w"), indent=1)
