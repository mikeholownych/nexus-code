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
    // One huge tool result makes the next admission impossible; the first request legitimately happened.
    const gw = await gateway((n) => (n === 1 ? { tool: { name: "read_file", args: { path: "big.txt" } } } : { text: "unexpected" }));
    const ws = repo({ "big.txt": "word ".repeat(40000) });
    const agent = mute(new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 5, temperature: 0, workspace: ws, shell: "bash", contextLimit: 30000 } as any));
    try {
      const r1 = await quiet(() => agent.runTurn("read the big file"));
      assert.equal(r1.execution, "BLOCKED");
      assert.equal(r1.reason, "CONTEXT_CAPACITY_EXCEEDED");
      assert.equal(r1.capacity!.modelCalled, true);
      assert.equal(r1.capacity!.pendingMessageRetained, true);
      assert.equal(gw.requests, 1);
      const kept = roles(agent);
      assert.equal(kept, "suat", "user message, assistant tool call and tool evidence are all preserved");
      for (let i = 0; i < 2; i++) {
        const r = await quiet(() => agent.runTurn("retry the same objective"));
        assert.equal(r.execution, "BLOCKED");
        assert.equal(r.capacity!.modelCalled, false, "the retry itself sent nothing");
        assert.equal(r.capacity!.pendingMessageRetained, false);
        assert.equal(roles(agent), kept, "retry did not append another user message");
      }
      assert.equal(gw.requests, 1, "no request after the block");
    } finally {
      agent.shutdown(); await gw.close(); fs.rmSync(ws, { recursive: true, force: true });
    }
  });

});
