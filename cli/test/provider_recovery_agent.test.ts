/**
 * Provider recovery in the agent loop: temporary provider failures (connection refused/reset, 429, 503, draining)
 * become loop state; the same inference step resumes over the preserved history, tools are never re-executed, and
 * the wait is visible in durable state, the turn result and operator notices.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { projectTurn, providerRecoveryNotice } from "../src/protocol.js";
import { DEFAULT_RECOVERY_POLICY, type RecoveryClock, type RecoveryPolicy } from "../src/core/provider_recovery.js";
import type { ProviderRecoveryRecord, TurnResult } from "../src/core/turn.js";
import { fakeClock, startGateway, type Gateway } from "./helpers/provider_fixture.js";

const policy = (p: Partial<RecoveryPolicy> = {}): RecoveryPolicy => ({ ...DEFAULT_RECOVERY_POLICY, ...p });

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-recovery-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

async function withAgent<T>(
  gws: Gateway[],
  clock: RecoveryClock,
  fn: (agent: AutonomousAgent, ctx: { repo: string; stateDir: string }) => Promise<T>,
  p: Partial<RecoveryPolicy> = {},
): Promise<T> {
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-recovery-state-"));
  const agent = new AutonomousAgent({
    endpoint: gws[0].url, fallbackEndpoints: gws.slice(1).map((g) => g.url),
    model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash",
    approvalMode: "auto", fullAccess: true,
  } as any);
  const a = agent as any;
  a.recoveryClock = clock;
  a.recoveryPolicy = policy(p);
  a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
  try {
    return await fn(agent, { repo, stateDir });
  } finally {
    agent.shutdown();
    for (const g of gws) await g.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

const recoveryOf = (r: TurnResult) => r.providerRecovery?.[0];

// ---------------------------------------------------------------- agent loop

describe("agent loop: temporary provider failures become loop state", () => {
  test("ECONNREFUSED then recovery: same step completes, cause chain preserved (1, 19)", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "recovered answer" }), { startDown: true });
    const clock = fakeClock(async (_ms, n) => { if (n === 3) await gw.up(); });
    await withAgent([gw], clock, async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "COMPLETED");
      assert.equal(r.modelStop, "FINAL_TEXT");
      const rec = recoveryOf(r)!;
      assert.equal(rec.state, "RESUMED");
      assert.equal(rec.submissions.length, 1);
      const failed = rec.submissions[0];
      assert.equal(failed.kind, "network_error");
      assert.equal(failed.execution, "NOT_EXECUTED");
      assert.match(failed.message, /cause: ECONNREFUSED/);
      assert.equal(gw.requests.length, 1, "exactly one submission reached the provider");
      assert.equal(gw.requests[0].id, rec.resumedRequestId);
      assert.notEqual(rec.resumedRequestId, failed.requestId);
      assert.equal(gw.requests[0].attempt, undefined, "a transport resubmission sends no task-retry header");
      assert.equal(gw.requests[0].previous, undefined);
      assert.ok(gw.probes >= 1);
    });
  });

  test("ECONNRESET after the request was sent: probe-gated replay with a fresh linked id (2)", async () => {
    const gw = await startGateway((n) => (n === 1 ? { kind: "reset" } : { kind: "text", content: "second time" }));
    await withAgent([gw], fakeClock(), async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "COMPLETED");
      const rec = recoveryOf(r)!;
      assert.equal(rec.submissions[0].execution, "UNKNOWN");
      assert.equal(rec.unknownReplays, 1);
      assert.ok(rec.probes >= 1);
      assert.equal(gw.requests.length, 2);
      assert.notEqual(gw.requests[1].id, gw.requests[0].id);
      assert.equal(rec.submissions[0].requestId, gw.requests[0].id);
      assert.equal(rec.resumedRequestId, gw.requests[1].id);
      assert.equal(gw.requests[1].attempt, undefined);
    });
  });

  test("a response cut off at the provider's time limit is not resubmitted unchanged: the replay, then the step's tool result, ask for less at once", async () => {
    const clock = fakeClock();
    const gw = await startGateway((n) => {
      if (n === 1) {
        clock.advance(600_000);
        return { kind: "error_frame", message: "timeout" };
      }
      if (n === 2) return { kind: "tools", calls: [{ name: "write_file", args: { path: "review.md", content: "# Review\n\nPart one.\n" } }] };
      return { kind: "text", content: "done" };
    });
    await withAgent([gw], clock, async (agent) => {
      const r = await agent.runTurn("write the review");
      const rec = recoveryOf(r)!;
      assert.equal(rec.submissions[0].kind, "provider_error_frame");
      assert.equal(rec.submissions[0].execution, "UNKNOWN");
      assert.ok(gw.requests.length >= 3);
      const NOTE = /^\[Nexus: your response at step 1 was cut off after 600 s, before it was complete, most likely because the provider ends a response that takes too long; none of it was used\. Respond with less at once\. Write a long file in parts: write_file with its first part, then add each further part with edit_file in later steps, replacing the file's last few lines \(enough that they occur nowhere earlier in it\) with those lines followed by the next part\. End each part where every bracket it opens is closed\./;
      const last = (i: number) => gw.requests[i].body.messages.at(-1);
      assert.ok(!String(last(0).content ?? "").includes("was cut off"));
      assert.equal(last(1).role, "user");
      assert.match(last(1).content, NOTE);
      // It reaches later steps in the step's tool result, and never stands in the conversation as a request.
      assert.ok(gw.requests[2].body.messages.some((m: any) => m.role === "tool" && NOTE.test(m.content)));
      const messages = (agent as any).messages as Array<{ role: string; content: unknown }>;
      assert.ok(!messages.some((m) => m.role === "user" && String(m.content).includes("was cut off")));
      assert.ok(fs.readFileSync(path.join((agent as any).config.workspace, "review.md"), "utf-8").startsWith("# Review"));
    });
  });

  test("a cut-off notice the step never delivered does not reach a later turn's step of the same number", async () => {
    const clock = fakeClock();
    const gw = await startGateway((n) => {
      if (n === 1) {
        clock.advance(600_000);
        return { kind: "error_frame", message: "timeout" };
      }
      if (n === 3) return { kind: "tools", calls: [{ name: "write_file", args: { path: "notes.md", content: "notes\n" } }] };
      return { kind: "text", content: "done" };
    });
    await withAgent([gw], clock, async (agent) => {
      await agent.runTurn("summarize");
      assert.match(String(gw.requests[1].body.messages.at(-1).content), /was cut off/, "the replay asked for less (else this proves nothing)");
      await agent.runTurn("write notes");
      assert.ok(gw.requests.length >= 4);
      const tools = gw.requests[3].body.messages.filter((m: any) => m.role === "tool");
      assert.ok(tools.length > 0 && !tools.some((m: any) => String(m.content).includes("was cut off")), JSON.stringify(tools).slice(0, 400));
    });
  });

  test("an ambiguous failure that did not run long is resubmitted as it was", async () => {
    const clock = fakeClock();
    const gw = await startGateway((n) => {
      if (n === 1) {
        clock.advance(30_000);
        return { kind: "error_frame", message: "worker lost" };
      }
      return { kind: "text", content: "ok" };
    });
    await withAgent([gw], clock, async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "COMPLETED");
      assert.equal(gw.requests.length, 2);
      assert.deepEqual(gw.requests[1].body.messages, gw.requests[0].body.messages);
    });
  });

  test("temporary 503 with Retry-After, then recovery (10)", async () => {
    const gw = await startGateway((n) => (n <= 2
      ? { kind: "http", status: 503, headers: { "retry-after": "2" }, body: JSON.stringify({ error: { code: "capacity_exhausted" } }) }
      : { kind: "text", content: "ok" }));
    const clock = fakeClock();
    await withAgent([gw], clock, async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "COMPLETED");
      assert.equal(gw.requests.length, 3);
      assert.ok(clock.sleeps.every((ms) => ms >= 2000 && ms <= 2200), `${clock.sleeps}`);
      assert.equal(recoveryOf(r)?.condition, "OVERLOADED");
      assert.equal(gw.probes, 0, "an overloaded provider is answering; it is not probed");
    });
  });

  test("draining 503 (gateway_restarting) waits, probes and resumes", async () => {
    const gw = await startGateway((n) => (n === 1
      ? { kind: "http", status: 503, headers: { "retry-after": "1" }, body: JSON.stringify({ error: { code: "gateway_restarting", message: "draining" } }) }
      : { kind: "text", content: "ok" }));
    await withAgent([gw], fakeClock(), async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "COMPLETED");
      assert.equal(recoveryOf(r)?.submissions[0].condition, "DRAINING");
      assert.ok(gw.probes >= 1);
    });
  });

  test("permanent 4xx fails the turn without entering recovery waits (11)", async () => {
    const gw = await startGateway(() => ({ kind: "http", status: 400, body: JSON.stringify({ error: { message: "bad tool schema" } }) }));
    const clock = fakeClock();
    await withAgent([gw], clock, async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "FAILED");
      assert.equal(r.inferenceFailure?.condition, "REQUEST_REJECTED");
      assert.equal(gw.requests.length, 1);
      assert.equal(clock.sleeps.length, 0);
      assert.equal(recoveryOf(r)?.state, "NOT_RECOVERABLE");
    });
  });

  test("repeated ambiguous 500s: bounded replays then a FAILED turn that says recovery was exhausted (14)", async () => {
    const gw = await startGateway(() => ({ kind: "http", status: 500, body: '{"error":"boom"}' }));
    await withAgent([gw], fakeClock(), async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "FAILED");
      assert.equal(gw.requests.length, 3);
      assert.equal(new Set(gw.requests.map((q) => q.id)).size, 3);
      assert.equal(recoveryOf(r)?.state, "EXHAUSTED");
      assert.match(r.detail ?? "", /provider recovery exhausted/);
    }, { maxUnknownReplays: 2 });
  });

  test("ambiguous failure with a backup endpoint: the replay goes to the backup, after a probe (15)", async () => {
    const primary = await startGateway(() => ({ kind: "reset" }));
    const backup = await startGateway(() => ({ kind: "text", content: "from backup" }));
    await withAgent([primary, backup], fakeClock(), async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "COMPLETED");
      assert.equal(primary.requests.length, 1);
      assert.equal(backup.requests.length, 1);
      assert.equal(recoveryOf(r)?.submissions[0].requestId, primary.requests[0].id);
      assert.equal(recoveryOf(r)?.resumedRequestId, backup.requests[0].id);
      assert.ok(backup.probes >= 1);
    });
  });

  test("deadline exhaustion fails the turn with the transport cause intact (5, 19)", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "never" }), { startDown: true });
    await withAgent([gw], fakeClock(), async (agent) => {
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "FAILED");
      assert.equal(r.inferenceFailure?.kind, "network_error");
      assert.ok(r.inferenceFailure?.transportCause?.some((c) => c.code === "ECONNREFUSED"));
      assert.equal(recoveryOf(r)?.state, "EXHAUSTED");
      assert.match(r.detail ?? "", /provider recovery exhausted/);
    }, { deadlineMs: 30_000 });
  });

  test("cancellation while waiting interrupts the turn in phase provider_wait (4)", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "never" }), { startDown: true });
    let agentRef: AutonomousAgent | undefined;
    const clock = fakeClock((_ms, n) => { if (n === 2) agentRef?.requestCancel("test"); });
    await withAgent([gw], clock, async (agent) => {
      agentRef = agent;
      const r = await agent.runTurn("do work");
      assert.equal(r.execution, "INTERRUPTED");
      assert.equal(r.interruption?.phase, "provider_wait");
      assert.equal(recoveryOf(r)?.state, "CANCELLED");
      assert.equal(gw.requests.length, 0);
    });
  });

  test("durable resume state survives the wait and recovery continues the same work (17, 18)", async () => {
    const gw = await startGateway((n) => (n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
      : { kind: "text", content: "listing reviewed" }));
    let observedDuringWait: any;
    const tools: string[] = [];
    const notices: Array<{ state: string; discarded: boolean }> = [];
    let agentRef: AutonomousAgent | undefined;
    const clock = fakeClock(async (_ms, n) => {
      if (n === 1) {
        const a = agentRef as any;
        observedDuringWait = {
          phase: agentRef!.getTurnLifecycle()?.phase,
          recovery: agentRef!.getProviderRecovery()?.state,
          saved: a.stateManager.loadTaskState(a.currentTaskId),
        };
        await gw.up();
      }
    });
    await withAgent([gw], clock, async (agent) => {
      agentRef = agent;
      agent.setObserver({
        onToolStart: (e) => tools.push(e.tool),
        onProviderRecovery: ({ record, discardedPartialOutput }) => notices.push({ state: record.state, discarded: discardedPartialOutput }),
      });
      // Take the provider down between step 1 (tool call) and step 2 (inference over the tool result).
      const a = agent as any;
      const dispatch = a.dispatchToolCall.bind(a);
      a.dispatchToolCall = async (...args: any[]) => {
        const out = await dispatch(...args);
        await gw.down();
        return out;
      };

      const r = await agent.runTurn("look around");
      assert.equal(r.execution, "COMPLETED");
      assert.equal(r.modelStop, "FINAL_TEXT");
      assert.deepEqual(tools, ["list_dir"], "the tool ran once; recovery never re-executes tools");

      assert.equal(observedDuringWait.phase, "provider_wait");
      assert.equal(observedDuringWait.recovery, "WAITING");
      assert.equal(observedDuringWait.saved.providerRecovery.state, "WAITING");
      assert.equal(observedDuringWait.saved.providerRecovery.step, 2);
      const savedMessages = observedDuringWait.saved.messages as any[];
      assert.ok(savedMessages.some((m) => m.role === "tool"), "tool evidence is durable during the wait");
      assert.equal(savedMessages.filter((m) => m.role === "user" && String(m.content).includes("look around")).length, 1, "objective preserved once, no duplicate submission");

      assert.equal(gw.requests.length, 2);
      const resumed = gw.requests[1];
      assert.equal(resumed.id, recoveryOf(r)?.resumedRequestId);
      assert.equal(resumed.body.messages.length, savedMessages.length, "the resumed request carries exactly the preserved history");
      assert.equal(resumed.body.messages.at(-1).role, "tool");
      assert.equal(agent.getProviderRecovery(), null);
      assert.deepEqual(notices.map((x) => x.state).filter((s) => s !== "PROBING"), ["WAITING", "RESUMED"]);
    });
  });
});

describe("operator surfaces", () => {
  const record: ProviderRecoveryRecord = {
    state: "WAITING", step: 2, startedAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T12:00:00.000Z",
    nextAttemptAt: "2026-10-07T12:00:04.000Z", condition: "TEMPORARILY_UNAVAILABLE", probes: 0, waitedMs: 0, unknownReplays: 0,
    submissions: [{ requestId: "r1", attempt: 1, failedAt: "2026-10-07T12:00:00.000Z", kind: "network_error", condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED", message: "Bearer sk-secret-token-abcdefghijklmnop failed" }],
    policy: { deadlineMs: 1, maxDelayMs: 1, maxUnknownReplays: 1 },
  };

  test("sidecar notices describe the wait and resume; probes are silent", () => {
    assert.match(providerRecoveryNotice(record, true)!, /waiting 4s.*Work is preserved\. The partial response was discarded\./);
    assert.equal(providerRecoveryNotice({ ...record, state: "PROBING" }, false), undefined);
    assert.match(providerRecoveryNotice({ ...record, state: "RESUMED", waitedMs: 7000 }, false)!, /recovered after 7s/);
  });

  test("projected turns redact recovery submission messages", () => {
    const turn = { providerRecovery: [record], inferenceFailure: null, verification: null, interruption: null } as unknown as TurnResult;
    assert.doesNotMatch(JSON.stringify(projectTurn(turn)), /sk-secret-token/);
  });
});
