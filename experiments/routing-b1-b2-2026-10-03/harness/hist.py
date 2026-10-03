import sys,json,collections
rows=[json.loads(l) for l in sys.stdin if l.strip().startswith("{")]
sel={d["request_id"]:d for d in rows if d["event"]=="worker_selected"}
fails=[d for d in rows if d["event"]=="execution_failed"]
print("total execution_failed in file:",len(fails), "| by detail kind:")
k=collections.Counter(("tool-call-parse-500" if "Failed to parse tool call" in d.get("detail","") else d.get("detail","")[:60]) for d in fails)
for a,b in k.most_common(8): print("  ",b,a)
byday=collections.Counter(d["recorded_at"][:13] for d in fails if "Failed to parse tool call" in d.get("detail",""))
print("tool-call-parse 500s by hour:",dict(sorted(byday.items())))
# per window: lead requests, failures
def win(lo,hi,label):
    s=[d for d in sel.values() if lo<=d["recorded_at"][11:19]<=hi and d["recorded_at"][:10]=="2026-10-03"]
    f=[d for d in fails if lo<=d["recorded_at"][11:19]<=hi and d["recorded_at"][:10]=="2026-10-03"]
    pools=collections.Counter(d.get("route_pool") for d in s)
    print(f"{label}: requests {dict(pools)} failures {len(f)} (tool-call parse: {sum('Failed to parse tool call' in d.get('detail','') for d in f)})")
win("13:03:00","13:22:56","B1 window (single-model lead)")
win("13:23:14","13:44:01","B2-run-1 window (deep planner + lead coder)")
# was each failing lead request the first lead request after a deep request?
order=sorted(sel.values(),key=lambda d:d["recorded_at"])
prev=None; res=[]
for d in order:
    if d["recorded_at"][:10]!="2026-10-03" or not("13:23:14"<=d["recorded_at"][11:19]<="13:44:01"): prev=d; continue
    if d.get("route_pool")=="lead":
        after_deep = prev is not None and prev.get("route_pool")=="deep"
        failed=any(f["request_id"]==d["request_id"] for f in fails)
        res.append((after_deep,failed))
    prev=d
import itertools
for ad in (True,False):
    sub=[f for a,f in res if a==ad]; print(f"lead requests {'immediately after a deep request' if ad else 'in a lead-only sequence'}: {len(sub)} total, {sum(sub)} failed")
