/**
 * `nexus doctor` / `/doctor`: deterministic diagnostics against isolated homes and local mock endpoints. No live
 * credentials, no production services. Each scenario is one of the failure paths the doctor must name truthfully.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildConfig } from "../src/config.js";
import {
  DOCTOR_EXIT,
  DoctorReport,
  doctorExitCode,
  proposedRepairs,
  redactDiagnostic,
  renderDoctorJson,
  renderDoctorText,
  runDoctor,
  runRepairs,
} from "../src/doctor.js";
import type { HarnessConfig } from "../src/types.js";
import { SafePathError, ancestryProblem, chmodVerified, identityOf, mkdirVerified, writeExclusiveVerified } from "../src/safe_fs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const LAUNCHER = path.join(ROOT, "harness.sh");
const SECRET = "sk-doctor-supersecret-0123456789abcdef";

interface Mock {
  url: string;
  paths: string[];
  headers: http.IncomingHttpHeaders[];
  chats: number;
  close(): Promise<void>;
}

/** Local OpenAI-compatible endpoint whose /models and chat behaviour each test chooses. */
async function mock(behaviour: { models?: string[]; status?: number; hang?: boolean } = {}): Promise<Mock> {
  const state = { paths: [] as string[], chats: 0, headers: [] as http.IncomingHttpHeaders[] };
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    state.paths.push(req.url ?? "");
    state.headers.push(req.headers);
    if (behaviour.hang) return;
    if (behaviour.status) {
      res.statusCode = behaviour.status;
      res.end(JSON.stringify({ error: { message: "nope" } }));
      return;
    }
    if (req.url?.includes("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: (behaviour.models ?? ["m"]).map((id) => ({ id })) }));
      return;
    }
    state.chats++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get paths() {
      return state.paths;
    },
    get chats() {
      return state.chats;
    },
    get headers() {
      return state.headers;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } as Mock;
}

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
let home: string;
let workspace: string;
let savedHome: string | undefined;

before(() => {
  savedHome = process.env.HOME;
  home = tmp("nexus-doctor-home-");
  workspace = tmp("nexus-doctor-ws-");
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

const cfg = (o: Partial<HarnessConfig> = {}): HarnessConfig => ({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", ...o });
const find = (report: DoctorReport, id: string) => report.findings.find((f) => f.id === id);
const doctor = (o: Parameters<typeof runDoctor>[0]) => runDoctor({ home, timeoutMs: 1500, ...(o as object) });

describe("doctor findings name the actual failure", () => {
  test("config.project_env_ignored reports operator-only settings a workspace .env tries to set (REQ-SEC-110)", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-doctor-projenv-"));
    try {
      fs.writeFileSync(path.join(ws, ".env"), "LOCAL_LLM_MODEL=x\nNODE_TLS_REJECT_UNAUTHORIZED=0\nHTTPS_PROXY=http://p\n");
      const warned = find(await doctor({ config: cfg({ workspace: ws }) }), "config.project_env_ignored")!;
      assert.equal(warned.status, "warn");
      assert.match(warned.explanation, /NODE_TLS_REJECT_UNAUTHORIZED, HTTPS_PROXY/);
      fs.writeFileSync(path.join(ws, ".env"), "LOCAL_LLM_MODEL=x\n");
      assert.equal(find(await doctor({ config: cfg({ workspace: ws }) }), "config.project_env_ignored")!.status, "pass");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("malformed configuration fails config.valid while independent checks still run", async () => {
    let configError: unknown;
    try {
      buildConfig({ provider: "no-such-provider" });
    } catch (err) {
      configError = err;
    }
    assert.ok(configError, "buildConfig rejects the unknown provider (normal startup would fail)");
    const report = await doctor({ configError, flags: { provider: "no-such-provider" } });
    assert.equal(find(report, "config.valid")?.status, "fail");
    assert.match(find(report, "config.valid")!.evidence[0], /Unknown provider 'no-such-provider'/);
    assert.equal(find(report, "runtime.node")?.status, "pass");
    assert.equal(find(report, "shell.executable")?.status, "pass", "the shell is checked from flags/env without a config");
    assert.equal(find(report, "endpoint.reachable")?.status, "skip");
    assert.equal(doctorExitCode(report), DOCTOR_EXIT.failures);
  });

  test("an unreachable endpoint fails reachability and skips what depends on it", async () => {
    const report = await doctor({ config: cfg({ endpoint: "http://127.0.0.1:9/v1" }) });
    assert.equal(find(report, "endpoint.configured")?.status, "pass");
    assert.equal(find(report, "endpoint.reachable")?.status, "fail");
    assert.equal(find(report, "endpoint.authenticated")?.status, "skip");
    assert.equal(find(report, "model.available")?.status, "skip");
    assert.equal(find(report, "inference.verified")?.status, "skip");
  });

  test("a hanging endpoint is bounded by the timeout", async () => {
    const m = await mock({ hang: true });
    try {
      const started = Date.now();
      const report = await doctor({ config: cfg({ endpoint: m.url }), timeoutMs: 600 });
      assert.ok(Date.now() - started < 5000, `bounded: ${Date.now() - started} ms`);
      assert.equal(find(report, "endpoint.reachable")?.status, "fail");
    } finally {
      await m.close();
    }
  });

  test("the model list keeps the endpoint's /v1 path and the configured model is checked", async () => {
    const m = await mock({ models: ["alpha", "beta"] });
    try {
      const missing = await doctor({ config: cfg({ endpoint: m.url, model: "gamma" }) });
      assert.equal(find(missing, "endpoint.authenticated")?.status, "pass");
      assert.equal(find(missing, "model.available")?.status, "warn");
      assert.match(find(missing, "model.available")!.explanation, /not listed.*availability is unverified/);
      assert.match(find(missing, "model.available")!.evidence[0], /alpha, beta/);
      assert.ok(m.paths.every((p) => p.startsWith("/v1/")), `requests kept /v1: ${m.paths.join(" ")}`);
      const present = await doctor({ config: cfg({ endpoint: m.url, model: "beta" }) });
      assert.equal(find(present, "model.available")?.status, "pass");
      assert.equal(find(present, "inference.verified")?.status, "skip", "a listed model is not proof of inference");
      assert.equal(m.chats, 0, "default checks send no inference request");
    } finally {
      await m.close();
    }
  });

  test("--deep can verify a configured model omitted from /models", async () => {
    const m = await mock({ models: ["alpha"] });
    try {
      const report = await doctor({ config: cfg({ endpoint: m.url, model: "gamma" }), deep: true });
      assert.equal(find(report, "inference.verified")?.status, "pass");
      assert.equal(find(report, "model.available")?.status, "pass");
      assert.match(find(report, "model.available")!.explanation, /not listed.*successful --deep inference probe verified/);
      assert.equal(m.chats, 1);
    } finally {
      await m.close();
    }
  });

  test("a rejected credential fails authentication", async () => {
    const m = await mock({ status: 401 });
    try {
      const report = await doctor({ config: cfg({ endpoint: m.url, apiKey: SECRET }) });
      assert.equal(find(report, "endpoint.reachable")?.status, "pass");
      assert.equal(find(report, "endpoint.authenticated")?.status, "fail");
      assert.equal(find(report, "model.available")?.status, "skip");
    } finally {
      await m.close();
    }
  });

  test("--deep sends exactly one inference request and says it costs model work", async () => {
    const m = await mock({ models: ["m"] });
    try {
      const report = await doctor({ config: cfg({ endpoint: m.url }), deep: true });
      assert.equal(find(report, "inference.verified")?.status, "pass", JSON.stringify(find(report, "inference.verified")));
      assert.match(find(report, "inference.verified")!.explanation, /costed model work/);
      assert.equal(m.chats, 1);
      assert.equal(find(report, "engine.tool")?.status, "pass", "deep engine check ran a read-only tool");
    } finally {
      await m.close();
    }
  });

  test("--deep engine probe passes in a large workspace (a listing bigger than the output cap is not a failure)", async () => {
    // A home-directory workspace lists thousands of entries: the probe must not depend on how much the workspace holds.
    const big = tmp("nexus-doctor-bigws-");
    for (let d = 0; d < 20; d++) {
      const sub = path.join(big, `directory-with-a-long-name-${d}`);
      fs.mkdirSync(sub);
      for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(sub, `file-with-a-reasonably-long-name-${i}.txt`), "");
    }
    for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(big, `top-level-file-with-a-reasonably-long-name-${i}.txt`), "");
    const m = await mock({ models: ["m"] });
    try {
      const report = await doctor({ config: cfg({ endpoint: m.url, workspace: big }), deep: true });
      assert.equal(find(report, "engine.tool")?.status, "pass", JSON.stringify(find(report, "engine.tool")));
    } finally {
      await m.close();
    }
  });

  test("a shell that is not on PATH fails shell.executable", async () => {
    const report = await doctor({ config: cfg({ shell: "no-such-shell-xyz" }) });
    assert.equal(find(report, "shell.executable")?.status, "fail");
  });

  test("an engine binary that does not run fails engine.binary", async () => {
    const broken = path.join(tmp("nexus-doctor-engine-"), "harness-core");
    fs.writeFileSync(broken, "#!/bin/sh\necho broken >&2\nexit 3\n", { mode: 0o755 });
    const report = await doctor({ config: cfg({ coreBinaryPath: broken }) });
    assert.equal(find(report, "engine.binary")?.status, "fail");
    assert.match(find(report, "engine.binary")!.evidence.join(" "), /broken/);
  });

  test("state directories: missing warns with a repair; unwritable fails; checks home's real paths", async () => {
    const h = tmp("nexus-doctor-state-");
    try {
      const missing = await runDoctor({ home: h, config: cfg() });
      assert.equal(find(missing, "state.sessions")?.status, "warn");
      assert.equal(find(missing, "state.sessions")?.repair?.id, "state.create");
      assert.equal(find(missing, "state.sessions")?.evidence[0], path.join(h, ".nexus", "sessions"));
      fs.mkdirSync(path.join(h, ".nexus", "sessions"), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(h, ".nexus", "sessions"), 0o500);
      const locked = await runDoctor({ home: h, config: cfg() });
      if (process.getuid?.() !== 0) assert.equal(find(locked, "state.sessions")?.status, "fail");
    } finally {
      fs.chmodSync(path.join(h, ".nexus", "sessions"), 0o700);
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("unreadable session records are reported, never deleted", async () => {
    const h = tmp("nexus-doctor-integrity-");
    fs.mkdirSync(path.join(h, ".nexus", "sessions"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(h, ".nexus", "sessions", "bad.json"), "{not json");
    const report = await runDoctor({ home: h, config: cfg() });
    assert.equal(find(report, "state.integrity")?.status, "warn");
    assert.ok(fs.existsSync(path.join(h, ".nexus", "sessions", "bad.json")));
    fs.rmSync(h, { recursive: true, force: true });
  });

  test("state integrity accepts empty and cursor-backed schema-2 histories, but reports malformed records", async () => {
    const h = tmp("nexus-doctor-schema2-");
    const sessions = path.join(h, ".nexus", "sessions");
    const tasks = path.join(h, ".nexus", "tasks");
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    fs.mkdirSync(tasks, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sessions, "index.json"), JSON.stringify({ schemaVersion: 1, sessions: [] }));
    const record = { schemaVersion: 2, taskId: "task-abc", messageLog: { schemaVersion: 2, sha256: "a".repeat(64), offset: 0, bytes: 1, count: 0 } };
    fs.writeFileSync(path.join(tasks, "task-abc.json"), JSON.stringify(record));
    fs.writeFileSync(path.join(tasks, "task-empty.json"), JSON.stringify({ schemaVersion: 2, taskId: "task-empty", messageLog: null }));
    fs.writeFileSync(path.join(tasks, "task-bad.json"), JSON.stringify({ schemaVersion: 2, taskId: "task-bad", messageLog: "not-a-cursor" }));
    try {
      const report = await runDoctor({ home: h, config: cfg() });
      const finding = find(report, "state.integrity")!;
      assert.equal(finding.status, "warn");
      assert.match(finding.explanation, /1 saved record\(s\) are malformed/);
      assert.ok(!finding.evidence.includes(path.join(tasks, "task-abc.json")));
      assert.ok(!finding.evidence.includes(path.join(tasks, "task-empty.json")));
      assert.ok(finding.evidence.includes(path.join(tasks, "task-bad.json")));
      assert.ok(!finding.evidence.includes(path.join(sessions, "index.json")));
      assert.ok(fs.existsSync(path.join(tasks, "task-abc.json")), "valid state remains untouched");
      assert.ok(fs.existsSync(path.join(tasks, "task-empty.json")), "valid empty-history state remains untouched");
      assert.ok(fs.existsSync(path.join(tasks, "task-bad.json")), "malformed state remains untouched");
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("state integrity only warns about writer-shaped temporary files and never labels arbitrary or active temp files interrupted", async () => {
    const h = tmp("nexus-doctor-temps-");
    const sessions = path.join(h, ".nexus", "sessions");
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    const arbitrary = path.join(sessions, "notes.tmp");
    const atomic = path.join(sessions, "session_20261022_000000_abc.json.12345678-1234-1234-1234-123456789abc.tmp");
    fs.writeFileSync(arbitrary, "user temp");
    fs.writeFileSync(atomic, "possibly active writer");
    try {
      const report = await runDoctor({ home: h, config: cfg() });
      const finding = find(report, "state.integrity")!;
      assert.equal(finding.status, "warn");
      assert.match(finding.explanation, /write may still be active/);
      assert.doesNotMatch(finding.explanation, /interrupted write/);
      assert.ok(finding.evidence.includes(atomic));
      assert.ok(!finding.evidence.includes(arbitrary));
      assert.ok(fs.existsSync(atomic));
      assert.ok(fs.existsSync(arbitrary));
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("state integrity directory traversal is asynchronous and leaves other event-loop work responsive", async () => {
    const h = tmp("nexus-doctor-async-state-");
    const sessions = path.join(h, ".nexus", "sessions");
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    const originalOpenDir = fs.promises.opendir;
    let delayedOpen = false;
    (fs.promises as any).opendir = async function (dir: string, ...args: any[]) {
      if (dir === sessions) {
        delayedOpen = true;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return (originalOpenDir as any).call(this, dir, ...args);
    };
    let heartbeat = false;
    try {
      const reportPromise = runDoctor({ home: h, config: cfg() });
      await new Promise<void>((resolve) => setTimeout(() => { heartbeat = true; resolve(); }, 0));
      const report = await reportPromise;
      assert.ok(delayedOpen, "integrity scan used asynchronous directory traversal");
      assert.ok(heartbeat, "event-loop timer ran while the filesystem scan was pending");
      assert.ok(find(report, "state.integrity"));
    } finally {
      (fs.promises as any).opendir = originalOpenDir;
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("state integrity stats large task directories in bounded concurrent batches", async () => {
    const h = tmp("nexus-doctor-batched-state-");
    const tasks = path.join(h, ".nexus", "tasks");
    fs.mkdirSync(tasks, { recursive: true, mode: 0o700 });
    const record = JSON.stringify({ taskId: "task", messages: [] });
    for (let i = 0; i < 512; i++) fs.writeFileSync(path.join(tasks, `task-${String(i).padStart(4, "0")}.json`), record);

    const originalLstat = fs.promises.lstat;
    let active = 0;
    let peakActive = 0;
    let taskStats = 0;
    (fs.promises as any).lstat = async function (file: fs.PathLike, ...args: any[]) {
      if (path.dirname(String(file)) === tasks) {
        active++;
        taskStats++;
        peakActive = Math.max(peakActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
          active--;
        }
      }
      return (originalLstat as any).call(this, file, ...args);
    };
    try {
      const report = await runDoctor({ home: h, config: cfg() });
      assert.equal(find(report, "state.integrity")?.status, "pass");
      assert.equal(find(report, "integrity.check"), undefined, "large state scan must finish before its per-check deadline");
      assert.equal(taskStats, 512, "every task record is considered when selecting the newest records");
      assert.ok(peakActive > 1, `stats should overlap instead of serializing; observed ${peakActive}`);
      assert.ok(peakActive <= 128, `stat concurrency must remain bounded; observed ${peakActive}`);
    } finally {
      (fs.promises as any).lstat = originalLstat;
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("default state integrity has a bounded extended deadline for slow long-lived stores", async () => {
    const h = tmp("nexus-doctor-integrity-deadline-");
    const tasks = path.join(h, ".nexus", "tasks");
    fs.mkdirSync(tasks, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tasks, "task-slow.json"), JSON.stringify({ taskId: "task-slow", messages: [] }));
    const originalLstat = fs.promises.lstat;
    (fs.promises as any).lstat = async function (file: fs.PathLike, ...args: any[]) {
      if (String(file) === path.join(tasks, "task-slow.json")) {
        await new Promise((resolve) => setTimeout(resolve, 5200));
      }
      return (originalLstat as any).call(this, file, ...args);
    };
    try {
      const report = await runDoctor({ home: h, config: cfg() });
      assert.equal(find(report, "state.integrity")?.status, "pass");
      assert.equal(find(report, "integrity.check"), undefined, "slow state metadata must not inherit the short endpoint timeout");
    } finally {
      (fs.promises as any).lstat = originalLstat;
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("an explicit timeout still bounds the state integrity check", async () => {
    const h = tmp("nexus-doctor-integrity-explicit-timeout-");
    const tasks = path.join(h, ".nexus", "tasks");
    fs.mkdirSync(tasks, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tasks, "task-slow.json"), JSON.stringify({ taskId: "task-slow", messages: [] }));
    const originalLstat = fs.promises.lstat;
    (fs.promises as any).lstat = async function (file: fs.PathLike, ...args: any[]) {
      if (String(file) === path.join(tasks, "task-slow.json")) {
        await new Promise((resolve) => setTimeout(resolve, 1300));
      }
      return (originalLstat as any).call(this, file, ...args);
    };
    try {
      const report = await runDoctor({ home: h, config: cfg(), timeoutMs: 100 });
      assert.equal(find(report, "integrity.check")?.status, "warn");
      assert.match(find(report, "integrity.check")?.explanation ?? "", /within 1100 ms/);
    } finally {
      (fs.promises as any).lstat = originalLstat;
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("MCP servers and plugins are inspected without being started or loaded", async () => {
    const marker = path.join(workspace, "started.marker");
    const server = path.join(workspace, "mcp-server.sh");
    fs.writeFileSync(server, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { ok: { command: server }, gone: { command: "no-such-mcp-binary" } } }));
    fs.mkdirSync(path.join(workspace, ".nexus", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".nexus", "plugins", "p.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "x"); export default { name: "p" };`);
    try {
      // Untrusted: the workspace's own configuration is still inspected, and reported as not loaded.
      const untrusted = await doctor({ config: cfg() });
      assert.equal(find(untrusted, "mcp.config")?.status, "warn");
      assert.match(find(untrusted, "mcp.config")!.evidence.join("\n"), /no-such-mcp-binary is not an executable/);
      assert.match(find(untrusted, "mcp.config")!.evidence.join("\n"), /\.mcp\.json: not loaded — this workspace is not trusted\. Trust it with `nexus trust/);
      assert.equal(find(untrusted, "plugins.config")?.status, "warn");
      assert.match(find(untrusted, "plugins.config")!.evidence.join("\n"), /p\.mjs: not loaded — this workspace is not trusted/);
      const { setWorkspaceTrusted } = await import("../src/workspace_trust.js");
      setWorkspaceTrusted(workspace, true);
      const report = await doctor({ config: cfg() });
      setWorkspaceTrusted(workspace, false);
      assert.equal(find(report, "mcp.config")?.status, "warn");
      assert.match(find(report, "mcp.config")!.evidence.join("\n"), /no-such-mcp-binary is not an executable/);
      assert.doesNotMatch(find(report, "mcp.config")!.evidence.join("\n"), /not trusted/);
      assert.match(find(report, "mcp.config")!.explanation, /none was started/);
      assert.equal(find(report, "plugins.config")?.status, "pass");
      assert.ok(!fs.existsSync(marker), "no MCP process was started and no plugin was imported");
      fs.writeFileSync(path.join(workspace, ".mcp.json"), "{broken");
      const invalid = await doctor({ config: cfg() });
      assert.match(find(invalid, "mcp.config")!.evidence.join("\n"), /not valid JSON \(Nexus ignores the whole file\)/);
    } finally {
      fs.rmSync(path.join(workspace, ".mcp.json"), { force: true });
      fs.rmSync(path.join(workspace, ".nexus"), { recursive: true, force: true });
      fs.rmSync(server, { force: true });
    }
  });
});

describe("output contract", () => {
  test("versioned JSON: every finding carries id, status, explanation, evidence and repair availability", async () => {
    const report = await doctor({ config: cfg() });
    const json = JSON.parse(renderDoctorJson(report));
    assert.equal(json.schemaVersion, 2);
    assert.equal(json.tool, "nexus doctor");
    assert.equal(json.context, "cli");
    const ids = new Set<string>();
    for (const finding of json.findings) {
      assert.match(finding.id, /^[a-z]+(\.[a-z_]+)+$/);
      assert.ok(!ids.has(finding.id), `duplicate id ${finding.id}`);
      ids.add(finding.id);
      assert.ok(["pass", "warn", "fail", "skip"].includes(finding.status));
      assert.equal(typeof finding.explanation, "string");
      assert.ok(Array.isArray(finding.evidence));
      assert.equal(typeof finding.repairAvailable, "boolean");
      if (finding.status === "fail") assert.ok(finding.action, `${finding.id} fails without a next action`);
    }
    const counted = Object.values(json.summary as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.equal(counted, json.findings.length);
    assert.ok(Array.isArray(json.effectiveConfig) && json.effectiveConfig.some((r: any) => r.key === "LOCAL_LLM_ENDPOINT"));
  });

  test("exit codes: 0 healthy, 1 warnings, 2 failures", () => {
    const base = { findings: [] } as unknown as DoctorReport;
    const withStatus = (status: string) => ({ ...base, findings: [{ status }] }) as unknown as DoctorReport;
    assert.equal(doctorExitCode(withStatus("pass")), 0);
    assert.equal(doctorExitCode(withStatus("skip")), 0);
    assert.equal(doctorExitCode(withStatus("warn")), 1);
    assert.equal(doctorExitCode(withStatus("fail")), 2);
  });

  test("secrets never appear in any output field or exception path", async () => {
    const m = await mock({ status: 401 });
    try {
      let configError: unknown = new Error(`provider rejected https://user:${SECRET}@example.test/v1?api_key=${SECRET} Authorization: Bearer ${SECRET}`);
      const failed = await doctor({ configError, flags: { apiKey: SECRET } });
      const report = await doctor({ config: cfg({ endpoint: `${m.url}?token=${SECRET}`, apiKey: SECRET }), flags: { apiKey: SECRET } });
      for (const out of [renderDoctorJson(failed), renderDoctorText(failed), renderDoctorJson(report), renderDoctorText(report)]) {
        assert.ok(!out.includes(SECRET), out.slice(0, 2000));
        assert.ok(!out.includes("supersecret"));
      }
      assert.ok(!redactDiagnostic(`Authorization: Bearer ${SECRET}`).includes(SECRET));
    } finally {
      await m.close();
    }
  });
});

describe("controlled repairs", () => {
  const prepared = () => {
    const h = tmp("nexus-doctor-fix-");
    const sessions = path.join(h, ".nexus", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.chmodSync(sessions, 0o777);
    fs.mkdirSync(path.join(h, ".config", "nexus"), { recursive: true });
    const creds = path.join(h, ".config", "nexus", "credentials.json");
    fs.writeFileSync(creds, JSON.stringify({ version: 1, providers: {} }));
    fs.chmodSync(creds, 0o644);
    return { h, sessions, creds, tasks: path.join(h, ".nexus", "tasks") };
  };
  const mode = (p: string) => fs.statSync(p).mode & 0o777;

  test("nothing changes without confirmation or under read-only policy", async () => {
    const { h, sessions } = prepared();
    try {
      const report = await runDoctor({ home: h, config: cfg() });
      assert.ok(proposedRepairs(report).length >= 3);
      const declined = await runRepairs(report, { home: h, config: cfg(), confirm: async () => false });
      assert.ok(declined.repairs!.every((r) => r.status === "declined"));
      const refused = await runRepairs(report, { home: h, config: cfg(), readOnly: true, confirm: async () => true });
      assert.ok(refused.repairs!.every((r) => r.status === "refused"));
      assert.equal(mode(sessions), 0o777);
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("confirmed repairs apply, back up previous modes, verify, and are idempotent", async () => {
    const { h, sessions, creds, tasks } = prepared();
    try {
      const report = await runDoctor({ home: h, config: cfg() });
      let asked: string[] = [];
      const fixed = await runRepairs(report, { home: h, config: cfg(), confirm: async (p) => ((asked = p.map((x) => x.description)), true) });
      assert.ok(asked.some((d) => d.includes("chmod") && d.includes(sessions)), asked.join("\n"));
      assert.equal(mode(sessions), 0o700);
      assert.equal(mode(creds), 0o600);
      assert.ok(fs.existsSync(tasks) && mode(tasks) === 0o700, "missing directory created 0700");
      assert.ok(fixed.repairs!.every((r) => r.status === "applied" && r.verified === "pass"), JSON.stringify(fixed.repairs));
      const backups = fs.readdirSync(path.join(h, ".nexus", "doctor-backups"));
      const manifest = JSON.parse(fs.readFileSync(path.join(h, ".nexus", "doctor-backups", backups[0]), "utf8"));
      assert.ok(manifest.entries.some((e: any) => e.path === sessions && e.previousMode === "777"));
      assert.equal(find(fixed, "state.sessions")?.status, "pass");
      assert.ok(!fs.existsSync(path.join(h, ".nexus", "doctor.lock")), "lock released");
      const again = await runDoctor({ home: h, config: cfg() });
      assert.equal(proposedRepairs(again).length, 0, "a second run proposes nothing");
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  test("a concurrent change or a held lock leaves the target alone", async () => {
    const { h, sessions } = prepared();
    try {
      const report = await runDoctor({ home: h, config: cfg() });
      fs.chmodSync(sessions, 0o750); // changed by someone else after the diagnosis
      const raced = await runRepairs(report, { home: h, config: cfg(), confirm: async () => true });
      const repair = raced.repairs!.find((r) => r.findingId === "state.sessions")!;
      assert.equal(repair.status, "skipped");
      assert.equal(mode(sessions), 0o750);
      fs.chmodSync(sessions, 0o777);
      const holder = spawn("sleep", ["30"]);
      fs.writeFileSync(path.join(h, ".nexus", "doctor.lock"), String(holder.pid));
      const locked = await runRepairs(await runDoctor({ home: h, config: cfg() }), { home: h, config: cfg(), confirm: async () => true });
      holder.kill();
      assert.ok(locked.repairs!.length > 0 && locked.repairs!.every((r) => r.status === "skipped" && /holds/.test(r.detail)), JSON.stringify(locked.repairs));
      assert.equal(mode(sessions), 0o777, "nothing changed while another doctor --fix held the lock");
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("repair safety and provider-specific requests", () => {
  const mode = (p: string) => fs.statSync(p).mode & 0o777;

  test("permissions are never changed through a symbolic link", async () => {
    const h = tmp("nexus-doctor-link-");
    const elsewhere = tmp("nexus-doctor-target-");
    try {
      fs.chmodSync(elsewhere, 0o777);
      fs.mkdirSync(path.join(h, ".nexus"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(h, ".nexus", "sessions"));
      const report = await runDoctor({ home: h, config: cfg() });
      const finding = find(report, "state.sessions")!;
      assert.equal(finding.status, "warn");
      assert.equal(finding.repairAvailable, false, "no repair is offered through a link");
      assert.match(finding.explanation, /symbolic link/);
      await runRepairs(report, { home: h, config: cfg(), confirm: async () => true });
      assert.equal(mode(elsewhere), 0o777, "the link target was not touched");
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
      fs.chmodSync(elsewhere, 0o700);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a directory replaced by a link between diagnosis and repair is left alone", async () => {
    const h = tmp("nexus-doctor-swap-");
    const elsewhere = tmp("nexus-doctor-target-");
    try {
      const sessions = path.join(h, ".nexus", "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.chmodSync(sessions, 0o777);
      fs.chmodSync(elsewhere, 0o777);
      const report = await runDoctor({ home: h, config: cfg() });
      assert.equal(find(report, "state.sessions")?.repair?.id, "state.permissions");
      fs.rmSync(sessions, { recursive: true });
      fs.symlinkSync(elsewhere, sessions);
      const fixed = await runRepairs(report, { home: h, config: cfg(), confirm: async () => true });
      assert.equal(fixed.repairs!.find((r) => r.findingId === "state.sessions")?.status, "skipped");
      assert.equal(mode(elsewhere), 0o777);
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
      fs.chmodSync(elsewhere, 0o700);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a cloud provider is diagnosed with that provider's protocol and credential", async () => {
    const m = await mock({ models: ["claude-test", "gpt-test"] });
    const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-doctor-test-0001";
      process.env.OPENROUTER_API_KEY = "sk-or-doctor-test-0002";
      const anthropic = buildConfig({ provider: "anthropic", baseUrl: m.url, model: "claude-test", workspace });
      const a = await doctor({ config: anthropic, flags: { provider: "anthropic" } });
      assert.equal(find(a, "model.available")?.status, "pass", JSON.stringify(a.findings.filter((f) => f.category === "endpoint")));
      const aHeaders = m.headers.filter((_, i) => m.paths[i].startsWith("/v1/models"));
      assert.ok(aHeaders.some((h) => h["x-api-key"] === "sk-ant-doctor-test-0001" && h["anthropic-version"]), "Anthropic key header and version");
      assert.ok(m.paths.some((p) => p === "/v1/models?limit=1000"), m.paths.join(" "));
      assert.ok(!renderDoctorJson(a).includes("sk-ant-doctor-test-0001"));
      const before = m.headers.length;
      const openrouter = buildConfig({ provider: "openrouter", baseUrl: m.url, model: "gpt-test", workspace });
      const o = await doctor({ config: openrouter, flags: { provider: "openrouter" } });
      assert.equal(find(o, "model.available")?.status, "pass");
      assert.ok(m.headers.slice(before).some((h) => h.authorization === "Bearer sk-or-doctor-test-0002"), "OpenRouter bearer credential");
      assert.ok(!renderDoctorJson(o).includes("sk-or-doctor-test-0002"));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await m.close();
    }
  });
});

describe("repairs cannot be redirected by links anywhere in the path", () => {
  const mode = (p: string) => fs.statSync(p).mode & 0o777;
  const withDirs = async (fn: (h: string, elsewhere: string) => Promise<void>) => {
    const h = tmp("nexus-doctor-anc-");
    const elsewhere = tmp("nexus-doctor-outside-");
    try {
      await fn(h, elsewhere);
    } finally {
      for (const d of [h, elsewhere]) {
        spawnSync("chmod", ["-R", "u+rwx", d]);
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  };

  test("a linked parent (~/.nexus -> elsewhere) gets no repair, and --fix changes nothing outside", async () => {
    await withDirs(async (h, elsewhere) => {
      fs.mkdirSync(path.join(elsewhere, "sessions"));
      fs.chmodSync(path.join(elsewhere, "sessions"), 0o777);
      fs.symlinkSync(elsewhere, path.join(h, ".nexus"));
      const report = await runDoctor({ home: h, config: cfg() });
      const finding = find(report, "state.sessions")!;
      assert.equal(finding.repairAvailable, false, JSON.stringify(finding));
      assert.match(finding.explanation, /not safe to change automatically \(.*\.nexus is a symbolic link\)/);
      assert.equal(find(report, "state.tasks")?.repairAvailable, false, "creating ~/.nexus/tasks would land outside too");
      const fixed = await runRepairs(report, { home: h, config: cfg(), confirm: async () => true });
      assert.equal(mode(path.join(elsewhere, "sessions")), 0o777);
      assert.deepEqual(fs.readdirSync(elsewhere), ["sessions"], "no lock, backup or directory was created outside the home");
      assert.ok(fixed.repairs!.every((r) => r.status !== "applied"));
    });
  });

  test("~/.nexus swapped for a link after the diagnosis: repairs, lock and backups stand down", async () => {
    await withDirs(async (h, elsewhere) => {
      const sessions = path.join(h, ".nexus", "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.chmodSync(sessions, 0o777);
      const report = await runDoctor({ home: h, config: cfg() });
      assert.equal(find(report, "state.sessions")?.repair?.id, "state.permissions");
      // The attacker's copy: same names, same mode, outside the home.
      fs.mkdirSync(path.join(elsewhere, "sessions"));
      fs.chmodSync(path.join(elsewhere, "sessions"), 0o777);
      fs.rmSync(path.join(h, ".nexus"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(h, ".nexus"));
      const fixed = await runRepairs(report, { home: h, config: cfg(), confirm: async () => true });
      assert.equal(mode(path.join(elsewhere, "sessions")), 0o777, "the outside directory kept its mode");
      assert.deepEqual(fs.readdirSync(elsewhere), ["sessions"], "no lock or backup was written through the link");
      assert.ok(fixed.repairs!.every((r) => r.status === "refused"), JSON.stringify(fixed.repairs));
    });
  });

  test("a linked credentials parent (~/.config -> elsewhere) gets no repair", async () => {
    await withDirs(async (h, elsewhere) => {
      fs.mkdirSync(path.join(elsewhere, "nexus"));
      fs.writeFileSync(path.join(elsewhere, "nexus", "credentials.json"), "{}");
      fs.chmodSync(path.join(elsewhere, "nexus", "credentials.json"), 0o644);
      fs.symlinkSync(elsewhere, path.join(h, ".config"));
      const report = await runDoctor({ home: h, config: cfg() });
      assert.equal(find(report, "credentials.store")?.repairAvailable, false);
      await runRepairs(report, { home: h, config: cfg(), confirm: async () => true });
      assert.equal(mode(path.join(elsewhere, "nexus", "credentials.json")), 0o644);
    });
  });

  test("a planted lock link is never followed or written through", async () => {
    await withDirs(async (h, elsewhere) => {
      const sessions = path.join(h, ".nexus", "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.chmodSync(sessions, 0o777);
      const victim = path.join(elsewhere, "victim");
      fs.writeFileSync(victim, "keep me");
      fs.symlinkSync(victim, path.join(h, ".nexus", "doctor.lock"));
      const fixed = await runRepairs(await runDoctor({ home: h, config: cfg() }), { home: h, config: cfg(), confirm: async () => true });
      assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
      assert.ok(fixed.repairs!.every((r) => r.status === "refused"), JSON.stringify(fixed.repairs));
      assert.equal(mode(sessions), 0o777, "no change without a safely held lock");
    });
  });

  test("the change is bound to the verified object: a final or parent swap after diagnosis is detected", async () => {
    await withDirs(async (h, elsewhere) => {
      // Final component swapped for a link to a same-mode directory.
      const dir = path.join(h, "a", "target");
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o777);
      const seen = identityOf(dir)!;
      fs.mkdirSync(path.join(elsewhere, "target"));
      fs.chmodSync(path.join(elsewhere, "target"), 0o777);
      fs.rmdirSync(dir);
      fs.symlinkSync(path.join(elsewhere, "target"), dir);
      assert.throws(() => chmodVerified(h, dir, 0o700, seen, "dir"), SafePathError);
      assert.equal(mode(path.join(elsewhere, "target")), 0o777);
      // Parent swapped: h/b -> elsewhere/b, which contains a same-named, same-mode child.
      const real = path.join(h, "b", "target");
      fs.mkdirSync(real, { recursive: true });
      fs.chmodSync(real, 0o777);
      const before = identityOf(real)!;
      fs.mkdirSync(path.join(elsewhere, "b", "target"), { recursive: true });
      fs.chmodSync(path.join(elsewhere, "b", "target"), 0o777);
      fs.renameSync(path.join(h, "b"), path.join(h, "b-moved"));
      fs.symlinkSync(path.join(elsewhere, "b"), path.join(h, "b"));
      assert.throws(() => chmodVerified(h, real, 0o700, before, "dir"), SafePathError);
      assert.equal(mode(path.join(elsewhere, "b", "target")), 0o777);
      assert.match(ancestryProblem(h, real) ?? "", /b is a symbolic link/);
      // Creation never goes through a linked parent, and exclusive files never through a final link.
      assert.throws(() => mkdirVerified(h, path.join(h, "b", "new")), SafePathError);
      assert.ok(!fs.existsSync(path.join(elsewhere, "b", "new")));
      fs.symlinkSync(path.join(elsewhere, "victim2"), path.join(h, "planted"));
      assert.throws(() => writeExclusiveVerified(h, path.join(h, "planted"), "x"));
      assert.ok(!fs.existsSync(path.join(elsewhere, "victim2")));
    });
  });
});

describe("entry points share one engine", () => {
  test("`nexus doctor --json` through the packaged launcher: isolated home, mock endpoint, exit code", async () => {
    const m = await mock({ models: ["m"] });
    try {
      const res = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn("bash", [LAUNCHER, "doctor", "--json", "-e", m.url, "-m", "m", "-w", workspace, "--timeout", "2000"], { env: { ...process.env, HOME: home, LOCAL_LLM_API_KEY: SECRET } });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("close", (code) => resolve({ code, out, err }));
      });
      const report = JSON.parse(res.out);
      assert.equal(report.schemaVersion, 2, res.err);
      assert.equal(res.code, doctorExitCode(report));
      assert.equal(report.findings.find((f: any) => f.id === "model.available").status, "pass");
      assert.ok(!res.out.includes(SECRET));
      const check = spawnSync("bash", [LAUNCHER, "check", "--json", "-e", m.url, "-w", workspace], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      const alias = JSON.parse(check.stdout);
      assert.deepEqual(alias.findings.map((f: any) => f.id).sort(), report.findings.map((f: any) => f.id).sort(), "check is the same engine");
    } finally {
      await m.close();
    }
  });

  test("an invalid option is a doctor execution error (exit 3) with machine-readable JSON", () => {
    const res = spawnSync("bash", [LAUNCHER, "doctor", "--json", "--timeout", "soon", "-w", workspace], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(res.status, 3, res.stderr);
    assert.match(JSON.parse(res.stdout).error, /--timeout must be a positive number/);
  });

  test("help documents flags, exit codes and the repair scope", () => {
    const res = spawnSync("bash", [LAUNCHER, "doctor", "--help"], { encoding: "utf8" });
    for (const text of ["--deep", "--fix", "--yes", "--json", "Exit codes: 0 healthy", "Supported repairs"]) assert.ok(res.stdout.includes(text), text);
  });

  test("the session context diagnoses the session's own configuration", async () => {
    const report = await runDoctor({ context: "session", home, config: cfg({ model: "switched-by-/model" }), timeoutMs: 1000 });
    assert.equal(report.context, "session");
    assert.equal(report.effectiveConfig?.find((r) => r.key === "LOCAL_LLM_MODEL")?.value, "switched-by-/model");
    assert.match(renderDoctorText(report), /active session configuration/);
  });
});

describe("SPEC-06 PR-6d requirements (ACC-PKG-06..09, REQ-DX-101..104)", () => {
  test("ACC-PKG-06 (REQ-DX-101): doctor stderr is empty on a healthy run (no MaxListenersExceededWarning)", async () => {
    const m = await mock({ models: ["m"] });
    try {
      const res = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn("bash", [LAUNCHER, "doctor", "-e", m.url, "-m", "m", "-w", workspace, "--timeout", "2000"], {
          env: { ...process.env, HOME: home, LOCAL_LLM_API_KEY: SECRET },
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("close", (code) => resolve({ code, out, err }));
      });
      assert.equal(res.err.trim(), "", `expected empty stderr, got: ${res.err}`);
    } finally {
      await m.close();
    }
  });

  test("ACC-PKG-07 (REQ-DX-101): packaged doctor remedies contain no make or harness.sh", async () => {
    const pkgHome = tmp("nexus-pkg-remedies-");
    const externalBin = path.join(pkgHome, "external-bin");
    const externalCheckout = path.join(pkgHome, "external-checkout");
    fs.mkdirSync(externalBin, { recursive: true });
    fs.mkdirSync(externalCheckout, { recursive: true });
    const externalLauncher = path.join(externalCheckout, "harness.sh");
    fs.writeFileSync(externalLauncher, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.symlinkSync(externalLauncher, path.join(externalBin, "nexus"));
    const m = await mock({ models: ["m"] });
    try {
      const res = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const cliEntry = path.join(ROOT, "cli/dist/index.js");
        const child = spawn(process.execPath, [cliEntry, "doctor", "--json", "-e", m.url, "-m", "m", "-w", workspace, "--timeout", "2000"], {
          env: { ...process.env, HOME: home, NEXUS_HOME: pkgHome, PATH: `${externalBin}${path.delimiter}${process.env.PATH ?? ""}` },
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("close", (code) => resolve({ code, out, err }));
      });
      const report = JSON.parse(res.out);
      const jsonStr = JSON.stringify(report);
      assert.ok(!jsonStr.includes("make build"), "packaged report must not suggest `make build`");
      assert.ok(!jsonStr.includes("make build-core"), "packaged report must not suggest `make build-core`");
      assert.ok(!jsonStr.includes("harness.sh"), "packaged report must not suggest `harness.sh`");
    } finally {
      await m.close();
    }
  });

  test("ACC-PKG-08 (REQ-DX-102): config.env at 0644 gives a warning and repair; --fix --yes sets 0600", async () => {
    const h = tmp("nexus-doctor-config-env-");
    const configDir = path.join(h, ".config", "nexus");
    fs.mkdirSync(configDir, { recursive: true });
    const configEnv = path.join(configDir, "config.env");
    fs.writeFileSync(configEnv, "LOCAL_LLM_MODEL=test-model\n", { mode: 0o644 });
    fs.chmodSync(configEnv, 0o644);

    const report1 = await runDoctor({ home: h, config: cfg() });
    const finding1 = report1.findings.find((f) => f.id === "config.env");
    assert.ok(finding1, "finding config.env must be present");
    assert.equal(finding1.status, "warn");
    assert.match(finding1.explanation, /readable by other users/);
    assert.ok(finding1.repair, "finding must propose a repair");
    assert.equal(finding1.repair.id, "config.permissions");

    const repaired = await runRepairs(report1, { home: h, config: cfg(), confirm: async () => true });
    const repairRes = repaired.repairs?.find((r) => r.id === "config.permissions");
    assert.ok(repairRes, "repair result must be present");
    assert.equal(repairRes.status, "applied");

    const modeAfter = fs.statSync(configEnv).mode & 0o777;
    assert.equal(modeAfter, 0o600, "config.env mode must be tightened to 0600");

    const report2 = await runDoctor({ home: h, config: cfg() });
    const finding2 = report2.findings.find((f) => f.id === "config.env");
    assert.ok(finding2);
    assert.equal(finding2.status, "pass");
    assert.equal(finding2.repair, undefined, "no repair needed after fix");
  });

  test("ACC-PKG-09 (REQ-DX-103): workspace path with a UUID segment appears unredacted in doctor output", async () => {
    const uuidWs = path.join(os.tmpdir(), "nexus-workspace-f1a2b3c4-d5e6-7890-abcd-ef0123456789");
    fs.mkdirSync(uuidWs, { recursive: true });
    try {
      const report = await runDoctor({ home, config: cfg({ workspace: uuidWs }) });
      const finding = report.findings.find((f) => f.id === "workspace.access");
      assert.ok(finding);
      assert.equal(finding.status, "pass");
      assert.ok(finding.evidence.includes(uuidWs), `evidence must contain unredacted path, got: ${finding.evidence.join(" ")}`);
      assert.ok(!finding.evidence.join(" ").includes("[REDACTED:HIGH_ENTROPY_STRING]"));
    } finally {
      fs.rmSync(uuidWs, { recursive: true, force: true });
    }
  });

  test("REQ-DX-104: tui.launch verifies launchability via nexus-tui --live --check", async () => {
    const report = await runDoctor({ home, config: cfg() });
    const finding = report.findings.find((f) => f.id === "tui.launch");
    assert.ok(finding, "tui.launch finding must be present");
    assert.equal(finding.status, "pass");
    assert.match(finding.explanation, /launchable and its sidecar resolves/);
  });
});

