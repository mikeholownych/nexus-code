/**
 * D4: a rejected pre-inference context admission is a first-class bounded condition.
 *
 * Contract under test (docs/reviews/NEXUS_PARALLEL_DEFECT_INVESTIGATION_2026-10-04.md, D4):
 *  - the turn ends BLOCKED / NOT_ESTABLISHED / CONTEXT_CAPACITY_EXCEEDED, not an exception or UNHANDLED_ERROR
 *  - no over-budget request reaches the gateway
 *  - when no model call happened in the turn, the pending user message is NOT left in history, so retries never accumulate
 *  - when earlier steps of the turn already ran, the existing conversation and tool evidence are kept (nothing is discarded)
 *  - the result states the admission arithmetic, whether a model call occurred, and what happened to the message
 */
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

describe("D4 context capacity is a bounded condition", () => {
  // Let the agent's trailing stdout writes (spinner/bell/banner) drain before node:test emits the next result line.
  afterEach(() => new Promise((r) => setTimeout(r, 100)));
  test("rejected at step 1: BLOCKED result, no gateway call, message not retained, retries do not accumulate", async () => {
    const gw = await gateway(() => ({ fail: true }));   // any request that reaches the gateway answers HTTP 500 (keeps stdout free of streamed answers)
    const ws = repo();
    // 6,000 is below the fixed overhead (system prompt + tool schemas) plus scaled reserves, so admission must refuse.
    const agent = mute(new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 4, temperature: 0, workspace: ws, shell: "bash", contextLimit: 6000 } as any));
    try {
      const before = roles(agent);
      for (let i = 1; i <= 3; i++) {
        const r = await quiet(() => agent.runTurn(`objective number ${i}`));
        assert.equal(r.execution, "BLOCKED");
        assert.equal(r.outcome, "NOT_ESTABLISHED");
        assert.equal(r.reason, "CONTEXT_CAPACITY_EXCEEDED");
        assert.equal(r.finalOutputComplete, false);
        assert.equal(exitCodeForTurn(r), 1);
        assert.ok(r.capacity, "capacity evidence present");
        assert.equal(r.capacity!.modelCalled, false);
        assert.equal(r.capacity!.pendingMessageRetained, false);
        assert.equal(r.capacity!.contextLimit, 6000);
        assert.ok(r.capacity!.estimatedPromptTokens + r.capacity!.completionReserveTokens + r.capacity!.toolResponseReserveTokens > 6000);
        assert.ok(r.capacity!.pendingMessageChars >= `objective number ${i}`.length);
        assert.equal(roles(agent), before, `history unchanged after attempt ${i}`);
      }
      assert.equal(gw.requests, 0, "no over-budget (or any) request was sent");
      // Recovery by changed conditions: the same session continues once the limit allows the request.
      (agent as any).config.contextLimit = 65536;
      const past = await quiet(() => agent.runTurn("objective number 4"));
      assert.equal(past.reason, "INFERENCE_FAILED", "admission now passes: the request reached the (failing) gateway");
      assert.equal(roles(agent), "su", "exactly one user message after recovery, no residue from the refused attempts");
      assert.equal(gw.requests, 1);
    } finally {
      agent.shutdown(); await gw.close(); fs.rmSync(ws, { recursive: true, force: true });
    }
  });

});
