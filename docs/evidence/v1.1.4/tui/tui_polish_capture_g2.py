#!/usr/bin/env python3
"""Captures for TUI audit defects D-11, D-14, D-15 and D-18, the same way for the `before` and the `after` build.

Drives a real `nexus-tui --live` through a pseudo-terminal (cli/test/helpers/tui_pty_driver.py's Screen reads what is
on screen). D-14 and D-18 use a scripted sidecar (a shell script that prints protocol events and logs what the TUI
sends); D-11 and D-15 use the real sidecar (cli/dist/sidecar.js of the same build) against a small fake OpenAI server
(this file: /v1/models and a streamed /v1/chat/completions).

Usage: tui_polish_capture_g2.py D-11|D-14|D-15|D-18 TUI_BINARY CLI_DIR LABEL OUTDIR
  CLI_DIR is a built cli directory (it holds dist/sidecar.js). LABEL is `before` or `after`.
"""
import json
import os
import pty
import fcntl
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "cli", "test", "helpers"))
from tui_pty_driver import Screen  # noqa: E402

HELLO = '{"v":1,"type":"hello","protocol":1,"pid":1}'
STATE = '{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":%s}'


class Term:
    def __init__(self, argv, env, cols, rows):
        self.screen = Screen(cols, rows)
        self.raw = b""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, seconds):
        deadline = time.monotonic() + seconds
        while (left := deadline - time.monotonic()) > 0:
            ready, _, _ = select.select([self.fd], [], [], left)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.raw += chunk
            self.screen.feed(chunk.decode("utf-8", "replace"))
            text = self.raw.decode("utf-8", "replace")
            if text.count("\x1b[c") > getattr(self, "answered", 0):
                self.answered = text.count("\x1b[c")
                os.write(self.fd, b"\x1b[?62c")

    def send(self, data, settle=0.3):
        os.write(self.fd, data.encode())
        self.pump(settle)

    def lines(self):
        return list(self.screen.lines())

    def wait(self, text, timeout=15):
        deadline = time.monotonic() + timeout
        while not any(text in line for line in self.lines()):
            if time.monotonic() > deadline:
                raise TimeoutError(f"never saw {text!r}:\n" + "\n".join(self.lines()))
            self.pump(0.05)

    def finish(self):
        self.pump(0.3)
        try:
            os.kill(self.pid, signal.SIGTERM)
            end = time.monotonic() + 8
            while time.monotonic() < end:
                self.pump(0.1)
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    break
        except (ProcessLookupError, ChildProcessError):
            pass


def shot(out, title, term, region=None):
    out.append(f"--- {title}")
    lines = term.lines()
    blanks = 0
    for line in (lines[region[0]:region[1]] if region else lines):
        blanks = blanks + 1 if not line.strip() else 0
        if blanks <= 1:  # runs of empty rows are collapsed
            out.append(line.rstrip())
    out.append("")


def scripted_sidecar(body, log):
    f = tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False)
    head = "printf '%%s\\n' '%s'\nprintf '%%s\\n' '%s'\n" % (HELLO, STATE % "false")
    f.write(head + body)
    f.close()
    return f.name


def emit(*events):
    return "".join("printf '%%s\\n' '%s'\n" % e for e in events)


READ_LOOP = r'''
ids=""
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG"
  case "$line" in
    *'"type":"steer"'*)
      id=$(printf '%s' "$line" | sed -E 's/.*"id":"([^"]*)".*/\1/')
      ids="$ids $id"
      printf '{"v":1,"type":"steer.ack","id":"%s","status":"queued","message":"Steering queued; the agent applies it at its next step."}\n' "$id" ;;
    *'"type":"cancel"'*)
      for id in $ids; do printf '{"v":1,"type":"steer.ack","id":"%s","status":"cancelled","message":"Cancelled with the turn before it could start; your message is back in the composer."}\n' "$id"; done
      printf '%s\n' '{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}' ;;
  esac
done
'''


def run_scripted(binary, body, cols=100, rows=24):
    log = tempfile.NamedTemporaryFile("w", suffix=".log", delete=False).name
    script = scripted_sidecar(body, log)
    env = {k: v for k, v in os.environ.items() if not k.startswith("NEXUS_")}
    env.update({"TERM": "xterm-256color", "LOG": log})
    return Term([binary, "--live", "--node", "sh", "--sidecar", script], env, cols, rows), log


def sent(log):
    try:
        return [l for l in open(log).read().splitlines() if l]
    except FileNotFoundError:
        return []


def activity_row(term):
    return next((l.rstrip() for l in term.lines() if any(c in l for c in "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")), "(no activity row)")


def d14(binary, out):
    BUSY = STATE % "true"
    for cols in (100, 60, 40):
        # (a) text streaming while the phase is still `inference`
        t, _ = run_scripted(binary, emit(BUSY, '{"v":1,"type":"activity","turn_id":"t1","phase":"inference","step":1,"segment":1}',
                                         '{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Here is the plan for the cache layer, streaming now"}') + "sleep 30\n", cols=cols)
        t.wait("Here is the plan")
        t.pump(0.6)
        out.append(f"=== D-14 (a) {cols} columns: text is streaming; status row: {activity_row(t)!r}")
        shot(out, f"(a) {cols}x24", t)
        t.finish()
        # (b) the controller's own verifier run
        t, _ = run_scripted(binary, emit(BUSY, '{"v":1,"type":"activity","turn_id":"t1","phase":"verifying","step":1,"segment":1,"tool":"npm test (before the change)"}') + "sleep 30\n", cols=cols)
        t.pump(1.0)
        out.append(f"=== D-14 (b) {cols} columns: verifier baseline run; status row: {activity_row(t)!r}")
        shot(out, f"(b) {cols}x24", t)
        t.finish()
    # (c) cancelled during tool settling
    turn = '{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED","reason":"OPERATOR_INTERRUPT","interruption":{"phase":"tool_settling","undispatchedToolCalls":0}}'
    result = '{"v":1,"type":"turn.result","turn_id":"t1","heading":"INTERRUPTED","line":"x","turn":%s,"model_summary":null}' % turn
    t, _ = run_scripted(binary, emit(result) + "sleep 30\n")
    t.pump(0.8)
    out.append("=== D-14 (c) cancel wording")
    shot(out, "(c) 100x24", t, (0, 8))
    t.finish()


def d18(binary, out):
    BUSY = STATE % "true"
    t, log = run_scripted(binary, emit(BUSY, '{"v":1,"type":"activity","turn_id":"t1","phase":"provider_wait","step":1,"segment":1}') + READ_LOOP)
    t.pump(0.6)
    out.append("=== D-18: two prompts typed while the agent waits on the provider, then Esc, then Enter")
    t.send("SC:e500 go\r", 0.4)
    t.send("SC:reset go\r", 0.5)
    shot(out, "after typing both (each is steering)", t)
    t.send("\x1b", 0.8)
    shot(out, "after Esc: what came back", t)
    t.send("\r", 0.5)
    out.append("--- what the TUI sent to the sidecar (steer and prompt.submit commands)")
    for line in sent(log):
        if '"steer"' in line or "prompt.submit" in line:
            out.append(line)
    out.append("")
    t.finish()


class Fake(BaseHTTPRequestHandler):
    models = ["fake-model", "other-model"]

    def log_message(self, *a):
        pass

    def _json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._json({"data": [{"id": m} for m in self.models]})
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        self.rfile.read(n)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for chunk in ({"choices": [{"index": 0, "delta": {"content": "Hello from the fake model."}, "finish_reason": None}]},
                      {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}):
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


def real_term(binary, cli_dir, home, repo, url, cols=100, rows=30):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("NEXUS_", "LOCAL_LLM"))}
    env.update({"HOME": home, "TERM": "xterm-256color", "NEXUS_NO_BROWSER": "1"})
    argv = [binary, "--live", "--node", "node", "--sidecar", os.path.join(cli_dir, "dist", "sidecar.js"), "--",
            "-w", repo, "-e", url + "/v1", "-m", "fake-model", "--mode", "auto"]
    return Term(argv, env, cols, rows)


def setup_real(cli_dir):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    home = tempfile.mkdtemp(prefix="nexus-polish-home-")
    repo = tempfile.mkdtemp(prefix="nexus-polish-repo-")
    subprocess.run(["git", "init", "-q", repo], check=True)
    open(os.path.join(repo, "README.md"), "w").write("demo\n")
    subprocess.run(["git", "-C", repo, "add", "."], check=True)
    subprocess.run(["git", "-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "-m", "init"], check=True)
    os.makedirs(os.path.join(home, ".config", "nexus"), exist_ok=True)
    json.dump({"trustedPaths": [os.path.realpath(repo)]}, open(os.path.join(home, ".config", "nexus", "trusted_workspaces.json"), "w"))
    return server, home, repo, f"http://127.0.0.1:{server.server_address[1]}"


def d11(binary, cli_dir, out):
    server, home, repo, url = setup_real(cli_dir)
    for cols in (100, 60, 40):
        t = real_term(binary, cli_dir, home, repo, url, cols=cols)
        t.wait(" send ")
        t.send("/model\r", 0.3)
        t.pump(3.0)
        out.append(f"=== D-11 {cols} columns: session started with -e {url}/v1 -m fake-model; /model")
        shot(out, f"/model at {cols}x30", t)
        t.send("\x1b", 0.3)
        t.finish()
    server.shutdown()


def d15(binary, cli_dir, out):
    server, home, repo, url = setup_real(cli_dir)
    t = real_term(binary, cli_dir, home, repo, url)
    t.wait(" send ")
    t.send("say hello\r", 0.3)
    t.wait("Hello from the fake model", 20)
    t.pump(1.5)
    t.send("/sessions\r", 0.3)
    t.pump(1.0)
    out.append("=== D-15: one saved session, the one in use (starred); then /resume with no argument")
    shot(out, "/sessions", t)
    t.send("/resume\r", 0.3)
    t.pump(2.0)
    shot(out, "/resume", t)
    t.finish()
    server.shutdown()


def main():
    defect, binary, cli_dir, label, outdir = sys.argv[1:6]
    out = [f"# {defect} {label}: {binary}"]
    {"D-11": lambda: d11(binary, cli_dir, out), "D-14": lambda: d14(binary, out), "D-15": lambda: d15(binary, cli_dir, out), "D-18": lambda: d18(binary, out)}[defect]()
    os.makedirs(outdir, exist_ok=True)
    open(os.path.join(outdir, f"{label}.txt"), "w").write("\n".join(out) + "\n")
    print("\n".join(out))


if __name__ == "__main__":
    main()
