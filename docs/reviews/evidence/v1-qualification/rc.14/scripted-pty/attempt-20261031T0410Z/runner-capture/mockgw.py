#!/usr/bin/env python3
"""Mock OpenAI-compatible gateway for the scope-D PTY audit. Usage: mockgw.py PORTFILE SCENARIO LOGFILE"""
import json, sys, time, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

portfile, scenario, logfile = sys.argv[1], sys.argv[2], sys.argv[3]
lock = threading.Lock()
count = {"n": 0}


def sse(o):
    return ("data: " + json.dumps(o) + "\n\n").encode()


def tools_in(body):
    return sum(1 for m in body.get("messages", []) if m.get("role") == "tool")


def plan(body):
    t = tools_in(body)
    if scenario == "write":  # one write_file then done
        if t == 0:
            return ("tools", [("write_file", {"path": "hello.txt", "content": "hi there\n"})], 1500)
        return ("text", "Wrote hello.txt. 完成 ✅ — naïve café 🎉", 0)
    if scenario == "write2":  # two sequential approvals
        if t == 0:
            return ("tools", [("write_file", {"path": "a.txt", "content": "a\n"})], 1500)
        if t == 1:
            return ("tools", [("write_file", {"path": "b.txt", "content": "b\n"})], 300)
        return ("text", "Done.", 0)
    if scenario == "slowstream":
        return ("stream", ["Thinking about it. "] * 200, 150)
    if scenario == "slowtool":
        if t == 0:
            return ("tools", [("run_command", {"command": "sleep 23.7; echo finished"})], 0)
        return ("text", "Done.", 0)
    if scenario == "unicode":
        return ("text", "宽字符测试 全角ＡＢＣ emoji 👩‍👩‍👧 🎉 combining é (é) RTL שלום tab\there " + "x" * 150, 0)
    if scenario == "http500":
        return ("http", 500, 0)
    return ("text", "Hello from mock.", 0)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._json(200, {"data": [{"id": "m"}]})
        self._json(404, {})

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(n)
        if self.path.endswith("/tokenize"):
            return self._json(404, {"message": "no tokenize"})
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        with lock:
            count["n"] += 1
            with open(logfile, "a") as f:
                f.write(json.dumps({"n": count["n"], "t": time.time(), "tools": tools_in(body), "stream": body.get("stream"), "last": (body.get("messages") or [{}])[-1].get("content", "")[:200] if isinstance((body.get("messages") or [{}])[-1].get("content", ""), str) else "?"}) + "\n")
        kind, payload, delay = plan(body)
        if kind == "http":
            time.sleep(delay / 1000)
            return self._json(payload, {"error": {"message": "mock failure"}})
        if kind == "stream":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("connection", "close")
            self.end_headers()
            try:
                for p in payload:
                    self.wfile.write(sse({"choices": [{"index": 0, "delta": {"content": p}}]}))
                    self.wfile.flush()
                    time.sleep(delay / 1000)
                self.wfile.write(sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}) + b"data: [DONE]\n\n")
            except Exception:
                pass
            self.close_connection = True
            return
        time.sleep(delay / 1000)
        if kind == "text":
            msg = {"role": "assistant", "content": payload}
            fin = "stop"
        else:
            msg = {"role": "assistant", "content": None, "tool_calls": [{"id": f"call_{count['n']}_{i}", "type": "function", "function": {"name": nme, "arguments": json.dumps(a)}} for i, (nme, a) in enumerate(payload)]}
            fin = "tool_calls"
        if body.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("connection", "close")
            self.end_headers()
            out = b""
            if kind == "text":
                out += sse({"choices": [{"index": 0, "delta": {"content": payload}}]})
            else:
                for i, tc in enumerate(msg["tool_calls"]):
                    out += sse({"choices": [{"index": 0, "delta": {"tool_calls": [dict(tc, index=i)]}}]})
            out += sse({"choices": [{"index": 0, "delta": {}, "finish_reason": fin}]}) + b"data: [DONE]\n\n"
            self.wfile.write(out)
            self.close_connection = True
            return
        self._json(200, {"choices": [{"index": 0, "message": msg, "finish_reason": fin}]})


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(portfile, "w").write(str(srv.server_address[1]))
srv.serve_forever()
