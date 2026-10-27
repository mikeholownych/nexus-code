"""Minimal PTY driver with pyte screen emulation for the scope-D audit."""
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time, json, re
import pyte

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = '/var/tmp/nexus-rc10-install-home/.local/nexus-rc10/lib/nexus/v1.0.0-rc.10'
TUI = REPO + "/bin/nexus"
SIDECAR = REPO + "/lib/cli/dist/sidecar.js"
INDEX = REPO + "/lib/cli/dist/index.js"


def start_gw(scenario, tag):
    portfile = os.path.join(HERE, f"gw_{tag}.port")
    log = os.path.join(HERE, f"gw_{tag}.log")
    for p in (portfile, log):
        if os.path.exists(p):
            os.remove(p)
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "mockgw.py"), portfile, scenario, log])
    for _ in range(100):
        if os.path.exists(portfile) and open(portfile).read():
            break
        time.sleep(0.05)
    return proc, f"http://127.0.0.1:{open(portfile).read()}/v1", log


def make_env(tag, endpoint, extra=None):
    root = os.path.join(HERE, "runs", tag)
    home = os.path.join(root, "home")
    ws = os.path.join(root, "ws")
    subprocess.run(["rm", "-rf", root])
    os.makedirs(home)
    os.makedirs(ws)
    open(os.path.join(ws, "base.txt"), "w").write("base\n")
    subprocess.run("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", shell=True, cwd=ws)
    env = {
        "PATH": os.environ["PATH"], "HOME": home, "XDG_CONFIG_HOME": home + "/.config", "XDG_DATA_HOME": home + "/.local/share",
        "XDG_STATE_HOME": home + "/.local/state", "XDG_CACHE_HOME": home + "/.cache",
        "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "C.UTF-8",
        "LOCAL_LLM_ENDPOINT": endpoint, "LOCAL_LLM_MODEL": "m", "NEXUS_TRUST_WORKSPACE": "1",
    }
    if extra:
        env.update(extra)
    launcher = os.environ.get("NEXUS_TEST_LAUNCHER")
    if launcher:
        trusted = subprocess.run([launcher, "trust", ws], env=env, text=True, capture_output=True)
        if trusted.returncode != 0:
            raise RuntimeError(f"could not trust synthetic workspace: {trusted.stderr}")
    return env, ws, home


class Session:
    def __init__(self, argv, env, cols, rows, cwd, tag):
        self.cols, self.rows, self.tag = cols, rows, tag
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""
        self.answered = 0
        self.log = open(os.path.join(HERE, f"{tag}.raw"), "wb")
        self.t0 = time.monotonic()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.notes = []

    def note(self, s):
        line = f"[{time.monotonic() - self.t0:7.2f}s] {s}"
        self.notes.append(line)
        print(line, flush=True)

    def resize(self, cols, rows):
        self.cols, self.rows = cols, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.screen.resize(rows, cols)
        os.kill(self.pid, signal.SIGWINCH)
        self.note(f"RESIZE {cols}x{rows}")

    def pump(self, seconds):
        deadline = time.monotonic() + seconds
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            r, _, _ = select.select([self.fd], [], [], left)
            if not r:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            self.raw += chunk
            self.log.write(chunk)
            self.log.flush()
            try:
                self.stream.feed(chunk)
            except Exception:
                pass
            q = self.raw.count(b"\x1b[c")
            while self.answered < q:
                os.write(self.fd, b"\x1b[?62c")
                self.answered += 1
        return True

    def send(self, data, settle=0.2, label=None):
        if isinstance(data, str):
            data = data.encode()
        self.note(f"SEND {label or repr(data)}")
        os.write(self.fd, data)
        self.pump(settle)

    def type(self, text, gap=0.08, label=None):
        self.note(f"TYPE {label or repr(text)} gap={gap}")
        for ch in text:
            os.write(self.fd, ch.encode())
            self.pump(gap)

    def text(self):
        # pyte 0.8.2 can raise IndexError for an empty Char at narrow terminal sizes.
        # Render the fixed-width buffer directly so harness failures do not mask product behavior.
        lines = []
        for y in range(self.screen.lines):
            row = self.screen.buffer[y]
            lines.append("".join((row[x].data or " ") for x in range(self.screen.columns)).rstrip())
        return "\n".join(lines)

    def dump(self, label):
        self.note(f"SCREEN {label} ({self.cols}x{self.rows})")
        body = self.text()
        with open(os.path.join(HERE, f"{self.tag}.screens.txt"), "a") as f:
            f.write(f"\n===== {label} @ {time.monotonic() - self.t0:.2f}s ({self.cols}x{self.rows}) =====\n{body}\n")
        return body

    def wait(self, pred, timeout, label):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            t = self.text()
            if (pred(t) if callable(pred) else pred in t):
                self.note(f"SAW {label}")
                return True
            if not self.pump(0.1):
                break
        self.note(f"TIMEOUT waiting for {label}")
        self.dump(f"timeout-{label}")
        return False

    def alive(self):
        try:
            pid, st = os.waitpid(self.pid, os.WNOHANG)
            if pid == 0:
                return True
            self.status = st
            return False
        except ChildProcessError:
            return False

    def close(self):
        if self.alive():
            os.kill(self.pid, signal.SIGTERM)
            for _ in range(80):
                self.pump(0.1)
                if not self.alive():
                    break
            else:
                os.kill(self.pid, signal.SIGKILL)
        with open(os.path.join(HERE, f"{self.tag}.notes.txt"), "w") as f:
            f.write("\n".join(self.notes) + "\n")


def tui_argv(ws, endpoint, approve=False, extra=()):
    a = [TUI, "--live", "-w", ws, "-e", endpoint, "-m", "m"]
    if approve:
        a.append("--approve")
    return a + list(extra)


def gw_log(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]
