#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
import os
import sys

HEADER_LOG = os.environ.get("NEXUS_HEADER_LOG")


class LoggingHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if HEADER_LOG:
            with open(HEADER_LOG, "a", encoding="utf-8") as log:
                log.write(f"GET {self.path}\n")
                for name, value in self.headers.items():
                    log.write(f"{name}: {value}\n")
                log.write("\n")
        super().do_GET()


handler = partial(LoggingHandler, directory=sys.argv[1])
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
print(f"PORT={server.server_port}", flush=True)
server.serve_forever()
