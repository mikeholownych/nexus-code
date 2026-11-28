import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import "./helpers/leak_guard.js";
import { makeAgent, makeWorld } from "./helpers/tool_characterization.js";
import { startGateway } from "./helpers/fixtures.js";

test("a mutating tool is not dispatched when its durable start journal cannot be written", async (t) => {
  const world = makeWorld();
  t.after(() => world.close());
  const gateway = await startGateway(() => ({
    kind: "tools",
    calls: [{ name: "write_file", args: { path: "journal-failure.txt", content: "must not be written\n" } }],
  }));
  t.after(() => gateway.close());

  const agent = makeAgent(world, {
    mode: "auto",
    fullAccess: true,
    config: { endpoint: gateway.url, maxSteps: 1 },
  });
  const stateManager = agent.getStateManager();
  let starts = 0;
  stateManager.recordOperationStart = (() => {
    starts++;
    throw new Error("injected durable start-journal failure");
  }) as typeof stateManager.recordOperationStart;

  const result = await agent.runTurn("Write journal-failure.txt");

  assert.equal(starts, 1, "the durable start boundary was reached exactly once");
  assert.equal(gateway.requests.length, 1, "the model requested one tool call");
  const activeWorktree = agent.getActiveWorktree();
  assert.equal(
    [world.repo, ...(activeWorktree ? [activeWorktree.worktreePath] : [])]
      .some((root) => fs.existsSync(path.join(root, "journal-failure.txt"))),
    false,
    "no mutating handler runs without its durable start record",
  );
  assert.equal(result.persistence?.durable, false);
  assert.ok(result.persistence?.failures.some((failure) => failure.includes("operation_start")));
});

test("a mutating tool result is not accepted when its durable end journal cannot be written", async (t) => {
  const world = makeWorld();
  t.after(() => world.close());
  const gateway = await startGateway((n) => ({
    kind: "tools",
    calls: n === 1
      ? [{ name: "write_file", args: { path: "journal-end-failure.txt", content: "effect happened\n" } }]
      : [{ name: "task_completed", args: { summary: "The write succeeded." } }],
  }));
  t.after(() => gateway.close());

  const agent = makeAgent(world, {
    mode: "auto",
    fullAccess: true,
    config: { endpoint: gateway.url, maxSteps: 3 },
  });
  const stateManager = agent.getStateManager();
  const recordOperationEnd = stateManager.recordOperationEnd.bind(stateManager);
  let ends = 0;
  stateManager.recordOperationEnd = ((...args: Parameters<typeof stateManager.recordOperationEnd>) => {
    ends++;
    if (ends === 1) throw new Error("injected durable end-journal failure");
    return recordOperationEnd(...args);
  }) as typeof stateManager.recordOperationEnd;

  const result = await agent.runTurn("Write journal-end-failure.txt and finish the task.");

  assert.equal(result.execution, "FAILED");
  assert.equal(result.reason, "PERSISTENCE_FAILED");
  assert.notEqual(result.outcome, "VERIFIED");
  assert.equal(ends, 1, "the durable end boundary was reached exactly once");
  assert.equal(gateway.requests.length, 1, "no completion request follows an unrecorded side effect");
  const activeWorktree = agent.getActiveWorktree();
  const effectRoots = [world.repo, ...(activeWorktree ? [activeWorktree.worktreePath] : [])];
  assert.ok(
    effectRoots.some((root) => {
      const target = path.join(root, "journal-end-failure.txt");
      return fs.existsSync(target) && fs.readFileSync(target, "utf8") === "effect happened\n";
    }),
    "the write happened even though its durable result record failed",
  );
  const lastReceipt = (agent as any).lastToolReceipts.at(-1);
  assert.equal(lastReceipt.success, false);
  assert.equal(lastReceipt.outcomeUnknown, true);
  assert.match(lastReceipt.error, /outcome could not be durably recorded/i);
  assert.ok(result.persistence?.failures.some((failure) => failure.includes("operation_end")));
  const taskId = (agent as any).currentTaskId as string;
  const savedState = stateManager.loadTaskState(taskId);
  assert.equal(savedState.currentOperation?.toolName, "write_file");
  assert.equal(savedState.currentOperation?.status, "outcome_unknown", "the failed end write is preserved as an unknown outcome instead of being overwritten with completion");
  const recovered = stateManager.recoverTaskState(taskId, { revalidateCandidate: false });
  assert.equal(recovered.interrupted, true);
  assert.equal(recovered.interruptedOperation?.toolName, "write_file");
  assert.match(recovered.interruptedOperation?.error ?? "", /outcome (?:is|was) unknown/i);
});
