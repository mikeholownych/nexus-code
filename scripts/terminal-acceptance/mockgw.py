#!/usr/bin/env python3
"""Deterministic OpenAI-compatible mock for the manual terminal matrix (ACCEPTANCE §5.3).

Adapted from docs/v1.0.0/evidence/D_pty/mockgw.py. The behaviour follows the keyword in the operator's latest prompt,
so one session covers every check:
  approve -> two write_file calls (approval panels), then a short reply
  stream  -> a long slow stream (resize while it streams)
  sleep   -> run_command "sleep 30" (press Esc while it runs)
  other   -> a short reply
Usage: mockgw.py PORTFILE LOGFILE
"""
import json
import sys
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

portfile, logfile = sys.argv[1], sys.argv[2]
lock = threading.Lock()
count = {"n": 0}


def sse(o):
    return ("data: " + json.dumps(o) + "\n\n").encode()


def latest_turn(body):
    """The operator's latest prompt and how many tool results followed it."""
    messages = body.get("messages", [])
    prompt, tools = "", 0
    for m in messages:
        if m.get("role") == "user" and isinstance(m.get("content"), str):
            prompt, tools = m["content"], 0
        elif m.get("role") == "tool":
            tools += 1
    return prompt.lower(), tools


def plan(body):
    prompt, tools = latest_turn(body)
    if "approve" in prompt:
        if tools == 0:
            return ("tools", [("write_file", {"path": "first.txt", "content": "first\n"})], 800)
        if tools == 1:
            return ("tools", [("write_file", {"path": "second.txt", "content": "second\n"})], 300)
        return ("text", "Wrote first.txt and second.txt.", 0)
    if "stream" in prompt:
        return ("stream", [f"Streaming line {i:03d} for the resize check. " for i in range(240)], 120)
    if "sleep" in prompt:
        if tools == 0:
            return ("tools", [("run_command", {"command": "sleep 30; echo slept"})], 0)
        return ("text", "The command finished.", 0)
    return ("text", "Mock gateway ready. Prompts: approve, stream, sleep.", 0)


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
            return self._json(200, {"data": [{"id": "terminal-matrix"}]})
        self._json(404, {})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path.endswith("/tokenize"):
            return self._json(404, {"message": "no tokenize"})
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        kind, payload, delay = plan(body)
        with lock:
            count["n"] += 1
            with open(logfile, "a") as f:
                f.write(json.dumps({"n": count["n"], "t": time.time(), "kind": kind, "turn": latest_turn(body)}) + "\n")
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
            msg, fin = {"role": "assistant", "content": payload}, "stop"
        else:
            calls = [{"id": f"call_{count['n']}_{i}", "type": "function", "function": {"name": n, "arguments": json.dumps(a)}} for i, (n, a) in enumerate(payload)]
            msg, fin = {"role": "assistant", "content": None, "tool_calls": calls}, "tool_calls"
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
with open(portfile, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
