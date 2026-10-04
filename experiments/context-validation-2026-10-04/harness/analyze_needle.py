#!/usr/bin/env python3
"""Summarise needle_sensitivity output: accuracy by target size (and position/fact), with exact binomial (Clopper-Pearson) 95% CIs."""
import json, sys, collections, math
def cp(k, n, a=0.05):
    from math import comb
    def tail(p, k, n, upper):
        return sum(comb(n, i) * p**i * (1-p)**(n-i) for i in (range(k, n+1) if upper else range(0, k+1)))
    lo = 0.0; hi = 1.0
    if k > 0:
        l, h = 0.0, 1.0
        for _ in range(60):
            m = (l+h)/2
            if tail(m, k, n, True) < a/2: l = m
            else: h = m
        lo = (l+h)/2
    if k < n:
        l, h = 0.0, 1.0
        for _ in range(60):
            m = (l+h)/2
            if tail(m, k, n, False) > a/2: l = m
            else: h = m
        hi = (l+h)/2
    return lo, hi
rows = [json.loads(l) for l in open(sys.argv[1])]
tr = [r for r in rows if r.get("type") == "trial" and "correct" in r]
by = collections.defaultdict(list)
for r in tr: by[r["target"]].append(r)
print("| target | actual prompt tokens (mean) | n | correct | accuracy [95% CI] | lookalike chosen | mean wall s |"); print("|---|---|---|---|---|---|---|")
for t in sorted(by):
    rs = by[t]; k = sum(r["correct"] for r in rs); n = len(rs); lo, hi = cp(k, n)
    print(f"| {t} | {sum(r['prompt_tokens'] for r in rs)/n:.0f} | {n} | {k} | {k/n:.2f} [{lo:.2f}, {hi:.2f}] | {sum(r['lookalike_chosen'] for r in rs)} | {sum(r['wall_s'] for r in rs)/n:.1f} |")
print("\nby position:"); 
for pos in ("early", "middle", "late"):
    xs = [r for r in tr if r["position"] == pos]
    if xs: print(f"  {pos}: {sum(r['correct'] for r in xs)}/{len(xs)}")
print("by fact:")
for f in sorted({r["fact"] for r in tr}):
    xs = [r for r in tr if r["fact"] == f]; print(f"  {f}: {sum(r['correct'] for r in xs)}/{len(xs)}")
errs = [r for r in rows if r.get("error")]; print("errors:", len(errs))
