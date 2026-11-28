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
