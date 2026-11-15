/**
 * DV-2: repeated verifier failures that show no convergence (same failure on changing candidates, A/B alternation,
 * a rising failing-test count) stop the turn BLOCKED with the attempt history. The signal never produces success.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";
import { assertTurnResultInvariants, summarizeTurn } from "../src/core/turn.js";
import { projectTurn } from "../src/protocol.js";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner.js";
import { attemptEvidence, convergenceHistory, convergenceSignal, createLedger, recordAttempt, type VerificationAttempt } from "../src/core/objective.js";

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, extra: Partial<typeof DEFAULT_CONTINUATION> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, ...extra },
});

let seq = 0;
const failed = (names: string[], extra: Partial<VerificationAttempt> = {}): Omit<VerificationAttempt, "n" | "at"> => ({
  command: "make test",
  inputs: `cand${++seq}`,
  status: "FAILED",
  filtered: false,
  failedCheck: names.length ? `not ok 1 - ${names[0]}` : "boom",
  classification: "CANDIDATE_FAILED",
  ...(names.length ? { failingTests: names } : {}),
  ...extra,
});
const ledgerOf = (...attempts: Array<Omit<VerificationAttempt, "n" | "at">>) => {
  const ledger = createLedger("obj");
  for (const a of attempts) recordAttempt(ledger, a);
  return ledger;
};

describe("DV-2 convergenceSignal", () => {
  test("three different candidates with the same failing check is stalled, with the attempts attached", () => {
    const s = convergenceSignal(ledgerOf(failed(["a"]), failed(["a"]), failed(["a"])));
    assert.equal(s.state, "stalled");
    assert.equal(s.attempts.length, 3);
    assert.match(s.evidence, /same failing tests \(untrusted verifier output: "a"\) in 3 consecutive attempts/);
    const bare = convergenceSignal(ledgerOf(failed([]), failed([]), failed([]), failed([])));
    assert.equal(bare.state, "stalled");
    assert.match(bare.evidence, /same failed check \(untrusted verifier output: "boom"\)/);
  });

  test("the same set in another order is the same failure", () => {
    assert.equal(convergenceSignal(ledgerOf(failed(["a", "b"]), failed(["b", "a"]), failed(["a", "b"]))).state, "stalled");
  });

  test("a changing failure set does not trip it", () => {
    assert.equal(convergenceSignal(ledgerOf(failed(["a", "b", "c"]), failed(["a", "b"]), failed(["a"]))).state, "converging");
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["b"]), failed(["c"]))).state, "converging");
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["a"]), failed(["b"]))).state, "converging");
  });

  test("the same failure on unchanged inputs is not a stall (the agent changed nothing)", () => {
    const same = { inputs: "same" };
    assert.equal(convergenceSignal(ledgerOf(failed(["a"], same), failed(["a"], same), failed(["a"], same))).state, "converging");
  });

  test("A/B/A/B alternation is oscillating", () => {
    const s = convergenceSignal(ledgerOf(failed(["a"]), failed(["b"]), failed(["a"]), failed(["b"])));
    assert.equal(s.state, "oscillating");
    assert.equal(s.attempts.length, 4);
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["b"]), failed(["a"]))).state, "converging");
  });

  test("a strictly rising failing-test count is diverging; a plateau is not", () => {
    const s = convergenceSignal(ledgerOf(failed(["a"]), failed(["a", "b"]), failed(["a", "b", "c"])));
    assert.equal(s.state, "diverging");
    assert.match(s.evidence, /1 -> 2 -> 3/);
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["b", "c"]), failed(["d", "e"]))).state, "converging");
  });

  test("ENVIRONMENT, timed-out, skipped and unclassified attempts are neither progress nor failure", () => {
    const env = failed([], { classification: "ENVIRONMENT", failedCheck: "boom" });
    const timedOut = failed([], { status: "TIMED_OUT", failedCheck: undefined, classification: undefined });
    const skipped = failed(["a"], { status: "SKIPPED_UNCHANGED_INPUTS" });
    const old = failed(["a"], { classification: undefined });
    const noise = [env, timedOut, skipped, old];
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), ...noise, failed(["a"]))).state, "converging", "two real failures plus noise are still two");
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), env, failed(["a"]), skipped, failed(["a"]))).state, "stalled", "noise between real failures does not break the run");
    assert.equal(convergenceSignal(ledgerOf(...noise, ...noise, ...noise)).state, "converging");
  });

  test("a requirement verifier's failures are not a task-verifier stall", () => {
    const req = () => failed(["a"], { requirementId: "R1" });
    assert.equal(convergenceSignal(ledgerOf(req(), req(), req())).state, "converging");
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), req(), failed(["a"]), req(), failed(["a"]))).state, "stalled", "task failures still count around them");
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["a"]), req(), req())).state, "converging");
  });

  test("a pass ends the history", () => {
    const pass: Omit<VerificationAttempt, "n" | "at"> = { command: "make test", inputs: "p", status: "PASSED" };
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["a"]), pass, failed(["a"]))).state, "converging");
  });

  test("thresholds are respected, and attempts judged once are not judged again", () => {
    const two = ledgerOf(failed(["a"]), failed(["a"]));
    assert.equal(convergenceSignal(two).state, "converging");
    assert.equal(convergenceSignal(two, 2).state, "stalled");
    const four = ledgerOf(failed(["a"]), failed(["a"]), failed(["a"]), failed(["a"]));
    assert.equal(convergenceSignal(four, 5).state, "converging");
    four.convergenceResetAfter = 4;
    assert.equal(convergenceSignal(four).state, "converging");
    recordAttempt(four, failed(["a"]));
    recordAttempt(four, failed(["a"]));
    assert.equal(convergenceSignal(four).state, "converging");
    recordAttempt(four, failed(["a"]));
    assert.equal(convergenceSignal(four).state, "stalled");
  });

  test("an old ledger without structured fields or a reset marker loads and is converging", () => {
    const old = JSON.parse(JSON.stringify(createLedger("obj")));
    for (let i = 1; i <= 4; i++) old.verification.push({ n: i, command: "make test", inputs: `i${i}`, status: "FAILED", failedCheck: "FAIL x", at: "t" });
    assert.equal(convergenceSignal(old).state, "converging");
  });

  test("the history is capped, redacted and carries candidate ids", () => {
    const attempts = Array.from({ length: 14 }, (_, i) => ({ n: i + 1, at: "t", ...failed(["a"], { failedCheck: "token=hunter2hunter2 " + "x".repeat(500) }) }));
    const h = convergenceHistory(attempts);
    assert.equal(h.length, 10);
    assert.ok(h[0].failedCheck!.length <= 200);
    assert.doesNotMatch(JSON.stringify(h), /hunter2hunter2/);
    assert.match(h[0].candidate, /^cand\d+$/);
  });

  test("a turn reason of VERIFIER_NOT_CONVERGING needs BLOCKED, NOT_ESTABLISHED and its history", () => {
    const base: any = {
      execution: "BLOCKED", outcome: "NOT_ESTABLISHED", acceptance: "NOT_REQUESTED", reason: "VERIFIER_NOT_CONVERGING", modelStop: "NONE",
      finalOutputComplete: false, verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 1, limitReached: false },
      unverifiedChangesPending: true, finishedAt: "t",
    };
    assert.throws(() => assertTurnResultInvariants(base), /attempt history/);
    assert.throws(() => assertTurnResultInvariants({ ...base, execution: "COMPLETED", convergence: { state: "stalled", evidence: "e", attempts: [] } }), /BLOCKED/);
    const ok = assertTurnResultInvariants({ ...base, convergence: { state: "stalled", evidence: "e", attempts: [] } });
    assert.match(summarizeTurn(ok).line, /VERIFIER_NOT_CONVERGING: e.*Nothing is verified/);
  });
});

const many = (total: number, extra: Partial<VerificationAttempt> = {}) =>
  failed(Array.from({ length: 10 }, (_, i) => `t${i}`), { failingTotal: total, failingTruncated: true, ...extra });

describe("DV-2 review fixes", () => {
  test("attemptEvidence keeps the uncapped failing count and says when the list was cut", () => {
    const out = Array.from({ length: 40 }, (_, i) => `not ok ${i + 1} - t${i}`).join("\n") + "\nℹ tests 40\n";
    const ev = attemptEvidence(out, 1);
    assert.equal(ev.failingTests!.length, 10);
    assert.equal(ev.failingTotal, 40);
    assert.equal(ev.failingTruncated, true);
    const small = attemptEvidence("not ok 1 - a\nℹ tests 1\n", 1);
    assert.equal(small.failingTotal, 1);
    assert.equal(small.failingTruncated, undefined);
  });

  test("a shrinking truncated failure set does not stall; the same truncated list with the same total does", () => {
    assert.equal(convergenceSignal(ledgerOf(many(40), many(25), many(12))).state, "converging");
    assert.equal(convergenceSignal(ledgerOf(many(40), many(40), many(40))).state, "stalled");
    assert.equal(convergenceSignal(ledgerOf(many(40), many(40), failed(Array.from({ length: 10 }, (_, i) => `t${i}`), { failingTruncated: true }))).state, "converging", "an unknown total abstains");
  });

  test("diverging is detected through totals above the cap, and abstains when a truncated total is unknown", () => {
    const s = convergenceSignal(ledgerOf(many(12), many(20), many(30)));
    assert.equal(s.state, "diverging");
    assert.match(s.evidence, /12 -> 20 -> 30/);
    const unknown = (k: number) => failed(Array.from({ length: 10 }, (_, i) => `u${i}`), { failingTruncated: true, failingTotal: k });
    assert.equal(convergenceSignal(ledgerOf(unknown(12), failed(Array.from({ length: 10 }, (_, i) => `v${i}`), { failingTruncated: true }), unknown(30))).state, "converging");
  });

  test("history is partitioned by command", () => {
    const other = (names: string[]) => failed(names, { command: "npm test" });
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), other(["a"]), failed(["a"]), other(["a"]))).state, "converging", "two per command is below the threshold");
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["a"]), other(["a"]))).state, "converging", "the judged command is the latest one");
    assert.equal(convergenceSignal(ledgerOf(other(["a"]), failed(["a"]), other(["a"]), failed(["a"]), other(["a"]))).state, "stalled", "npm test alone reaches three");
  });

  test("filtered runs do not take part in alternation", () => {
    const filtered = failed(["a"], { filtered: true });
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["b"]), filtered, failed(["b"]))).state, "converging");
    assert.equal(convergenceSignal(ledgerOf(failed(["a"]), failed(["b"]), failed(["a"]), failed(["b"]))).state, "oscillating");
  });

  test("a check-only failure needs one more attempt, and the exit code is part of the key", () => {
    assert.equal(convergenceSignal(ledgerOf(failed([], { exitCode: 1 }), failed([], { exitCode: 1 }), failed([], { exitCode: 1 }))).state, "converging");
    assert.equal(convergenceSignal(ledgerOf(failed([], { exitCode: 1 }), failed([], { exitCode: 1 }), failed([], { exitCode: 1 }), failed([], { exitCode: 1 }))).state, "stalled");
    assert.equal(convergenceSignal(ledgerOf(failed([], { exitCode: 1 }), failed([], { exitCode: 2 }), failed([], { exitCode: 1 }), failed([], { exitCode: 2 }))).state, "oscillating");
  });

  test("evidence and history redact secrets, neutralise controls and label names as untrusted", () => {
    const s = convergenceSignal(ledgerOf(...[1, 2, 3, 4].map(() => failed([], { failedCheck: "FAIL token=hunter2hunter2 \u202e\u001b[31mx" }))));
    assert.equal(s.state, "stalled");
    assert.doesNotMatch(s.evidence, /hunter2hunter2|\u202e|\u001b/);
    const named = convergenceSignal(ledgerOf(failed(["a"]), failed(["a"]), failed(["a"])));
    assert.match(named.evidence, /untrusted verifier output/);
    const h = convergenceHistory([{ n: 1, at: "t", ...failed(["a"], { command: "make test TOKEN=hunter2hunter2 \u202e" }) }]);
    assert.doesNotMatch(JSON.stringify(h), /hunter2hunter2|\u202e/);
  });

  test("projectTurn redacts the convergence evidence and the attempt commands", () => {
    const turn: any = {
      execution: "BLOCKED", outcome: "NOT_ESTABLISHED", acceptance: "NOT_REQUESTED", reason: "VERIFIER_NOT_CONVERGING", modelStop: "NONE",
      finalOutputComplete: false, verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 1, limitReached: false },
      unverifiedChangesPending: true, finishedAt: "t",
      convergence: { state: "stalled", evidence: "same check token=hunter2hunter2", attempts: [{ n: 1, command: "make test TOKEN=hunter2hunter2", status: "FAILED", candidate: "abc", failedCheck: "FAIL token=hunter2hunter2", failingTests: ["x token=hunter2hunter2"] }] },
    };
    assert.doesNotMatch(JSON.stringify(projectTurn(turn)), /hunter2hunter2/);
    assert.equal(projectTurn(turn).convergence?.state, "stalled");
  });

  test("the operation runner names the reason and state in the retry/revise question", () => {
    const executor = new AgentWorkUnitExecutor({ baseConfig: {} as HarnessConfig });
    const turn = {
      execution: "BLOCKED", outcome: "NOT_ESTABLISHED", reason: "VERIFIER_NOT_CONVERGING", detail: "e", steps: { used: 1, max: 5 }, modelStop: "NONE",
      convergence: { state: "oscillating", evidence: "the failure alternated between two sets across the last 4 attempts", attempts: [] },
    };
    const r = (executor as any).classify({ id: "u", title: "Unit", role: "implementer" }, { id: "r1", model: "m" }, turn, undefined, null, { observeSuccess() {} }, false);
    assert.equal(r.kind, "failed");
    assert.match(r.reason, /VERIFIER_NOT_CONVERGING \(oscillating\)/);
    assert.match(r.question, /VERIFIER_NOT_CONVERGING.*oscillating/);
    assert.deepEqual(r.options.map((o: any) => o.action.kind), ["retry", "revise"]);
  });

  test("a restored ledger keeps the reset marker", async () => {
    const ledger = ledgerOf(failed(["a"]), failed(["a"]), failed(["a"]));
    ledger.convergenceResetAfter = 3;
    const repo = makeRepo();
    const gw = await startGateway(() => ({ kind: "text", content: "ok" }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      agent.restoreSession([{ role: "system", content: "s" }], false, JSON.parse(JSON.stringify(ledger)));
      const restored = agent.getObjective()!;
      assert.equal(restored.convergenceResetAfter, 3);
      assert.equal(convergenceSignal(restored).state, "converging");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

const write = (name: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content: `${name}\n` } }] });
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };
const script = (...replies: Reply[]) => (n: number): Reply => replies[n - 1] ?? { kind: "text", content: "stopping" };

describe("DV-2 at the agent layer", () => {
  test("three candidates failing the same check end the turn BLOCKED with the attempt history, not looping", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\t@echo 'not ok 1 - adds numbers'\n\t@echo 'ℹ tests 1'\n\t@exit 1\n" });
    const gw = await startGateway(script(write("a.txt"), done, write("b.txt"), done, write("c.txt"), done, write("d.txt"), done, write("e.txt"), done));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      assert.equal(turn.execution, "BLOCKED");
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.reason, "VERIFIER_NOT_CONVERGING");
      assert.equal(turn.convergence?.state, "stalled");
      assert.equal(turn.convergence?.attempts.length, 3);
      assert.deepEqual(turn.convergence?.attempts.map((a) => a.failingTests), [["adds numbers"], ["adds numbers"], ["adds numbers"]]);
      assert.equal(new Set(turn.convergence?.attempts.map((a) => a.candidate)).size, 3);
      assert.equal(gw.requests.length, 6, "no inference request after the third failure");
      const last = (agent as any).messages.filter((m: any) => m.role === "tool" && m.name === "task_completed").at(-1);
      assert.match(last.content, /not converging/);
      assert.match(last.content, /operator must decide/);
      assert.equal(agent.getObjective()!.convergenceResetAfter, 3);
      assert.equal(agent.getObjective()!.outcome?.status, "blocked");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a changing failure set does not stop the turn", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\t@echo \"not ok 1 - t$$(ls | wc -l)\"\n\t@echo 'ℹ tests 1'\n\t@exit 1\n" });
    const gw = await startGateway(script(write("a.txt"), done, write("b.txt"), done, write("c.txt"), done, { kind: "text", content: "I will leave it here." }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      assert.notEqual(turn.reason, "VERIFIER_NOT_CONVERGING");
      assert.notEqual(turn.execution, "BLOCKED");
      assert.equal(turn.convergence, undefined);
      assert.ok(gw.requests.length >= 7, "the model was still asked to continue");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the threshold comes from the continuation config", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\t@echo 'not ok 1 - adds numbers'\n\t@echo 'ℹ tests 1'\n\t@exit 1\n" });
    const gw = await startGateway(script(write("a.txt"), done, write("b.txt"), done, write("c.txt"), done));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { verifierConvergenceAttempts: 2 })));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      assert.equal(turn.reason, "VERIFIER_NOT_CONVERGING");
      assert.equal(turn.convergence?.attempts.length, 2);
      assert.equal(gw.requests.length, 4);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an ENVIRONMENT failure repeated never trips it", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\tnosuchtool-dv2\n" });
    const gw = await startGateway(script(write("a.txt"), done, write("b.txt"), done, write("c.txt"), done, write("d.txt"), done));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      assert.notEqual(turn.reason, "VERIFIER_NOT_CONVERGING");
      const ledger = agent.getObjective()!;
      assert.ok(ledger.verification.length >= 3);
      assert.ok(ledger.verification.every((a) => a.classification === "ENVIRONMENT"));
      assert.equal(convergenceSignal(ledger).state, "converging");
      assert.equal(convergenceSignal({ verification: ledger.verification.map((a) => ({ ...a, classification: "CANDIDATE_FAILED" as const })) }).state, "stalled", "were these candidate failures the signal would trip");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

