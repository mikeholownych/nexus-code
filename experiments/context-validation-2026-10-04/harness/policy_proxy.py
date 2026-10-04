#!/usr/bin/env python3
"""Experiment-only OpenAI-compatible proxy that applies a context policy to /v1/chat/completions requests between an UNMODIFIED Nexus
and the real gateway. Lets Layer B compare C0 (pass-through) with a deterministic A1+E policy without touching Nexus runtime code.

Policies:  c0   pass-through
           c2   cap tool results (CAP tokens, head+tail), exact-duplicate back-references (keyed by tool name + normalised output),
                evict results older than KEEP assistant turns to a stub that tells the model the call can be re-run (raw stays on the proxy
                disk under evidence/ and is logged in the manifest), pinned objective = the first user message is never touched.
Every request writes a manifest line to --manifest (packet hash, message/token counts before/after, capped/deduped/evicted refs).
Streaming responses are piped through unchanged. Provider token usage is not available on streams; the harness reads gateway counters.

usage: policy_proxy.py --policy c2 --listen 18111 --upstream http://127.0.0.1:18010 --manifest results/layerB/c2.manifest.jsonl [--cap 3000] [--keep 6]
"""
import argparse, hashlib, http.server, json, os, re, sys, threading, time, urllib.request

BPE = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d| ?[^\W\d_]+| ?\d+| ?[^\s\w]+|\s+(?!\S)|\s+", re.U)
def est(t): return sum((-(-len(x) // 4) if len(x) > 8 else 1) for x in BPE.findall(t or ""))
def mtok(m):
    c = m.get("content"); c = c if isinstance(c, str) else json.dumps(c) if c else ""
    return est(c) + est(json.dumps(m["tool_calls"]) if m.get("tool_calls") else "") + 4
def norm(s): return re.sub(r"\"duration_ms\": \d+", "", re.sub(r"\d{4}-\d\d-\d\dT[\d:.]+Z", "", s))

def apply_c2(messages, cap, keep, evidence_dir):
    # index assistant turns that own tool results
    out = []; seen = {}; notes = {"capped": [], "deduped": [], "evicted": []}
    asst_idx = [i for i, m in enumerate(messages) if m["role"] == "assistant"]
    total_turns = len(asst_idx)
    call_of = {}
    for m in messages:
        for tc in (m.get("tool_calls") or []): call_of[tc["id"]] = f"{tc['function']['name']} {str(tc['function'].get('arguments',''))[:100]}"
    turn_no = 0
    for i, m in enumerate(messages):
        if m["role"] == "assistant": turn_no += 1
        if m["role"] != "tool" or not isinstance(m.get("content"), str):
            out.append(m); continue
        c = m["content"]; h = hashlib.sha1(norm(c).encode()).hexdigest(); ref = f"evidence://{h[:10]}"
        os.makedirs(evidence_dir, exist_ok=True)
        p = os.path.join(evidence_dir, h[:10] + ".txt")
        if not os.path.exists(p): open(p, "w").write(c)
        desc = call_of.get(m.get("tool_call_id"), m.get("name", "tool"))
        age = total_turns - turn_no
        t = est(c)
        if age > keep and t > 60:
            body = f"[evicted result of `{desc}` ({t} tokens, {ref}). To see it again, re-run the same tool call.]"; notes["evicted"].append(ref)
        elif h in seen and len(c) > 200:
            body = f"[duplicate of an earlier identical result ({seen[h]}); not repeated. Re-run the tool if you need to re-read it.]"; notes["deduped"].append(ref)
        else:
            seen.setdefault(h, ref)
            if t > cap:
                lim = cap * 4; half = lim // 2
                body = c[:half] + f"\n... [truncated: {t - cap} tokens omitted; full output {ref}; re-run with a narrower request, e.g. a line range] ...\n" + c[-half:]
                notes["capped"].append(ref)
            else: body = c
        out.append({**m, "content": body})
    return out, notes

def enforce_budget(msgs, budget, keep_recent=2):
    """Evict oldest not-yet-stubbed tool results (store keeps them) until the message estimate fits `budget`; the last `keep_recent` assistant turns are never evicted."""
    total = sum(mtok(m) for m in msgs); evicted = 0
    asst = [i for i, m in enumerate(msgs) if m["role"] == "assistant"]; protect_from = asst[-keep_recent] if len(asst) >= keep_recent else 0
    call_of = {}
    for m in msgs:
        for tc in (m.get("tool_calls") or []): call_of[tc["id"]] = f"{tc['function']['name']} {str(tc['function'].get('arguments',''))[:100]}"
    out = list(msgs)
    for i, m in enumerate(out):
        if total <= budget: break
        if m["role"] == "tool" and i < protect_from and isinstance(m.get("content"), str) and not m["content"].startswith("[evicted") and est(m["content"]) > 60:
            h = hashlib.sha1(norm(m["content"]).encode()).hexdigest()[:10]
            stub = f"[evicted result of `{call_of.get(m.get('tool_call_id'), m.get('name','tool'))}` (evidence://{h}) to fit the context budget. To see it again, re-run the same tool call.]"
            total -= mtok(m) - (est(stub) + 4); out[i] = {**m, "content": stub}; evicted += 1
    return out, evicted

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--policy", default="c0", choices=["c0", "c2"]); ap.add_argument("--listen", type=int, required=True)
    ap.add_argument("--upstream", default="http://127.0.0.1:18010"); ap.add_argument("--manifest", required=True)
    ap.add_argument("--cap", type=int, default=3000); ap.add_argument("--keep", type=int, default=6)
    ap.add_argument("--budget", type=int, default=0, help="c2 only: hard message-token budget enforced by oldest-first eviction")
    a = ap.parse_args(); os.makedirs(os.path.dirname(a.manifest) or ".", exist_ok=True)
    evdir = os.path.join(os.path.dirname(a.manifest) or ".", "evidence"); lock = threading.Lock(); counter = [0]

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *x): pass
        def _forward(self, body=None):
            hdr = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "connection", "accept-encoding")}
            req = urllib.request.Request(a.upstream + self.path, data=body, headers=hdr, method=self.command)
            try: r = urllib.request.urlopen(req, timeout=900)
            except urllib.error.HTTPError as e: r = e
            self.send_response(r.status if hasattr(r, "status") else r.code)
            for k, v in r.headers.items():
                if k.lower() not in ("transfer-encoding", "connection", "content-length"): self.send_header(k, v)
            self.send_header("Connection", "close"); self.end_headers()
            while True:
                chunk = r.read(1024)
                if not chunk: break
                self.wfile.write(chunk); self.wfile.flush()
            self.close_connection = True
        def do_GET(self): self._forward()
        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("content-length", 0)))
            if self.path.endswith("/chat/completions") and a.policy != "c0":
                try:
                    b = json.loads(raw); before = sum(mtok(m) for m in b["messages"])
                    msgs, notes = apply_c2(b["messages"], a.cap, a.keep if not a.budget else 10**6, evdir)   # with a budget, eviction is budget-driven
                    if a.budget:
                        msgs, ev = enforce_budget(msgs, a.budget); notes["evicted"] = notes["evicted"] + ["b"] * ev
                    b["messages"] = msgs; raw2 = json.dumps(b).encode(); after = sum(mtok(m) for m in msgs)
                except Exception as e:
                    raw2 = raw; before = after = -1; notes = {"error": str(e)[:200]}
            else:
                raw2 = raw
                try: before = after = sum(mtok(m) for m in json.loads(raw)["messages"]); notes = {}
                except Exception: before = after = -1; notes = {}
            with lock:
                counter[0] += 1
                open(a.manifest, "a").write(json.dumps({"n": counter[0], "t": time.time(), "policy": a.policy, "path": self.path, "msgs_est_before": before, "msgs_est_after": after,
                    "packet_sha256": hashlib.sha256(raw2).hexdigest(), **{k: len(v) if isinstance(v, list) else v for k, v in notes.items()}}) + "\n")
            self._forward(raw2)
    http.server.ThreadingHTTPServer.daemon_threads = True
    print("proxy up", a.policy, a.listen, flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", a.listen), H).serve_forever()

if __name__ == "__main__": main()
