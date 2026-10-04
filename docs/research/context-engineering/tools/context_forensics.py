#!/usr/bin/env python3
"""Read-only context accounting for a persisted Nexus session JSON.

Usage: context_forensics.py <session.json> [--json]
Token estimates use a char/4 proxy and the BPE-ish regex heuristic from cli/src/tokens.ts (NOT server counts).
Nothing here touches runtime behaviour or the session file.
"""
import json, re, sys, hashlib, collections

BPE = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d| ?[^\W\d_]+| ?\d+| ?[^\s\w]+|\s+(?!\S)|\s+", re.U)

def est(text):
    if not text: return 0
    n = 0
    for m in BPE.findall(text):
        n += -(-len(m) // 4) if len(m) > 8 else 1
    return n

def content_str(m):
    c = m.get("content")
    return c if isinstance(c, str) else ("" if c is None else json.dumps(c))

def norm(s):
    s = re.sub(r"\d{4}-\d\d-\d\dT[\d:.]+Z", "<ts>", s)
    s = re.sub(r"\"duration_ms\": \d+", "\"duration_ms\": N", s)
    return s

def main():
    d = json.load(open(sys.argv[1]))
    msgs = d["messages"]
    tools_by_id = {}
    for m in msgs:
        for tc in m.get("tool_calls") or []:
            tools_by_id[tc["id"]] = tc["function"]
    rows = []
    cum = 0
    seen = {}
    dup_tokens = 0
    for i, m in enumerate(msgs):
        s = content_str(m)
        tc = json.dumps(m.get("tool_calls")) if m.get("tool_calls") else ""
        t = est(s) + est(tc) + 4
        cum += t
        h = hashlib.sha1(norm(s).encode()).hexdigest()
        dup = h in seen and len(s) > 200
        if dup: dup_tokens += t
        seen.setdefault(h, i)
        name = m.get("name") or ""
        args = ""
        if m["role"] == "tool":
            # tool_call_ids are redacted in persisted sessions (HIGH_ENTROPY_STRING), so pair by adjacency instead
            prev = msgs[i - 1] if i else {}
            if prev.get("tool_calls"):
                f = prev["tool_calls"][0]["function"]; args = f.get("arguments", "")[:100]
                name = m.get("name") or f.get("name", name)
        elif m.get("tool_calls"):
            f = m["tool_calls"][0]["function"]; name = f["name"]; args = f["arguments"][:100]
        rows.append(dict(i=i, role=m["role"], tool=name, tokens=t, cum=cum, chars=len(s), dup_of=seen[h] if dup else None,
                         truncated="[TRUNCATED]" in s, args=args, head=s[:90].replace("\n", " ")))
    by_role = collections.Counter(); tok_role = collections.Counter()
    for r in rows: by_role[r["role"]] += 1; tok_role[r["role"]] += r["tokens"]
    tool_tok = collections.Counter(); tool_n = collections.Counter()
    for r in rows:
        if r["role"] == "tool": tool_tok[r["tool"]] += r["tokens"]; tool_n[r["tool"]] += 1
    calls = collections.Counter()
    for m in msgs:
        for tc in m.get("tool_calls") or []:
            calls[(tc["function"]["name"], tc["function"]["arguments"])] += 1
    repeated_calls = {f"{k[0]} {k[1][:80]}": v for k, v in calls.items() if v > 1}
    out = dict(session=d.get("id"), messages=len(msgs), total_est_tokens=cum, by_role_count=dict(by_role), by_role_tokens=dict(tok_role),
               tool_result_tokens=dict(tool_tok), tool_result_counts=dict(tool_n),
               exact_duplicate_message_tokens=dup_tokens, truncated_tool_results=sum(1 for r in rows if r["truncated"] and r["role"] == "tool"),
               repeated_identical_tool_calls=repeated_calls, rows=rows, persisted_tokenStats=d.get("tokenStats"))
    if "--json" in sys.argv:
        print(json.dumps(out, indent=1)); return
    print(f"session {out['session']}: {out['messages']} messages, est {cum} tokens (final message list, excl. tool schemas)")
    print("by role (msgs/tokens):", {k: (by_role[k], tok_role[k]) for k in by_role})
    print("tool results by tool (n/tokens):", {k: (tool_n[k], tool_tok[k]) for k in tool_tok})
    print("exact-duplicate message tokens:", dup_tokens, "| truncated tool results:", out["truncated_tool_results"])
    print("repeated identical tool calls:", repeated_calls)
    print("persisted tokenStats (cumulative prompt est):", out["persisted_tokenStats"])
    print("\n i  role       tool            tok   cum  flags  head")
    for r in rows:
        fl = ("D" if r["dup_of"] is not None else "-") + ("T" if r["truncated"] else "-")
        print(f"{r['i']:2d}  {r['role']:9s} {r['tool'][:14]:14s} {r['tokens']:5d} {r['cum']:6d}  {fl}    {r['head']}")
main()
