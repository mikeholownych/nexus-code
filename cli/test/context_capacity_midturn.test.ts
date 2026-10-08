/** D4 (continued): admission refused after earlier steps of the turn already ran; see context_capacity.test.ts for the contract. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { ApplicationCore } from "../src/core/app.js";
import { exitCodeForTurn } from "../src/core/turn.js";
import { gateway, repo, mute, roles } from "./helpers/capacity_fixture.js";

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => fn();

describe("D4 context capacity after earlier steps ran", () => {
  afterEach(() => new Promise((r) => setTimeout(r, 100)));
  test("rejected after earlier steps ran: existing evidence kept, retries stay idempotent, no model call after the block", async () => {
    // A completed earlier turn leaves evidence (suat*). A later turn whose prompt alone exceeds
    // the budget is refused fail-closed before any inference, and retries stay idempotent.
    const gw = await gateway((n) => (n === 1 ? { tool: { name: "read_file", args: { path: "notes.txt" } } } : { text: "unexpected" }));
    const ws = repo({ "notes.txt": "ordinary notes ".repeat(800) });
    const agent = mute(new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 5, temperature: 0, workspace: ws, shell: "bash", contextLimit: 30000 } as any));
    try {
      const r1 = await quiet(() => agent.runTurn("read the notes file"));
      assert.equal(r1.execution, "COMPLETED");
      assert.equal(gw.requests, 2);
      const kept = roles(agent);
      assert.ok(kept.includes("u") && kept.includes("a") && kept.includes("t"), "user message, assistant tool call and tool evidence are all preserved");
      const huge = "blocking-payload ".repeat(Math.ceil(300_000 / 17)); // ~300k chars exceeds the budget even after the strongest compaction
      for (let i = 0; i < 2; i++) {
        const r = await quiet(() => agent.runTurn(`retry the same objective ${huge}`));
        assert.equal(r.execution, "BLOCKED");
        assert.equal(r.reason, "CONTEXT_CAPACITY_EXCEEDED");
        assert.equal(r.capacity!.modelCalled, false, "the retry itself sent nothing");
        assert.equal(r.capacity!.pendingMessageRetained, false);
        assert.equal(roles(agent), kept, "retry did not append another user message");
      }
      assert.equal(gw.requests, 2, "no request after the completed read turn");
    } finally {
      agent.shutdown(); await gw.close(); fs.rmSync(ws, { recursive: true, force: true });
    }
  });

});
