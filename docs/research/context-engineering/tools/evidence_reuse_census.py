#!/usr/bin/env python3
"""Offline proxy census: how often is a large tool result *referenced again* by later assistant output?

For every persisted session/task JSON with >= 10 messages, for every tool result >= MIN_TOK estimated tokens, extract
"distinctive anchors" (path-like strings and identifiers >= 8 chars that occur in that result but in no more than
MAX_SHARE of all results of the session). A result counts as 'referenced later' at distance d (in assistant turns) if a later
assistant message text or tool-call arguments contains >= 1 anchor. This is a PROXY: mention != need, absence != unneeded.
Read-only. Usage: evidence_reuse_census.py <dir> [--min-tok 500]
"""
import json, re, sys, glob, os, collections, statistics
BPE = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d| ?[^\W\d_]+| ?\d+| ?[^\s\w]+|\s+(?!\S)|\s+", re.U)
def est(t): return sum((-(-len(x)//4) if len(x) > 8 else 1) for x in BPE.findall(t or ""))
ANCHOR = re.compile(r"[A-Za-z0-9_./-]{8,}")
def text(m):
    c = m.get("content"); c = c if isinstance(c, str) else ""
    tc = json.dumps(m.get("tool_calls")) if m.get("tool_calls") else ""
    return c, tc
def main():
    d = sys.argv[1]; min_tok = int(sys.argv[sys.argv.index("--min-tok")+1]) if "--min-tok" in sys.argv else 500
    files = sorted(glob.glob(os.path.join(d, "*.json")))
    tot_res = 0; tot_tok = 0; ref_tok = 0; never_tok = 0; dists = []; nsess = 0; per_sess = []
    for f in files:
        try: s = json.load(open(f))
        except Exception: continue
        msgs = s.get("messages") or []
        if len(msgs) < 10: continue
        nsess += 1
        results = [(i, m) for i, m in enumerate(msgs) if m.get("role") == "tool"]
        anchors = {}
        df = collections.Counter()
        for i, m in results:
            a = set(ANCHOR.findall(text(m)[0]))
            anchors[i] = a
            df.update(a)
        s_tok = s_never = 0
        for i, m in results:
            t = est(text(m)[0]) + 4
            if t < min_tok: continue
            tot_res += 1; tot_tok += t; s_tok += t
            distinct = {a for a in anchors[i] if df[a] <= max(2, len(results) * 0.15)}
            later = [(j, text(x)) for j, x in enumerate(msgs) if j > i and x.get("role") == "assistant"]
            hit = None
            for k, (j, (c, tc)) in enumerate(later):
                blob = c + tc
                if any(a in blob for a in distinct): hit = k + 1; break
            if hit: ref_tok += t; dists.append(hit)
            else: never_tok += t; s_never += t
        if s_tok: per_sess.append((os.path.basename(f), s_tok, s_never))
    print(f"sessions analysed: {nsess}; large results (>= {min_tok} est tokens): {tot_res}; tokens: {tot_tok}")
    if tot_tok:
        print(f"never referenced again by later assistant output (proxy): {never_tok} tokens = {100*never_tok/tot_tok:.1f}%")
        print(f"referenced later: {ref_tok} tokens = {100*ref_tok/tot_tok:.1f}%")
    if dists:
        qs = statistics.quantiles(dists, n=10) if len(dists) >= 10 else []
        print(f"first-reference distance (assistant turns after the result): median {statistics.median(dists)}, mean {statistics.mean(dists):.1f}, p90 {qs[-1] if qs else max(dists)}; >5 turns later: {100*sum(1 for x in dists if x > 5)/len(dists):.1f}%; >10: {100*sum(1 for x in dists if x > 10)/len(dists):.1f}%")
main()
