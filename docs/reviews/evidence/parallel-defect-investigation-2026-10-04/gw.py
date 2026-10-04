import http.server, json, threading, sys
log=[]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self): self.send_response(200); self.send_header("content-type","application/json"); self.end_headers(); self.wfile.write(b'{"data":[{"id":"m"}]}')
    def do_POST(self):
        b=json.loads(self.rfile.read(int(self.headers['content-length'])))
        users=[m['content'] for m in b['messages'] if m['role']=='user']; log.append(users[-1].split('\n[Git')[0])
        self.send_response(200); self.send_header("content-type","text/event-stream"); self.end_headers()
        self.wfile.write(b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
def start():
    s=http.server.ThreadingHTTPServer(("127.0.0.1",0),H); threading.Thread(target=s.serve_forever,daemon=True).start(); return s
