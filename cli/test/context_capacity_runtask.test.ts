/** D4 (continued): the runTask / exit-code projection of a capacity refusal. See context_capacity.test.ts for the contract. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { ApplicationCore } from "../src/core/app.js";
import { exitCodeForTurn } from "../src/core/turn.js";
import { gateway, repo, mute, roles } from "./helpers/capacity_fixture.js";

/** The inference-failure path prints to stderr via console.error; keep it out of the interleaved test stream. */
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = e; }
};

describe("D4 context capacity via runTask", () => {
  test("runTask projection: failure semantics are consistent and distinct from an unhandled error", async () => {
    const gw = await gateway(() => ({ text: "x" }));
    const ws = repo();
    const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 3, temperature: 0, workspace: ws, shell: "bash", contextLimit: 6000 } as any);
    mute(app.getAgent());
    try {
      const res = await quiet(() => app.runTask("do the thing", { quiet: true }));
      assert.equal(res.success, false);
      assert.equal(res.exitCode, 1);
      assert.equal(res.turn.execution, "BLOCKED");
      assert.equal(res.turn.reason, "CONTEXT_CAPACITY_EXCEEDED");
      assert.notEqual(res.turn.reason, "UNHANDLED_ERROR");
      assert.equal(res.error, undefined, "not reported as a thrown error");
      assert.equal(gw.requests, 0);
    } finally {
      app.shutdown(); await gw.close(); fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
