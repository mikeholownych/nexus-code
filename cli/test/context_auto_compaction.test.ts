/**
 * Deterministic tests for automatic context management (auto-compaction) within turns.
 *
 * Covers the within-turn automatic continuation requirement: without an operator
 * `/compact`, a long autonomous turn keeps dispatching while the gateway stays
 * fail-closed (never exceeds the limit), re-compacting adaptively and escalating
 * reduction hardness without thrashing on no-op passes.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { calculateContextBudget } from "../src/tokens.js";
import {
  estimateNextRequestTokens,
  isContextPressureHigh,
  isContextAdmissible,
  countTokens,
} from "../src/tokens.js";
import { gateway, repo, mute, roles } from "./helpers/capacity_fixture.js";

describe("predictive context estimation", () => {
  test("estimateNextRequestTokens provides accurate predictions", () => {
    const messages = [
      { role: "system" as const, content: "System prompt" },
      { role: "user" as const, content: "Hello" },
    ];
    const tools = [{ type: "function" as const, function: { name: "test", description: "test", parameters: {} } }];
    const result = estimateNextRequestTokens(messages, tools, 65536, 8192, 4096, 1000);
    assert.ok(result.estimatedPromptTokens >= 0);
    assert.equal(result.estimatedTokens, result.estimatedPromptTokens);
    assert.equal(result.completionReserveTokens, 8192);
    assert.equal(result.toolResponseReserveTokens, 4096);
    assert.equal(result.safetyMarginTokens, 1000);
    assert.ok(result.totalPredictedTokens > result.estimatedPromptTokens);
    assert.ok(result.utilizationPercent >= 0 && result.utilizationPercent <= 100);
  });

  test("estimateNextRequestTokens scales utilization with context size", () => {
    const small = estimateNextRequestTokens([{ role: "user" as const, content: "hi" }], [], 65536, 8192, 4096, 1000);
    const large = estimateNextRequestTokens([{ role: "user" as const, content: "x".repeat(20000) }], [], 65536, 8192, 4096, 1000);
    assert.ok(large.utilizationPercent > small.utilizationPercent);
  });

  test("isContextPressureHigh true when predicted request exceeds limits", () => {
    // ~200k chars ≈ 50k tokens; with completion+tool+margin reserves the prediction
    // exceeds an 80% utilization of the 65536 budget.
    const big = [{ role: "user" as const, content: "x".repeat(200_000) }];
    assert.equal(isContextPressureHigh(big, [], 65536, 80, 8192, 4096, 1000), true);
  });

  test("isContextPressureHigh false for a tiny budget", () => {
    const tiny = [{ role: "user" as const, content: "hello world" }];
    assert.equal(isContextPressureHigh(tiny, [], 65536, 80, 8192, 4096, 1000), false);
  });

  test("isContextAdmissible enforces reserves correctly", () => {
    assert.equal(isContextAdmissible(50000, 65536, 8192, 4096), true); // 50000+8192+4096=62288 <= 65536
    assert.equal(isContextAdmissible(55000, 65536, 8192, 4096), false); // 55000+8192+4096=68188>65536
    assert.equal(isContextAdmissible(50000, 60000, 8192, 4096), false);
  });

  test("countTokens works on various inputs", () => {
    assert.ok(countTokens("hello") > 0);
    assert.equal(countTokens(""), 0);
    assert.equal(countTokens(null as any), 0);
    assert.equal(countTokens(undefined as any), 0);
  });
});

describe("automatic mid-turn context compaction", () => {
  afterEach(() => new Promise((r) => setTimeout(r, 100)));
  test("a sustained turn auto-compacts (without operator /compact) and never exceeds the budget", async () => {
    const limit = 50_000;
    const completionReserve = 8_192;
    const toolResponseReserve = 4_096;
    const agent = new AutonomousAgent({
      endpoint: "http://localhost:1234/v1",
      model: "test-model",
      workspace: process.cwd(),
      maxSteps: 10,
      shell: "bash",
      contextLimit: limit,
      completionReserveTokens: completionReserve,
      toolResponseReserveTokens: toolResponseReserve,
    } as any);
    const dispatched: number[] = [];
    const admissionLogs: string[] = [];
    let turn = 0;
    (agent as any).client = {
      chatCompletionStream: async (messages: any[], tools: any[]) => {
        const budget = calculateContextBudget(messages, tools, limit).totalActiveTokens;
        dispatched.push(budget);
        assert.ok(budget + completionReserve + toolResponseReserve <= limit, `over-budget dispatch at step ${turn + 1}`);
        turn++;
        if (turn <= 6) {
          const id = `cycle-${turn}`;
          return {
            role: "assistant",
            content: `<thought>$${turn === 1 ? "DURABLE_AUTO_FINDING_1" : `Finding ${turn}`}: continue.</thought>`,
            tool_calls: [{ id, type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "src" }) } }],
          };
        }
        return { role: "assistant", content: "Done." };
      },
    };
    (agent as any).bridge.executeTool = async (_name: string) => ({
      success: true,
      output: `listing\n${"sample-line\n".repeat(4_500)}`,
    });
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      if (String(args[0]).startsWith("[context_admission]")) admissionLogs.push(String(args[0]));
      else originalLog(...args);
    };
    try {
      const durationStart = Date.now();
      const result = await agent.runTurn("Implement and verify a bounded cache across multiple steps.");
      const durationMs = Date.now() - durationStart;
      void durationMs;
      assert.notEqual(result.execution, "BLOCKED", "automatic compaction must let the turn continue, not fall over");
      assert.ok(turn >= 7, "the sustained run should progress beyond the single-step baseline");
      assert.ok(dispatched.every((estimate) => estimate + completionReserve + toolResponseReserve <= limit), "every dispatched request must stay within budget");
    } finally {
      console.log = originalLog;
      agent.shutdown();
    }
    const autoCompacted = admissionLogs.filter((line) => line.includes("state=auto_compacted"));
    assert.ok(autoCompacted.length >= 1, "expected at least one automatic in-turn compaction, got none");
    const finalAdmissions = admissionLogs.filter((line) => line.includes("state=admitted"));
    const compactedTrue = finalAdmissions.filter((line) => line.includes("compacted=true"));
    assert.ok(compactedTrue.length >= 1, "expected at least one auto-compacted admission");
    // Reserves must be reported on every admission log line regardless of state.
    assert.ok(admissionLogs.every((line) => line.includes(`completion_reserve=${completionReserve}`) && line.includes(`tool_response_reserve=${toolResponseReserve}`)));
    const finalHistory = agent.getMessages().map((m) => typeof m.content === "string" ? m.content : "").join("\n");
    assert.ok(finalHistory.includes("DURABLE_AUTO_FINDING_1"), "the first-turn decision must survive auto-compactions");
  });

  test("compaction escalates but stops (anti-thrashing) when even the strongest pass cannot reclaim the irreducible user payload", async () => {
    // The only content auto-compaction must never drop is the current user message; when that alone
    // exceeds the budget the attempt ladder stops (bounded attempts) and the turn fails fail-closed
    // before any inference — while a later, affordable turn is still recoverable (no thrash wedge).
    const gw = await gateway(() => ({ text: "unexpected" }));
    const ws = repo({});
    const agent = mute(new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 5, temperature: 0, workspace: ws, shell: "bash", contextLimit: 30000 } as any));
    let madeAttempt = false;
    let attemptsSeen = 0;
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      const line = String(args[0]);
      if (line.startsWith("[context_admission]") && line.includes("compaction_insufficient")) {
        madeAttempt = true;
        attemptsSeen = Math.max(attemptsSeen, Number(/(?:attempts=)(\d+)/.exec(line)?.[1] ?? 0));
      }
      if (!line.startsWith("[context_admission]")) originalLog(...args);
    };
    try {
      const huge = "blocking-payload ".repeat(Math.ceil(300_000 / 17)); // ~300k chars >> 30k limit
      const r1 = await agent.runTurn(`read the big file ${huge}`);
      assert.equal(r1.execution, "BLOCKED");
      assert.equal(r1.reason, "CONTEXT_CAPACITY_EXCEEDED");
      assert.equal(gw.requests, 0, "the admission was refused before any gateway call");
      assert.ok(madeAttempt, "a compaction attempt should have been made before giving up");
      assert.ok(attemptsSeen <= 5, `anti-thrashing: at most 5 attempts, saw ${attemptsSeen}`);
      // The refused user message is withdrawn, so a small follow-up turn still succeeds.
      const retry = await agent.runTurn("again");
      assert.equal(retry.execution, "COMPLETED", "refusal must not wedge subsequent affordable turns");
      assert.equal(gw.requests, 1);
    } finally {
      console.log = originalLog;
      agent.shutdown(); await gw.close(); fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});