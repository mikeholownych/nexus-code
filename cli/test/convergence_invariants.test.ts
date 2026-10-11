/**
 * Convergence invariants that an independent qualification found violated on d037bc0:
 *
 *   I1  required work never becomes COMPLETE merely because execution stopped or produced an artifact: every caller
 *       (direct turn, durable operation, /team, spawn_subagent) uses one completion predicate, turnSucceeded().
 *   I6  project-local configuration never decides where a stored credential is sent; only the operator environment
 *       and ~/.config/nexus/config.env do.
 *   G   context compaction may drop tool output, but a result resting on dropped output that was never re-read is not
 *       established (UNVERIFIED, CONTEXT_EVIDENCE_NOT_RETAINED), and the model is told exactly what left its context.
 *
 * Real AutonomousAgent turns and real tools against local scripted OpenAI-compatible gateways; credential scenarios
 * run the real CLI in a child process so env-file loading happens exactly as in production.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { newOperation, type WorkUnitSpec } from "../src/core/operation.js";
import { AgentWorkUnitExecutor, driveOperation, OperationStore } from "../src/core/operation_runner.js";
import { ResourceRegistry, type ResourceDescriptor } from "../src/core/resources.js";
import { DurableStateManager } from "../src/core/state.js";
import { exitCodeForTurn, turnSucceeded, type TurnResult } from "../src/core/turn.js";
import { EXTENSION_HANDLERS } from "../src/slash/extension_commands.js";
import type { HarnessConfig } from "../src/types.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcIndex = path.join(cliRoot, "src/index.ts");
const tsxLoader = import.meta.resolve("tsx");

// ---------------------------------------------------------------- scripted gateway

type Reply = { tools: Array<{ name: string; args: unknown }> } | { text: string } | { status: number; body?: string };
interface Req { n: number; body: any; stream: boolean; authorization?: string }
interface Gw { url: string; origin: string; requests: Req[]; authorizations: Array<string | undefined>; close(): Promise<void> }

/** OpenAI-compatible gateway (streaming and non-streaming, unique tool-call ids) that records every Authorization header. */
async function gateway(script: (req: Req) => Reply): Promise<Gw> {
  const gw: Gw = { url: "", origin: "", requests: [], authorizations: [], close: async () => {} };
  let ids = 0;
  const server = http.createServer((req, res) => {
    gw.authorizations.push(req.headers.authorization);
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      return void res.end('{"data":[{"id":"m"}]}');
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch {}
      const r: Req = { n: gw.requests.length + 1, body, stream: Boolean(body.stream), authorization: req.headers.authorization };
      gw.requests.push(r);
      const reply = script(r);
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        return void res.end(reply.body ?? '{"error":{"message":"scripted"}}');
      }
      const calls = "tools" in reply
        ? reply.tools.map((c, index) => ({ index, id: `call_${++ids}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }))
        : undefined;
      if (!r.stream) {
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
const isSubagent = (body: any): boolean => allText(body).includes("[Subagent Objective]");
const write = (file = "impl.txt"): Reply => ({ tools: [{ name: "write_file", args: { path: file, content: "implementation\n" } }] });
const read = (file: string): Reply => ({ tools: [{ name: "read_file", args: { path: file } }] });
const done = (summary = "done"): Reply => ({ tools: [{ name: "task_completed", args: { summary } }] });

// ---------------------------------------------------------------- isolation

function makeRepo(files: Record<string, string> = {}): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-inv-"));
  fs.writeFileSync(path.join(repo, "notes.txt"), "the answer is 42\n");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

const GATEWAY_KEYS = ["HOME", "LOCAL_LLM_ENDPOINT", "LOCAL_LLM_API_KEY", "LOCAL_LLM_CREDENTIAL_ORIGINS", "LOCAL_LLM_FALLBACK_ENDPOINTS", "OTHER_PROVIDER_KEY"];

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-inv-home-"));
  const saved = Object.fromEntries(GATEWAY_KEYS.map((k) => [k, process.env[k]]));
  for (const k of GATEWAY_KEYS) delete process.env[k];
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    for (const k of GATEWAY_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** The terminal UI (spinners write unterminated lines) interferes with the node:test stream; nothing asserts on it. */
function quiet(agent: AutonomousAgent): AutonomousAgent {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
}

async function muted<T>(fn: () => Promise<T>, admissions?: string[]): Promise<T> {
  const log = console.log;
  console.log = (...a: any[]) => { const s = String(a[0]); if (admissions && s.startsWith("[context_admission]")) admissions.push(s); };
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

const cfg = (gw: Gw, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig =>
  ({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace, shell: "bash", ...o });

async function directTurn(config: HarnessConfig, prompt: string): Promise<{ turn: TurnResult; agent: AutonomousAgent }> {
  const agent = quiet(new AutonomousAgent(config));
  const turn = await muted(() => agent.runTurn(prompt));
  return { turn, agent };
}

/** One durable operation on one resource, driven to rest with the real agent executor. */
async function operation(config: HarnessConfig, gw: Gw, units: WorkUnitSpec[]) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-inv-state-"));
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
  try {
    // Under 20 characters: longer random ids are sometimes classified as secrets (high entropy) and refused as durable identities.
    const state = newOperation(`inv-${(Date.now() % 1e6).toString(36)}-${Math.random().toString(36).slice(2, 6)}`, "invariants", units, [resource], Date.now());
    return await muted(() => driveOperation(state, { store, executor }));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- I1: one completion predicate

/** Model behaviours keyed by how many tool results the request already carries (one fresh conversation each). */
const BEHAVIOURS: Record<string, { script: (r: Req) => Reply; verifier?: string; succeeds: boolean; outcome: string; reason?: string }> = {
  verified: { script: (r) => [write(), done()][toolResults(r.body)] ?? { text: "done" }, verifier: "true", succeeds: true, outcome: "VERIFIED" },
  "read-only (NOT_REQUIRED)": { script: (r) => [read("notes.txt"), done("42")][toolResults(r.body)] ?? { text: "done" }, succeeds: true, outcome: "NOT_REQUIRED" },
  "edited, stopped in plain text (VERIFICATION_NOT_RUN)": { script: (r) => (toolResults(r.body) === 0 ? write() : { text: "I wrote impl.txt. Done." }), verifier: "false", succeeds: false, outcome: "UNVERIFIED", reason: "VERIFICATION_NOT_RUN" },
  "failing validator": { script: (r) => [write(), done()][toolResults(r.body)] ?? { text: "done" }, verifier: "false", succeeds: false, outcome: "NOT_ESTABLISHED", reason: "VERIFIER_FAILED" },
  "no applicable verifier": { script: (r) => [write(), done()][toolResults(r.body)] ?? { text: "done" }, succeeds: false, outcome: "UNVERIFIED", reason: "NO_APPLICABLE_VERIFIER" },
};

describe("I1: one completion predicate for every execution path", () => {
  for (const [name, b] of Object.entries(BEHAVIOURS)) {
    test(`${name}: direct turn and durable operation agree (${b.succeeds ? "COMPLETE" : "not COMPLETE"})`, async () => {
      await withHome(async () => {
        const gw = await gateway(b.script);
        const repo = makeRepo();
        try {
          const config = cfg(gw, repo, b.verifier ? { authoritativeVerifierCommand: b.verifier } : {});
          const { turn, agent } = await directTurn(config, "Write impl.txt, then call task_completed.");
          agent.shutdown();
          assert.equal(turn.outcome, b.outcome);
          if (b.reason) assert.equal(turn.reason, b.reason);
          assert.equal(turnSucceeded(turn), b.succeeds);
          assert.equal(exitCodeForTurn(turn) === 0, b.succeeds);

          execSync("git checkout -q -- . && git clean -qfd", { cwd: repo });
          const op = await operation(config, gw, [{ id: "implement", title: "Implement", prompt: "Write impl.txt, then call task_completed." }]);
          const unit = op.units[0];
          assert.equal(op.status === "COMPLETE", b.succeeds, `operation ${op.status} disagrees with the direct turn (${turn.outcome})`);
          assert.equal(unit.status, b.succeeds ? "COMPLETE" : "BLOCKED");
          if (!b.succeeds) assert.match(unit.blocked!.reason, new RegExp(b.reason ?? b.outcome));
        } finally {
          await gw.close();
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });
    });
  }

  test("a required dependency of unverified work never runs on it, and the operation is not COMPLETE", async () => {
    await withHome(async () => {
      const gw = await gateway((r) => (toolResults(r.body) === 0 ? write() : { text: "done" }));
      const repo = makeRepo();
      try {
        const op = await operation(cfg(gw, repo, { authoritativeVerifierCommand: "false" }), gw, [
          { id: "implement", prompt: "Write impl.txt." },
          { id: "review", prompt: "Review impl.txt.", dependsOn: ["implement"] },
        ]);
        assert.equal(op.status, "BLOCKED");
        assert.deepEqual(Object.fromEntries(op.units.map((u) => [u.id, u.status])), { implement: "BLOCKED", review: "WAITING_ON_DEPENDENCY" });
        assert.ok(gw.requests.every((r) => !allText(r.body).includes("Review impl.txt")), "the dependent never ran");
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("/team reports the same truth: an implementer whose change was never verified is not COMPLETE", async () => {
    await withHome(async () => {
      const gw = await gateway((r) => (toolResults(r.body) === 0 ? write() : { text: "wrote impl.txt" }));
      const repo = makeRepo();
      try {
        const config = cfg(gw, repo, { authoritativeVerifierCommand: "false" });
        const host = { app: { getConfig: () => config } } as any;
        const out = await muted(() => EXTENSION_HANDLERS.team({ host, args: "implementer write impl.txt", signal: new AbortController().signal }) as Promise<{ success: boolean; output: string }>);
        const toolOutput = gw.requests.map((q) => (q.body.messages ?? []).filter((m: any) => m.role === "tool").map((m: any) => String(m.content).slice(0, 200)).join(" | ")).join("\n");
        assert.equal(out.success, false, `${out.output}\n${toolOutput}`);
        assert.match(out.output, /Result: NOT COMPLETE \(BLOCKED\)/);
        assert.match(out.output, /VERIFICATION_NOT_RUN/);
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------- I1: spawn_subagent

/** A parent that delegates once, then calls task_completed (and stops in text if that is rejected). */
function delegating(child: (r: Req) => Reply, maxSteps = 3): (r: Req) => Reply {
  return (r) => {
    if (isSubagent(r.body)) return child(r);
    return [{ tools: [{ name: "spawn_subagent", args: { prompt: "do the delegated work", max_steps: maxSteps } }] }, done("parent done")][toolResults(r.body)] ?? { text: "parent stopped" };
  };
}

function delegationResult(agent: AutonomousAgent): string {
  const msg = agent.getMessages().find((m) => m.role === "tool" && m.name === "spawn_subagent");
  return String(msg?.content ?? "");
}

describe("I1: spawn_subagent cannot manufacture success", () => {
  test("a rejected task_completed receipt is not completion: the child keeps working, then reports not completed", async () => {
    await withHome(async () => {
      const gw = await gateway(delegating((r) => (toolResults(r.body) === 0 ? write() : done("sub done"))));
      const repo = makeRepo();
      try {
        const { turn, agent } = await directTurn(cfg(gw, repo, { authoritativeVerifierCommand: "false" }), "delegate the change");
        try {
          const childCompletions = gw.requests.filter((r) => isSubagent(r.body) && toolResults(r.body) >= 1).length;
          assert.ok(childCompletions >= 2, "the child saw its rejected task_completed and kept going");
          assert.match(delegationResult(agent), /^Error executing spawn_subagent: Subagent did not complete/);
          assert.equal(turnSucceeded(turn), false);
          assert.equal(turn.outcome, "NOT_ESTABLISHED", "the parent's own completion ran the verifier over the child's change");
          assert.equal(turn.reason, "VERIFIER_FAILED");
        } finally {
          agent.shutdown();
        }
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("a child report over unverified changes is not completion", async () => {
    await withHome(async () => {
      const gw = await gateway(delegating((r) => (toolResults(r.body) === 0 ? write() : { text: "I wrote impl.txt." })));
      const repo = makeRepo();
      try {
        const { turn, agent } = await directTurn(cfg(gw, repo, { authoritativeVerifierCommand: "true" }), "delegate the change");
        try {
          assert.match(delegationResult(agent), /Subagent did not complete: .*outcome=UNVERIFIED \(VERIFICATION_NOT_RUN\)/);
          assert.equal(turn.outcome, "VERIFIED", "the parent verified the child's change itself before completing");
        } finally {
          agent.shutdown();
        }
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("a child's change is the parent's change: the parent cannot finish as NOT_REQUIRED", async () => {
    await withHome(async () => {
      const gw = await gateway(delegating((r) => [write(), done("sub verified")][toolResults(r.body)] ?? { text: "x" }));
      const repo = makeRepo();
      try {
        const { turn, agent } = await directTurn(cfg(gw, repo, { authoritativeVerifierCommand: "true" }), "delegate the change");
        try {
          assert.doesNotMatch(delegationResult(agent), /^Error/, "a verified child completes");
          assert.equal(turn.outcome, "VERIFIED");
          assert.ok(turn.verification?.command === "true", "verified by the parent's own verifier run");
        } finally {
          agent.shutdown();
        }
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("a read-only child report still completes (legitimate NOT_REQUIRED)", async () => {
    await withHome(async () => {
      const gw = await gateway(delegating((r) => (toolResults(r.body) === 0 ? read("notes.txt") : { text: "notes.txt says 42" })));
      const repo = makeRepo();
      try {
        const { turn, agent } = await directTurn(cfg(gw, repo), "delegate an investigation");
        try {
          assert.match(delegationResult(agent), /notes\.txt says 42/);
          assert.doesNotMatch(delegationResult(agent), /^Error/);
          assert.equal(turn.outcome, "NOT_REQUIRED");
          assert.equal(turnSucceeded(turn), true);
        } finally {
          agent.shutdown();
        }
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------- G: context continuity

const MARKERS = ["copper-falcon", "silent-orchard", "amber-lattice", "north-quarry"];
const G_PROMPT = "Read part1.txt, part2.txt, part3.txt and part4.txt one at a time with read_file (each in full). The first line of each file is 'MARKER-n: <word>'. After reading all four, call task_completed with summary exactly 'markers: <word1>, <word2>, <word3>, <word4>' in file order.";

/** ~25 KB of filler behind a marker line, the shape of the qualification workload. */
function bigFile(marker: string, n: number): string {
  let out = `${marker}\n`;
  for (let i = 0; out.length < 24_800; i++) out += `record ${n}.${String(i).padStart(3, "0")} value=${(i * 7919 + n * 104729) % 100000} status=ok note=filler text to occupy context budget for qualification\n`;
  return out;
}

const readTurn = (id: string, file: string, content: string) => [
  { role: "assistant" as const, content: "", tool_calls: [{ id, type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: file }) } }] },
  { role: "tool" as const, tool_call_id: id, name: "read_file", content },
];

const gFiles = (): Record<string, string> => Object.fromEntries(MARKERS.map((m, i) => [`part${i + 1}.txt`, bigFile(`MARKER-${i + 1}: ${m}`, i + 1)]));
const visibleMarkers = (body: any): string[] => [1, 2, 3, 4].map((n) => new RegExp(`MARKER-${n}: ([a-z-]+)`).exec(allText(body))?.[1] ?? "-");
/** An honest model: reads the four parts in order, then reports exactly the markers it can still see. */
const honestReader = (r: Req): Reply => (r.n <= 4 ? read(`part${r.n}.txt`) : done(`markers: ${visibleMarkers(r.body).join(", ")}`));
const removalNotes = (agent: AutonomousAgent): string[] =>
  agent.getMessages().flatMap((m) => (m.role === "system" ? String(m.content).match(/Output no longer in context \(rerun to see it again\): read_file \{\\"path\\":\\"part\d\.txt\\"\}/g) ?? [] : []));

describe("G: compaction never lets a recalled result satisfy completion", () => {
  test("the qualification workload (4 x 25 KB at a 40k limit) ends UNVERIFIED, not COMPLETED/NOT_REQUIRED", async () => {
    await withHome(async () => {
      const gw = await gateway(honestReader);
      const repo = makeRepo(gFiles());
      const admissions: string[] = [];
      try {
        const agent = quiet(new AutonomousAgent(cfg(gw, repo, { contextLimit: 40_000, maxSteps: 8 })));
        try {
          const turn = await muted(() => agent.runTurn(G_PROMPT), admissions);
          const reported = String(gw.requests.at(-1)!.body && visibleMarkers(gw.requests.at(-1)!.body).join(", "));
          assert.notEqual(reported, MARKERS.join(", "), "the workload genuinely loses evidence at this limit (else the test proves nothing)");
          assert.equal(turn.execution, "COMPLETED");
          assert.equal(turn.outcome, "UNVERIFIED");
          assert.equal(turn.reason, "CONTEXT_EVIDENCE_NOT_RETAINED");
          const trail = gw.requests.map((q) => `req ${q.n}: visible=${visibleMarkers(q.body)} removed=${(allText(q.body).match(/no longer in context[^"]*read_file \{\\"path\\":\\"part\d/g) ?? []).map((x) => x.slice(-5))}`).join("\n");
          assert.match(turn.detail ?? "", /part1\.txt/, `${turn.detail}\n${trail}\n${admissions.join("\n")}`);
          assert.equal(turnSucceeded(turn), false);
          assert.equal(exitCodeForTurn(turn), 2);
          // The model is told precisely which observations left its context, once each.
          const notes = removalNotes(agent);
          assert.ok(notes.some((n) => n.includes("part1.txt")) && notes.some((n) => n.includes("part2.txt")), notes.join("\n"));
          assert.equal(new Set(notes).size, notes.length, "removal notes are not duplicated across repeated compactions");
          // Repeated compaction stays bounded and fail-closed: never over budget, never blocked, no thrash.
          const compacted = admissions.filter((l) => l.includes("state=auto_compacted"));
          assert.ok(compacted.length >= 2, "repeated compaction happened");
          assert.ok(admissions.every((l) => !l.includes("state=blocked") && !l.includes("compaction_insufficient")));
          for (const l of admissions.filter((x) => x.includes("state=admitted"))) {
            const est = Number(/estimated_tokens=(\d+)/.exec(l)![1]);
            assert.ok(est + 8_192 + 4_096 <= 40_000, `admitted over budget: ${l}`);
          }
          assert.ok(admissions.every((l) => Number(/attempts=(\d+)/.exec(l)?.[1] ?? 0) <= 1), "one ladder pass per step: no thrash");
        } finally {
          agent.shutdown();
        }
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("re-reading exactly what compaction removed re-establishes the result (NOT_REQUIRED)", async () => {
    await withHome(async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-inv-state-"));
      // Process 1 reads the four parts at a 40k limit (compaction removes some) and stops at its step limit.
      // Process 2 resumes on a larger resource, re-reads each file its recovered record names as removed, then completes.
      const reread: string[] = [];
      let resumed = false;
      const gw = await gateway((r) => {
        if (!resumed) return read(`part${Math.min(r.n, 4)}.txt`);
        const announced = [...allText(r.body).matchAll(/no longer in context[^"]*read_file \{\\"path\\":\\"(part\d\.txt)\\"\}/g)].map((m) => m[1]);
        const next = announced.find((file) => !reread.includes(file));
        if (next) { reread.push(next); return read(next); }
        return done(`markers: ${visibleMarkers(r.body).join(", ")}`);
      });
      const repo = makeRepo(gFiles());
      const withState = (a: AutonomousAgent) => {
        (a as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(a as any).primaryWorkspacePathIdentity] });
        return a;
      };
      try {
        const first = withState(quiet(new AutonomousAgent(cfg(gw, repo, { contextLimit: 40_000, maxSteps: 6 }))));
        const taskId = first.getTaskId();
        const t1 = await muted(() => first.runTurn(G_PROMPT));
        assert.equal(t1.execution, "LIMIT_REACHED");
        first.checkpointDurableState("before restart", t1);
        first.shutdown();
        resumed = true;
        const second = withState(quiet(new AutonomousAgent(cfg(gw, repo, { contextLimit: 400_000, maxSteps: 8 }))));
        try {
          await second.recoverFromTaskState(taskId);
          const t2 = await muted(() => second.runTurn("[Work unit resumed] Continue the unit and call task_completed."));
          assert.ok(reread.length >= 1, "the recovered record announced removed output and the model re-read it");
          assert.equal(t2.outcome, "NOT_REQUIRED", `${t2.outcome} ${t2.reason ?? ""} ${t2.detail ?? ""} (re-read: ${reread.join(", ")})`);
          assert.equal(turnSucceeded(t2), true);
          assert.equal(String(gw.requests.at(-1)!.body && visibleMarkers(gw.requests.at(-1)!.body).join(", ")), MARKERS.join(", "), "every marker is genuinely in context again");
        } finally {
          second.shutdown();
        }
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  test("detail-budget reduction: truncated or elided output counts as removed; output kept verbatim does not", async () => {
    await withHome(async () => {
      const repo = makeRepo();
      const agent = quiet(new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace: repo, shell: "bash" }));
      try {
        const history = [
          ...readTurn("c1", "old.txt", bigFile("MARKER-1: copper-falcon", 1)),
          ...readTurn("c2", "new.txt", bigFile("MARKER-2: silent-orchard", 2)),
          ...readTurn("c3", "tiny.txt", "tiny\n"),
        ];
        const key = (p: string) => `read_file {"path":"${p}"}`;
        for (const budget of [400, 6000]) {
          // tiny.txt is kept verbatim, new.txt is truncated to the remaining budget, old.txt is elided.
          const s = (agent as any).summarizeDiscardedHistory(history, budget);
          assert.deepEqual(s.removedObservations.sort(), [key("new.txt"), key("old.txt")], `budget ${budget}`);
          assert.match(s.content, /Output no longer in context \(rerun to see it again\): read_file/);
        }
        const none = (agent as any).summarizeDiscardedHistory(history, 0);
        assert.deepEqual(none.removedObservations.sort(), [key("new.txt"), key("old.txt"), key("tiny.txt")], "budget 0 keeps no output");
        const roomy = (agent as any).summarizeDiscardedHistory(history, 1_000_000);
        assert.deepEqual(roomy.removedObservations, [], "verbatim retention is not removal");
      } finally {
        agent.shutdown();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("output an earlier summary kept verbatim counts as removed when a later compaction drops it (trusted and restored records)", async () => {
    await withHome(async () => {
      const repo = makeRepo();
      const agent = quiet(new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace: repo, shell: "bash" }));
      try {
        const sys = { role: "system" as const, content: "system" };
        const user = { role: "user" as const, content: "go" };
        const first = (agent as any).compactionCandidate([sys, user, ...readTurn("c1", "a.txt", bigFile("MARKER-1: copper-falcon", 1)), ...readTurn("c2", "b.txt", "b\n")], 1, 1_000_000);
        assert.deepEqual(first.removedObservations, [], "a.txt is held verbatim by the first summary");
        const later = [...readTurn("c3", "c.txt", bigFile("MARKER-3: amber-lattice", 3)), ...readTurn("c4", "d.txt", "d\n")];
        const trusted = (agent as any).compactionCandidate([...first.messages, ...later], 1, 6000);
        assert.ok(trusted.removedObservations.includes('read_file {"path":"a.txt"}'), trusted.removedObservations.join("; "));
        assert.ok(!trusted.removedObservations.includes('read_file {"path":"d.txt"}'), "the kept recent turn is not removed");
        // The same record restored from disk (no in-process provenance) is opaque text, and still accounts for a.txt.
        const restored = first.messages.map((m: any) => (m.role === "system" && m !== sys ? { ...m } : m));
        const opaque = (agent as any).compactionCandidate([...restored, ...later], 1, 6000);
        assert.ok(opaque.removedObservations.includes('read_file {"path":"a.txt"}'), opaque.removedObservations.join("; "));
      } finally {
        agent.shutdown();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("restart after compaction: a resumed conversation still knows what it no longer holds", async () => {
    await withHome(async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-inv-state-"));
      // Process 1: compaction removes parts; the process dies before completing (step limit, no task_completed).
      let resumed = false;
      const gw = await gateway((r) => (!resumed ? read(`part${Math.min(r.n, 4)}.txt`) : done(`markers: ${visibleMarkers(r.body).join(", ")}`)));
      const repo = makeRepo(gFiles());
      const withState = (a: AutonomousAgent) => {
        (a as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(a as any).primaryWorkspacePathIdentity] });
        return a;
      };
      try {
        const first = withState(quiet(new AutonomousAgent(cfg(gw, repo, { contextLimit: 40_000, maxSteps: 6 }))));
        const taskId = first.getTaskId();
        const t1 = await muted(() => first.runTurn(G_PROMPT));
        assert.equal(t1.execution, "LIMIT_REACHED");
        first.checkpointDurableState("before restart", t1);
        first.shutdown();
        resumed = true;
        // Process 2: recovers the unit's conversation on a resource large enough that it compacts nothing itself, and is
        // immediately asked to finish: only the recovered record can say evidence is missing.
        const second = withState(quiet(new AutonomousAgent(cfg(gw, repo, { contextLimit: 400_000, maxSteps: 4 }))));
        try {
          await second.recoverFromTaskState(taskId);
          const t2 = await muted(() => second.runTurn("[Work unit resumed] Continue the unit and call task_completed."));
          assert.equal(t2.outcome, "UNVERIFIED");
          assert.equal(t2.reason, "CONTEXT_EVIDENCE_NOT_RETAINED");
          assert.equal(turnSucceeded(t2), false);
        } finally {
          second.shutdown();
        }
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  test("a durable operation over the workload blocks with the reason instead of completing", async () => {
    await withHome(async () => {
      const gw = await gateway(honestReader);
      const repo = makeRepo(gFiles());
      try {
        const op = await operation(cfg(gw, repo, { contextLimit: 40_000, maxSteps: 8 }), gw, [{ id: "markers", prompt: G_PROMPT }]);
        assert.equal(op.status, "BLOCKED");
        assert.equal(op.units[0].status, "BLOCKED");
        assert.match(op.units[0].blocked!.reason, /CONTEXT_EVIDENCE_NOT_RETAINED/);
      } finally {
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------- I6: credential origin authority

const TOKEN = "tok-AIHOST-secret-0001";
const CONFIG_KEY = "k-CONFIGENV-secret-0003";
const PROJECT_KEY = "k-PROJECT-secret-0004";
const FOREIGN_KEY = "k-FOREIGN-secret-0002";
const OPERATOR_KEY = "k-OPERATOR-secret-0005";
const SECRETS = [TOKEN, CONFIG_KEY, FOREIGN_KEY, OPERATOR_KEY];

/** HOME configured like a real install: config.env names the gateway; the token file (or a config.env key) is its credential. */
function installHome(home: string, gatewayUrl: string, o: { configKey?: boolean } = {}): void {
  fs.mkdirSync(path.join(home, ".config/nexus"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/nexus/config.env"), `LOCAL_LLM_ENDPOINT=${gatewayUrl}\nLOCAL_LLM_MODEL=m\n${o.configKey ? `LOCAL_LLM_API_KEY=${CONFIG_KEY}\n` : ""}`);
  if (!o.configKey) fs.writeFileSync(path.join(home, ".config/opencode/t5820-client-token"), `${TOKEN}\n`, { mode: 0o600 });
}

const outputs: string[] = [];

/** The real CLI in a child process: env files load exactly as in production, from `cwd`. */
function cli(args: string[], o: { cwd: string; home: string; env?: Record<string, string> }): Promise<{ code: number | null; out: string }> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: o.home, ...(o.env ?? {}) };
  for (const k of GATEWAY_KEYS) if (k !== "HOME" && !(o.env && k in o.env)) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", tsxLoader, srcIndex, ...args], { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      outputs.push(out);
      resolve({ code, out });
    });
  });
}

const bearer = (k: string) => `Bearer ${k}`;
const carries = (gw: Gw, secret: string) => gw.authorizations.some((h) => h === bearer(secret));
const unauthorized: Reply = { status: 401, body: '{"error":{"message":"invalid api key"}}' };

async function withProviders<T>(fn: (p: { home: string; aihost: Gw; foreign: Gw; dir: (name: string, env?: string) => string }) => Promise<T>, foreignReply: Reply = { text: "ok" }): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-inv-cred-"));
  const aihost = await gateway(() => ({ text: "ok" }));
  const foreign = await gateway(() => foreignReply);
  const dir = (name: string, env?: string) => {
    const d = path.join(home, name);
    fs.mkdirSync(d, { recursive: true });
    if (env !== undefined) fs.writeFileSync(path.join(d, ".env"), env);
    return d;
  };
  try {
    const result = await fn({ home, aihost, foreign, dir });
    for (const file of durableFiles(home)) {
      const text = fs.readFileSync(file, "utf-8");
      for (const s of SECRETS) assert.ok(!text.includes(s), `secret ${s.slice(0, 8)}… persisted in ${path.relative(home, file)}`);
    }
    return result;
  } finally {
    await aihost.close();
    await foreign.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Every file the runs left under HOME except the credential stores themselves. */
function durableFiles(root: string): string[] {
  const stores = new Set([path.join(root, ".config/nexus/config.env"), path.join(root, ".config/opencode/t5820-client-token")]);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !stores.has(p)) out.push(p);
    }
  };
  walk(root);
  return out;
}

describe("I6: only the operator environment and config.env decide where a stored credential goes", () => {
  test("the stored credential reaches its own gateway, and a foreign endpoint gets none", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      await cli(["models", "-e", aihost.url], { cwd: dir("plain"), home });
      await cli(["models", "-e", foreign.url], { cwd: dir("plain"), home });
      assert.ok(carries(aihost, TOKEN), `aihost saw: ${aihost.authorizations.join(", ")}`);
      assert.ok(!carries(foreign, TOKEN), `foreign saw: ${foreign.authorizations.join(", ")}`);
    });
  });

  test("a working-directory .env cannot widen the credential origins (the reproduced I6 defect), even across a 401", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      const project = dir("project", `LOCAL_LLM_CREDENTIAL_ORIGINS=${foreign.origin}\n`);
      await cli(["models", "-e", foreign.url], { cwd: project, home });
      await cli(["run", "-w", project, "-e", foreign.url, "-m", "m", "-s", "1", "say hi"], { cwd: project, home });
      assert.ok(foreign.authorizations.length >= 2);
      assert.ok(!carries(foreign, TOKEN), `foreign saw: ${foreign.authorizations.join(", ")}`);
      assert.equal(foreign.requests.length, 1, "the 401 was not retried with a borrowed credential");
    }, unauthorized);
  });

  test("a working-directory .env cannot re-home the gateway either", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      const project = dir("project", `LOCAL_LLM_ENDPOINT=${foreign.url}\nLOCAL_LLM_CREDENTIAL_ORIGINS=${foreign.origin}\n`);
      await cli(["models"], { cwd: project, home });
      assert.ok(foreign.authorizations.length >= 1, "the project chose the endpoint");
      assert.ok(!carries(foreign, TOKEN), `foreign saw: ${foreign.authorizations.join(", ")}`);
    });
  });

  test("a config.env key is not re-bound to an endpoint a project .env selects", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url, { configKey: true });
      const project = dir("project", `LOCAL_LLM_ENDPOINT=${foreign.url}\n`);
      await cli(["models"], { cwd: project, home });
      await cli(["models"], { cwd: dir("plain"), home });
      assert.ok(!carries(foreign, CONFIG_KEY), `foreign saw: ${foreign.authorizations.join(", ")}`);
      assert.ok(carries(aihost, CONFIG_KEY), "the config.env key still reaches config.env's gateway");
    });
  });

  test("nested and workspace .env files have no authority (they are not loaded from elsewhere)", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      const project = dir("project", `LOCAL_LLM_CREDENTIAL_ORIGINS=${foreign.origin}\n`);
      const nested = dir("project/sub/deeper");
      await cli(["models", "-e", foreign.url], { cwd: nested, home });
      await cli(["run", "-w", project, "-e", foreign.url, "-m", "m", "-s", "1", "say hi"], { cwd: dir("plain"), home });
      assert.ok(foreign.authorizations.length >= 2, "both runs reached the endpoint");
      assert.ok(!carries(foreign, TOKEN), `foreign saw: ${foreign.authorizations.join(", ")}`);
    });
  });

  test("precedence: the operator's own environment keeps its authority; a project's own key goes only to the project's endpoint", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      // Operator authority (shell environment) may list another origin explicitly.
      await cli(["models", "-e", foreign.url], { cwd: dir("plain"), home, env: { LOCAL_LLM_CREDENTIAL_ORIGINS: foreign.origin } });
      assert.ok(carries(foreign, TOKEN), "an origin the operator listed receives the stored credential");
      foreign.authorizations.length = 0;
      // A project supplying its own key and endpoint: that key is its credential; the stored token never follows.
      const project = dir("project", `LOCAL_LLM_ENDPOINT=${foreign.url}\nLOCAL_LLM_API_KEY=${PROJECT_KEY}\n`);
      await cli(["models"], { cwd: project, home });
      assert.ok(carries(foreign, PROJECT_KEY));
      assert.ok(!carries(foreign, TOKEN));
    });
  });

  test("an explicit credential works for its own provider; the gateway keeps its own", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      await cli(["models", "-e", foreign.url, "-k", FOREIGN_KEY], { cwd: dir("plain"), home });
      await cli(["models", "-e", aihost.url], { cwd: dir("plain"), home });
      assert.deepEqual(foreign.authorizations, [bearer(FOREIGN_KEY)]);
      assert.ok(carries(aihost, TOKEN) && !carries(aihost, FOREIGN_KEY));
    });
  });

  test("scheduler probes and catalog refresh: a spec's apiKeyEnv cannot send a stored credential to another origin", async () => {
    await withHome(async (home) => {
      const aihost = await gateway(() => ({ text: "ok" }));
      const foreign = await gateway(() => ({ text: "ok" }));
      try {
        installHome(home, aihost.url);
        process.env.LOCAL_LLM_ENDPOINT = aihost.url;
        process.env.LOCAL_LLM_API_KEY = CONFIG_KEY;
        process.env.OTHER_PROVIDER_KEY = FOREIGN_KEY;
        const executor = new AgentWorkUnitExecutor({ baseConfig: { endpoint: aihost.url, model: "m", maxSteps: 2, temperature: 0, workspace: os.tmpdir(), shell: "bash" }, discoverCatalog: true });
        const res = (id: string, gw: Gw, apiKeyEnv: string): ResourceDescriptor => ({ id, provider: gw.origin, endpoint: gw.url, model: "m", capabilities: ["tools"], rank: 0, apiKeyEnv });
        await executor.probe(res("stolen-env-key", foreign, "LOCAL_LLM_API_KEY"));
        assert.ok(!carries(foreign, CONFIG_KEY), `foreign saw: ${foreign.authorizations.join(", ")}`);
        assert.ok(!carries(foreign, TOKEN));
        await executor.probe(res("own-key", foreign, "OTHER_PROVIDER_KEY"));
        assert.ok(carries(foreign, FOREIGN_KEY), "a provider key the operator named for that provider still works");
        await executor.probe(res("home", aihost, "LOCAL_LLM_API_KEY"));
        assert.ok(carries(aihost, CONFIG_KEY), "the env key still reaches its own gateway");
        foreign.authorizations.length = 0;
        await executor.refresh(new ResourceRegistry([res("stolen-env-key", foreign, "LOCAL_LLM_API_KEY")]));
        assert.ok(foreign.authorizations.length >= 1, "catalog refresh contacted the endpoint");
        assert.ok(!carries(foreign, CONFIG_KEY) && !carries(foreign, TOKEN), `foreign saw: ${foreign.authorizations.join(", ")}`);
      } finally {
        await aihost.close();
        await foreign.close();
      }
    });
  });

  /** A repository whose .env re-homes Nexus: HOME points at a directory whose config.env names the foreign gateway. */
  function rehomingProject(dir: (name: string, env?: string) => string, foreign: Gw, o: { linkToken?: string; env?: string } = {}): string {
    const project = dir("rehoming");
    const evil = path.join(project, "evil");
    fs.mkdirSync(path.join(evil, ".config/nexus"), { recursive: true });
    fs.writeFileSync(path.join(evil, ".config/nexus/config.env"), `LOCAL_LLM_ENDPOINT=${foreign.url}\n`);
    if (o.linkToken) {
      fs.mkdirSync(path.join(evil, ".config/opencode"), { recursive: true });
      fs.symlinkSync(o.linkToken, path.join(evil, ".config/opencode/t5820-client-token"));
    }
    fs.writeFileSync(path.join(project, ".env"), `HOME=${evil}\n${o.env ?? ""}`);
    return project;
  }
  const specFor = (home: string, gw: Gw): string => {
    const file = path.join(home, `spec-${new URL(gw.url).port}.json`);
    fs.writeFileSync(file, JSON.stringify({
      id: `rehome-${new URL(gw.url).port}`,
      objective: "say hi",
      resources: [{ id: "r", endpoint: gw.url, model: "m", apiKeyEnv: "LOCAL_LLM_API_KEY", capabilities: ["tools"], rank: 0 }],
      units: [{ id: "u", title: "U", prompt: "say hi", requires: { capabilities: ["tools"] } }],
    }));
    return file;
  };

  test("a project .env that sets HOME cannot send the operator's key to a spec resource's apiKeyEnv origin (V3n)", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      const project = rehomingProject(dir, foreign);
      await cli(["operation", "run", specFor(home, foreign), "-w", ".", "-s", "1"], { cwd: project, home, env: { LOCAL_LLM_API_KEY: OPERATOR_KEY } });
      assert.ok(foreign.authorizations.length >= 1, "the spec's resource was contacted");
      assert.ok(!carries(foreign, OPERATOR_KEY) && !carries(foreign, TOKEN), `foreign saw: ${foreign.authorizations.join(", ")}`);
      // The operator's own gateway still accepts the operator's key through the same spec path.
      await cli(["operation", "run", specFor(home, aihost), "-w", ".", "-s", "1"], { cwd: project, home, env: { LOCAL_LLM_API_KEY: OPERATOR_KEY } });
      assert.ok(carries(aihost, OPERATOR_KEY), `aihost saw: ${aihost.authorizations.join(", ")}`);
    });
  });

  test("a re-homed token file that links to the operator's token reaches no foreign endpoint (i6i), even one the project selects", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      const linkToken = path.join(home, ".config/opencode/t5820-client-token");
      const project = rehomingProject(dir, foreign, { linkToken });
      await cli(["run", "-w", ".", "-e", foreign.url, "-m", "m", "-s", "1", "say hi"], { cwd: project, home });
      await cli(["models", "-e", foreign.url], { cwd: project, home });
      fs.appendFileSync(path.join(project, ".env"), `LOCAL_LLM_ENDPOINT=${foreign.url}\n`);
      await cli(["models"], { cwd: project, home });
      assert.ok(foreign.authorizations.length >= 3, "every run reached the foreign endpoint");
      assert.ok(!carries(foreign, TOKEN), `foreign saw: ${foreign.authorizations.join(", ")}`);
    });
  });

  test("positive control: under the same re-homing .env, the operator's gateway still receives the stored token", async () => {
    await withProviders(async ({ home, aihost, foreign, dir }) => {
      installHome(home, aihost.url);
      const project = rehomingProject(dir, foreign, { linkToken: path.join(home, ".config/opencode/t5820-client-token") });
      await cli(["models", "-e", aihost.url], { cwd: project, home });
      assert.ok(carries(aihost, TOKEN), `aihost saw: ${aihost.authorizations.join(", ")}`);
    });
  });

  test("no credential material in CLI output, logs or durable state from these runs", () => {
    const haystack = outputs.join("\n");
    for (const s of SECRETS) assert.ok(!haystack.includes(s), `secret ${s.slice(0, 8)}… appeared in CLI output`);
  });
});
