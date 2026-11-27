import assert from "node:assert/strict";
import { test } from "node:test";
import { requestJsonProposal } from "../src/core/proposal_inference.js";
import type { ChatMessage } from "../src/types.js";

test("proposal inference submits no tools and reads one structured answer", async () => {
  const reply = await requestJsonProposal({
    async chatCompletion(messages, tools, _id, signal) {
      assert.deepEqual(tools, []);
      assert.equal(messages[1].content, "objective");
      assert.equal(signal?.aborted, false);
      return { role: "assistant", content: '{"items":[]}' };
    },
  }, "contract", "objective");
  assert.deepEqual(reply, { items: [] });
});

test("proposal inference rejects tool calls, prose and oversized replies", async () => {
  const replies: ChatMessage[] = [
    { role: "assistant", content: '{"items":[]}', tool_calls: [{ id: "call", type: "function", function: { name: "write_file", arguments: "{}" } }] },
    { role: "assistant", content: 'Here is the plan: {"items":[]}' },
    { role: "assistant", content: '{"items":[],"items":["duplicate"]}' },
    { role: "assistant", content: JSON.stringify({ items: "x".repeat(128 * 1024) }) },
  ];
  for (const reply of replies) {
    await assert.rejects(requestJsonProposal({ async chatCompletion() { return reply; } }, "contract", "objective"));
  }
});

test("proposal policy rejects cancellation and oversized input before dispatch", async () => {
  const client = { async chatCompletion(): Promise<ChatMessage> { assert.fail("unexpected inference"); } };
  const signal = AbortSignal.abort(new Error("operator cancelled"));
  await assert.rejects(requestJsonProposal(client, "contract", "objective", signal), /operator cancelled/);
  await assert.rejects(requestJsonProposal(client, "contract", "x".repeat(64 * 1024)), /too large/);
});

test("a reply arriving after cancellation is discarded", async () => {
  const controller = new AbortController();
  const pending = requestJsonProposal({
    async chatCompletion() {
      controller.abort(new Error("operator cancelled"));
      return { role: "assistant", content: '{"items":[]}' };
    },
  }, "contract", "objective", controller.signal);
  await assert.rejects(pending, /operator cancelled/);
});
