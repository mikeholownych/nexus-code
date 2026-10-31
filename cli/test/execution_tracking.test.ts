/**
 * Objective-scoped execution tracking (core/execution_tracking.ts): identities, progress judgement, repetition,
 * polling and transient failures, bounded storage that does not hide a loop, and compaction thrash evidence.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionTracker,
  REPEAT_THRESHOLD,
  actionIdentity,
  backoffMs,
  classifyOutcome,
  combineState,
  createTracking,
  normalizeOutcomeText,
  normalizeTracking,
  outcomeIdentity,
} from "../src/core/execution_tracking.js";
import { createLedger, isContinuationPrompt, isNewObjective, recordAttempt, renderPinnedLedger, trackingOf } from "../src/core/objective.js";

const obs = (name: string, args: unknown, text: string, state: string, success = true) => ({ name, args, text, success, stateBefore: state });

describe("identities", () => {
  test("action identity ignores key order, whitespace and is independent of call ids", () => {
    assert.equal(actionIdentity("read_file", '{"path":"a.ts","limit":10}'), actionIdentity("read_file", { limit: 10, path: "a.ts" }));
    assert.equal(actionIdentity("run_command", { command: "npm   test\n" }), actionIdentity("run_command", '{ "command": "npm test" }'));
    assert.notEqual(actionIdentity("read_file", { path: "a.ts" }), actionIdentity("read_file", { path: "b.ts" }));
  });

  test("outcome identity ignores timestamps, durations, uuids, request ids and temp paths, not content", () => {
    const a = "2026-10-13T21:00:01.123Z ok in 0.53s request_id=abc123 /tmp/tmp.XyZ12 id 3f0e0d5c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    const b = "2026-10-14T09:15:44Z ok in 12ms request_id=zzz999 /tmp/tmp.Q77 id 99999999-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    assert.equal(outcomeIdentity(true, a), outcomeIdentity(true, b));
    assert.notEqual(outcomeIdentity(true, "1 passed"), outcomeIdentity(true, "2 passed"));
    assert.notEqual(outcomeIdentity(true, "x"), outcomeIdentity(false, "x"));
    assert.match(normalizeOutcomeText("at 21:04:05 took 3 sec"), /<time>.*<dur>/);
  });

  test("a command's exit code decides its outcome, and its timing fields are not part of it", () => {
    const out = (exit: number, ms: number, timedOut = false) => JSON.stringify({ command: "make", duration_ms: ms, exit_code: exit, stderr: "", stdout: "x", timed_out: timedOut }, null, 2);
    const t = ExecutionTracker.fresh();
    const first = t.observe(1, obs("run_command", { command: "make" }, out(2, 50), "S"));
    assert.equal(first.record.outcomeClass, "deterministic_failure");
    assert.equal(t.observe(2, obs("run_command", { command: "make" }, out(2, 73), "S")).repeat, true, "a different duration is the same outcome");
    assert.equal(t.observe(3, obs("run_command", { command: "make" }, out(0, 50), "S")).repeat, false, "a different exit code is a different outcome");
    assert.equal(t.observe(4, obs("run_command", { command: "make" }, out(-1, 50, true), "S")).record.outcomeClass, "transient_failure");
  });

  test("transient and deterministic failures are told apart", () => {
    assert.equal(classifyOutcome(false, "connect ECONNREFUSED 127.0.0.1:5432"), "transient_failure");
    assert.equal(classifyOutcome(false, "HTTP/1.1 503 Service Unavailable"), "transient_failure");
    assert.equal(classifyOutcome(false, "anything", true), "transient_failure");
    assert.equal(classifyOutcome(false, "TypeError: x is not a function"), "deterministic_failure");
    assert.equal(classifyOutcome(true, "Connection refused (but this succeeded)"), "success");
  });

  test("an unknown part makes a combined state unknown", () => {
    assert.equal(combineState(["a", "unknown", "c"]), "unknown");
    assert.equal(combineState(["a", "b"]), combineState(["a", "b"]));
  });
});

describe("repetition is judged on action, outcome and state", () => {
  test("the same read on an unchanged state is a loop at the threshold; reformatted args and new call ids do not hide it", () => {
    const t = ExecutionTracker.fresh();
    const v1 = t.observe(1, obs("read_file", '{"path":"a"}', "A", "S1"));
    const v2 = t.observe(2, obs("read_file", { path: "a" }, "A", "S1"));
    const v3 = t.observe(3, obs("read_file", '{ "path" : "a" }', "A", "S1"));
    assert.equal(v1.informative, true);
    assert.equal(v2.repeat, true);
    assert.equal(v2.loop, false);
    assert.equal(v3.loop, true);
    assert.equal(v3.record.count, REPEAT_THRESHOLD);
    assert.equal(t.loops().length, 1);
  });

  test("a retry after a meaningful input change is a new observation, not a repeat", () => {
    const t = ExecutionTracker.fresh();
    t.observe(1, obs("run_command", { command: "npm test" }, "1 failing", "S1", false));
    t.observe(2, obs("run_command", { command: "npm test" }, "1 failing", "S1", false));
    const afterEdit = t.observe(3, obs("run_command", { command: "npm test" }, "1 failing", "S2", false));
    assert.equal(afterEdit.repeat, false, "same command and output on a changed workspace is a legitimate retry");
    assert.equal(afterEdit.informative, true);
  });

  test("an external command's unchanged success is a poll, not a loop; a transient failure is waited out", () => {
    const t = ExecutionTracker.fresh();
    for (let i = 1; i <= 4; i++) {
      const v = t.observe(i, obs("run_command", { command: "curl -s localhost/status" }, `pending at 2026-10-13T21:0${i}:00Z`, "S1"));
      if (i > 1) {
        assert.equal(v.poll, true);
        assert.equal(v.loop, false);
      }
    }
    const tr = ExecutionTracker.fresh();
    tr.observe(1, obs("run_command", { command: "psql" }, "ECONNREFUSED", "S1", false));
    const again = tr.observe(2, obs("run_command", { command: "psql" }, "ECONNREFUSED", "S1", false));
    assert.equal(again.poll, true);
    assert.equal(again.informative, false);
    assert.equal(tr.priorRun("run_command", { command: "psql" }, "S1")?.outcomeClass, "transient_failure");
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test("a deterministic failure repeated on an unchanged state is a loop and is recorded as a failed approach", () => {
    const t = ExecutionTracker.fresh();
    let last;
    for (let i = 1; i <= 3; i++) last = t.observe(i, obs("run_command", { command: "make" }, "error: missing ;", "S1", false));
    assert.equal(last!.loop, true);
    assert.equal(t.data.failedApproaches.length, 1, "recorded once, not per repetition");
  });

  test("re-reading output compaction removed is re-acquisition, not a loop; recurring re-acquisition is context thrash", () => {
    const t = ExecutionTracker.fresh();
    t.observe(1, obs("read_file", { path: "big" }, "BIG", "S"));
    const r2 = t.observe(2, { ...obs("read_file", { path: "big" }, "BIG", "S"), reacquire: true });
    const r3 = t.observe(3, { ...obs("read_file", { path: "big" }, "BIG", "S"), reacquire: true });
    assert.equal(r2.reacquired, true);
    assert.equal(r2.loop, false);
    assert.equal(r3.loop, false, "three reads, two of them re-acquisitions: not a loop");
    assert.equal(r3.thrash, true, "the second re-acquisition is thrash evidence");
    assert.equal(t.loops().length, 0);
    assert.equal(t.reacquisitions()[0].reacquired, 2);
    // Reads made while the model still had the output still count toward a loop.
    t.observe(4, obs("read_file", { path: "big" }, "BIG", "S"));
    t.observe(5, obs("read_file", { path: "big" }, "BIG", "S"));
    assert.equal(t.observe(6, obs("read_file", { path: "big" }, "BIG", "S")).loop, true);
  });

  test("on an unknown state nothing is called a repeat or a loop", () => {
    const t = ExecutionTracker.fresh();
    for (let i = 1; i <= 5; i++) {
      const v = t.observe(i, obs("read_file", { path: "a" }, "A", "unknown"));
      assert.equal(v.repeat, false);
      assert.equal(v.loop, false);
      assert.equal(v.stateUnknown, true);
    }
    assert.equal(t.loops().length, 0);
  });
});

describe("progress", () => {
  test("a new workspace state, new information or a new ledger state is progress; plan edits and identical rewrites are not", () => {
    const t = ExecutionTracker.fresh();
    t.noteState("S0");
    t.noteLedgerState("L0");
    const write = t.observe(1, obs("write_file", { path: "a", content: "x" }, "wrote 1 byte", "S0"));
    assert.equal(t.evaluateStep(1, { stateBefore: "S0", stateAfter: "S1", verdicts: [write], ledgerState: "L0" }).progressed, true);
    // The same content written again: the state does not change, and a mutation is not information.
    const rewrite = t.observe(2, obs("write_file", { path: "a", content: "x" }, "wrote 1 byte", "S1"));
    assert.equal(t.evaluateStep(2, { stateBefore: "S1", stateAfter: "S1", verdicts: [rewrite], ledgerState: "L0" }).progressed, false);
    const plan = t.observe(3, obs("update_plan", { phases: ["a", "b"] }, "ok", "S1"));
    assert.equal(t.evaluateStep(3, { stateBefore: "S1", stateAfter: "S1", verdicts: [plan], ledgerState: "L0" }).progressed, false);
    // Returning to an earlier state is not progress either.
    assert.equal(t.evaluateStep(4, { stateBefore: "S1", stateAfter: "S0", verdicts: [], ledgerState: "L0" }).progressed, false);
    assert.equal(t.data.stepsWithoutProgress, 3);
    assert.equal(t.evaluateStep(5, { stateBefore: "S0", stateAfter: "S0", verdicts: [], ledgerState: "L1" }).progressed, true);
    assert.equal(t.data.stepsWithoutProgress, 0);
    const read = t.observe(6, obs("read_file", { path: "b" }, "B", "S0"));
    assert.equal(t.evaluateStep(6, { stateBefore: "S0", stateAfter: "S0", verdicts: [read], ledgerState: "L1" }).progressed, true);
  });

  test("operator input resets the no-progress run without erasing repetition evidence", () => {
    const t = ExecutionTracker.fresh();
    for (let i = 1; i <= 3; i++) t.evaluateStep(i, { stateBefore: "S", stateAfter: "S", verdicts: [t.observe(i, obs("read_file", { path: "a" }, "A", "S"))] });
    assert.equal(t.loops().length, 1);
    t.operatorInput(4, "continue");
    assert.equal(t.data.stepsWithoutProgress, 0);
    assert.equal(t.loops().length, 1);
    assert.equal(t.observe(5, obs("read_file", { path: "a" }, "A", "S")).loop, true, "the loop is still recognized after the follow-up");
  });

  test("ACC-CONT-09 / REQ-AGT-108: distinct workspace mutations on unknown state count as progress; identical writes stagnate", () => {
    const t = ExecutionTracker.fresh();
    // 14 distinct writes on unknown state: each step counts as progress, stepsWithoutProgress never reaches 12
    for (let i = 1; i <= 14; i++) {
      const v = t.observe(i, obs("write_file", { path: `f${i}.ts`, content: `code ${i}` }, "ok", "unknown"));
      const ev = t.evaluateStep(i, { stateBefore: "unknown", stateAfter: "unknown", verdicts: [v] });
      assert.equal(ev.progressed, true, `step ${i} distinct write progressed`);
      assert.equal(t.data.stepsWithoutProgress, 0);
    }

    // Inverse test: 13 identical writes on unknown state
    const tStagnant = ExecutionTracker.fresh();
    // Step 1: initial write progresses (stepsWithoutProgress = 0)
    const vFirst = tStagnant.observe(1, obs("write_file", { path: "same.ts", content: "same" }, "ok", "unknown"));
    const evFirst = tStagnant.evaluateStep(1, { stateBefore: "unknown", stateAfter: "unknown", verdicts: [vFirst] });
    assert.equal(evFirst.progressed, true, "first write progressed");
    assert.equal(tStagnant.data.stepsWithoutProgress, 0);

    // Steps 2 through 13: 12 identical writes with no progress
    for (let i = 2; i <= 13; i++) {
      const vRepeat = tStagnant.observe(i, obs("write_file", { path: "same.ts", content: "same" }, "ok", "unknown"));
      const evRepeat = tStagnant.evaluateStep(i, { stateBefore: "unknown", stateAfter: "unknown", verdicts: [vRepeat] });
      assert.equal(evRepeat.progressed, false, `step ${i} repeat did not progress`);
    }
    // After 13 steps (1 initial + 12 repeated without progress), stepsWithoutProgress is 12 (hits default stagnationSteps of 12)
    assert.equal(tStagnant.data.stepsWithoutProgress, 12);
  });
});

describe("bounded storage does not hide a loop", () => {
  test("repetition records showing recurrence survive eviction pressure; an evicted triple still counts when it recurs", () => {
    const t = ExecutionTracker.fresh();
    t.observe(1, obs("read_file", { path: "loop" }, "L", "S"));
    t.observe(2, obs("read_file", { path: "loop" }, "L", "S"));
    for (let i = 0; i < 600; i++) t.observe(3 + i, obs("read_file", { path: `f${i}` }, `content ${i}`, "S"));
    assert.ok(t.data.repetitions.length <= 256);
    assert.ok(t.data.evicted.repetitions > 0);
    assert.ok(t.data.repetitions.some((r) => r.action.includes('"loop"')), "the recurring record was kept");
    assert.equal(t.observe(700, obs("read_file", { path: "loop" }, "L", "S")).loop, true);
    // A single-count record that was evicted is still known through the bounded seen-set.
    const recurring = t.observe(701, obs("read_file", { path: "f0" }, "content 0", "S"));
    assert.equal(recurring.repeat, true);
    assert.equal(recurring.record.count, 2);
  });
});

describe("compaction thrash evidence", () => {
  test("consecutive low-yield pressure compactions are counted; a useful one resets the run", () => {
    const t = ExecutionTracker.fresh();
    const base = { step: 1, trigger: "auto" as const, archivedMessages: 1, committed: true };
    assert.equal(t.compaction({ ...base, id: "a", beforeTokens: 52000, afterTokens: 51000 }, 65536, true).lowYield, true);
    t.compaction({ ...base, id: "b", beforeTokens: 52000, afterTokens: 51500 }, 65536, true);
    assert.equal(t.data.lowYieldCompactions, 2);
    t.compaction({ ...base, id: "c", beforeTokens: 60000, afterTokens: 20000 }, 65536, true);
    assert.equal(t.data.lowYieldCompactions, 0);
    // A compaction forced because the request did not fit is never low-yield thrash.
    assert.equal(t.compaction({ ...base, id: "d", beforeTokens: 70000, afterTokens: 69000 }, 65536, false).lowYield, undefined);
  });
});

describe("the ledger carries tracking", () => {
  test("a new ledger has tracking; a restored ledger without it is completed; the pinned block shows loops and failures", () => {
    const ledger = createLedger("1. Fix A\n2. Fix B");
    assert.ok(ledger.execution);
    const old = structuredClone(ledger) as any;
    delete old.execution;
    const t = trackingOf(old);
    assert.equal(t.data.cumulativeSteps, 0);
    for (let i = 1; i <= 3; i++) t.observe(i, obs("run_command", { command: "make" }, "error 1", "S", false));
    const pinned = renderPinnedLedger(old, false);
    assert.match(pinned, /Repeated without progress/);
    assert.match(pinned, /Failed approaches/);
    assert.deepEqual(normalizeTracking(JSON.parse(JSON.stringify(old.execution))).repetitions.length, 1);
    assert.deepEqual(Object.keys(createTracking()).sort(), Object.keys(normalizeTracking(undefined)).sort());
  });

  test("every holder shares one tracking record: re-reading it never orphans a running tracker", () => {
    // Live finding (2026-10-13): compaction re-read the ledger's tracking mid-turn and replaced it with a copy, so the
    // turn's further steps went to an orphaned record (persisted cumulativeSteps 1 after an 11-step turn).
    const ledger = createLedger("Refactor the parser");
    const running = trackingOf(ledger);
    running.beginStep();
    const again = trackingOf(ledger);
    running.beginStep();
    assert.equal(again.data, running.data);
    assert.equal(ledger.execution!.cumulativeSteps, 2);
    const legacy: any = { cumulativeSteps: 4 };
    assert.equal(normalizeTracking(legacy), legacy, "filled in place");
    assert.deepEqual(legacy.repetitions, []);
  });

  test("an unfinished single-request objective continued with 'continue' keeps its ledger; new work starts a new one", () => {
    const ledger = createLedger("Refactor the parser");
    ledger.outcome = { status: "incomplete", reason: "stagnation", remaining: [], at: "x" };
    for (const p of ["continue", "Continue.", "keep going", "please continue where you left off", "try again", "resume"]) {
      assert.equal(isContinuationPrompt(p), true, p);
      assert.equal(isNewObjective(ledger, p), false, p);
    }
    for (const p of ["continue with the README instead", "fix the lexer", "Now write docs for it"]) {
      assert.equal(isNewObjective(ledger, p), true, p);
    }
    ledger.outcome = { status: "completed", reason: "done", remaining: [], at: "x" };
    assert.equal(isNewObjective(ledger, "continue"), true, "a completed objective is never continued");
  });

  test("AGT-13: recordAttempt counter is monotonic beyond 50 attempts", () => {
    const ledger = createLedger("Verify monotonic counter");
    for (let i = 1; i <= 60; i++) {
      const attempt = recordAttempt(ledger, {
        command: "npm test",
        inputs: `candidate-${i}`,
        status: "FAILED",
      });
      assert.equal(attempt.n, i, `attempt ${i} has n=${i}`);
    }
    assert.equal(ledger.verification.length, 50, "verification array bounded at 50");
    assert.equal(ledger.verification[0].n, 11, "first retained attempt is n=11");
    assert.equal(ledger.verification[ledger.verification.length - 1].n, 60, "last attempt is n=60");
  });
});
