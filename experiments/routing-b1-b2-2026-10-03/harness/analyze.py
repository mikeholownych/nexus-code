import json, collections, os, re
E = "evidence/"
rows = [json.loads(l) for l in open(E + "gateway-evidence-full-after-experiment.jsonl") if l.startswith("{")]
sel = {r["request_id"]: r for r in rows if r["event"] == "worker_selected"}
val = {r["request_id"]: r for r in rows if r["event"] == "response_validated"}
fail = collections.defaultdict(list)
for r in rows:
    if r["event"] in ("execution_failed", "routing_rejected", "response_rejected"): fail[r["request_id"]].append(r)
arms = {a: json.load(open(f"{E}{a}/results.json")) for a in ("B1-run-2", "B2-run-2")}
out = {}
for a, res in arms.items():
    for r in res:
        reqs = r["request_ids"]
        pools = collections.Counter(sel[q]["route_pool"] for q in reqs if q in sel)
        workers = collections.Counter(sel[q]["worker_id"] for q in reqs if q in sel)
        fb = sum(1 for q in reqs if q in sel and sel[q].get("route_fallback"))
        errs = [(f["event"], f.get("failure_class"), (f.get("detail") or "")[:90]) for q in reqs for f in fail.get(q, [])]
        tc_parse = sum("Failed to parse tool call" in (e[2] or "") for e in errs)
        r.update(routed_requests=len(reqs), matched_in_gateway=sum(q in sel for q in reqs), pools=dict(pools), workers=dict(workers), fallback_requests=fb, gateway_errors=errs, tool_call_parse_errors=tc_parse,
                 merged_tool_names=sorted(set(re.findall(r"Tool Call: (\w+)", re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", open(f"{E}{a}/{r['task']}.transcript.txt").read()))) - {"read_file","write_file","edit_file","list_dir","search_code","run_command","find_files","task_completed","run_tests","patch_file","file_info","batch_read","file_tree","update_plan","git_status","git_diff","git_log","outline_file","search_symbols","delete_file","cst_symbols","trigram_search","hybrid_search"}))
    out[a] = res
json.dump(out, open(E + "paired-analysis.json", "w"), indent=1)
b1 = {r["task"]: r for r in out["B1-run-2"]}; b2 = {r["task"]: r for r in out["B2-run-2"]}
print(f"{'task':22} {'B1-run-2':34} {'B2-run-2':34} pools(B2)")
def f(r): return ("PASS " if r["validated"] else "FAIL ") + f"{r['secs']:.0f}s/{r['steps']}st " + r["classification"]
for t in b1: print(f"{t:22} {f(b1[t]):34} {f(b2[t]):34} {b2[t]['pools']}")
for a, d in (("B1-run-2", b1), ("B2-run-2", b2)):
    v = list(d.values()); c = collections.Counter(r["classification"] for r in v)
    print(a, "validated", sum(r["validated"] for r in v), "/", len(v), "| avg s", round(sum(r["secs"] for r in v) / len(v)), "| avg steps", round(sum(r["steps"] for r in v) / len(v), 1), "| total s", round(sum(r["secs"] for r in v)), "|", dict(c))
    print("   requests", sum(r["routed_requests"] for r in v), "matched in gateway", sum(r["matched_in_gateway"] for r in v), "pools", dict(sum((collections.Counter(r["pools"]) for r in v), collections.Counter())), "fallbacks", sum(r["fallback_requests"] for r in v), "gateway errors", sum(len(r["gateway_errors"]) for r in v), "tool-call-parse errors", sum(r["tool_call_parse_errors"] for r in v), "merged tool names", [r["task"] for r in v if r["merged_tool_names"]])
