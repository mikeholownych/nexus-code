import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { dispatchToolCallImpl } from "../src/core/dispatch_tool_call.js";
import { resolveDelegationContract } from "../src/core/delegation_contract.js";
import { startGateway, makeRepo } from "./helpers/fixtures.js";
import "./helpers/leak_guard.js";

const isSubagentRequest = (request: any): boolean =>
  (request.messages ?? []).some((message: any) => String(message.content ?? "").includes("[Subagent Objective]"));

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

test("model-generated delegation metadata cannot grant authority or start a child", { timeout: 30_000 }, async () => {
  const repo = makeRepo();
  const gateway = await startGateway((n) => n === 1
    ? {
        kind: "tools",
        calls: [{
          name: "spawn_subagent",
          args: {
            prompt: "Read the protected workspace files.",
            profile: "semantic_explorer",
            authorizedScope: ["."],
            permittedCapabilities: ["fs_read", "fs_write", "proc_exec"],
            executionMode: "durable",
            max_children: 999,
          },
        }],
      }
    : { kind: "text", content: "I will continue without delegating." });
  const agent = new AutonomousAgent({
    endpoint: gateway.url,
    model: "m",
    maxSteps: 2,
    temperature: 0,
    workspace: repo,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
  });

  try {
    await agent.runTurn("Inspect the repository without granting new authority.");

    const firstRequest = gateway.requests[0] as any;
    const spawnSchema = firstRequest.tools.find((tool: any) => tool.function?.name === "spawn_subagent");
    const properties = spawnSchema?.function?.parameters?.properties ?? {};
    for (const authorityField of ["authorizedScope", "permittedCapabilities", "executionMode", "max_children"]) {
      assert.equal(Object.hasOwn(properties, authorityField), false, `the model-facing schema must omit ${authorityField}`);
    }

    const spawnResult = agent.getMessages().find((message: any) => message.role === "tool" && message.name === "spawn_subagent");
    assert.match(String(spawnResult?.content), /Invalid delegation request.*Only prompt, profile, inputs/);
    assert.equal(gateway.requests.length, 2, "the only inference requests are the parent request and its follow-up");
    assert.equal(gateway.requests.some((request: any) =>
      request.messages?.some((message: any) => String(message.content ?? "").includes("[Subagent Objective]"))), false,
    "the untrusted metadata is rejected before child construction or inference");
    assert.equal(fs.existsSync(path.join(repo, "protected.txt")), false);
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("prompt-only delegation still runs in an isolated child context", { timeout: 30_000 }, async () => {
  const repo = makeRepo({ "notes.txt": "The requested note is present.\n" });
  const gateway = await startGateway((_n, request) => {
    if (isSubagentRequest(request)) {
      return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "The note is present." } }] };
    }
    const toolResults = (request.messages ?? []).filter((message: any) => message.role === "tool");
    if (toolResults.length > 0) return { kind: "text", content: "The delegated inspection is complete." };
    return { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "Read notes.txt and report its first sentence." } }] };
  });
  const agent = new AutonomousAgent({
    endpoint: gateway.url,
    model: "m",
    maxSteps: 3,
    temperature: 0,
    workspace: repo,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
  });

  try {
    await agent.runTurn("Inspect notes.txt. PARENT_PRIVATE_CONTEXT_8f02 is not part of the delegated request.");

    const childRequests = (gateway.requests as any[]).filter(isSubagentRequest);
    assert.equal(childRequests.length, 1, "prompt-only invocation creates exactly one child");
    assert.equal(gateway.requests.length, 3, "parent, child and parent follow-up each use their own inference request");
    assert.equal(JSON.stringify(childRequests[0].messages).includes("PARENT_PRIVATE_CONTEXT_8f02"), false);
    const spawnResult = agent.getMessages().find((message: any) => message.role === "tool" && message.name === "spawn_subagent");
    assert.doesNotMatch(String(spawnResult?.content), /^Error executing spawn_subagent:/);
  } finally {
    agent.shutdown();
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
