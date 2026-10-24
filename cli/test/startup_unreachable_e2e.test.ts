/**
 * ACC-INF-07 (REQ-TUI-105): Startup endpoint probe and first-contact recovery deadline.
 *
 * Verifies:
 * 1. SidecarServer.start() probes the endpoint (3 s GET /models) and emits a notice naming the unreachable
 *    endpoint URL, cause, and fix (`nexus doctor`, `~/.config/nexus/config.env`, `/connect`).
 * 2. AutonomousAgent / ProviderRecoveryController bounds never-succeeded endpoints (`everSucceeded=false`)
 *    to 120 s (2 minutes) by default instead of the 20-minute mid-session recovery deadline, ending with
 *    actionable fix guidance.
 * 3. Real PTY session against `http://127.0.0.1:9/v1` shows the unreachable endpoint and fix hint on the
 *    startup screen, and the first prompt ends with guidance within the bounded first-contact window.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { DEFAULT_RECOVERY_POLICY } from "../src/core/provider_recovery.js";
import { fakeClock, startGateway } from "./helpers/provider_fixture.js";
import { makeRepo, makeHome, trustWorkspace, ptyTest } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(here, "../dist/index.js");

describe("ACC-INF-07 (REQ-TUI-105): Startup endpoint probe and first-contact deadline", () => {
  ptyTest("startup trust Escape exits the CLI process promptly", { timeout: 30_000 }, async () => {
    assert.ok(fs.existsSync(INDEX), `missing ${INDEX} (run npm --prefix cli run build)`);
    const repo = makeRepo();
    const home = makeHome();
    const pyScript = `
import os, pty, select, subprocess, sys, time, json

master, slave = pty.openpty()
env = os.environ.copy()
env["HOME"] = ${JSON.stringify(home)}
env["XDG_CONFIG_HOME"] = ${JSON.stringify(path.join(home, ".config"))}
proc = subprocess.Popen(
    [${JSON.stringify(process.execPath)}, ${JSON.stringify(INDEX)}, "repl", "--yes", "-w", ${JSON.stringify(repo)}],
    stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True
)
os.close(slave)

buf = ""
def read_until(substr, timeout):
    global buf
    deadline = time.time() + timeout
    while time.time() < deadline and substr not in buf:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                data = os.read(master, 4096).decode("utf-8", errors="replace")
                if not data:
                    break
                buf += data
            except OSError:
                break
    return substr in buf

prompted = read_until("Trust this folder?", 10.0)
if prompted:
    os.write(master, b"\\x1b")
try:
    code = proc.wait(timeout=4.0)
except subprocess.TimeoutExpired:
    code = None
    proc.terminate()
    try:
        proc.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
os.close(master)
print(json.dumps({"prompted": prompted, "exited": code is not None, "code": code, "output": buf[-1000:]}))
`;
    try {
      const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn("python3", ["-c", pyScript], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("close", (exitCode) => resolve({ code: exitCode, out, err }));
      });
      assert.equal(code, 0, `PTY script failed: ${err}\n${out}`);
      const result = JSON.parse(out.trim().split("\n").pop() || "{}");
      assert.equal(result.prompted, true, `startup trust prompt did not appear:\n${result.output}`);
      assert.equal(result.exited, true, `CLI stayed alive after trust prompt exit:\n${result.output}`);
      assert.equal(result.code, 0, `CLI exit should be clean:\n${result.output}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("SidecarServer.start() probes unreachable endpoint (127.0.0.1:9) and emits notice with URL and fix hint", async () => {
    const repo = makeRepo();
    const home = makeHome();
    const events: any[] = [];
    const app = new ApplicationCore({
      endpoint: "http://127.0.0.1:9/v1",
      model: "m",
      maxSteps: 4,
      temperature: 0,
      workspace: repo,
      shell: "bash",
      approvalMode: "auto",
    });
    const server = new SidecarServer({
      app,
      write: (line) => events.push(JSON.parse(line)),
      historyFile: path.join(home, ".nexus_history"),
    });
    try {
      server.start();
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const notice = events.find((e) => e.type === "notice" && /127\.0\.0\.1:9/.test(e.text));
        if (notice) {
          assert.match(notice.text, /http:\/\/127\.0\.0\.1:9\/v1/);
          assert.match(notice.text, /unreachable/i);
          assert.match(notice.text, /nexus doctor/);
          assert.match(notice.text, /config\.env/);
          assert.match(notice.text, /\/connect/);
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.fail(`Expected unreachable endpoint notice, got events: ${JSON.stringify(events)}`);
    } finally {
      await server.shutdown();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("Never-succeeded endpoint bounds recovery wait to 120 s (2 min) default and ends with guidance", async () => {
    assert.equal(DEFAULT_RECOVERY_POLICY.firstContactDeadlineMs, 120_000);
    const gw = await startGateway(() => ({ kind: "text", content: "never" }), { startDown: true });
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fc-state-"));
    const clock = fakeClock();
    const agent = new AutonomousAgent({
      endpoint: gw.url,
      model: "m",
      maxSteps: 4,
      temperature: 0,
      workspace: repo,
      shell: "bash",
      approvalMode: "auto",
      fullAccess: true,
    } as any);
    const a = agent as any;
    a.recoveryClock = clock;
    a.recoveryPolicy = { ...DEFAULT_RECOVERY_POLICY };
    a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
    try {
      const r = await agent.runTurn("check status");
      assert.equal(r.execution, "FAILED");
      const rec = r.providerRecovery?.[0];
      assert.ok(rec, "expected providerRecovery record");
      assert.equal(rec.state, "EXHAUSTED");
      assert.equal(rec.everSucceeded, false);
      assert.equal(rec.policy.deadlineMs, 120_000, "first-contact deadline must be 120 s, not 20 min");
      assert.ok(clock.elapsed() <= 120_000, `elapsed virtual time ${clock.elapsed()} ms must not exceed 120 s`);
      assert.match(rec.reason ?? "", /nexus doctor/);
      assert.match(rec.reason ?? "", /config\.env/);
      assert.match(rec.reason ?? "", /\/connect/);
      assert.match(r.detail ?? "", /nexus doctor/);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  ptyTest("PTY s1a: with endpoint at 127.0.0.1:9, startup screen names endpoint as unreachable with fix hint, and first prompt ends with guidance", { timeout: 60_000 }, async () => {
    assert.ok(fs.existsSync(INDEX), `missing ${INDEX} (run npm --prefix cli run build)`);
    const repo = makeRepo();
    const home = makeHome();
    trustWorkspace(home, repo);
    const pyScript = `
import os, pty, select, subprocess, sys, time, json

master, slave = pty.openpty()
env = os.environ.copy()
env["HOME"] = ${JSON.stringify(home)}
env["XDG_CONFIG_HOME"] = ${JSON.stringify(path.join(home, ".config"))}
env["NEXUS_FIRST_CONTACT_DEADLINE_MS"] = "1500"
env["LOCAL_LLM_RECOVERY_BASE_DELAY_MS"] = "400"
env["LOCAL_LLM_RECOVERY_MIN_DELAY_MS"] = "200"

proc = subprocess.Popen(
    [${JSON.stringify(process.execPath)}, ${JSON.stringify(INDEX)}, "repl", "--yes", "-w", ${JSON.stringify(repo)}, "-e", "http://127.0.0.1:9/v1", "-m", "m"],
    stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True
)
os.close(slave)

buf = ""
def read_until( substr, timeout=15.0 ):
    global buf
    deadline = time.time() + timeout
    while time.time() < deadline:
        if substr in buf:
            return True
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                data = os.read(master, 4096).decode("utf-8", errors="replace")
                if not data:
                    break
                buf += data
            except OSError:
                break
    return substr in buf

startup_ok = read_until("127.0.0.1:9", 10.0) and read_until("nexus doctor", 5.0)
os.write(master, b"hello\\n")
turn_ok = read_until("did not recover within", 15.0)
os.write(master, b"/exit\\n")
time.sleep(0.3)
try:
    proc.terminate()
    proc.wait(timeout=3)
except Exception:
    proc.kill()
os.close(master)
print(json.dumps({"startup_ok": startup_ok, "turn_ok": turn_ok, "output": buf[-2000:]}))
`;
    try {
      const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn("python3", ["-c", pyScript], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("close", (c) => resolve({ code: c, out, err }));
      });
      assert.equal(code, 0, `PTY script failed: ${err}\n${out}`);
      const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
      assert.equal(parsed.startup_ok, true, `Startup screen did not show unreachable endpoint + fix hint:\n${parsed.output}`);
      assert.equal(parsed.turn_ok, true, `First prompt did not end with bounded recovery guidance:\n${parsed.output}`);
      assert.match(parsed.output, /127\.0\.0\.1:9/);
      assert.match(parsed.output, /nexus doctor/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
