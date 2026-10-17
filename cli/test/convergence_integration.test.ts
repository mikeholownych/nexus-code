/**
 * Convergence scheduling end to end: real AutonomousAgent turns against local OpenAI-compatible gateways.
 * A: reroute. B: park, continue independent work, resume the parked unit from its history. C: true wait before
 * task execution, then implement and validate after wake. D: process restart while waiting. Fake clocks throughout.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { newOperation, type DurableOperationState, type WorkUnitSpec } from "../src/core/operation.js";
import { AgentWorkUnitExecutor, OperationRunner, OperationStore } from "../src/core/operation_runner.js";
import { ResourceRegistry, type ResourceDescriptor } from "../src/core/resources.js";
import { DurableStateManager } from "../src/core/state.js";
import type { InferenceFailure } from "../src/core/turn.js";
import type { HarnessConfig } from "../src/types.js";
import { fakeClock, startGateway, type FakeClock, type Gateway, type Reply } from "./helpers/provider_fixture.js";

const complete = (summary: string): Reply => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary } }] });
const limited = (secs: number): Reply => ({ kind: "http", status: 429, headers: { "retry-after": String(secs) }, body: '{"error":{"message":"rate limited","type":"rate_limit_exceeded"}}' });
const userText = (body: any): string => (body.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => String(m.content)).join("\n");
const unitOf = (body: any): string | undefined => userText(body).match(/Work unit '(\w+)'/)?.[1];

interface Env {
  repo: string;
  stateDir: string;
  executor(config?: Partial<HarnessConfig>): AgentWorkUnitExecutor;
  store(): OperationStore;
}

async function withEnv<T>(gws: Gateway[], fn: (env: Env) => Promise<T>): Promise<T> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-conv-"));
  fs.writeFileSync(path.join(repo, "notes.txt"), "the answer is 42\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-conv-state-"));
  const base: HarnessConfig = { endpoint: gws[0].url, model: "unused", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" };
  const env: Env = {
    repo,
    stateDir,
    executor: (config: Partial<HarnessConfig> = {}) =>
      new AgentWorkUnitExecutor({
        baseConfig: { ...base, ...config },
        createAgent: (config) => {
          const agent = new AutonomousAgent(config, 1);
          const a = agent as any;
          a.recoveryClock = fakeClock();
          a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
          return agent;
        },
      }),
    store: () => new OperationStore(repo, stateDir),
  };
  try {
    return await fn(env);
  } finally {
    for (const g of gws) await g.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

const resource = (id: string, gw: Gateway, o: Partial<ResourceDescriptor> = {}): ResourceDescriptor => ({
  id, provider: new URL(gw.url).origin, endpoint: gw.url, model: id, capabilities: ["tools"], rank: 0, ...o,
});

function run(env: Env, state: DurableOperationState, clock: FakeClock = fakeClock()) {
  const store = env.store();
  return { runner: new OperationRunner(state, { executor: env.executor(), clock, persist: (s) => store.save(s) }), clock, store };
}

describe("convergence scheduling with real agent turns", () => {
  test("A. reroute: the preferred reviewer is rate-limited, an equivalent qualified reviewer completes the work", async () => {
    const gwA = await startGateway(() => limited(120));
    const gwB = await startGateway(() => complete("review done on b"));
    await withEnv([gwA, gwB], async (env) => {
      const state = newOperation("op-a", "review the change", [{ id: "review", title: "Review", prompt: "Review notes.txt", requires: { capabilities: ["review"] } }],
        [resource("rev-a", gwA, { capabilities: ["tools", "review"] }), resource("rev-b", gwB, { capabilities: ["tools", "review"], rank: 1 }), resource("cheap", gwB, { model: "cheap" })], 0);
      const { runner, clock } = run(env, state);
      const out = await runner.run();
      assert.equal(out.status, "COMPLETE");
      assert.equal(gwA.requests.length, 1, "one request to the rate-limited reviewer, then none");
      assert.equal(gwB.requests.length, 1);
      assert.equal(gwB.requests[0].body.model, "rev-b", "the qualified alternate, not the cheap model");
      assert.notEqual(gwA.requests[0].id, gwB.requests[0].id, "a fresh request id on the new resource");
      const u = out.units[0];
      assert.deepEqual(u.reroutes.map((r) => [r.from, r.to]), [["rev-a", "rev-b"]]);
      assert.match(u.reroutes[0].reason, /rate limited \(HTTP 429\)/);
      assert.equal(u.result!.summary, "review done on b");
      assert.equal(clock.sleeps.length, 0, "no waiting when a qualified alternate exists");
    });
  });

  test("B. park and continue: the deep review parks mid-unit, independent work completes, review resumes from its history", async () => {
    const gwDeep = await startGateway((n) => (n === 1 ? { kind: "tools", calls: [{ name: "read_file", args: { path: "notes.txt" } }] } : n === 2 ? limited(60) : complete("deep review: answer verified as 42")));
    const gwLead = await startGateway((n, body) => complete(`${userText(body).match(/Work unit '(\w+)'/)?.[1]} done`));
    await withEnv([gwDeep, gwLead], async (env) => {
      const units: WorkUnitSpec[] = [
        { id: "review", title: "Deep review", prompt: "Review notes.txt deeply", requires: { capabilities: ["reasoning"] } },
        { id: "docs", title: "Docs", prompt: "Summarise notes.txt" },
        { id: "tests", title: "Tests", prompt: "List test gaps" },
        { id: "final", title: "Final acceptance", prompt: "Confirm all results", dependsOn: ["review", "docs", "tests"] },
      ];
      const state = newOperation("op-b", "ship the change", units, [resource("deep", gwDeep, { capabilities: ["tools", "reasoning"], rank: 1 }), resource("lead", gwLead)], 0);
      const { runner, clock } = run(env, state);
      const out = await runner.run();
      assert.equal(out.status, "COMPLETE");
      const types = out.events.map((e) => e.type);
      const parkedEvent = out.events.find((e) => e.type === "WORK_PARKED")!;
      assert.match(parkedEvent.message, /Deep review parked: deep rate limited \(HTTP 429\); eligible again \d\d:\d\d UTC\. Continuing 2 independent tasks\./);
      assert.ok(types.indexOf("OPERATION_WAITING") > out.events.findIndex((e) => e.type === "WORK_COMPLETED" && e.unitId === "tests"));
      assert.equal(clock.sleeps.length, 1);
      assert.ok(clock.sleeps[0] >= 59_000 && clock.sleeps[0] <= 61_000, `wait ${clock.sleeps[0]}`);
      // Resumed from history: the read_file result from before parking is in the resumed request, not re-run.
      assert.equal(gwDeep.requests.length, 3);
      const resumed = gwDeep.requests[2].body.messages;
      assert.equal(resumed.filter((m: any) => m.role === "tool" && /the answer is 42/.test(String(m.content))).length, 1);
      assert.match(userText(gwDeep.requests[2].body), /Work unit resumed on deep/);
      const final = gwLead.requests.find((r) => /Work unit 'final'/.test(userText(r.body)))!;
      assert.match(userText(final.body), /Deep review: deep review: answer verified as 42/, "acceptance sees the parked unit's result");
      assert.equal(gwLead.requests.filter((r) => /Work unit 'review'/.test(userText(r.body))).length, 0, "the unqualified model never got the review");
    });
  });

  test("C. true wait: the operation waits before task execution, then implements and validates after wake", async () => {
    const counts = new Map<string, number>();
    const gw = await startGateway((_n, body) => {
      const unit = unitOf(body);
      const count = (counts.get(unit ?? "") ?? 0) + 1;
      counts.set(unit ?? "", count);
      if (unit === "impl" && count === 1) return {
        kind: "tools",
        calls: [{ name: "edit_file", args: {
          path: "math.mjs",
          old_content: "export const add = (a, b) => a - b;\n",
          new_content: "export const add = (a, b) => a + b;\n",
        } }],
      };
      if (unit === "validate" && count === 1) return { kind: "tools", calls: [{ name: "run_tests", args: {} }] };
      return complete(unit === "validate" ? "ran the regression test after wake" : "fixed addition after wake");
    });
    await withEnv([gw], async (env) => {
      fs.writeFileSync(path.join(env.repo, "package.json"), JSON.stringify({ private: true, type: "module" }));
      fs.writeFileSync(path.join(env.repo, "Makefile"), ".PHONY: test\ntest:\n\tenv -u NODE_TEST_CONTEXT node --test test/math.test.mjs\n");
      fs.writeFileSync(path.join(env.repo, "math.mjs"), "export const add = (a, b) => a - b;\n");
      fs.mkdirSync(path.join(env.repo, "test"), { recursive: true });
      fs.writeFileSync(path.join(env.repo, "test/math.test.mjs"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../math.mjs";\ntest("addition", () => assert.equal(add(2, 3), 5));\n');
      execSync("git add package.json Makefile math.mjs test/math.test.mjs && git commit -qm 'seed wait-resume implementation fixture'", { cwd: env.repo, stdio: "ignore" });
      const state = newOperation("op-c", "implement and validate", [
        { id: "impl", title: "Implement", role: "implementer", prompt: "Fix add(a, b) to return the sum." },
        { id: "validate", title: "Validate", role: "tester", prompt: "Run the regression test for add(a, b).", dependsOn: ["impl"] },
      ], [resource("only", gw)], 0);
      // This known resource backoff predates execution: the operation waits without persisting
      // an agent conversation, then starts fresh work after the resource becomes eligible.
      const clock = fakeClock();
      const rateLimit: InferenceFailure = {
        kind: "http_error", origin: "provider", message: "HTTP 429", httpStatus: 429,
        condition: "RATE_LIMITED", execution: "NOT_EXECUTED", hints: { retryAfterMs: 90_000 },
      };
      const registry = new ResourceRegistry(state.resources, state.conditions, clock);
      assert.ok(registry.observeFailure(state.resources[0]!, rateLimit));
      state.conditions = registry.snapshot();
      const store = env.store();
      const statuses: string[] = [];
      let waitedBeforeInference = false;
      const runner = new OperationRunner(state, {
        executor: env.executor({
          approvalMode: "auto",
          fullAccess: true,
          authoritativeVerifierCommand: "make test",
          trustedDeliverableFiles: ["math.mjs"],
        }),
        clock,
        persist: (s) => {
          store.save(s);
          statuses.push(store.load("op-c").status);
          if (s.status === "WAITING") {
            assert.equal(gw.requests.length, 0, "the durable wait is recorded before any agent inference");
            waitedBeforeInference = true;
          }
        },
      });
      const out = await runner.run();
      assert.equal(out.status, "COMPLETE");
      assert.ok(statuses.includes("WAITING"));
      assert.equal(waitedBeforeInference, true);
      assert.equal(clock.sleeps.length, 1);
      assert.equal(gw.requests.length, 4);
      assert.deepEqual(out.units.map((u) => u.result?.outcome), ["VERIFIED", "VERIFIED"]);
      assert.equal(fs.readFileSync(path.join(env.repo, "math.mjs"), "utf8"), "export const add = (a, b) => a + b;\n");
      assert.equal(counts.get("impl"), 2);
      assert.equal(counts.get("validate"), 2);
      const types = out.events.map((e) => e.type);
      assert.ok(types.indexOf("OPERATION_WAITING") < types.indexOf("OPERATION_RESUMED"));
    });
  });

  test("D. restart during WAITING: a new process reconstructs the wait and resumes the unit from durable state", async () => {
    const gw = await startGateway((n) => (n === 1 ? { kind: "tools", calls: [{ name: "read_file", args: { path: "notes.txt" } }] } : n === 2 ? limited(300) : complete("finished after restart")));
    await withEnv([gw], async (env) => {
      const t0 = fakeClock().now();
      const state = newOperation("op-d", "survive restart", [{ id: "x", title: "Unit X", prompt: "Read notes.txt and report" }], [resource("only", gw)], t0);
      const store1 = env.store();
      let reached!: () => void;
      const waiting = new Promise<void>((r) => (reached = r));
      const hang: FakeClock = { ...fakeClock(), sleep: () => new Promise<void>(() => {}) };
      void new OperationRunner(state, { executor: env.executor(), clock: hang, persist: (s) => { store1.save(s); if (s.status === "WAITING") reached(); } }).run();
      await waiting;

      // "New process": only what is on disk.
      const loaded = env.store().load("op-d");
      assert.equal(loaded.status, "WAITING");
      assert.equal(loaded.units[0].status, "PARKED");
      assert.ok(loaded.units[0].agentTaskId);
      const c2 = fakeClock();
      const later: FakeClock = { ...c2, now: () => c2.now() + 100_000 };
      const { runner } = run(env, loaded, later);
      const out = await runner.run();
      assert.equal(out.status, "COMPLETE");
      assert.equal(c2.sleeps.length, 1);
      assert.ok(c2.sleeps[0] >= 199_000 && c2.sleeps[0] <= 201_000, `remaining wait ${c2.sleeps[0]}`);
      assert.equal(gw.requests.length, 3);
      assert.equal(gw.requests[2].body.messages.filter((m: any) => m.role === "tool" && /the answer is 42/.test(String(m.content))).length, 1, "history recovered from disk");
      assert.equal(env.store().load("op-d").status, "COMPLETE");
    });
  });

  test("context admission still governs a unit on a small-context resource", async () => {
    const gw = await startGateway(() => complete("never"));
    await withEnv([gw], async (env) => {
      const state = newOperation("op-ctx", "x", [{ id: "big", title: "Big unit", prompt: "Summarise: " + "lorem ipsum ".repeat(4000) }], [resource("tiny", gw, { contextLength: 4096 })], 0);
      const out = await run(env, state).runner.run();
      assert.equal(gw.requests.length, 0, "admission refused before any inference");
      assert.equal(out.status, "BLOCKED");
      assert.match(out.blocked!.decisions[0].question, /needs more context than tiny admits/);
    });
  });
});
