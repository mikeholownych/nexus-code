#!/usr/bin/env python3
"""Preflight for Layer-B runs. Refuses (exit 1) unless
  (1) the FULL objective text reaches the model as the first user message through the exact delivery path used (`harness run "<objective>"`),
  (2) the fixture verifier fails at baseline, completes within VERIFIER_BUDGET_S, and is not subject to the 35 s RPC timeout.
usage: preflight.py <fixture_dir(ledger)> [--nexus /path/to/cli/dist/index.js]
Prints the first user message verbatim-length evidence and the verifier runtime.
"""
import http.server, json, os, subprocess, sys, threading, time, hashlib
VERIFIER_BUDGET_S = 20
ws = os.path.abspath(sys.argv[1]); nexus = sys.argv[sys.argv.index("--nexus") + 1] if "--nexus" in sys.argv else "/tmp/nexus-snap/cli/dist/index.js"
objective = open(os.path.join(ws, "OBJECTIVE.md")).read()
seen = []
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b'{"data":[{"id":"m"}]}')
    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers["content-length"]))); seen.append(b)
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        self.wfile.write(b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
home = os.path.join("/tmp", "preflight-home"); os.makedirs(home, exist_ok=True)
subprocess.run(["node", nexus, "run", "-w", ws, "-e", f"http://127.0.0.1:{port}/v1", "-m", "m", "-s", "2", objective], env=dict(os.environ, HOME=home), capture_output=True, timeout=120)
ok = True
users = [m for m in (seen[0]["messages"] if seen else []) if m["role"] == "user"]
first = users[0]["content"] if users else ""
delivered = objective.strip() in first
print(f"[1] objective delivery: {len(objective)} chars in OBJECTIVE.md; first user message {len(first)} chars; full objective present: {delivered}")
if not delivered: ok = False
t0 = time.time(); r = subprocess.run("npm test 2>&1 | tail -3", shell=True, cwd=ws, capture_output=True, text=True); dt = time.time() - t0
failing = "# fail 0" not in r.stdout and "ℹ fail 0" not in r.stdout
print(f"[2] verifier baseline: runtime {dt:.1f}s (budget {VERIFIER_BUDGET_S}s, RPC timeout 35s); baseline failing: {failing}")
if dt > VERIFIER_BUDGET_S or not failing: ok = False
print("PREFLIGHT", "PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
