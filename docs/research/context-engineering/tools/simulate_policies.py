#!/usr/bin/env python3
"""Token-only simulation of context policies on a recorded session (NO correctness claims).

Policies (applied to the transcript the model *would have been sent*):
  A0   as recorded
  CAP  tool results capped at CAP tokens (head+tail), raw assumed stored by reference (+STUB tokens for the ref marker)
  DUP  CAP + exact-duplicate results (same normalised text) replaced by a back-reference stub
  EVICT DUP + results older than K assistant turns replaced by a stub (kept in store, recallable)
Cost model: tokens per request = fixed (system + schemas) + sum of message tokens. Estimates use the Nexus-style BPE heuristic.
Usage: simulate_policies.py <session.json> [schema_tokens]
"""
import json, re, sys, hashlib
BPE = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d| ?[^\W\d_]+| ?\d+| ?[^\s\w]+|\s+(?!\S)|\s+", re.U)
def est(t): return sum((-(-len(x)//4) if len(x) > 8 else 1) for x in BPE.findall(t or ""))
def norm(s): return re.sub(r"\"duration_ms\": \d+", "", re.sub(r"\d{4}-\d\d-\d\dT[\d:.]+Z", "", s))
d = json.load(open(sys.argv[1])); m = d["messages"]; SCH = int(sys.argv[2]) if len(sys.argv) > 2 else 4877
STUB = 40
def tok(x, override=None):
    c = x.get("content"); c = c if isinstance(c, str) else ""
    if override is not None: return override
    return est(c) + est(json.dumps(x["tool_calls"]) if x.get("tool_calls") else "") + 4
n_steps = sum(1 for x in m if x["role"] == "assistant")
def run(policy, cap=3000, k=6):
    seen = {}; total = 0; peak = 0
    for step in range(1, n_steps + 1):
        upto = 2 + 2 * (step - 1)
        req = SCH
        for i in range(upto):
            x = m[i]; t = tok(x)
            if x["role"] == "tool" and policy != "A0":
                c = x.get("content") if isinstance(x.get("content"), str) else ""
                if t > cap: t = cap + STUB
                if policy in ("DUP", "EVICT"):
                    h = hashlib.sha1(norm(c).encode()).hexdigest()
                    if h in seen and seen[h] < i and len(c) > 200: t = STUB
                    else: seen.setdefault(h, i)
                if policy == "EVICT":
                    age = (upto - i) // 2
                    if age > k: t = STUB
            req += t
        total += req; peak = max(peak, req)
    return total, peak
base, bpeak = run("A0")
print(f"{'policy':28s} {'cumulative':>11s} {'vs A0':>7s} {'peak':>7s}")
for name, pol, kw in [("A0 recorded", "A0", {}), ("CAP 3000", "CAP", dict(cap=3000)), ("CAP 1500", "CAP", dict(cap=1500)), ("CAP 3000 + DUP", "DUP", dict(cap=3000)),
                      ("CAP 3000 + DUP + EVICT k=6", "EVICT", dict(cap=3000, k=6)), ("CAP 3000 + DUP + EVICT k=3", "EVICT", dict(cap=3000, k=3))]:
    t, p = run(pol, **kw)
    print(f"{name:28s} {t:11d} {100*t/base:6.1f}% {p:7d}")
