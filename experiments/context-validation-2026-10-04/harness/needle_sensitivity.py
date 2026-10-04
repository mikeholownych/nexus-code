#!/usr/bin/env python3
"""E2 / H12: does local-model correctness depend on context length (and distractor load) in the 5-50k range?

Each trial builds a Nexus-shaped transcript (system, objective, N read_file tool results taken from real fixture text) of a target size,
plants ONE decisive fact (and a lookalike with a different scope) at a controlled position inside one tool result, then asks a closed question whose
correct answer requires the planted fact. Scoring is deterministic string matching. Model is called at temperature 0, max_tokens 48.
Cells: size x position. Same trial seeds are used across sizes so only context length/distractor load varies.

usage: needle_sensitivity.py --fixture /tmp/fx/ledger --tools fixtures/nexus_tools_and_system.json --out results/needle.jsonl
       [--sizes 5000,10000,20000,35000,50000] [--n 30] [--model engineering/b0]
"""
import argparse, json, os, random, sys, time, hashlib
sys.path.insert(0, os.path.dirname(__file__))
from replay_layouts import read_token, post, metrics, busy, est

FACTS = [
    dict(id="legacy_ts", fact="NOTE(ops): the legacy exporter emits `ts` in epoch MILLISECONDS; importers must divide by 1000.",
         lookalike="NOTE(partner-v2): the partner v2 feed emits `ts` in epoch MICROSECONDS; this does not apply to the legacy exporter.",
         question="What unit does the legacy exporter's `ts` field use, and what must importers do before comparing with internal windows? Answer exactly in the form `UNIT=<seconds|milliseconds|microseconds>; ACTION=<short text>`.",
         ok=lambda a: "UNIT=MILLISECONDS" in a.upper() and ("1000" in a or "DIVIDE" in a.upper()), bad=lambda a: "MICRO" in a.upper() and "UNIT=MILLI" not in a.upper()),
    dict(id="rounding", fact="NOTE(ledger): the internal ledger rounds amounts HALF UP to the nearest cent.",
         lookalike="NOTE(partner-v2): partner v2 amounts use banker's rounding; this does not apply to the internal ledger.",
         question="Which rounding rule does the internal ledger use for amounts? Answer exactly in the form `RULE=<half-up|bankers|floor>`.",
         ok=lambda a: "RULE=HALF-UP" in a.upper() or "RULE=HALF UP" in a.upper(), bad=lambda a: "RULE=BANKER" in a.upper()),
    dict(id="flag", fact="NOTE(ci): integration tests only run when the environment variable LEDGER_TZ_STRICT=1 is set.",
         lookalike="NOTE(old-docs): in v1 the integration tests were enabled by LEDGER_STRICT=true; this flag was removed in v2.",
         question="Which environment variable enables the integration tests in the current version? Answer exactly in the form `VAR=<name>`.",
         ok=lambda a: "VAR=LEDGER_TZ_STRICT" in a.upper(), bad=lambda a: "VAR=LEDGER_STRICT" in a.upper() and "TZ" not in a.upper()),
    dict(id="region", fact="NOTE(limits): the account limit for acct17 is 7421 and applies to region 'eu' only.",
         lookalike="NOTE(limits-draft): a draft proposed 9000 as the acct17 limit for region 'na'; it was never adopted.",
         question="What is the adopted limit for acct17 in region eu? Answer exactly in the form `LIMIT=<number>`.",
         ok=lambda a: "LIMIT=7421" in a.upper().replace(" ", ""), bad=lambda a: "LIMIT=9000" in a.upper().replace(" ", "")),
]

def haystack_chunks(fixture):
    texts = []
    for rel in ("docs/CHANGELOG.md", "docs/ARCHITECTURE.md", "TODO.md", "fixtures/noise_transactions.json"):
        t = open(os.path.join(fixture, rel)).read()
        for i in range(0, len(t), 3000): texts.append((rel, t[i:i + 3000]))
    return texts

def build(system, tools_est, fixture, size_tokens, fact, pos, rng, chunks):
    objective = open(os.path.join(fixture, "OBJECTIVE.md")).read()
    msgs = [system, {"role": "user", "content": objective}]
    budget = size_tokens - est(system["content"]) - est(objective) - 400
    order = chunks[:]; rng.shuffle(order)
    picked = []; used = 0
    for rel, c in order:
        t = est(c)
        if used + t > budget: break
        picked.append((rel, c)); used += t
    for extra in order:                              # always at least two chunks (fact + lookalike need separate homes)
        if len(picked) >= 2: break
        if extra not in picked: picked.append(extra)
    # plant fact + lookalike inside one chunk, at a controlled relative position of the whole transcript
    idx = {"early": 0, "middle": len(picked) // 2, "late": len(picked) - 1}[pos]
    rel, c = picked[idx]; cut = rng.randint(len(c) // 4, 3 * len(c) // 4)
    c = c[:cut] + "\n" + fact["fact"] + "\n" + c[cut:]
    lrel, lc = picked[(idx + 1) % len(picked)] if len(picked) > 1 else (rel, c)
    if len(picked) > 1:
        lcut = rng.randint(len(lc) // 4, 3 * len(lc) // 4); lc = lc[:lcut] + "\n" + fact["lookalike"] + "\n" + lc[lcut:]
        picked[(idx + 1) % len(picked)] = (lrel, lc)
    picked[idx] = (rel, c)
    for i, (rel, c) in enumerate(picked):
        cid = f"call_{i+1:03d}"
        msgs.append({"role": "assistant", "content": "", "tool_calls": [{"id": cid, "type": "function", "function": {"name": "read_file", "arguments": json.dumps({"path": rel})}}]})
        msgs.append({"role": "tool", "tool_call_id": cid, "name": "read_file", "content": c})
    msgs.append({"role": "user", "content": fact["question"] + " Do not call any tool; answer directly from the tool results shown above, in exactly the requested form, with no other text."})
    return msgs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", required=True); ap.add_argument("--tools", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--sizes", default="11000,15000,25000,35000,50000"); ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--model", default="engineering/b0"); ap.add_argument("--base", default="http://127.0.0.1:18010")
    ap.add_argument("--yield-to-others", action="store_true", help="before each request wait (<=180 s) until no other chat request is in flight")
    a = ap.parse_args(); tok = read_token()
    td = json.load(open(a.tools)); tools = td["tools"]; system = {"role": "system", "content": td["system"]}
    tools_est = est(json.dumps(tools)); chunks = haystack_chunks(a.fixture)
    out = open(a.out, "a"); positions = ["early", "middle", "late"]
    out.write(json.dumps({"type": "meta", "model": a.model, "sizes": a.sizes, "n": a.n, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}) + "\n")
    for trial in range(a.n):                       # same seeds across sizes
        fact = FACTS[trial % len(FACTS)]; pos = positions[(trial // len(FACTS)) % 3]
        for size in [int(s) for s in a.sizes.split(",")]:
            rng = random.Random(1000 + trial)
            msgs = build(system, tools_est, a.fixture, size, fact, pos, rng, chunks)
            body = {"model": a.model, "messages": msgs, "max_tokens": 160, "temperature": 0}   # no tools param: the study isolates length/distractor effects
            row = {"type": "trial", "trial": trial, "fact": fact["id"], "position": pos, "target": size}
            try:
                if a.yield_to_others:
                    t0 = time.time()
                    while time.time() - t0 < 180:
                        chat, eng = busy(metrics(a.base, tok))
                        if chat == 0: break
                        time.sleep(4)
                resp, dt, route = post(a.base, tok, body, timeout=900)
                ans = (resp["choices"][0]["message"].get("content") or "")
                u = resp.get("usage", {})
                row.update(prompt_tokens=u.get("prompt_tokens"), cached=(u.get("prompt_tokens_details") or {}).get("cached_tokens"), wall_s=round(dt, 2),
                           answer=ans[:200], correct=bool(fact["ok"](ans)), lookalike_chosen=bool(fact["bad"](ans)))
            except Exception as e:
                row.update(error=str(e)[:200])
            out.write(json.dumps(row) + "\n"); out.flush()
            print(f"t{trial:02d} {fact['id']:9s} {pos:6s} size={size:5d} -> prompt={row.get('prompt_tokens')} ok={row.get('correct')} lookalike={row.get('lookalike_chosen')} {row.get('wall_s')}s", flush=True)

if __name__ == "__main__": main()
