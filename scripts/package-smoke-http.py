#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
import sys

handler = partial(SimpleHTTPRequestHandler, directory=sys.argv[1])
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
print(f"PORT={server.server_port}", flush=True)
server.serve_forever()
