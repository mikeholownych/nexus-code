import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent, AgentObserver, observationKey } from "../src/agent.js";
import { startGateway, makeRepo } from "./helpers/fixtures.js";

describe("AgentObserver", () => {
  test("receives tool start/end and streamed assistant text in order", async () => {
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
      : { kind: "text", content: "There is one file." });
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const seen: string[] = [];
    let text = "";
    const observer: AgentObserver = {
      onToolStart: (e) => seen.push(`start:${e.tool}:${e.args.path}:${Boolean(e.callId)}`),
      onToolEnd: (e) => seen.push(`end:${e.tool}:${e.success}`),
      onAssistantDelta: (delta) => { if (!seen.includes("text")) seen.push("text"); text += delta; },
    };
    agent.setObserver(observer);
    try {
      const turn = await agent.runTurn("what is here?");
      assert.equal(turn.outcome, "NOT_REQUIRED");
      assert.deepEqual(seen, ["start:list_dir:.:true", "end:list_dir:true", "text"]);
      assert.equal(text, "There is one file.");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a denied tool reports onToolEnd with success=false", async () => {
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] }
      : { kind: "text", content: "ok" });
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const ends: Array<{ tool: string; success: boolean }> = [];
    agent.setObserver({ onToolEnd: (e) => ends.push({ tool: e.tool, success: e.success }) });
    try {
      await agent.runTurn("make x", async () => false);
      assert.deepEqual(ends, [{ tool: "write_file", success: false }]);
      assert.equal(fs.existsSync(`${repo}/x.txt`), false);
      assert.equal(agent.getCompletionSummary(), undefined);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

function traceFileFor(taskId: string): string {
  return path.join(os.homedir(), ".local/share/nexus/traces", taskId, "trace.jsonl");
}

function traceSpans(taskId: string): any[] {
  const file = traceFileFor(taskId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .flatMap((line) => JSON.parse(line).resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
}

function spanAttribute(span: any, key: string): unknown {
  const value = span.attributes.find((attribute: any) => attribute.key === key)?.value;
  return value?.stringValue ?? (value?.intValue !== undefined ? Number(value.intValue) : undefined) ?? value?.boolValue ?? value?.doubleValue;
}

describe("Agent local tracing", () => {
  test("worktree-backed interactive turns emit one turn span", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "worktree-trace-response" }));
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", worktree: true } as any);
    try {
      const result = await agent.runTurn("worktree trace prompt");
      assert.equal(result.execution, "COMPLETED");
      const turnSpans = traceSpans(agent.getTaskId()).filter((span) => span.name === "nexus.agent.turn");
      assert.equal(turnSpans.length, 1, "the public interactive turn has exactly one trace span");
    } finally {
      if (agent.getActiveWorktree()) agent.discardActiveWorktree();
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("agent turn records local trace spans", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "trace-response-marker" }));
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-trace-env-credential";
    try {
      const first = await agent.runTurn("trace-prompt-marker");
      const taskId = agent.getTaskId();
      const firstFile = traceFileFor(taskId);
      const firstSpans = traceSpans(taskId);
      const root = firstSpans.find((span) => span.name === "nexus.agent.turn");

      const limitGateway = await startGateway(() => ({ kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }));
      let limitRoot: any;
      let blockedRoot: any;
      let interruptedRoot: any;
      const limited = new AutonomousAgent({ endpoint: limitGateway.url, model: "m", maxSteps: 1, temperature: 0, workspace: repo, shell: "bash" } as any);
      try {
        const limitResult = await limited.runTurn("reach the one-step limit");
        assert.equal(limitResult.execution, "LIMIT_REACHED");
        limitRoot = traceSpans(limited.getTaskId()).find((span) => span.name === "nexus.agent.turn");
      } finally {
        limited.shutdown();
        await limitGateway.close();
      }

      const blockedGateway = await startGateway(() => ({ kind: "text", content: "must-not-be-requested" }));
      const blocked = new AutonomousAgent({ endpoint: blockedGateway.url, model: "m", maxSteps: 2, temperature: 0, workspace: repo, shell: "bash", contextLimit: 6000 } as any);
      try {
        const blockedResult = await blocked.runTurn("capacity block status");
        assert.equal(blockedResult.execution, "BLOCKED");
        blockedRoot = traceSpans(blocked.getTaskId()).find((span) => span.name === "nexus.agent.turn");
      } finally {
        blocked.shutdown();
        await blockedGateway.close();
      }

      const interruptGateway = await startGateway(() => ({ kind: "text", content: "cancelled-turn-response", delayMs: 300 }));
      const interrupted = new AutonomousAgent({ endpoint: interruptGateway.url, model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash" } as any);
      try {
        const pending = interrupted.runTurn("cancelled turn status");
        await new Promise((resolve) => setTimeout(resolve, 20));
        interrupted.requestCancel("trace status test");
        const interruptedResult = await pending;
        assert.equal(interruptedResult.execution, "INTERRUPTED");
        interruptedRoot = traceSpans(interrupted.getTaskId()).find((span) => span.name === "nexus.agent.turn");
      } finally {
        interrupted.shutdown();
        await interruptGateway.close();
      }

      const resumed = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
      try {
        await resumed.recoverFromTaskState(taskId);
        const second = await resumed.runTurn("resume-trace-prompt-marker", undefined, { resume: true });
        assert.equal(second.execution, "COMPLETED");
        assert.equal(resumed.getTaskId(), taskId);
        assert.equal(traceFileFor(resumed.getTaskId()), firstFile, "resumed task appends to the same trace file");
        const spans = traceSpans(taskId);
        assert.ok(fs.existsSync(firstFile), "trace is stored under the durable task ID");
        assert.ok(root, "completed turn has a root span");
        assert.ok(limitRoot, "limited turn has a root span");
        assert.equal(limitRoot.status.code, 0, "LIMIT_REACHED maps to OTel unset");
        assert.equal(spanAttribute(limitRoot, "nexus.turn.execution"), "LIMIT_REACHED");
        assert.ok(blockedRoot, "blocked turn has a root span");
        assert.equal(blockedRoot.status.code, 2, "BLOCKED maps to OTel error");
        assert.equal(spanAttribute(blockedRoot, "nexus.turn.execution"), "BLOCKED");
        assert.ok(interruptedRoot, "cancelled turn has a root span");
        assert.equal(interruptedRoot.status.code, 0, "INTERRUPTED maps to OTel unset");
        assert.equal(spanAttribute(interruptedRoot, "nexus.turn.execution"), "INTERRUPTED");
        assert.equal(root.status.code, 1, "COMPLETED maps to OTel ok");
        assert.equal(spanAttribute(root, "nexus.turn.execution"), first.execution);
        assert.equal(spanAttribute(root, "nexus.turn.outcome"), first.outcome);
        assert.equal(path.dirname(firstFile), path.join(os.homedir(), ".local/share/nexus/traces", taskId));
        assert.equal(spans.filter((span) => span.name === "nexus.agent.turn").length, 2);
        const serialized = fs.readFileSync(firstFile, "utf8");
        for (const secret of ["trace-prompt-marker", "resume-trace-prompt-marker", "trace-response-marker", "synthetic-trace-env-credential"]) {
          assert.equal(serialized.includes(secret), false, `trace excludes ${secret}`);
        }
      } finally {
        resumed.shutdown();
      }
    } finally {
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("model request spans are nested and contain no conversation payload", async () => {
    const gw = await startGateway((n) => n === 1
      ? { kind: "text", content: "model-response-payload-marker" }
      : { kind: "http", status: 400, body: "model-error-payload-marker" });
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    try {
      await agent.runTurn("model-request-prompt-marker");
      const successTaskId = agent.getTaskId();
      const root = traceSpans(successTaskId).find((span) => span.name === "nexus.agent.turn");
      const requests = traceSpans(successTaskId).filter((span) => span.kind === 3);
      const failed = await agent.runTurn("failed-model-prompt-marker");
      assert.notEqual(failed.execution, "COMPLETED");
      const failedRoot = traceSpans(agent.getTaskId()).filter((span) => span.name === "nexus.agent.turn").at(-1);
      const failedSpans = traceSpans(agent.getTaskId()).filter((span) => span.kind === 3);
      const errorSpans = failedSpans.filter((span) => span.status.code === 2);
      const rootIds = new Set(traceSpans(agent.getTaskId()).filter((span) => span.name === "nexus.agent.turn").map((span) => span.spanId));
      assert.ok(root, "turn root exists");
      assert.ok(requests.length > 0, "model request span exists");
      for (const span of requests) {
        assert.equal(span.parentSpanId, root.spanId, "request span is parented to its turn");
        assert.equal(span.status.code, 1, "successful request has ok status");
        assert.ok(spanAttribute(span, "gen_ai.operation.name"));
        assert.ok(spanAttribute(span, "gen_ai.provider.name"));
        assert.equal(spanAttribute(span, "gen_ai.request.model"), "m");
      }
      assert.equal(fs.readFileSync(traceFileFor(successTaskId), "utf8").includes("model-request-prompt-marker"), false);
      assert.equal(failedRoot?.status.code, 2, "FAILED and BLOCKED map to OTel error");
      assert.equal(spanAttribute(failedRoot, "nexus.turn.execution"), failed.execution);
      assert.ok(errorSpans.length > 0, "failed model request has an error span");
      for (const span of failedSpans) assert.ok(rootIds.has(span.parentSpanId), "every request span is parented to a turn");
      const serialized = fs.readFileSync(traceFileFor(agent.getTaskId()), "utf8");
      for (const secret of ["failed-model-prompt-marker", "model-error-payload-marker"]) assert.equal(serialized.includes(secret), false);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("findings distillation emits a nested model request span", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "findings-response-payload-marker" }));
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const taskId = agent.getTaskId();
    const root = (agent as any).safeStartTraceSpan("nexus.agent.turn", { "nexus.task.id": taskId });
    (agent as any).activeTraceSpanId = root.spanId;
    const callId = "findings-call";
    const source: any[] = [
      { role: "system", content: "system" },
      { role: "user", content: "findings-request-payload-marker" },
      { role: "assistant", tool_calls: [{ id: callId, function: { name: "list_dir", arguments: "{}" } }] },
      { role: "tool", tool_call_id: callId, content: "findings-tool-output-payload-marker" },
      { role: "assistant", content: "I inspected the output." },
    ];
    try {
      const recorded = await (agent as any).recordFindings(
        (agent as any).client,
        1,
        source,
        [observationKey("list_dir", "{}")],
      );
      assert.equal(recorded, true);
      (agent as any).safeEndTraceSpan(root, "ok");
      const spans = traceSpans(taskId);
      const request = spans.find((span) => span.kind === 3);
      assert.ok(request, "findings distillation emits a GenAI request span");
      assert.equal(request.parentSpanId, root.spanId);
      assert.equal(request.status.code, 1);
      assert.equal(spanAttribute(request, "gen_ai.operation.name"), "chat");
      assert.ok(spanAttribute(request, "gen_ai.provider.name"));
      assert.equal(spanAttribute(request, "gen_ai.request.model"), "m");
      const serialized = fs.readFileSync(traceFileFor(taskId), "utf8");
      for (const secret of ["findings-request-payload-marker", "findings-tool-output-payload-marker", "findings-response-payload-marker"]) {
        assert.equal(serialized.includes(secret), false);
      }
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("operator compaction model request is a nested client span", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "operator-compaction-response-marker" }));
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any, 1, { durable: false });
    const taskId = agent.getTaskId();
    const root = (agent as any).safeStartTraceSpan("nexus.agent.turn", { "nexus.task.id": taskId });
    (agent as any).activeTraceSpanId = root.spanId;
    (agent as any).messages = [
      { role: "system", content: "system" },
      { role: "user", content: "operator-compaction-request-payload-marker" },
      { role: "assistant", content: "old assistant context" },
      { role: "user", content: "current operator request" },
    ];
    try {
      const result = await agent.compactNow(true);
      assert.equal(result.ok, true);
      (agent as any).safeEndTraceSpan(root, "ok");
      const spans = traceSpans(taskId);
      const request = spans.find((span) => span.kind === 3);
      assert.ok(request, "operator LLM compaction emits a GenAI request span");
      assert.equal(request.parentSpanId, root.spanId, "request is parented to the active turn");
      assert.equal(request.status.code, 1);
      assert.equal(spanAttribute(request, "gen_ai.operation.name"), "chat");
      assert.ok(spanAttribute(request, "gen_ai.provider.name"));
      assert.equal(spanAttribute(request, "gen_ai.request.model"), "m");
      const serialized = fs.readFileSync(traceFileFor(taskId), "utf8");
      for (const secret of ["operator-compaction-request-payload-marker", "operator-compaction-response-marker"]) {
        assert.equal(serialized.includes(secret), false);
      }
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("subagent model requests are nested under the parent turn", async () => {
    const gw = await startGateway((_n, body) => {
      const messages = body?.messages ?? [];
      const isSubagent = JSON.stringify(messages).includes("[Subagent Objective]");
      if (isSubagent) return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "subagent-response-marker" } }] };
      const toolResults = messages.filter((message: any) => message.role === "tool").length;
      return toolResults === 0
        ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "Inspect the workspace." } }] }
        : { kind: "text", content: "parent-response-marker" };
    });
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    try {
      const result = await agent.runTurn("Use a subagent to inspect the workspace.");
      assert.equal(result.execution, "COMPLETED");
      const spans = traceSpans(agent.getTaskId());
      const root = spans.find((span) => span.name === "nexus.agent.turn");
      const requests = spans.filter((span) => span.kind === 3);
      assert.ok(root, "parent turn root exists");
      assert.equal(requests.length, 3, "parent, subagent, and parent-final requests share the task trace");
      for (const request of requests) {
        assert.equal(request.parentSpanId, root.spanId);
        assert.equal(request.status.code, 1);
        assert.equal(spanAttribute(request, "gen_ai.operation.name"), "chat");
        assert.equal(spanAttribute(request, "gen_ai.request.model"), "m");
      }
      const serialized = fs.readFileSync(traceFileFor(agent.getTaskId()), "utf8");
      for (const secret of ["Inspect the workspace", "subagent-response-marker", "parent-response-marker"]) {
        assert.equal(serialized.includes(secret), false);
      }
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("tool spans record safe identity and outcome only", async () => {
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "tool-argument-payload-marker" } }] }
      : { kind: "text", content: "tool-response" });
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, "tool-argument-payload-marker"));
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    try {
      await agent.runTurn("tool-prompt-payload-marker");
      const spans = traceSpans(agent.getTaskId());
      const root = spans.find((span) => span.name === "nexus.agent.turn");
      const tool = spans.find((span) => span.name === "nexus.agent.tool");
      assert.ok(tool, "tool dispatch emits a span");
      assert.equal(tool.parentSpanId, root.spanId);
      assert.equal(spanAttribute(tool, "nexus.tool.name"), "list_dir");
      assert.equal(spanAttribute(tool, "nexus.tool.success"), true);
      const serialized = fs.readFileSync(traceFileFor(agent.getTaskId()), "utf8");
      for (const secret of ["tool-argument-payload-marker", "tool-prompt-payload-marker"]) assert.equal(serialized.includes(secret), false);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("compaction spans preserve active and out-of-turn parentage without summary content", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "compaction-root-response" }));
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any, 1, { durable: false });
    try {
      await agent.runTurn("compaction-root-prompt");
      const system = { role: "system", content: "system" };
      const original = { role: "user", content: "old message to archive" };
      const retained = { role: "user", content: "retained summary message" };
      const activeRoot = (agent as any).safeStartTraceSpan("nexus.agent.turn", { "nexus.task.id": agent.getTaskId() });
      (agent as any).activeTraceSpanId = activeRoot.spanId;
      (agent as any).commitCompaction([system, original], [system, retained], {
        trigger: "auto", step: 2, beforeTokens: 900, afterTokens: 300, pressureOnly: true, summary: "compaction-summary-payload-marker",
      });
      (agent as any).safeEndTraceSpan(activeRoot, "ok");
      (agent as any).activeTraceSpanId = undefined;

      (agent as any).messages = [
        system,
        { role: "user", content: "out-of-turn-compaction-request-payload-marker" },
        { role: "assistant", content: "old assistant context" },
        { role: "user", content: "current operator request" },
      ];
      const outOfTurn = await agent.compactNow(true);
      assert.equal(outOfTurn.ok, true);
      const spans = traceSpans(agent.getTaskId());
      const activeCompact = spans.find((span) => span.name === "nexus.context.compaction" && span.parentSpanId === activeRoot.spanId);
      const outOfTurnCompact = spans.find((span) => span.name === "nexus.context.compaction" && span.attributes.some((attribute: any) => attribute.key === "nexus.compaction.trigger" && attribute.value.stringValue === "manual_llm"));
      const outOfTurnRequest = spans.find((span) => span.kind === 3 && span.parentSpanId === outOfTurnCompact?.spanId);
      assert.ok(activeCompact, "in-turn compaction is parented to the active turn");
      assert.ok(outOfTurnCompact, "out-of-turn committed compaction emits a span");
      assert.equal(outOfTurnCompact.parentSpanId, undefined, "out-of-turn compaction is a root, not a child of an ended turn");
      assert.ok(outOfTurnRequest, "out-of-turn LLM request is a child of its compaction span");
      assert.equal(outOfTurnRequest.status.code, 1);
      assert.equal(spanAttribute(activeCompact, "nexus.compaction.trigger"), "auto");
      assert.equal(spanAttribute(activeCompact, "nexus.compaction.before_tokens"), 900);
      assert.equal(spanAttribute(activeCompact, "nexus.compaction.after_tokens"), 300);
      const serialized = fs.readFileSync(traceFileFor(agent.getTaskId()), "utf8");
      for (const secret of ["compaction-summary-payload-marker", "out-of-turn-compaction-request-payload-marker", "operator-compaction-response-marker"]) {
        assert.equal(serialized.includes(secret), false);
      }
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("trace failures never interrupt an agent turn", async () => {
    const home = os.homedir();
    const traceParent = path.join(home, ".local", "share", "nexus");
    const traceDir = path.join(traceParent, "traces");
    fs.mkdirSync(traceDir, { recursive: true, mode: 0o700 });
    const gw = await startGateway(() => ({ kind: "text", content: "turn-survives-trace-error" }));
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const taskTraceDir = path.join(traceDir, agent.getTaskId());
    fs.symlinkSync(os.tmpdir(), taskTraceDir, "dir");
    try {
      const result = await agent.runTurn("trace initialization failure is isolated");
      assert.equal(result.execution, "COMPLETED");
      assert.equal(result.outcome, "NOT_REQUIRED");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.unlinkSync(taskTraceDir);
    }
  });
});
