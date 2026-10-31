/**
 * The inter-agent channel: typed, persisted, addressed messages, delivered at most once. A message is advisory
 * context; these tests assert the mechanics, not any claim about its content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newOperation, type DurableOperationState, type OperationMessage, type UnitRunResult, type WorkUnitSpec } from "../src/core/operation.js";
import { OperationRunner, OperationStore, type UnitRunContext, type WorkUnitExecutor } from "../src/core/operation_runner.js";
import { MAX_MESSAGES, MAX_MESSAGE_BODY, MAX_MESSAGES_PER_TURN, MessageRejected, markDelivered, messagesBlock, publishMessage, undeliveredFor } from "../src/core/operation_messages.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import { fakeClock } from "./helpers/provider_fixture.js";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const res = (id: string): ResourceDescriptor => ({
  id,
  provider: `https://${id}.test`,
  endpoint: `https://${id}.test/v1`,
  model: `model-${id}`,
  capabilities: ["tools"],
  rank: 0,
});

const unit = (id: string, o: Partial<WorkUnitSpec> = {}): WorkUnitSpec => ({ id, title: id, prompt: `do ${id}`, ...o });
const done = (summary = "ok"): UnitRunResult => ({ kind: "completed", summary, outcome: "NOT_REQUIRED" });

function state(units: WorkUnitSpec[] = [unit("a"), unit("b")]): DurableOperationState {
  return newOperation("op-msg", "objective", units, [res("r1")], 1_800_000_000_000);
}

test("a message is validated before it is stored", () => {
  const op = state();
  const cases: Array<[Parameters<typeof publishMessage>[1], RegExp]> = [
    [{ from: "a", to: "nope", kind: "request", body: "x" }, /no work unit 'nope'/],
    [{ from: "a", to: "b", kind: "request", body: "   " }, /non-empty body/],
    [{ from: "a", to: "b", kind: "request", body: "x".repeat(MAX_MESSAGE_BODY + 1) }, /limited to 4000 characters/],
    [{ from: "a", to: "b", kind: "request", body: "escape\u001b[31m" }, /control characters/],
    [{ from: "a", to: "b", kind: "gossip" as any, body: "x" }, /unknown message kind/],
    [{ from: "", to: "b", kind: "request", body: "x" }, /needs a sender/],
    [{ from: "a", to: "b", kind: "request", body: "x", refs: [{ kind: "url" as any, ref: "http://x" }] }, /unknown reference kind/],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => publishMessage(op, input, 1), expected, JSON.stringify(input.kind));
  }
});

test("messages are addressed, ordered and delivered at most once", () => {
  const op = state([unit("a"), unit("b"), unit("c")]);
  publishMessage(op, { from: "a", to: "*", kind: "artifact", body: "a is done", refs: [{ kind: "unit", ref: "a" }] }, 10);
  publishMessage(op, { from: "operator", to: "b", kind: "request", body: "focus on b" }, 20);
  publishMessage(op, { from: "a", to: "c", kind: "observation", body: "for c only" }, 30);

  assert.deepEqual(undeliveredFor(op, "b").map((m) => m.id), ["msg-1", "msg-2"]);
  assert.deepEqual(undeliveredFor(op, "c").map((m) => m.id), ["msg-1", "msg-3"], "a unit never receives its own message");
  assert.deepEqual(undeliveredFor(op, "a").map((m) => m.id), [], "a broadcast never returns to its sender, and a direct message is not for it");

  markDelivered(op, ["msg-1"], "b", new Date(40).toISOString());
  assert.deepEqual(undeliveredFor(op, "b").map((m) => m.id), ["msg-2"]);
  assert.equal(op.messages!.find((m) => m.id === "msg-1")!.deliveredTo, "b");

  // Re-marking is idempotent: the first delivery record wins.
  markDelivered(op, ["msg-1"], "c", new Date(50).toISOString());
  assert.equal(op.messages!.find((m) => m.id === "msg-1")!.deliveredTo, "b");
});

test("a turn receives at most the per-turn cap, oldest first", () => {
  const op = state();
  for (let i = 0; i < MAX_MESSAGES_PER_TURN + 5; i++) {
    publishMessage(op, { from: "a", to: "b", kind: "observation", body: `m${i}` }, i);
  }
  const owed = undeliveredFor(op, "b");
  assert.equal(owed.length, MAX_MESSAGES_PER_TURN);
  assert.equal(owed[0].body, "m0");
});

test("the record stays bounded: delivered messages are dropped before undelivered ones", () => {
  const op = state();
  for (let i = 0; i < MAX_MESSAGES; i++) {
    publishMessage(op, { from: "a", to: "b", kind: "observation", body: `m${i}` }, i);
  }
  markDelivered(op, [op.messages![0].id], "b", new Date(1).toISOString());
  const { dropped } = publishMessage(op, { from: "a", to: "b", kind: "observation", body: "overflow" }, 999);
  assert.equal(op.messages!.length, MAX_MESSAGES);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].body, "m0", "the delivered message goes first");
  assert.equal(op.messages!.at(-1)!.body, "overflow");
});

test("ACC-V11-MAO-05: a completed unit's artifact reaches the next unit exactly once", async () => {
  const clock = fakeClock();
  const op = newOperation("op-deliver", "objective", [unit("a"), unit("b")], [res("r1")], clock.now());
  const seen: Array<{ unit: string; messages: OperationMessage[] | undefined; dependencies: string[] }> = [];
  const executor: WorkUnitExecutor = {
    run: async (u, _r, ctx: UnitRunContext) => {
      seen.push({ unit: u.id, messages: ctx.messages, dependencies: ctx.dependencies.map((d) => d.id) });
      return done(u.id === "a" ? "the schema is documented" : "done");
    },
  };
  const runner = new OperationRunner(op, { executor, clock, persist: () => {} });
  await runner.run();

  assert.equal(op.status, "COMPLETE");
  const published = op.messages!.find((m) => m.from === "a")!;
  assert.equal(published.kind, "artifact");
  assert.match(published.body, /the schema is documented/);

  const second = seen.find((entry) => entry.unit === "b")!;
  assert.deepEqual(second.messages?.map((m) => m.id), [published.id], "b receives a's artifact once");
  assert.equal(published.deliveredTo, "b");
  assert.equal(seen.find((entry) => entry.unit === "a")!.messages, undefined, "a receives nothing it did not earn");

  // A resumed turn does not repeat a delivered message.
  const again = new OperationRunner(op, { executor, clock, persist: () => {} });
  const resumeSeen: OperationMessage[][] = [];
  again.state.units[1].status = "RUNNABLE";
  again.state.status = "RUNNING";
  (again as any).opts.executor = { run: async (_u: any, _r: any, ctx: UnitRunContext) => { resumeSeen.push(ctx.messages ?? []); return done(); } };
  await again.run();
  assert.deepEqual(resumeSeen.flat().map((m) => m.id).filter((id) => id === published.id), [], "a delivered message is not repeated");
});

test("ACC-V11-CTX-02: a dependent unit receives exactly its declared dependencies' summaries", async () => {
  const clock = fakeClock();
  const op = newOperation(
    "op-deps",
    "objective",
    [unit("a"), unit("b"), unit("c", { dependsOn: ["a"] })],
    [res("r1")],
    clock.now(),
  );
  const seen: Array<{ unit: string; dependencies: Array<{ id: string; summary: string }> }> = [];
  const executor: WorkUnitExecutor = {
    run: async (u, _r, ctx: UnitRunContext) => {
      seen.push({ unit: u.id, dependencies: ctx.dependencies });
      return done(`${u.id} summary`);
    },
  };
  await new OperationRunner(op, { executor, clock, persist: () => {} }).run();
  assert.deepEqual(seen.find((s) => s.unit === "c")!.dependencies, [{ id: "a", title: "a", summary: "a summary" }]);
  assert.equal(seen.find((s) => s.unit === "b")!.dependencies.length, 0);
});

test("the prompt fragment names the sender and kind, and carries pointers", () => {
  const block = messagesBlock([
    { id: "msg-1", at: "2026-10-31T00:00:00.000Z", from: "impl", to: "*", kind: "artifact", body: "done", refs: [{ kind: "receipt", ref: "abc123" }] },
  ]);
  assert.match(block, /Messages from other units \(advisory/);
  assert.match(block, /- \[artifact\] impl: done \(receipt: abc123\)/);
  assert.equal(messagesBlock([]), "");
  assert.equal(messagesBlock(undefined), "");
});

test("ACC-V11-CTX-03: the operator command publishes through the store and rejects a bad recipient with exit 2", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-v11-msg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const stateDir = path.join(root, "state");
  const store = new OperationStore(workspace, path.join(stateDir, "tasks"), root);
  const op = state();
  store.save(op);

  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), NEXUS_STATE_DIR: stateDir, NO_COLOR: "1" };
  const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, ["--import", "tsx", path.join(cliDir, "src/index.ts"), ...args, "-w", workspace], { cwd: cliDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env }), stderr: "" };
    } catch (error: any) {
      return { status: Number(error?.status ?? -1), stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? "") };
    }
  };

  const ok = run(["operation", "message", op.id, "--to", "b", "--kind", "request", "--body", "please cover the migration test"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Message msg-1 published to b\./);

  const bad = run(["operation", "message", op.id, "--to", "nobody", "--body", "x"]);
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /no work unit 'nobody'/);

  const reloaded = store.load(op.id);
  assert.equal(reloaded.messages!.length, 1);
  assert.equal(reloaded.messages![0].body, "please cover the migration test");
  assert.equal(reloaded.events.at(-1)!.type, "OPERATION_MESSAGE");
  assert.doesNotMatch(JSON.stringify(reloaded.events.at(-1)), /please cover/, "event detail never carries the body");
});
