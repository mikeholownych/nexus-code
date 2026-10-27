#!/usr/bin/env python3
import json,sys,time
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
portfile,logfile=sys.argv[1:3]
def sse(o): return ("data: "+json.dumps(o)+"\n\n").encode()
class H(BaseHTTPRequestHandler):
  protocol_version="HTTP/1.1"
  def log_message(self,*a): pass
  def out(self,code,obj):
    b=json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type","application/json"); self.send_header("content-length",str(len(b))); self.end_headers(); self.wfile.write(b)
  def stream_msg(self,msg,finish):
    self.send_response(200); self.send_header("content-type","text/event-stream"); self.send_header("connection","close"); self.end_headers()
    if msg.get("content") is not None:
      event={"choices":[{"index":0,"delta":{"content":msg["content"]}}]}
      self.wfile.write(sse(event))
    else:
      for i,tc in enumerate(msg.get("tool_calls",[])):
        event={"choices":[{"index":0,"delta":{"tool_calls":[{"index":i,**tc}]}}]}
        self.wfile.write(sse(event))
    self.wfile.write(sse({"choices":[{"index":0,"delta":{},"finish_reason":finish}]})+b"data: [DONE]\n\n")
    self.close_connection=True
  def do_GET(self):
    if self.path.endswith("/models"): return self.out(200,{"data":[{"id":"m"}]})
    return self.out(404,{})
  def do_POST(self):
    n=int(self.headers.get("content-length",0))
    try: body=json.loads(self.rfile.read(n))
    except Exception: body={}
    messages=body.get("messages",[])
    user=next((m.get("content","") for m in reversed(messages) if m.get("role")=="user" and isinstance(m.get("content"),str)),"")
    tools=sum(1 for m in messages if m.get("role")=="tool")
    with open(logfile,"a") as f: f.write(json.dumps({"time":time.time(),"path":self.path,"user":user[:120],"tools":tools})+"\n")
    if "talk slowly" in user:
      self.send_response(200); self.send_header("content-type","text/event-stream"); self.send_header("connection","close"); self.end_headers()
      try:
        for _ in range(120):
          self.wfile.write(sse({"choices":[{"index":0,"delta":{"content":"Thinking about accessibility state. "}}]})); self.wfile.flush(); time.sleep(.05)
        self.wfile.write(sse({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})+b"data: [DONE]\n\n")
      except Exception: pass
      self.close_connection=True; return
    if "create a11y.txt" in user and tools==0:
      msg={"role":"assistant","content":None,"tool_calls":[{"id":"a11y-write","type":"function","function":{"name":"write_file","arguments":json.dumps({"path":"a11y.txt","content":"accessible state\n"})}}]}
      return self.stream_msg(msg,"tool_calls")
    if "run harmless command" in user:
      msg={"role":"assistant","content":None,"tool_calls":[{"id":"a11y-safe-run","type":"function","function":{"name":"run_command","arguments":json.dumps({"command":"echo synthetic-safe"})}}]}
      return self.stream_msg(msg,"tool_calls")
    if "run it" in user and tools==0:
      msg={"role":"assistant","content":None,"tool_calls":[{"id":"a11y-run","type":"function","function":{"name":"run_command","arguments":json.dumps({"command":"sleep 20; echo finished"})}}]}
      return self.stream_msg(msg,"tool_calls")
    return self.stream_msg({"role":"assistant","content":"Done. The synthetic operation is complete."},"stop")
srv=ThreadingHTTPServer(("127.0.0.1",0),H)
open(portfile,"w").write(str(srv.server_address[1]))
srv.serve_forever()
