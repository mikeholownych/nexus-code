import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutonomousAgent } from "../src/agent.js";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner_execution.js";
import type { UnitRunContext } from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { WorkUnit } from "../src/core/operation.js";
import type { ChatMessage, HarnessConfig } from "../src/types.js";
import type { TaskRecoveryResult } from "../src/core/state.js";
import type { TurnResult } from "../src/core/turn.js";

test("explicit operation-unit restart starts a fresh conversation instead of resuming discarded worktree history", async () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "Nexus system prompt" },
    {
      role: "user",
      content: "[Work unit 'u1': Implement feature] Part of the operation: Ship the feature\nTask:\nImplement feature",
    },
    { role: "assistant", content: "I edited files in the previous unit worktree." },
  ];
  const turnCalls: Array<{ prompt: string; resume?: boolean }> = [];
  const restartCalls: boolean[] = [];
  const recovery = {
    success: true,
    state: { currentOperation: null },
    obligationRecordPresent: true,
    interrupted: false,
    worktreeStatus: "consistent",
    candidateStatus: "no_candidate",
    invalidatedReceiptCount: 0,
    reconstructedStateSummary: {
      milestonesRecovered: 0,
      planPhasesRecovered: 0,
      messagesRecovered: 3,
      ephemeralPidsCleared: false,
      authorityResurrected: false,
    },
    diagnostics: [],
  } as unknown as TaskRecoveryResult;
  const turn = {
    execution: "COMPLETED",
    outcome: "NOT_REQUIRED",
    acceptance: "NOT_REQUESTED",
    modelStop: "NONE",
    finalOutputComplete: true,
    verification: null,
    interruption: null,
    inferenceFailure: null,
    steps: { used: 1, max: 5, limitReached: false },
    unverifiedChangesPending: false,
    finishedAt: new Date().toISOString(),
  } as TurnResult;
  const fakeAgent = {
    durable: false,
    getTaskId: () => "task-u1",
    getMessages: () => messages,
    recoverFromTaskState: async () => recovery,
    restartConversation: (priorChangesUnknown: boolean) => {
      restartCalls.push(priorChangesUnknown);
      messages.splice(0, messages.length, { role: "system", content: "Nexus system prompt" });
    },
    setProviderRecoveryHooks: () => undefined,
    checkpointDurableState: () => undefined,
    getObjective: () => ({ verification: [] }),
    getCompletionSummary: () => ({ summary: "completed from fresh task" }),
    runTurn: async (prompt: string, _objective: unknown, options: { resume?: boolean }) => {
      turnCalls.push({ prompt, resume: options.resume });
      return turn;
    },
    shutdown: () => undefined,
  } as unknown as AutonomousAgent;
  const executor = new AgentWorkUnitExecutor({
    baseConfig: {
      endpoint: "https://provider.invalid/v1",
      model: "test-model",
      workspace: "/tmp/nexus-operation-restart-workspace",
      shell: "bash",
      maxSteps: 5,
      temperature: 0,
    } as HarnessConfig,
    createAgent: () => fakeAgent,
  });
  const unit: WorkUnit = {
    id: "u1",
    title: "Implement feature",
    prompt: "Implement feature",
    dependsOn: [],
    requires: { capabilities: ["tools"] },
    status: "RUNNABLE",
    agentTaskId: "task-u1",
    reroutes: [],
    runs: 1,
    unknownResumes: 0,
    modelsUsed: [],
  };
  const resource: ResourceDescriptor = {
    id: "primary",
    endpoint: "https://provider.invalid/v1",
    provider: "https://provider.invalid",
    model: "test-model",
    capabilities: ["tools"],
    rank: 0,
  };
  const ctx: UnitRunContext = {
    objective: "Ship the feature",
    dependencies: [],
    operatorDecision: { label: "restart the unit from the integration tip", restart: true },
    bindAgentTask: () => undefined,
    observeFailure: () => null,
    observeSuccess: () => undefined,
    shouldYield: () => false,
  };

  const outcome = await executor.run(unit, resource, ctx);

  assert.equal(outcome.kind, "completed");
  assert.deepEqual(restartCalls, [false], "the existing obligation record should be preserved");
  assert.equal(turnCalls.length, 1);
  assert.equal(turnCalls[0].resume, false);
  assert.match(turnCalls[0].prompt, /operator decided: restart the unit from the integration tip/i);
  assert.match(turnCalls[0].prompt, /earlier conversation is not being continued/i);
  assert.doesNotMatch(turnCalls[0].prompt, /I edited files in the previous unit worktree/);
});
