import sys,json,collections
lo,hi=sys.argv[1],sys.argv[2]
ev=[]
for l in sys.stdin:
    try: d=json.loads(l)
    except: continue
    t=d.get("recorded_at","")
    if lo<=t[11:19]<=hi and t[:10]=="2026-10-03": ev.append(d)
c=collections.Counter((d["event"],d.get("route_pool") or d.get("worker_id","")[-8:]) for d in ev)
print("window events:",len(ev)); 
for k,v in sorted(c.items()): print(" ",k,v)
odd=[d for d in ev if d["event"] not in("worker_selected","response_validated")]
print("non-routine events:",len(odd))
for d in odd[:25]: print(" ",d["recorded_at"][11:19],d["event"],{k:v for k,v in d.items() if k not in("evidence_id","previous_hash","record_hash","recorded_at","event","worker_identity")})
# per-request timing for deep pool
sel={d["request_id"]:d for d in ev if d["event"]=="worker_selected"}
val={d["request_id"]:d for d in ev if d["event"]=="response_validated"}
deep=[(sel[r]["recorded_at"][11:19],val[r]["elapsed_ms"] if r in val else None) for r in sel if sel[r].get("route_pool")=="deep"]
print("deep-pool requests (time, elapsed_ms or None=no validated response):"); print(" ",sorted(deep)[:60])
