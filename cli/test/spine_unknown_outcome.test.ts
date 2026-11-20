import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ExecutionSpine, type CandidateMutationEvent, type InvocationContext, type InvocationRequest } from "../src/core/spine.js";
import { createDefaultRegistry } from "../src/core/capabilities.js";
import type { ExecutionResult } from "../src/types.js";

const context: InvocationContext = { workspaceRoot: "/workspace", dryRun: false, readOnly: false };
const request = (toolName: string, args: Record<string, unknown>): InvocationRequest => ({
  taskId: "task-unknown",
  actor: "agent",
  executionDomain: "agent_orchestration",
  toolName,
  args,
});

async function execute(toolName: string, result: ExecutionResult) {
  const spine = new ExecutionSpine({ registry: createDefaultRegistry() });
  const mutations: CandidateMutationEvent[] = [];
  spine.setHook("candidateMutation", async (event) => { mutations.push(event); });
  spine.registerHandler(toolName, async () => result);
  const receipt = await spine.execute(request(toolName, { path: "a.txt", content: "x" }), context);
  return { receipt, mutations };
}

describe("unknown tool outcomes through the execution spine", () => {
  test("a timed-out mutating tool is marked unknown and possibly changed the candidate", async () => {
    const { receipt, mutations } = await execute("write_file", {
      success: false, output: "", error: "RPC request timed out", timedOut: true,
    });
    assert.equal(receipt.success, false);
    assert.equal(receipt.status, "UNKNOWN");
    assert.equal(receipt.outcomeUnknown, true);
    assert.equal(receipt.status, "UNKNOWN");
    assert.match(receipt.error ?? "", /OUTCOME UNKNOWN/);
    assert.equal(receipt.candidateMutated, true);
    assert.equal(mutations.length, 1);
  });

  test("a disconnect explicitly marked unknown is not downgraded to ordinary failure", async () => {
    const { receipt } = await execute("write_file", {
      success: false, output: "", error: "RPC daemon disconnected", outcomeUnknown: true,
    });
    assert.equal(receipt.outcomeUnknown, true);
    assert.match(receipt.error ?? "", /OUTCOME UNKNOWN/);
  });

  test("a confirmed failure remains a failure and does not create a mutation obligation", async () => {
    const { receipt, mutations } = await execute("write_file", {
      success: false, output: "", error: "permission denied",
    });
    assert.equal(receipt.outcomeUnknown, undefined);
    assert.equal(receipt.error, "permission denied");
    assert.equal(receipt.candidateMutated, false);
    assert.equal(mutations.length, 0);
  });
});
