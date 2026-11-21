import assert from "node:assert/strict";
import test from "node:test";
import { dispatchToolCallImpl } from "../src/core/dispatch_tool_call.js";
import { resolveDelegationContract } from "../src/core/delegation_contract.js";

test("delegation contract refuses capabilities outside the inherited intersection", () => {
  const contract = {
    id: "child-1",
    parentId: "parent-1",
    objective: "Inspect source",
    profile: "semantic_explorer",
    inputs: {},
    authorizedScope: ["src"],
    permittedCapabilities: ["fs_read"],
    executionMode: "transient" as const,
    requiresVerification: false,
    requiresIndependentReview: false,
  };
  const layers = ["parent", "profile", "task", "session", "workspace"].map((source) => ({
    source: source as "parent" | "profile" | "task" | "session" | "workspace",
    authorizedScope: ["*"],
    permittedCapabilities: ["fs_read"],
  }));
  assert.deepEqual(resolveDelegationContract(contract, layers).permittedCapabilities, ["fs_read"]);
  assert.throws(() => resolveDelegationContract({ ...contract, permittedCapabilities: ["fs_write"] }, layers), /unauthorized capability/);
});

test("dispatcher denies a delegated tool omitted from its host allowlist", async () => {
  const agent: any = {
    delegatedToolAllowList: new Set(["read_file"]),
    config: { dryRun: false },
    activeWorktree: undefined,
    currentTaskId: "parent-1",
    capabilityRegistry: { getByToolName: (name: string) => ({ id: name }) },
    lastToolReceipts: [],
    getEffectiveTools: () => [],
  };
  const result = await dispatchToolCallImpl.call(agent, {
    id: "call-1",
    function: { name: "write_file", arguments: JSON.stringify({ path: "src/a.ts", content: "bad" }) },
  } as any, 1, "subagent");
  assert.equal(result.receipt.status, "DENIED");
  assert.equal(result.receipt.denialReason, "DELEGATION_AUTHORITY");
  assert.equal(result.receipt.candidateMutated, false);
});
