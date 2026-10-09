/**
 * Durable continuity of work across process death, retries and resumes (acceptance blockers V1 and V2,
 * docs/reviews/NEXUS_ACCEPTANCE_BLOCKERS_2026-10-08.md):
 *
 *   V1  a resumed unit continues its authorized task from its recorded conversation; missing or inconsistent durable
 *       history blocks the unit (only the operator can start it over) and is never read as NOT_REQUIRED.
 *   V2  workspace changes that no verifier has established stay unverified across step limits, retries, process
 *       restarts and every supported resume path, so a later attempt that changes nothing cannot complete the unit.
 *
 * Real AutonomousAgent turns against local scripted gateways; process death uses the real CLI in a child process.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { ApplicationCore } from "../src/core/app.js";
import { newOperation, type DurableOperationState, type WorkUnitSpec } from "../src/core/operation.js";
import { AgentWorkUnitExecutor, applyOperatorDecision, driveOperation, OperationStore } from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import { DurableStateManager } from "../src/core/state.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { SidecarServer } from "../src/sidecar.js";
import type { HarnessConfig } from "../src/types.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcIndex = path.join(cliRoot, "src/index.ts");
const tsxLoader = import.meta.resolve("tsx");

// ---------------------------------------------------------------- scripted gateway

type Reply = { tools: Array<{ name: string; args: unknown }> } | { text: string } | { hold: true };
interface Gw { url: string; origin: string; requests: any[]; held: boolean; close(): Promise<void> }

/** Tool-call ids the provider issues: short ones survive persistence redaction, high-entropy ones may not. */
type IdStyle = "low-entropy" | "high-entropy";
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 32 distinct characters: always above the persistence classifier's entropy threshold. */
const highEntropyId = () => {
  const chars = [...ID_ALPHABET];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return `call_${chars.slice(0, 32).join("")}`;
};

/** OpenAI-compatible gateway (streaming and not). A `hold` reply never answers: the client waits until it is killed. */
async function gateway(script: (body: any) => Reply, ids: IdStyle = "low-entropy"): Promise<Gw> {
  const gw: Gw = { url: "", origin: "", requests: [], held: false, close: async () => {} };
  let n = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      return void res.end('{"data":[{"id":"m"}]}');
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      gw.requests.push(body);
      const reply = script(body);
      if ("hold" in reply) {
        gw.held = true;
        return;
      }
      const calls = "tools" in reply
        ? reply.tools.map((c, index) => ({ index, id: ids === "low-entropy" ? `call_${++n}` : highEntropyId(), type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }))
        : undefined;
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        const message = calls ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: (reply as { text: string }).text };
        return void res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = calls ? { tool_calls: calls } : { content: (reply as { text: string }).text };
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  gw.url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  gw.origin = new URL(gw.url).origin;
  gw.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return gw;
}

const toolResults = (body: any): number => (body.messages ?? []).filter((m: any) => m.role === "tool").length;
const allText = (body: any): string => (body.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");
const lastUser = (body: any): string => {
  const users = (body.messages ?? []).filter((m: any) => m.role === "user");
  const c = users[users.length - 1]?.content;
  return typeof c === "string" ? c : "";
};
const write = (file = "impl.txt"): Reply => ({ tools: [{ name: "write_file", args: { path: file, content: "implementation\n" } }] });
const read = (file: string): Reply => ({ tools: [{ name: "read_file", args: { path: file } }] });
const done = (summary = "done"): Reply => ({ tools: [{ name: "task_completed", args: { summary } }] });
const resumed = (body: any) => lastUser(body).startsWith("[Work unit resumed");

// ---------------------------------------------------------------- isolation

function makeRepo(files: Record<string, string> = {}): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cont-"));
  fs.writeFileSync(path.join(repo, "notes.txt"), "the answer is 42\n");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

const ENV_KEYS = ["HOME", "LOCAL_LLM_ENDPOINT", "LOCAL_LLM_API_KEY", "LOCAL_LLM_MODEL", "LOCAL_LLM_CREDENTIAL_ORIGINS", "LOCAL_LLM_FALLBACK_ENDPOINTS"];

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cont-home-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function quiet(agent: AutonomousAgent): AutonomousAgent {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
}

async function muted<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

const cfg = (gw: Gw, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig =>
  ({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace, shell: "bash", ...o });

/** A durable operation driven in-process with the real agent executor; decisions are applied as the CLI does. */
function operationRig(config: HarnessConfig, gw: Gw) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cont-state-"));
  const resource: ResourceDescriptor = { id: "primary", provider: gw.origin, endpoint: gw.url, model: "m", capabilities: ["tools"], rank: 0 };
  const store = new OperationStore(config.workspace, stateDir);
  const executor = new AgentWorkUnitExecutor({
    baseConfig: config,
    createAgent: (c) => {
      const agent = quiet(new AutonomousAgent(c, 1));
      const a = agent as any;
      a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
      return agent;
    },
  });
  // Each rig has its own state directory; a random id could be redacted as high-entropy on disk.
  const id = "continuity-op";
  return {
    id,
    start: (units: WorkUnitSpec[]) => muted(() => driveOperation(newOperation(id, "continuity", units, [resource], Date.now()), { store, executor })),
    decide: (decisionId: string, option: string, note?: string) => {
      applyOperatorDecision(store, id, decisionId, option, note);
      return muted(() => driveOperation(store.load(id), { store, executor }));
    },
    /** The unit's durable conversation task file. */
    taskFile: (op: DurableOperationState, unitId: string) => path.join(stateDir, `${op.units.find((u) => u.id === unitId)!.agentTaskId}.json`),
    close: () => fs.rmSync(stateDir, { recursive: true, force: true }),
  };
}

const unitOf = (op: DurableOperationState, id: string) => op.units.find((u) => u.id === id)!;
const decisionOf = (op: DurableOperationState, id: string) => unitOf(op, id).blocked!.decision;

// ---------------------------------------------------------------- V2: verification obligations survive attempts

describe("V2: unverified changes survive retries, step limits, restarts and resumes", () => {
  test("retry after UNVERIFIED: the resumed attempt changes nothing, the unit stays unverified and its dependent never runs", async () => {
    await withHome(async () => {
      const gw = await gateway((b) => (lastUser(b).includes("Review impl.txt") ? done("reviewed") : resumed(b) ? done("nothing more to do") : toolResults(b) === 0 ? write() : done()));
      const repo = makeRepo();
      const rig = operationRig(cfg(gw, repo), gw);
      try {
        let op = await rig.start([{ id: "implement", prompt: "Write impl.txt." }, { id: "review", prompt: "Review impl.txt.", dependsOn: ["implement"] }]);
        assert.equal(unitOf(op, "implement").status, "BLOCKED");
        const retry = decisionOf(op, "implement").options.find((o) => o.label === "retry")!;
        op = await rig.decide(decisionOf(op, "implement").id, retry.id);
        assert.ok(gw.requests.some(resumed), "the retry ran");
        assert.equal(unitOf(op, "implement").status, "BLOCKED", `implement: ${JSON.stringify(unitOf(op, "implement").result ?? unitOf(op, "implement").blocked?.reason)}`);
        assert.match(unitOf(op, "implement").blocked!.reason, /UNVERIFIED/);
        assert.equal(unitOf(op, "review").status, "WAITING_ON_DEPENDENCY");
        assert.ok(gw.requests.every((b) => !lastUser(b).includes("Review impl.txt")), "the dependent never ran");
        assert.notEqual(op.status, "COMPLETE");
      } finally {
        rig.close();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("continue after the step limit: a write before the limit is still unverified after the continuation", async () => {
    await withHome(async () => {
      const gw = await gateway((b) => (lastUser(b).includes("Review impl.txt") ? done("reviewed") : resumed(b) ? done("finished") : toolResults(b) === 0 ? write() : read("impl.txt")));
      const repo = makeRepo();
      const rig = operationRig(cfg(gw, repo, { maxSteps: 3 }), gw);
      try {
        let op = await rig.start([{ id: "implement", prompt: "Write impl.txt." }, { id: "review", prompt: "Review impl.txt.", dependsOn: ["implement"] }]);
        assert.match(unitOf(op, "implement").blocked!.reason, /step limit/);
        const more = decisionOf(op, "implement").options.find((o) => o.label === "continue with more steps")!;
        op = await rig.decide(decisionOf(op, "implement").id, more.id);
        assert.equal(unitOf(op, "implement").status, "BLOCKED");
        assert.match(unitOf(op, "implement").blocked!.reason, /UNVERIFIED/);
        assert.ok(gw.requests.every((b) => !lastUser(b).includes("Review impl.txt")), "the dependent never ran");
      } finally {
        rig.close();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("a continuation completes when the verifier establishes the carried change (VERIFIED, then the dependent runs)", async () => {
    await withHome(async () => {
      const gw = await gateway((b) => (lastUser(b).includes("Review impl.txt") ? done("reviewed") : resumed(b) ? done("finished") : toolResults(b) === 0 ? write() : read("impl.txt")));
      const repo = makeRepo();
      const rig = operationRig(cfg(gw, repo, { maxSteps: 3, authoritativeVerifierCommand: "test -f impl.txt" }), gw);
      try {
        let op = await rig.start([{ id: "implement", prompt: "Write impl.txt." }, { id: "review", prompt: "Review impl.txt.", dependsOn: ["implement"] }]);
        const more = decisionOf(op, "implement").options.find((o) => o.label === "continue with more steps")!;
        op = await rig.decide(decisionOf(op, "implement").id, more.id);
        assert.equal(unitOf(op, "implement").status, "COMPLETE");
        assert.equal(unitOf(op, "implement").result!.outcome, "VERIFIED");
        assert.equal(op.status, "COMPLETE");
      } finally {
        rig.close();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("nexus run --resume <task> and /recover: a restarted process inherits the unverified change; a read-only turn is not NOT_REQUIRED", async () => {
    await withHome(async () => {
      const gw = await gateway((b) => (lastUser(b).startsWith("Write impl.txt") ? (toolResults(b) === 0 ? write() : done()) : done("nothing left")));
      const repo = makeRepo();
      const config = cfg(gw, repo);
      try {
        const first = new ApplicationCore(config);
        quiet(first.getAgent());
        const r1 = await muted(() => first.runTask("Write impl.txt."));
        first.shutdown();
        assert.equal(r1.turn.outcome, "UNVERIFIED");
        const second = new ApplicationCore(config);
        quiet(second.getAgent());
        const r2 = await muted(() => second.runTask("Anything left?", { resumeTaskId: r1.taskId }));
        second.shutdown();
        assert.equal(r2.turn.outcome, "UNVERIFIED", `resumed turn: ${r2.turn.outcome}`);
        assert.notEqual(r2.exitCode, 0);
        const third = new ApplicationCore(config);
        quiet(third.getAgent());
        const recovered = await third.executeSlashCommand("recover", r1.taskId);
        assert.ok(recovered.success, recovered.output);
        const r3 = await muted(() => third.getAgent().runTurn("Anything left?"));
        third.shutdown();
        assert.equal(r3.outcome, "UNVERIFIED", `turn after /recover: ${r3.outcome}`);
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("interactive /resume (sidecar): a resumed session keeps its outstanding verification obligation", async () => {
    await withHome(async () => {
      const gw = await gateway((b) => (lastUser(b).startsWith("Write impl.txt") ? (toolResults(b) === 0 ? write() : { text: "I wrote impl.txt." }) : done("nothing left")));
      const repo = makeRepo();
      const config = cfg(gw, repo);
      const turnResult = async (resume: string | undefined, text: string) => {
        const app = new ApplicationCore(config as any);
        quiet(app.getAgent());
        const events: any[] = [];
        const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)), ...(resume ? { resume } : {}) });
        server.start();
        await muted(async () => {
          await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t", text }));
          await server.idle();
        });
        app.shutdown();
        return { result: events.find((e) => e.type === "turn.result"), notices: events.filter((e) => e.type === "notice").map((e) => e.text) };
      };
      try {
        const first = await turnResult(undefined, "Write impl.txt.");
        assert.equal(first.result.turn.outcome, "UNVERIFIED");
        const second = await turnResult("latest", "Anything left?");
        assert.ok(second.notices.some((n: string) => n.startsWith("Resumed session")), `notices: ${second.notices.join(" | ")}`);
        assert.equal(second.result.turn.outcome, "UNVERIFIED", `resumed turn: ${second.result.turn.outcome}`);
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("interactive /resume after the process ended mid-turn: the change made before the end is still unverified", async () => {
    await withHome(async () => {
      let hold = true;
      const gw = await gateway((b) => {
        if (lastUser(b).startsWith("Write impl.txt")) return toolResults(b) === 0 ? write() : hold ? { hold: true } : done();
        return done("nothing left");
      });
      const repo = makeRepo();
      const config = cfg(gw, repo);
      // First host: the write lands, then the process "ends" while the next inference request is outstanding.
      const app1 = new ApplicationCore(config as any);
      quiet(app1.getAgent());
      const server1 = new SidecarServer({ app: app1, mode: "auto", write: () => {} });
      let app2: ApplicationCore | undefined;
      server1.start();
      const abandoned = muted(() => server1.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t", text: "Write impl.txt." })));
      try {
        const deadline = Date.now() + 15_000;
        while (!gw.held && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        assert.ok(gw.held, "the first turn reached the held request");
        // Second host: a new application resumes the latest session from disk only.
        app2 = new ApplicationCore(config as any);
        quiet(app2.getAgent());
        const events: any[] = [];
        const server2 = new SidecarServer({ app: app2, mode: "auto", write: (line) => events.push(JSON.parse(line)), resume: "latest" });
        server2.start();
        hold = false;
        await muted(async () => {
          await server2.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t2", text: "Anything left?" }));
          await server2.idle();
        });
        const result = events.find((e) => e.type === "turn.result");
        assert.equal(result.turn.outcome, "UNVERIFIED", `resumed turn: ${result.turn.outcome}`);
      } finally {
        // The abandoned first turn must end, or its provider wait keeps the test process alive.
        await server1.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
        await gw.close();
        await Promise.race([abandoned.catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
        app2?.shutdown();
        app1.shutdown();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

describe("V2: a tool still running when an interactive host ends", () => {
  test("interactive /resume after the host ended inside a writing command: the change is still unverified", async () => {
    await withHome(async () => {
      const gw = await gateway((b) =>
        lastUser(b).startsWith("Run the writer") && toolResults(b) === 0
          ? { tools: [{ name: "run_command", args: { command: "printf x > out.txt; sleep 6" } }] }
          : done("nothing left"));
      const repo = makeRepo();
      const config = cfg(gw, repo);
      const app1 = new ApplicationCore(config as any);
      quiet(app1.getAgent());
      const server1 = new SidecarServer({ app: app1, mode: "auto", write: () => {} });
      let app2: ApplicationCore | undefined;
      server1.start();
      const abandoned = muted(() => server1.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t", text: "Run the writer." })));
      try {
        await until(() => fs.existsSync(path.join(repo, "out.txt")), 15_000);
        // Second host: a new application resumes the latest session from disk while the command is still running.
        app2 = new ApplicationCore(config as any);
        quiet(app2.getAgent());
        const events: any[] = [];
        const server2 = new SidecarServer({ app: app2, mode: "auto", write: (line) => events.push(JSON.parse(line)), resume: "latest" });
        server2.start();
        await muted(async () => {
          await server2.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t2", text: "Anything left?" }));
          await server2.idle();
        });
        const result = events.find((e) => e.type === "turn.result");
        assert.equal(result.turn.outcome, "UNVERIFIED", `resumed turn: ${result.turn.outcome}`);
      } finally {
        await server1.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
        await Promise.race([abandoned.catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
        await gw.close();
        app2?.shutdown();
        app1.shutdown();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------- R1: state written before the obligation was recorded

describe("R1: task state and sessions without a recorded obligation (written by earlier builds)", () => {
  test("an operation interrupted after an earlier clean turn: after 'continue after inspection' the unit stays UNVERIFIED and its dependent never runs", async () => {
    await withHome(async () => {
      const gw = await gateway((b) => {
        if (lastUser(b).includes("Review the markers")) return done("reviewed");
        if (resumed(b)) return done("x.txt written and c.txt read");
        return [read("a.txt"), read("b.txt")][Math.min(toolResults(b), 1)];
      });
      const repo = makeRepo({ "a.txt": "MARK-a\n", "b.txt": "MARK-b\n", "c.txt": "MARK-c\n" });
      const rig = operationRig(cfg(gw, repo, { maxSteps: 2 }), gw);
      try {
        let op = await rig.start([
          { id: "markers", title: "Markers", prompt: "OBJ-LEGACY: read a.txt, b.txt and c.txt, write x.txt, report." },
          { id: "review", prompt: "Review the markers.", dependsOn: ["markers"] },
        ]);
        assert.match(unitOf(op, "markers").blocked!.reason, /step limit/);
        // The file as an earlier build left it when killed in a later turn: that turn's write and its reads are not in
        // the conversation (saved only at turn end), its last tool's record is `completed`, and there is no obligation
        // field; only the earlier, read-only turn is recorded (lastTurn: no unverified changes).
        const file = rig.taskFile(op, "markers");
        edit(file, ({ unverifiedChangesPending: _p, ...s }) => ({
          ...s,
          currentOperation: {
            invocationId: "call_read_c",
            toolName: "read_file",
            argsSummary: "c.txt",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            status: "completed",
          },
        }));
        const legacy = JSON.parse(fs.readFileSync(file, "utf-8"));
        assert.equal("unverifiedChangesPending" in legacy, false);
        assert.equal(legacy.lastTurn?.unverifiedChangesPending, false, "precondition: the recorded turn was clean");
        assert.equal(legacy.messages.filter((m: any) => m.role === "tool").length, 2);
        fs.writeFileSync(path.join(repo, "x.txt"), "x");

        const more = decisionOf(op, "markers").options.find((o) => o.label === "continue with more steps")!;
        const before = gw.requests.length;
        op = await rig.decide(decisionOf(op, "markers").id, more.id);
        assert.match(unitOf(op, "markers").blocked!.reason, /read_file/, "the interrupted tool is reported");
        assert.equal(gw.requests.length, before, "no inference before the operator inspects");
        const inspect = decisionOf(op, "markers").options.find((o) => o.label === "continue after inspection")!;
        op = await rig.decide(decisionOf(op, "markers").id, inspect.id);
        assert.ok(gw.requests.slice(before).some(resumed), "the continuation ran");
        assert.equal(unitOf(op, "markers").status, "BLOCKED", `markers: ${JSON.stringify(unitOf(op, "markers").result)}`);
        assert.match(unitOf(op, "markers").blocked!.reason, /UNVERIFIED/);
        assert.equal(unitOf(op, "review").status, "WAITING_ON_DEPENDENCY");
        assert.ok(gw.requests.every((b) => !lastUser(b).includes("Review the markers")), "the dependent never ran");
        assert.notEqual(op.status, "COMPLETE");
      } finally {
        rig.close();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("interactive /resume (sidecar): a session without the obligation field resumes UNVERIFIED; a recorded false stays false", async () => {
    await withHome(async (home) => {
      const gw = await gateway((b) => (lastUser(b).startsWith("Read a.txt") && toolResults(b) === 0 ? read("a.txt") : done("nothing left")));
      const repo = makeRepo({ "a.txt": "MARK-a\n" });
      const config = cfg(gw, repo);
      const turn = async (resume: string | undefined, text: string) => {
        const app = new ApplicationCore(config as any);
        quiet(app.getAgent());
        const events: any[] = [];
        const server = new SidecarServer({ app, mode: "auto", write: (line) => events.push(JSON.parse(line)), ...(resume ? { resume } : {}) });
        server.start();
        await muted(async () => {
          await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t", text }));
          await server.idle();
        });
        app.shutdown();
        return events.find((e) => e.type === "turn.result").turn.outcome;
      };
      const sessions = () => {
        const dir = path.join(home, ".nexus", "sessions");
        return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
      };
      try {
        assert.equal(await turn(undefined, "Read a.txt."), "NOT_REQUIRED");
        assert.ok(sessions().every((f) => JSON.parse(fs.readFileSync(f, "utf-8")).unverifiedChangesPending === false), "precondition: recorded false");
        assert.equal(await turn("latest", "Anything left?"), "NOT_REQUIRED", "a recorded false stays false");
        for (const f of sessions()) edit(f, ({ unverifiedChangesPending: _p, ...s }) => s);
        assert.equal(await turn("latest", "Anything left?"), "UNVERIFIED", "an absent obligation is pending");
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------- V1: missing or inconsistent durable history

describe("V1: a unit whose durable history is missing or inconsistent is blocked, never completed", () => {
  /** Reads markers; a blind model (no authorized task in context) claims there is nothing to do. */
  const reader = (b: any): Reply => {
    if (!allText(b).includes("OBJ-READ-ABC")) return done("nothing to do");
    if (resumed(b)) return done("continued");
    if (lastUser(b).includes("record was lost")) return toolResults(b) === 0 ? read("a.txt") : done("markers read");
    return [read("a.txt"), read("b.txt"), done("markers read")][Math.min(toolResults(b), 2)];
  };
  /** The same unit, but its first attempt writes before reading. */
  const writer = (b: any): Reply =>
    !allText(b).includes("OBJ-READ-ABC") || resumed(b) || lastUser(b).includes("record was lost") ? reader(b) : toolResults(b) === 0 ? write("draft.txt") : read("a.txt");
  const UNIT: WorkUnitSpec = { id: "markers", title: "Markers", prompt: "OBJ-READ-ABC: read a.txt and b.txt, then report their markers." };
  const files = { "a.txt": "MARK-a\n", "b.txt": "MARK-b\n" };

  const corruptions: Array<{ name: string; corrupt: (file: string) => void; problem: RegExp; restartedOutcome: "COMPLETE" | "BLOCKED"; firstTurnWrites?: boolean }> = [
    { name: "missing conversation (empty history)", corrupt: (f) => edit(f, (s) => ({ ...s, messages: [] })), problem: /no conversation was recorded/, restartedOutcome: "COMPLETE" },
    { name: "inconsistent conversation (a replacement objective)", corrupt: (f) => edit(f, (s) => ({ ...s, messages: [s.messages[0], { role: "user", content: "Merge the segment files into one." }] })), problem: /does not contain the unit's authorized task/, restartedOutcome: "COMPLETE" },
    { name: "partial history after a write (the obligation record survives)", corrupt: (f) => edit(f, (s) => ({ ...s, messages: [] })), problem: /no conversation was recorded/, restartedOutcome: "BLOCKED", firstTurnWrites: true },
    { name: "missing durable state (task file deleted)", corrupt: (f) => fs.rmSync(f), problem: /could not be loaded/, restartedOutcome: "BLOCKED" },
    {
      name: "a task file written before obligations were recorded, with no conversation",
      corrupt: (f) => edit(f, ({ unverifiedChangesPending: _p, lastTurn: _t, ...s }) => ({ ...s, messages: [] })),
      problem: /no conversation was recorded/,
      restartedOutcome: "BLOCKED",
    },
    {
      name: "a conversation truncated to its system prompt, with no obligation record",
      corrupt: (f) => edit(f, ({ unverifiedChangesPending: _p, lastTurn: _t, ...s }) => ({ ...s, messages: [s.messages[0]] })),
      problem: /does not contain the unit's authorized task/,
      restartedOutcome: "BLOCKED",
    },
  ];

  for (const c of corruptions) {
    test(`${c.name}: resume blocks without inference, and only an explicit restart runs the authorized task again`, async () => {
      await withHome(async () => {
        const gw = await gateway(c.firstTurnWrites ? writer : reader);
        const repo = makeRepo(files);
        const rig = operationRig(cfg(gw, repo, { maxSteps: 2 }), gw);
        try {
          let op = await rig.start([UNIT]);
          assert.match(unitOf(op, "markers").blocked!.reason, /step limit/, "the first attempt stops at the step limit");
          if (c.firstTurnWrites) assert.ok(fs.existsSync(path.join(repo, "draft.txt")), "the first attempt changed the workspace");
          c.corrupt(rig.taskFile(op, "markers"));
          const before = gw.requests.length;
          const more = decisionOf(op, "markers").options.find((o) => o.label === "continue with more steps")!;
          op = await rig.decide(decisionOf(op, "markers").id, more.id);
          assert.equal(unitOf(op, "markers").status, "BLOCKED");
          assert.match(unitOf(op, "markers").blocked!.reason, c.problem);
          assert.equal(gw.requests.length, before, "no inference ran on the unusable history");
          const restart = decisionOf(op, "markers").options.find((o) => o.label === "restart the unit from its authorized task");
          assert.ok(restart, `offered: ${decisionOf(op, "markers").options.map((o) => o.label).join(", ")}`);
          op = await rig.decide(decisionOf(op, "markers").id, restart.id);
          const restartRequest = gw.requests[before];
          assert.ok(lastUser(restartRequest).startsWith("[Work unit 'markers'"), "the restart sends the unit's authorized task");
          assert.ok(lastUser(restartRequest).includes("record was lost"), "the model is told the earlier record was lost");
          assert.equal(restartRequest.messages[0].role, "system");
          assert.equal(unitOf(op, "markers").status, c.restartedOutcome, `after restart: ${unitOf(op, "markers").blocked?.reason ?? "complete"}`);
          if (c.restartedOutcome === "BLOCKED") assert.match(unitOf(op, "markers").blocked!.reason, /UNVERIFIED/);
        } finally {
          rig.close();
          await gw.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });
    });
  }

  test("a compacted conversation that kept only an earlier resume prompt still resumes (it restates the authorized task)", async () => {
    await withHome(async () => {
      const gw = await gateway(reader);
      const repo = makeRepo(files);
      const rig = operationRig(cfg(gw, repo, { maxSteps: 2 }), gw);
      try {
        let op = await rig.start([UNIT]);
        edit(rig.taskFile(op, "markers"), (s) => ({
          ...s,
          messages: [
            s.messages[0],
            { role: "system", content: "[Summary of earlier work: a.txt and b.txt were read.]" },
            { role: "user", content: `[Work unit resumed on primary (m) after: an operator decision]\nThe unit's authorized task, which remains its only objective:\n${UNIT.prompt}\nYour earlier progress on this unit is above.` },
          ],
        }));
        const more = decisionOf(op, "markers").options.find((o) => o.label === "continue with more steps")!;
        op = await rig.decide(decisionOf(op, "markers").id, more.id);
        assert.equal(unitOf(op, "markers").status, "COMPLETE", `${unitOf(op, "markers").blocked?.reason}`);
      } finally {
        rig.close();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("a conversation where nothing happened yet (only the system prompt) starts the unit, without a restart decision", async () => {
    await withHome(async () => {
      const gw = await gateway(reader);
      const repo = makeRepo(files);
      const rig = operationRig(cfg(gw, repo, { maxSteps: 2 }), gw);
      try {
        let op = await rig.start([UNIT]);
        edit(rig.taskFile(op, "markers"), (s) => ({ ...s, messages: [s.messages[0]] }));
        const before = gw.requests.length;
        const more = decisionOf(op, "markers").options.find((o) => o.label === "continue with more steps")!;
        op = await rig.decide(decisionOf(op, "markers").id, more.id);
        const first = gw.requests[before];
        assert.ok(first, `no request: ${unitOf(op, "markers").blocked?.reason}`);
        assert.ok(lastUser(first).startsWith("[Work unit 'markers'") && !lastUser(first).includes("record was lost"));
        assert.doesNotMatch(unitOf(op, "markers").blocked?.reason ?? "", /unusable/);
      } finally {
        rig.close();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("an operator revision continues the unit's recorded conversation (the history predates the revision)", async () => {
    await withHome(async () => {
      const gw = await gateway(reader);
      const repo = makeRepo(files);
      const rig = operationRig(cfg(gw, repo, { maxSteps: 2 }), gw);
      try {
        let op = await rig.start([UNIT]);
        const revise = decisionOf(op, "markers").options.find((o) => o.label.startsWith("revise the unit"))!;
        assert.ok(revise, `offered: ${decisionOf(op, "markers").options.map((o) => o.label).join(", ")}`);
        const before = gw.requests.length;
        op = await rig.decide(decisionOf(op, "markers").id, revise.id, "REVISED-NOTE: report the markers in upper case");
        const first = gw.requests[before];
        assert.ok(first, `no request: ${unitOf(op, "markers").blocked?.reason}`);
        assert.ok(resumed(first) && lastUser(first).includes("REVISED-NOTE"), "the revised task is restated on resume");
        assert.equal(toolResults(first), 2, "the earlier progress was kept");
        assert.equal(unitOf(op, "markers").status, "COMPLETE", `${unitOf(op, "markers").blocked?.reason}`);
      } finally {
        rig.close();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("a resumed unit is told its authorized task again and continues from its recorded conversation", async () => {
    await withHome(async () => {
      const gw = await gateway((b) => (!allText(b).includes("OBJ-READ-ABC") ? done("nothing to do") : resumed(b) ? (toolResults(b) < 3 ? read("b.txt") : done("MARK-a MARK-b")) : read("a.txt")));
      const repo = makeRepo(files);
      const rig = operationRig(cfg(gw, repo, { maxSteps: 2 }), gw);
      try {
        let op = await rig.start([UNIT]);
        const before = gw.requests.length;
        const more = decisionOf(op, "markers").options.find((o) => o.label === "continue with more steps")!;
        op = await rig.decide(decisionOf(op, "markers").id, more.id);
        const first = gw.requests[before];
        assert.equal(first.messages[0].role, "system");
        assert.ok(first.messages.some((m: any) => m.role === "user" && String(m.content).startsWith("[Work unit 'markers'")), "the original task is in the recovered history");
        assert.equal(toolResults(first), 2, "earlier tool results are recovered");
        assert.ok(lastUser(first).includes(UNIT.prompt), "the resume prompt restates the authorized task");
        assert.equal(unitOf(op, "markers").status, "COMPLETE");
      } finally {
        rig.close();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

function edit(file: string, fn: (state: any) => any): void {
  fs.writeFileSync(file, JSON.stringify(fn(JSON.parse(fs.readFileSync(file, "utf-8"))), null, 2));
}

// ---------------------------------------------------------------- V1: real process death

/** The real CLI in a child process with its own process group (killed as a whole, like a crash). */
function cliProcess(args: string[], o: { cwd: string; home: string }) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: o.home };
  for (const k of ENV_KEYS) if (k !== "HOME") delete env[k];
  const child = spawn(process.execPath, ["--import", tsxLoader, srcIndex, ...args], { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return {
    kill: () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} },
    done: async () => ({ code: await exited, out, err }),
  };
}

async function cli(args: string[], o: { cwd: string; home: string }): Promise<{ code: number | null; out: string; err: string }> {
  const p = cliProcess(args, o);
  const killer = setTimeout(() => p.kill(), 90_000);
  try {
    return await p.done();
  } finally {
    clearTimeout(killer);
  }
}

async function until(cond: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function writeSpec(dir: string, id: string, gw: Gw, prompt: string): string {
  const spec = path.join(dir, `${id}.json`);
  fs.writeFileSync(spec, JSON.stringify({
    id,
    objective: "report the markers",
    resources: [{ id: "probe", endpoint: gw.url, model: "m", capabilities: ["tools"], rank: 0 }],
    units: [{ id: "markers", title: "Markers", prompt, requires: { capabilities: ["tools"] } }],
  }));
  return spec;
}

/** The operation state `-j` prints last on stdout (tool and model output may precede it). */
const opState = (out: string): DurableOperationState => JSON.parse(out.slice(out.startsWith("{\n") ? 0 : out.lastIndexOf("\n{\n") + 1));

describe("V1: process death mid-turn, then restart and resume", () => {
  for (const ids of ["low-entropy", "high-entropy"] as const) {
    test(`killed between tools (${ids} tool-call ids): the resumed unit holds its task and earlier results, and finishes it`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cont-kill-"));
      let phase: "first" | "resume" = "first";
      const gw = await gateway((b) => {
        if (!allText(b).includes("OBJ-READ-ABC")) return done("nothing to do");
        const n = toolResults(b);
        if (phase === "first" && n === 2) return { hold: true };
        return [read("a.txt"), read("b.txt"), read("c.txt"), done("MARK-a MARK-b MARK-c")][n] ?? { text: "done" };
      }, ids);
      const ws = path.join(home, "ws");
      fs.mkdirSync(ws);
      for (const f of ["a", "b", "c"]) fs.writeFileSync(path.join(ws, `${f}.txt`), `MARK-${f}\n`);
      let run: ReturnType<typeof cliProcess> | undefined;
      try {
        const spec = writeSpec(home, "cont-kill", gw, "OBJ-READ-ABC: read a.txt, b.txt and c.txt, then report their markers.");
        run = cliProcess(["operation", "run", spec, "-w", ws, "-s", "8"], { cwd: ws, home });
        await until(() => gw.held);
        run.kill();
        await run.done();
        phase = "resume";
        const before = gw.requests.length;
        const resumedRun = await cli(["operation", "resume", "cont-kill", "-w", ws, "-s", "8", "-j"], { cwd: ws, home });
        const first = gw.requests[before];
        assert.ok(first, `the resumed run sent no request: ${resumedRun.out.slice(-400)}`);
        assert.equal(first.messages[0].role, "system", "the system prompt was recovered");
        assert.ok(first.messages.some((m: any) => m.role === "user" && String(m.content).startsWith("[Work unit 'markers'")), "the unit's task was recovered");
        assert.match(allText(first), /MARK-a[\s\S]*MARK-b/, "earlier tool results were recovered");
        assert.ok(gw.requests.slice(before).every((b) => allText(b).includes("OBJ-READ-ABC")), "no request ran without the authorized task");
        const op = opState(resumedRun.out);
        assert.equal(op.status, "COMPLETE");
        assert.ok(gw.requests.slice(before).some((b) => allText(b).includes("MARK-c")), "the remaining read ran after the restart");
      } finally {
        run?.kill();
        await gw.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("killed while a writing tool ran: resume blocks, and continuing after inspection cannot complete the unit unverified", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cont-kill-"));
    const gw = await gateway((b) => {
      if (!allText(b).includes("OBJ-WRITE")) return done("nothing to do");
      if (lastUser(b).includes("Nexus stopped while")) return done("checked; nothing else to do");
      return toolResults(b) === 0 ? { tools: [{ name: "run_command", args: { command: "sleep 30" } }] } : done("ran it");
    });
    const ws = path.join(home, "ws");
    fs.mkdirSync(ws);
    const tasks = path.join(home, ".nexus", "tasks");
    const inFlight = () => fs.existsSync(tasks) && fs.readdirSync(tasks).some((f) => f.endsWith(".json") && fs.readFileSync(path.join(tasks, f), "utf-8").includes('"status": "in_flight"'));
    let run: ReturnType<typeof cliProcess> | undefined;
    try {
      const spec = writeSpec(home, "cont-inflight", gw, "OBJ-WRITE: run the long command.");
      run = cliProcess(["operation", "run", spec, "-w", ws, "-s", "6"], { cwd: ws, home });
      await until(inFlight);
      run.kill();
      await run.done();
      let op = opState((await cli(["operation", "resume", "cont-inflight", "-w", ws, "-s", "6", "-j"], { cwd: ws, home })).out);
      assert.equal(op.status, "BLOCKED");
      assert.match(unitOf(op, "markers").blocked!.reason, /run_command was in flight/);
      const decision = decisionOf(op, "markers");
      const resumedRun = await cli(["operation", "decide", "cont-inflight", decision.id, decision.options[0].id, "-w", ws, "-s", "6", "-j"], { cwd: ws, home });
      op = opState(resumedRun.out);
      assert.ok(gw.requests.some((b) => lastUser(b).includes("Nexus stopped while run_command")), "the model is told the tool may have partially run");
      assert.equal(unitOf(op, "markers").status, "BLOCKED", `after continuing: ${unitOf(op, "markers").status}`);
      assert.match(unitOf(op, "markers").blocked!.reason, /UNVERIFIED/);
    } finally {
      run?.kill();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("V2: process death while a subagent ran", () => {
  test("a subagent that wrote before the kill leaves the unit unverified after continuing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cont-kill-"));
    const isChild = (b: any) => allText(b).includes("[Subagent Objective]");
    const gw = await gateway((b) => {
      if (isChild(b)) return toolResults(b) === 0 ? write("child.txt") : { hold: true };
      if (!allText(b).includes("OBJ-DELEGATE")) return done("nothing to do");
      if (lastUser(b).includes("Nexus stopped while")) return done("checked; nothing else to do");
      return toolResults(b) === 0 ? { tools: [{ name: "spawn_subagent", args: { prompt: "Write child.txt.", max_steps: 4 } }] } : done("delegated");
    });
    const ws = path.join(home, "ws");
    fs.mkdirSync(ws);
    let run: ReturnType<typeof cliProcess> | undefined;
    try {
      const spec = writeSpec(home, "cont-subagent", gw, "OBJ-DELEGATE: have a subagent write child.txt.");
      run = cliProcess(["operation", "run", spec, "-w", ws, "-s", "6"], { cwd: ws, home });
      await until(() => gw.held && fs.existsSync(path.join(ws, "child.txt")));
      run.kill();
      await run.done();
      let op = opState((await cli(["operation", "resume", "cont-subagent", "-w", ws, "-s", "6", "-j"], { cwd: ws, home })).out);
      assert.equal(op.status, "BLOCKED");
      assert.match(unitOf(op, "markers").blocked!.reason, /spawn_subagent/);
      const decision = decisionOf(op, "markers");
      op = opState((await cli(["operation", "decide", "cont-subagent", decision.id, decision.options[0].id, "-w", ws, "-s", "6", "-j"], { cwd: ws, home })).out);
      assert.ok(gw.requests.some((b) => lastUser(b).includes("Nexus stopped while spawn_subagent")), "the continuation ran");
      assert.equal(unitOf(op, "markers").status, "BLOCKED", `after continuing: ${unitOf(op, "markers").status}`);
      assert.match(unitOf(op, "markers").blocked!.reason, /UNVERIFIED/);
    } finally {
      run?.kill();
      await gw.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- operation records and redaction (F1)

describe("durable operation records match their start whatever the provider's call id looks like", () => {
  test("a high-entropy invocation id is redacted on disk, yet the operation is recorded as completed; recorded progress clears it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cont-op-"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cont-ws-"));
    try {
      const identity = WorkspacePath.fromSelectedWorkspace(ws);
      const manager = new DurableStateManager({ baseDir: dir, workspacePaths: [identity] });
      const now = new Date().toISOString();
      manager.saveTaskState({ schemaVersion: 1, taskId: "t1", sessionId: "t1", id: "t1", title: "t", workspacePath: identity.value, workspace: identity.value, createdAt: now, updatedAt: now, status: "in_progress", activePlan: [], milestones: [], validationReceipts: [], messages: [] });
      const id = highEntropyId();
      manager.recordOperationStart("t1", { invocationId: id, seq: 7, toolName: "read_file" });
      assert.notEqual(manager.loadTaskState("t1").currentOperation!.invocationId, id, "precondition: persistence redacts this id");
      manager.recordOperationEnd("t1", id, { success: true }, 7);
      assert.equal(manager.loadTaskState("t1").currentOperation!.status, "completed");
      // Finished, but its result never reached the durable conversation: recovery treats it as interrupted.
      const recovered = manager.recoverTaskState("t1", { revalidateCandidate: false });
      assert.equal(recovered.interrupted, true);
      assert.match(recovered.interruptedOperation!.error!, /result was not recorded/);
      manager.recordOperationStart("t1", { invocationId: id, seq: 8, toolName: "read_file" });
      manager.recordOperationEnd("t1", id, { success: true }, 8);
      manager.recordProgress("t1", { messages: [{ role: "system", content: "s" }] });
      assert.equal(manager.loadTaskState("t1").currentOperation, null);
      assert.equal(manager.recoverTaskState("t1", { revalidateCandidate: false }).interrupted, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
