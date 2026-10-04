#!/usr/bin/env python3
"""Layer A: mechanical/economic replay of a recorded Nexus session under alternative context layouts.

Sends, for each step k of the recorded session, the request the layout would have sent (max_tokens=1, temperature 0, non-streaming so the
gateway returns exact `usage.prompt_tokens` and `prompt_tokens_details.cached_tokens`), and records wall time (≈ prefill time),
provider token counts and cache reuse. No correctness is measured here. The model's own outputs are NOT regenerated; the recorded
assistant/tool messages are replayed as history.

Gateway is used read-mostly: inference requests only (+ GET /metrics). It refuses to start unless the gateway looks idle.

usage: replay_layouts.py --session S.json --tools fixtures/nexus_tools_and_system.json --out results/layerA.jsonl
         [--layouts L0,L1,L2,L2b,L3u,L3s] [--reps 2] [--steps 1-30] [--model engineering/b0] [--dry]
"""
import argparse, hashlib, json, os, re, sys, time, urllib.request

BPE = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d| ?[^\W\d_]+| ?\d+| ?[^\s\w]+|\s+(?!\S)|\s+", re.U)
def est(t): return sum((-(-len(x) // 4) if len(x) > 8 else 1) for x in BPE.findall(t or ""))
def mtok(m):
    c = m.get("content"); c = c if isinstance(c, str) else ""
    return est(c) + est(json.dumps(m["tool_calls"]) if m.get("tool_calls") else "") + 4
def norm(s): return re.sub(r"\"duration_ms\": \d+", "", re.sub(r"\d{4}-\d\d-\d\dT[\d:.]+Z", "", s))

# ---------------------------------------------------------------- trace preparation
def prepare(session):
    """Return (system_msg, turns[]) where each turn = (assistant_msg, tool_msg) with valid sequential tool_call ids."""
    msgs = session["messages"]
    system = msgs[0]; first_user = msgs[1]
    turns = []; n = 0
    i = 2
    while i + 1 < len(msgs):
        a, t = msgs[i], msgs[i + 1]
        if a["role"] != "assistant" or t["role"] != "tool": break
        n += 1; cid = f"call_{n:03d}"
        calls = [dict(tc) for tc in (a.get("tool_calls") or [])]
        if calls: calls[0] = {**calls[0], "id": cid}
        a2 = {"role": "assistant", "content": a.get("content") or "", **({"tool_calls": calls} if calls else {})}
        t2 = {"role": "tool", "tool_call_id": cid, "name": t.get("name") or (calls[0]["function"]["name"] if calls else "tool"), "content": t.get("content") or ""}
        turns.append((a2, t2)); i += 2
    return system, first_user, turns

def call_desc(a):
    tc = (a.get("tool_calls") or [{}])[0].get("function", {})
    return f"{tc.get('name','?')} {str(tc.get('arguments',''))[:80]}"

def cap_text(c, cap_tokens):
    """head+tail by chars so the result is ~cap_tokens (4 chars/token)."""
    lim = cap_tokens * 4
    if len(c) <= lim: return c, False
    h = lim // 2
    return c[:h] + "\n... [truncated for context; full raw result stored by reference] ...\n" + c[-h:], True

# ---------------------------------------------------------------- layouts: k = number of completed turns visible (request k+1)
PIN = {"role": "user", "content": "[PINNED OBJECTIVE]\nPlaceholder objective and constraints block (~150 tokens). " + "Keep scope to the stated task; do not edit tests; verification must use the selected verifier. " * 8}

def L0(system, user, turns, k, **kw):
    out = [system, user]
    for a, t in turns[:k]: out += [a, t]
    return out

def _capdup(turns, k, cap=3000):
    seen = {}; res = []
    for idx, (a, t) in enumerate(turns[:k]):
        c = t["content"]; h = hashlib.sha1(norm(c).encode()).hexdigest()
        ref = f"evidence://r{idx+1:03d}"
        if h in seen and len(c) > 200:
            body = f"[duplicate of {seen[h]}: identical output, not repeated]"
        else:
            seen.setdefault(h, ref)
            body, trunc = cap_text(c, cap)
            if trunc: body += f"\n[full result: {ref}; use recall]"
        res.append((a, {**t, "content": body}))
    return res

def L1(system, user, turns, k, **kw):
    out = [system, user]
    for a, t in _capdup(turns, k): out += [a, t]
    return out

def stub(a, t, idx):
    return {**t, "content": f"[evicted result of `{call_desc(a)}` ({est(t['content'])} tokens) -> evidence://r{idx+1:03d}; use recall to re-read]"}

def L2(system, user, turns, k, keep=6, **kw):
    """per-step eviction: any result older than `keep` turns becomes a stub (changes history every step)."""
    base = _capdup(turns, k); out = [system, user]
    for idx, (a, t) in enumerate(base):
        age = k - idx
        out += [a, stub(a, t, idx) if age > keep else t]
    return out

def L2b(system, user, turns, k, keep=6, epoch=6, **kw):
    """epoch eviction: evict only at epoch boundaries (history changes once per `epoch` steps)."""
    kk = (k // epoch) * epoch                        # eviction horizon frozen between epoch boundaries
    base = _capdup(turns, k); out = [system, user]
    for idx, (a, t) in enumerate(base):
        age = kk - idx
        out += [a, stub(a, t, idx) if age > keep else t]
    return out

def L3u(system, user, turns, k, recent=4, **kw):
    """naive rebuilt packet: evidence block re-ordered newest-first each step, followed by a recent verbatim window."""
    base = _capdup(turns, k)
    old = base[:max(0, k - recent)]; rec = base[max(0, k - recent):]
    ev = "\n\n".join(f"[evidence r{i+1:03d}: {call_desc(a)}]\n{t['content']}" for i, (a, t) in reversed(list(enumerate(old))))
    out = [system, PIN, user]
    if ev: out.append({"role": "user", "content": "[EVIDENCE SELECTED FOR THIS TURN]\n" + ev})
    for a, t in rec: out += [a, t]
    return out

def L3s(system, user, turns, k, recent=4, **kw):
    """prefix-stable rebuilt packet: evidence appended in first-seen order, stubs for old, volatile tail last."""
    base = _capdup(turns, k)
    old = base[:max(0, k - recent)]; rec = base[max(0, k - recent):]
    ev = "\n\n".join(f"[evidence r{i+1:03d}: {call_desc(a)}]\n{(t['content'] if est(t['content']) < 600 else stub(a, t, i)['content'])}" for i, (a, t) in enumerate(old))
    out = [system, PIN, user]
    if ev: out.append({"role": "user", "content": "[EVIDENCE LEDGER]\n" + ev})
    for a, t in rec: out += [a, t]
    return out

LAYOUTS = {"L0": L0, "L1": L1, "L2": L2, "L2b": L2b, "L3u": L3u, "L3s": L3s}

# ---------------------------------------------------------------- gateway
def read_token():
    for p in (os.path.expanduser("~/.config/opencode/t5820-client-token"),):
        if os.path.exists(p): return open(p).read().strip()
    raise SystemExit("no gateway token found")

def metrics(base, tok):
    req = urllib.request.Request(base + "/metrics", headers={"Authorization": f"Bearer {tok}"})
    txt = urllib.request.urlopen(req, timeout=15).read().decode()
    m = {}
    for l in txt.splitlines():
        if l.startswith("#") or not l.strip(): continue
        k, _, v = l.rpartition(" ")
        try: m[k] = float(v)
        except ValueError: pass
    return m

WORKER = None   # set by --worker: attribute idleness/completions to one worker only (other pools' traffic is then not contamination)

def busy(mt):
    chat = sum(v for k, v in mt.items() if k.startswith("aihost_http_requests_in_flight") and "v1_chat_completions" in k)
    eng = sum(v for k, v in mt.items() if k.startswith("aihost_engine_prompt_tokens_in_flight") and (WORKER is None or f'worker_id="{WORKER}"' in k))
    gen = sum(v for k, v in mt.items() if k.startswith("aihost_engine_generation_tokens_in_flight") and (WORKER is None or f'worker_id="{WORKER}"' in k))
    return (chat if WORKER is None else 0), eng + gen

def post(base, tok, body, timeout=600):
    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    t0 = time.time(); r = urllib.request.urlopen(req, timeout=timeout); raw = r.read(); dt = time.time() - t0
    return json.loads(raw), dt, r.headers.get("X-AIHost-Route", "")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True); ap.add_argument("--tools", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--layouts", default="L0,L1,L2,L2b,L3u,L3s"); ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--steps", default="1-30"); ap.add_argument("--model", default="engineering/b0")
    ap.add_argument("--base", default="http://127.0.0.1:18010"); ap.add_argument("--dry", action="store_true")
    ap.add_argument("--worker", default=None, help="gateway worker_id serving --model (attribute contamination per worker)")
    a = ap.parse_args()
    global WORKER; WORKER = a.worker
    session = json.load(open(a.session)); tools = json.load(open(a.tools))["tools"]
    system, user, turns = prepare(session)
    lo, hi = (int(x) for x in a.steps.split("-"))
    steps = [s for s in range(lo, hi + 1) if s - 1 <= len(turns)]
    tok = None if a.dry else read_token()
    out = open(a.out, "a") if not a.dry else None
    meta = {"type": "meta", "session_sha256": hashlib.sha256(open(a.session, "rb").read()).hexdigest(), "turns": len(turns), "model": a.model,
            "layouts": a.layouts, "reps": a.reps, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if out: out.write(json.dumps(meta) + "\n")
    def completions(mt):
        return sum(v for k2, v in mt.items() if k2.startswith("aihost_inference_completions_total") and 'outcome="completed"' in k2
                   and (WORKER is None or f'worker_id="{WORKER}"' in k2))

    def wait_quiet(secs=45, max_wait=1800):
        """Block until the gateway has shown no in-flight work and no completions for `secs` seconds."""
        t0 = time.time(); quiet_since = None; last = None
        while time.time() - t0 < max_wait:
            mt = metrics(a.base, tok); chat, eng = busy(mt); c = completions(mt)
            if chat == 0 and eng == 0 and (last is None or c == last):
                quiet_since = quiet_since or time.time()
                if time.time() - quiet_since >= secs: return True
            else:
                quiet_since = None
            last = c; time.sleep(3)
        return False

    def run_block(rep, name, attempt):
        fn = LAYOUTS[name]; rows = []
        nonce = hashlib.sha1(f"{time.time()}{rep}{name}{attempt}".encode()).hexdigest()[:10]
        sys_n = {**system, "content": f"[run {nonce}]\n" + system["content"]}      # unique prefix: no cross-block cache reuse; intra-block reuse intact
        for step in steps:
            k = step - 1
            msgs = fn(sys_n, user, turns, k)
            est_total = sum(mtok(m) for m in msgs) + est(json.dumps(tools))
            row = {"type": "req", "rep": rep, "layout": name, "step": step, "attempt": attempt, "est_tokens": est_total, "messages": len(msgs)}
            mt0 = metrics(a.base, tok); chat, eng = busy(mt0); c0 = completions(mt0)
            body = {"model": a.model, "messages": msgs, "tools": tools, "tool_choice": "auto", "max_tokens": 1, "temperature": 0}
            try:
                resp, dt, route = post(a.base, tok, body)
            except Exception as e:
                row.update(error=str(e)[:200], contaminated=True); rows.append(row); break
            mt1 = metrics(a.base, tok); c1 = completions(mt1)
            u = resp.get("usage", {})
            contaminated = (c1 - c0) != 1          # idle gauges lag after our own previous request, so only attributed completions count
            row.update(wall_s=round(dt, 3), prompt_tokens=u.get("prompt_tokens"), cached_tokens=(u.get("prompt_tokens_details") or {}).get("cached_tokens"),
                       route=route, idle_before=(chat == 0 and eng == 0), completions_delta=c1 - c0, contaminated=contaminated)
            rows.append(row)
            print(f"rep{rep} {name:3s} step{step:2d} try{attempt} est={est_total:6d} prompt={row['prompt_tokens']} cached={row['cached_tokens']} wall={dt:6.2f}s{' CONTAMINATED' if contaminated else ''}", flush=True)
            if contaminated: break
        return rows

    for rep in range(1, a.reps + 1):
        for name in a.layouts.split(","):
            for attempt in range(1, 4):
                if not wait_quiet():
                    print(f"gateway never quiet; giving up on rep{rep} {name}", flush=True); break
                rows = run_block(rep, name, attempt)
                for r_ in rows: out.write(json.dumps(r_) + "\n")
                out.flush()
                if rows and not any(r_.get("contaminated") for r_ in rows) and len(rows) == len(steps): break
            else:
                out.write(json.dumps({"type": "gave_up", "rep": rep, "layout": name}) + "\n"); out.flush()
    if out: out.close()

if __name__ == "__main__": main()
