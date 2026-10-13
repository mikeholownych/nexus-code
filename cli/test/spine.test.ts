import { test, describe } from "node:test";
import assert from "node:assert";
import {
  ExecutionSpine,
  ExecutionReceipt,
  InvocationRequest,
  InvocationContext,
  extractTargetResources,
  ProcessLifecycleEvent,
  CandidateMutationEvent,
} from "../src/core/spine.js";
import { createDefaultRegistry } from "../src/core/capabilities.js";
import { AutonomousAgent } from "../src/agent.js";
import { HarnessConfig } from "../src/types.js";

describe("WP-01: ExecutionSpine & Invocation Pipeline (INC-02)", () => {
  const dummyContext: InvocationContext = {
    workspaceRoot: "/workspace",
    dryRun: false,
    readOnly: false,
  };

  test("EXEC-002 & CAP-004: Standard execution through 6 stages emits complete receipt", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({ registry });

    let lifecycleEvents: ProcessLifecycleEvent[] = [];
    let mutationEvents: CandidateMutationEvent[] = [];
    let emittedReceipts: ExecutionReceipt[] = [];

    spine.setHook("processLifecycle", async (e) => {
      lifecycleEvents.push(e);
    });
    spine.setHook("candidateMutation", async (e) => {
      mutationEvents.push(e);
    });
    spine.setHook("evidenceEmission", async (r) => {
      emittedReceipts.push(r);
    });

    spine.registerHandler("read_file", async (args) => ({
      success: true,
      output: `File content of ${args.path}`,
    }));

    const req: InvocationRequest = {
      taskId: "task-test-01",
      actor: "agent",
      executionDomain: "agent_orchestration",
      toolName: "read_file",
      args: { path: "src/main.ts" },
    };

    const receipt = await spine.execute(req, dummyContext);

    assert.strictEqual(receipt.success, true);
    assert.strictEqual(receipt.status, "COMPLETED");
    assert.strictEqual(receipt.toolName, "read_file");
    assert.strictEqual(receipt.capabilityId, "fs_read");
    assert.strictEqual(receipt.taskId, "task-test-01");
    assert.strictEqual(receipt.actor, "agent");
    assert.strictEqual(receipt.executionDomain, "agent_orchestration");
    assert.deepStrictEqual(receipt.targetResources, ["src/main.ts"]);
    assert.strictEqual(receipt.output, "File content of src/main.ts");
    assert.strictEqual(receipt.candidateMutated, false, "read_file must not be marked as mutating candidate");
    assert.ok(receipt.invocationId, "Spine must assign immutable invocationId");
    assert.ok(receipt.timestamp, "Spine must record timestamp");
    assert.strictEqual(receipt.simulated, false);

    assert.strictEqual(lifecycleEvents.length, 2, "Must receive start and exit lifecycle events");
    assert.strictEqual(lifecycleEvents[0].stage, "start");
    assert.strictEqual(lifecycleEvents[1].stage, "exit");
    assert.strictEqual(mutationEvents.length, 0, "No candidate mutation event for read operation");
    assert.strictEqual(emittedReceipts.length, 1, "Must emit receipt to evidence hook");
    assert.strictEqual(emittedReceipts[0].invocationId, receipt.invocationId);
  });

  test("CAND-001 & CAP-004: Mutating capability triggers candidateMutation hook and marks receipt", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({ registry });

    let mutationEvents: CandidateMutationEvent[] = [];
    spine.setHook("candidateMutation", async (e) => {
      mutationEvents.push(e);
    });

    spine.registerHandler("write_file", async (args) => ({
      success: true,
      output: `Wrote ${args.content.length} bytes to ${args.path}`,
    }));

    const req: InvocationRequest = {
      toolName: "write_file",
      args: { path: "hello.txt", content: "Hello World" },
    };

    const receipt = await spine.execute(req, dummyContext);

    assert.strictEqual(receipt.success, true);
    assert.strictEqual(receipt.capabilityId, "fs_write");
    assert.strictEqual(receipt.candidateMutated, true, "write_file must be marked as candidateMutated");
    assert.strictEqual(mutationEvents.length, 1);
    assert.strictEqual(mutationEvents[0].toolName, "write_file");
    assert.deepStrictEqual(mutationEvents[0].mutatedPaths, ["hello.txt"]);
  });

  test("EXEC-010: Dry-run simulation marks simulated flag and skips mutation hook", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({ registry });

    let mutationEvents: CandidateMutationEvent[] = [];
    spine.setHook("candidateMutation", async (e) => {
      mutationEvents.push(e);
    });

    spine.registerHandler("write_file", async () => ({
      success: true,
      output: "Simulated write",
    }));

    const req: InvocationRequest = {
      toolName: "write_file",
      args: { path: "simulated.txt", content: "data" },
    };

    const receipt = await spine.execute(req, { ...dummyContext, dryRun: true });

    assert.strictEqual(receipt.success, true);
    assert.strictEqual(receipt.simulated, true, "Receipt must reflect simulated mode (EXEC-010)");
    assert.strictEqual(receipt.candidateMutated, false, "Dry run must not trigger candidate mutation");
    assert.strictEqual(mutationEvents.length, 0);
  });

  test("FAIL-001: Negative Test — Unregistered tool fails closed with clean receipt", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({ registry });

    let emittedReceipt: ExecutionReceipt | undefined;
    spine.setHook("evidenceEmission", async (r) => {
      emittedReceipt = r;
    });

    const req: InvocationRequest = {
      toolName: "non_existent_unregistered_tool",
      args: { foo: "bar" },
    };

    const receipt = await spine.execute(req, dummyContext);

    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.status, "FAILED");
    assert.strictEqual(receipt.capabilityId, "unregistered");
    assert.ok(receipt.error?.includes("FAIL-001"), "Error must cite FAIL-001");
    assert.ok(emittedReceipt, "Evidence hook must receive failure receipt");
  });

  test("FAIL-002: Negative Test — Malformed arguments rejected at Stage 1 before dispatch", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({ registry });

    let handlerCalled = false;
    spine.registerHandler("read_file", async () => {
      handlerCalled = true;
      return { success: true, output: "" };
    });

    // read_file requires 'path'
    const req: InvocationRequest = {
      toolName: "read_file",
      args: { start_line: 1 }, // missing 'path'!
    };

    const receipt = await spine.execute(req, dummyContext);

    assert.strictEqual(handlerCalled, false, "Handler must NOT be invoked when arguments are malformed");
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.status, "FAILED");
    assert.ok(receipt.error?.includes("Missing required parameter 'path'"), "Error must report missing parameter");
  });

  test("FAIL-001: Exception in handler fails closed gracefully without crashing", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({ registry });

    spine.registerHandler("run_command", async () => {
      throw new Error("Simulated backend crash / segmentation fault");
    });

    const req: InvocationRequest = {
      toolName: "run_command",
      args: { command: "segfault" },
    };

    const receipt = await spine.execute(req, dummyContext);

    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.status, "FAILED");
    assert.ok(receipt.error?.includes("FAIL-001"), "Error must report FAIL-001 on exception");
    assert.ok(receipt.error?.includes("Simulated backend crash"), "Receipt must contain original error message");
  });

  test("F-09: Upfront Hook — ContextAdmissionHook gates execution", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({
      registry,
      hooks: {
        contextAdmission: async () => ({
          admitted: false,
          reason: "Context token limit exceeded: 70000 > 65536",
        }),
      },
    });

    let handlerCalled = false;
    spine.registerHandler("search_code", async () => {
      handlerCalled = true;
      return { success: true, output: "" };
    });

    const receipt = await spine.execute(
      { toolName: "search_code", args: { query: "test" } },
      dummyContext
    );

    assert.strictEqual(handlerCalled, false);
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.status, "DENIED");
    assert.ok(receipt.error?.includes("Context token limit exceeded"));
  });

  test("F-09: Upfront Hook — AuthorityAdmissionHook gates execution (WP-02 interface)", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({
      registry,
      hooks: {
        authorityAdmission: async (req) => {
          if (req.toolName === "run_command" && req.args.command?.includes("rm -rf")) {
            return { admitted: false, reason: "Dangerous destruction command denied by policy" };
          }
          return { admitted: true };
        },
      },
    });

    const denied = await spine.execute(
      { toolName: "run_command", args: { command: "rm -rf /" } },
      dummyContext
    );
    assert.strictEqual(denied.success, false);
    assert.strictEqual(denied.status, "DENIED");
    assert.ok(denied.error?.includes("Dangerous destruction command denied"));

    spine.registerHandler("run_command", async () => ({ success: true, output: "safe" }));
    const allowed = await spine.execute(
      { toolName: "run_command", args: { command: "ls -la" } },
      dummyContext
    );
    assert.strictEqual(allowed.success, true);
    assert.strictEqual(allowed.status, "COMPLETED");
  });

  test("F-09: Upfront Hook — ResourceConfinementHook blocks out-of-bounds resources", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({
      registry,
      hooks: {
        resourceConfinement: async (req) => {
          if (req.args.path?.includes("../..")) {
            return { confined: false, reason: "Path traversal escape detected" };
          }
          return { confined: true };
        },
      },
    });

    const receipt = await spine.execute(
      { toolName: "read_file", args: { path: "../../etc/passwd" } },
      dummyContext
    );

    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.status, "BLOCKED");
    assert.ok(receipt.error?.includes("Path traversal escape detected"));
  });

  test("F-09: Upfront Hook — EgressQuarantineHook sanitizes payload (WP-05 interface)", async () => {
    const registry = createDefaultRegistry();
    const spine = new ExecutionSpine({
      registry,
      hooks: {
        egressQuarantine: async (req) => ({
          allowed: true,
          sanitizedArgs: {
            ...req.args,
            content: req.args.content.replace(/sk-[a-zA-Z0-9]{10}/g, "[SECRET_QUARANTINED]"),
          },
        }),
      },
    });

    let receivedArgs: any;
    spine.registerHandler("write_file", async (args) => {
      receivedArgs = args;
      return { success: true, output: "written" };
    });

    const receipt = await spine.execute(
      { toolName: "write_file", args: { path: "key.txt", content: "key is sk-ABCDEF1234" } },
      dummyContext
    );

    assert.strictEqual(receipt.success, true);
    assert.strictEqual(receivedArgs.content, "key is [SECRET_QUARANTINED]");
  });

  test("Integration Test: AutonomousAgent executes turn through ExecutionSpine", async () => {
    const config: HarnessConfig = {
      endpoint: "http://localhost:1234/v1",
      model: "mock-model",
      maxSteps: 5,
      temperature: 0,
      workspace: process.cwd(),
      shell: "bash",
    };

    const agent = new AutonomousAgent(config);
    assert.ok(agent.getSpine(), "Agent must instantiate ExecutionSpine");
    assert.ok(agent.getCapabilityRegistry(), "Agent must instantiate CapabilityRegistry");
    // The 36 baseline capabilities, read_findings, read_archive and enable_tools (every agent's), and the top-level agent's own
    // orchestration tools: update_requirements, read_objective.
    assert.strictEqual(agent.getCapabilityRegistry().listCapabilities().length, 41);
    assert.ok(agent.getCapabilityRegistry().getByToolName("update_requirements"));
    assert.ok(agent.getCapabilityRegistry().getByToolName("read_objective"));
    assert.ok(agent.getCapabilityRegistry().getByToolName("read_findings"));

    // Mock client to return a tool call
    let turnCount = 0;
    const mockClient = {
      chatCompletionStream: async () => {
        turnCount++;
        if (turnCount === 1) {
          return {
            role: "assistant",
            content: "I will read package.json",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "package.json", start_line: 1, end_line: 5 }),
                },
              },
            ],
          };
        }
        return {
          role: "assistant",
          content: "Finished inspecting package.json",
        };
      },
      chatCompletion: async () => ({
        role: "assistant",
        content: "done",
      }),
    };
    (agent as any).client = mockClient;
    (agent as any).plannerClient = mockClient;
    (agent as any).coderClient = mockClient;

    // Override read_file handler on agent spine for mock testing
    agent.getSpine().registerHandler("read_file", async (args) => ({
      success: true,
      output: `Mock content of ${args.path} lines ${args.start_line}-${args.end_line}`,
    }));

    try {
      await agent.runTurn("Inspect package.json");

      const messages = agent.getMessages();
      const toolMessage = messages.find((m) => m.role === "tool");
      assert.ok(toolMessage, "Turn must produce a tool response message");
      assert.strictEqual(toolMessage?.name, "read_file");
      assert.ok(toolMessage?.content?.includes("Mock content of package.json"));
    } finally {
      agent.shutdown();
    }
  });
});
