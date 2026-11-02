/**
 * Unit tests for semantic observation identity (core/observation_identity.ts) and the recovery state machine in the
 * execution tracker. Pure and deterministic: no agent loop, no engine.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readRequests, readCoverage, shellReadRequest, covered, mergeIntervals } from "../src/core/observation_identity.js";
import { ExecutionTracker, createTracking, normalizeTracking } from "../src/core/execution_tracking.js";
import { createLedger, renderPinnedLedger } from "../src/core/objective.js";

const WS = "/work/repo";
/** The engine's numbered listing (core file_ops: `{:>5} | line`). */
const numbered = (lines: string[], start = 1) => lines.map((l, i) => `${String(start + i).padStart(5)} | ${l}\n`).join("");

describe("read requests across interfaces", () => {
  test("read_file, batch_read and recognised shell forms name the same resource and lines", () => {
    assert.deepEqual(readRequests("read_file", { path: "cli/src/doctor.ts" }, WS), [{ path: "cli/src/doctor.ts", start: 1, end: undefined }]);
    assert.deepEqual(readRequests("read_file", JSON.stringify({ path: "./cli/../cli/src/doctor.ts", start_line: 1, end_line: 50 }), WS), [{ path: "cli/src/doctor.ts", start: 1, end: 50 }]);
    assert.deepEqual(readRequests("read_file", { path: `${WS}/cli/src/doctor.ts` }, WS), [{ path: "cli/src/doctor.ts", start: 1, end: undefined }]);
    assert.deepEqual(readRequests("batch_read", { paths: ["a.ts", "b/c.ts"], max_lines_per_file: 20 }, WS), [{ path: "a.ts", start: 1, end: 20 }, { path: "b/c.ts", start: 1, end: 20 }]);
    assert.deepEqual(readRequests("run_command", { command: "cat cli/src/doctor.ts" }, WS), [{ path: "cli/src/doctor.ts", start: 1, end: undefined }]);
    assert.deepEqual(readRequests("run_command", { command: "sed -n '1,500p' cli/src/doctor.ts" }, WS), [{ path: "cli/src/doctor.ts", start: 1, end: 500 }]);
    assert.deepEqual(readRequests("run_command", { command: "head -500 cli/src/doctor.ts" }, WS), [{ path: "cli/src/doctor.ts", start: 1, end: 500 }]);
    assert.deepEqual(readRequests("run_command", { command: "head -n 20 cli/src/doctor.ts" }, WS), [{ path: "cli/src/doctor.ts", start: 1, end: 20 }]);
    assert.deepEqual(readRequests("run_command", { command: `cd ${WS} && cat "cli/src/doctor.ts"` }, WS), [{ path: "cli/src/doctor.ts", start: 1, end: undefined }]);
    assert.deepEqual(readRequests("run_command", { command: "cd cli && sed -n 10,20p src/doctor.ts" }, WS), [{ path: "cli/src/doctor.ts", start: 10, end: 20 }]);
  });

  test("anything else is not a classifiable read (never judged equivalent)", () => {
    for (const command of [
      "cat cli/src/doctor.ts | head -5", "cat a.ts b.ts", "cat *.ts", "cat $FILE", "cat a.ts > /tmp/x", "tail -n 5 a.ts", "awk 'NR<5' a.ts",
      "head -c 100 a.ts", "sed -i 's/a/b/' a.ts", "sed -n '/x/p' a.ts", "cat ../outside.txt", "cd / && cat etc/passwd", "cat a.ts; rm a.ts",
      "cat `ls`", "cat a.ts && echo done", "less a.ts", "cat ~/x",
    ]) {
      assert.equal(readRequests("run_command", { command }, WS), undefined, command);
    }
    assert.equal(readRequests("read_file", { path: "a.ts", offset: 0, length: 10 }, WS), undefined, "byte reads are not line reads");
    assert.equal(readRequests("read_file", { path: "../escape.ts" }, WS), undefined);
    assert.equal(readRequests("read_file", { path: "a.ts", start_line: 9, end_line: 3 }, WS), undefined);
    assert.equal(readRequests("run_command", { command: "cat a.ts", cwd: "sub" }, WS), undefined);
    assert.equal(readRequests("search_code", { query: "x" }, WS), undefined);
    assert.equal(shellReadRequest("cd ../other && cat a.ts", WS), undefined);
  });
});

describe("coverage from what a read returned", () => {
  test("read_file coverage is the reported range; shell coverage is the printed lines; truncated output covers nothing", () => {
    const out = JSON.stringify({ path: "a.ts", total_lines: 120, start_line: 1, end_line: 50, content: numbered(Array(50).fill("x")) });
    const [c] = readCoverage("read_file", { path: "a.ts", start_line: 1, end_line: 50 }, out, WS)!;
    assert.deepEqual({ ...c, fingerprint: typeof c.fingerprint }, { path: "a.ts", start: 1, end: 50, total: 120, fingerprint: "string" });
    const cat = readCoverage("run_command", { command: "cat a.ts" }, JSON.stringify({ exit_code: 0, stdout: "1\n2\n3\n", stderr: "", timed_out: false }), WS)!;
    assert.deepEqual(cat.map(({ start, end, total }) => [start, end, total]), [[1, 3, 3]], "cat printed the whole file");
    const head = readCoverage("run_command", { command: "head -n 10 a.ts" }, JSON.stringify({ exit_code: 0, stdout: "1\n2\n", stderr: "", timed_out: false }), WS)!;
    assert.deepEqual(head.map(({ start, end, total }) => [start, end, total]), [[1, 2, 2]], "fewer lines than asked: EOF reached");
    const sed = readCoverage("run_command", { command: "sed -n '5,7p' a.ts" }, JSON.stringify({ exit_code: 0, stdout: "5\n6\n7\n", stderr: "", timed_out: false }), WS)!;
    assert.deepEqual(sed.map(({ start, end, total }) => [start, end, total]), [[5, 7, undefined]]);
    assert.equal(readCoverage("run_command", { command: "cat a.ts" }, JSON.stringify({ exit_code: 1, stdout: "", stderr: "No such file", timed_out: false }), WS), undefined);
    assert.equal(readCoverage("run_command", { command: "cat a.ts" }, JSON.stringify({ exit_code: 0, stdout: "a\n[TRUNCATED 999 BYTES]\nb\n", stderr: "", timed_out: false }), WS), undefined);
    assert.equal(readCoverage("read_file", { path: "a.ts" }, "not json", WS), undefined);
    // A batch with any failed file is one observation that is not attributable to line ranges.
    const ok = { path: "a.ts", success: true, total_lines: 1, content: numbered(["x"]) };
    assert.equal(readCoverage("batch_read", { paths: ["a.ts", "missing.ts"] }, JSON.stringify({ files: [ok, { path: "missing.ts", success: false, total_lines: 0, content: "", error: "Open error" }] }), WS), undefined);
    assert.equal(readCoverage("batch_read", { paths: ["a.ts"] }, JSON.stringify({ files: [ok] }), WS)?.length, 1);
    // A listing whose numbering does not match the reported range cannot be attributed to lines.
    assert.equal(readCoverage("read_file", { path: "a.ts" }, JSON.stringify({ path: "a.ts", total_lines: 3, start_line: 1, end_line: 3, content: "1\n2\n3\n" }), WS), undefined);
  });

  test("the same lines hash the same through read_file, batch_read, cat, head and sed (CRLF included)", () => {
    const file = ["alpha", "beta", "gamma", "delta"];
    const fp = (c?: Array<{ fingerprint: string }>) => c?.[0]?.fingerprint;
    const rf = fp(readCoverage("read_file", { path: "a.ts" }, JSON.stringify({ path: "a.ts", total_lines: 4, start_line: 1, end_line: 4, content: numbered(file) }), WS));
    const br = fp(readCoverage("batch_read", { paths: ["a.ts"] }, JSON.stringify({ files: [{ path: "a.ts", success: true, total_lines: 4, content: numbered(file) }] }), WS));
    const cat = fp(readCoverage("run_command", { command: "cat a.ts" }, JSON.stringify({ exit_code: 0, stdout: file.join("\r\n") + "\r\n", stderr: "", timed_out: false }), WS));
    assert.ok(rf && rf === br && rf === cat, `${rf} ${br} ${cat}`);
    const rf23 = fp(readCoverage("read_file", { path: "a.ts", start_line: 2, end_line: 3 }, JSON.stringify({ path: "a.ts", total_lines: 4, start_line: 2, end_line: 3, content: numbered(file.slice(1, 3), 2) }), WS));
    const sed23 = fp(readCoverage("run_command", { command: "sed -n '2,3p' a.ts" }, JSON.stringify({ exit_code: 0, stdout: "beta\ngamma\n", stderr: "", timed_out: false }), WS));
    assert.ok(rf23 && rf23 === sed23);
    assert.notEqual(rf23, rf);
  });

  test("interval helpers", () => {
    assert.deepEqual(mergeIntervals([[10, 20], [1, 5], [6, 9], [30, 31]]), [[1, 20], [30, 31]]);
    assert.equal(covered([[1, 50]], 1, 50), true);
    assert.equal(covered([[1, 50]], 40, 60), false);
    assert.equal(covered([[1, 20], [21, 40]], 10, 30), true);
  });
});

let callSeq = 0;
/** Feeds one read observation (a new tool call id each time) with the file signature `sig`; returns the verdict and its call id. */
function readObs(t: ExecutionTracker, step: number, args: Record<string, unknown>, lines: number, total: number, state: string, present: (id: string) => boolean, start = 1, sig = "SIG") {
  return readObsWithId(t, step, args, lines, total, state, present, start, sig).verdict;
}
function readObsWithId(t: ExecutionTracker, step: number, args: Record<string, unknown>, lines: number, total: number, state: string, present: (id: string) => boolean, start = 1, sig = "SIG") {
  const callId = `call_${++callSeq}`;
  const end = start + lines - 1;
  const out = JSON.stringify({ path: args.path, total_lines: total, start_line: start, end_line: end, content: numbered(Array.from({ length: lines }, (_, i) => `l${start + i}`), start) });
  const verdict = t.observe(step, {
    name: "read_file",
    args,
    success: true,
    text: out,
    stateBefore: state,
    coverage: readCoverage("read_file", args, out, WS)?.map((c) => ({ ...c, sig })),
    callId,
    present,
  });
  return { verdict, callId };
}
const SIG = () => "SIG";

describe("tracker: equivalence, escalation and refusal", () => {
  test("a narrower re-read of lines still in context is a duplicate; a re-read after compaction removed them is not equivalent", () => {
    const t = ExecutionTracker.fresh();
    const all = () => true;
    const v1 = readObs(t, 1, { path: "a.ts" }, 100, 100, "S", all);
    assert.equal(v1.classification, "OBSERVATION_NEW");
    const v2 = readObs(t, 2, { path: "a.ts", start_line: 1, end_line: 40 }, 40, 100, "S", all);
    assert.equal(v2.classification, "OBSERVATION_DUPLICATE");
    assert.equal(v2.informative, false, "covered lines are not new information");
    assert.ok(v2.equivalence, "equivalent: lines in context re-read");
    const gone = readObs(t, 3, { path: "a.ts", start_line: 1, end_line: 30 }, 30, 100, "S", () => false);
    assert.equal(gone.classification, "OBSERVATION_DUPLICATE");
    assert.equal(gone.equivalence, undefined, "the model no longer had it: a re-acquisition, not an equivalent");
    const over = readObs(t, 4, { path: "a.ts", start_line: 90, end_line: 120 }, 11, 100, "S2", all, 90);
    assert.equal(over.classification, "OBSERVATION_NEW", "another state: new");
    const v5 = readObs(t, 5, { path: "a.ts", start_line: 95, end_line: 140 }, 6, 100, "S2", all, 95);
    assert.equal(v5.classification, "OBSERVATION_DUPLICATE");
    const partial = readObs(t, 6, { path: "a.ts", start_line: 50, end_line: 100 }, 51, 100, "S2", all, 50);
    assert.equal(partial.classification, "OBSERVATION_OVERLAPPING");
    assert.equal(partial.informative, true);
  });

  test("the same lines with different content on the 'same' state are new (the content decides)", () => {
    const t = ExecutionTracker.fresh();
    const mk = (content: string) => JSON.stringify({ path: "a.ts", total_lines: 1, start_line: 1, end_line: 1, content: numbered([content]) });
    const obs = (step: number, content: string) => t.observe(step, { name: "read_file", args: { path: "a.ts" }, success: true, text: mk(content), stateBefore: "S", coverage: readCoverage("read_file", { path: "a.ts" }, mk(content), WS)?.map((c) => ({ ...c, sig: "SIG" })), callId: `k${step}`, present: () => true });
    obs(1, "one");
    assert.equal(obs(2, "two").classification, "OBSERVATION_NEW");
  });

  test("escalation: advisory, then constrained, at most once per step; refusals are bounded; progress completes recovery", () => {
    const t = ExecutionTracker.fresh();
    assert.equal(t.recordUnproductive(5, "read a", "S", 2, 2).outcome, "advisory");
    assert.equal(t.recordUnproductive(5, "read b", "S", 2, 2).sameStep, true, "a second loop in the same batch does not escalate");
    assert.equal(t.data.recovery.notes, 1);
    assert.equal(t.recordUnproductive(6, "read a", "S", 2, 2).outcome, "constrained");
    assert.equal(t.recoveryStage, "constrained");
    const present = () => true;
    readObs(t, 6, { path: "a.ts" }, 10, 10, "S", present);
    assert.equal(t.recoveryDenial(6, "run_command", { command: "cat a.ts" }, "S", WS, present, SIG), undefined, "nothing is refused in the step whose note the model has not seen");
    const denial = t.recoveryDenial(7, "run_command", { command: "cat a.ts" }, "S", WS, present, SIG)!;
    assert.ok(denial, "a shell re-read of lines in context is refused while constrained");
    assert.equal(t.recoveryDenial(7, "run_command", { command: "cat a.ts" }, "S-changed", WS, present, SIG), undefined, "a changed workspace lifts it");
    assert.equal(t.recoveryDenial(7, "run_command", { command: "cat a.ts" }, "S", WS, () => false, SIG), undefined, "output gone from context: allowed");
    assert.equal(t.recoveryDenial(7, "read_file", { path: "a.ts", start_line: 5, end_line: 20 }, "S", WS, present, SIG)?.coveredBy.length, 1, "clamped to EOF (10 lines)");
    assert.equal(t.recoveryDenial(7, "read_file", { path: "b.ts" }, "S", WS, present, SIG), undefined, "unread file: allowed");
    assert.equal(t.recoveryDenial(7, "run_tests", {}, "S", WS, present, SIG), undefined, "validation is never refused");
    assert.equal(t.recoveryDenial(7, "task_completed", {}, "S", WS, present, SIG), undefined);
    assert.equal(t.recordDenial(7, denial), false);
    assert.equal(t.recordDenial(8, denial), false);
    assert.equal(t.recordDenial(9, denial), true, "the third refusal beyond two allowed exhausts recovery");
    t.evaluateStep(10, { stateBefore: "S", stateAfter: "S3", verdicts: [] });
    assert.equal(t.recoveryStage, "normal", "a new workspace state is progress");
    assert.equal(t.data.recovery.denials, 0);
    assert.equal(t.recordUnproductive(20, "read c", "S3", 2, 2).outcome, "constrained", "a later episode with its notes spent is constrained at once");
    t.operatorInput(21, "operator steering");
    assert.equal(t.recoveryStage, "normal");
    assert.equal(t.data.recovery.notes, 0, "operator input starts recovery over");
    const kinds = t.data.recovery.events.map((e) => e.kind);
    for (const k of ["non_progress_detected", "recovery_advisory_issued", "recovery_constrained", "tool_execution_denied", "recovery_exhausted", "recovery_progress_detected", "recovery_completed"]) assert.ok(kinds.includes(k), k);
    assert.ok(t.data.recovery.events.every((e) => e.detail.length <= 400));
  });

  test("a file whose own signature changed is neither equivalent nor refused (state identity does not cover ignored files)", () => {
    const t = ExecutionTracker.fresh();
    readObs(t, 1, { path: "build.log" }, 10, 10, "S", () => true, 1, "v1");
    assert.equal(readObs(t, 2, { path: "build.log" }, 10, 10, "S", () => true, 1, "v2").equivalence, undefined, "another version of the file");
    t.recordUnproductive(3, "a", "S", 1, 1);
    assert.equal(t.recoveryDenial(4, "read_file", { path: "build.log" }, "S", WS, () => true, () => "v3"), undefined, "changed since read: allowed");
    assert.equal(t.recoveryDenial(4, "read_file", { path: "build.log" }, "S", WS, () => true, () => undefined), undefined, "unreadable now: allowed");
    assert.ok(t.recoveryDenial(4, "read_file", { path: "build.log" }, "S", WS, () => true, () => "v2"), "unchanged since the last read: refused");
  });

  test("presence is per tool call: another run with the same arguments on another state does not make this state's output present", () => {
    const t = ExecutionTracker.fresh();
    const s1 = readObsWithId(t, 1, { path: "a.ts" }, 10, 10, "S1", () => true);
    const s2 = readObsWithId(t, 2, { path: "a.ts" }, 10, 10, "S2", () => true);
    t.recordUnproductive(3, "a", "S1", 1, 1);
    const onlyS2 = (id: string) => id === s2.callId;
    assert.equal(t.recoveryDenial(4, "read_file", { path: "a.ts" }, "S1", WS, onlyS2, SIG), undefined, "S1's output was compacted away: re-acquisition allowed");
    assert.ok(t.recoveryDenial(4, "read_file", { path: "a.ts" }, "S1", WS, (id) => id === s1.callId, SIG));
    // Other observing tools depend on what the state identity does not cover (ignored files, LSP, index): never refused.
    t.observe(5, { name: "list_dir", args: { path: "." }, success: true, text: "a.ts", stateBefore: "S1", callId: "ld1", present: () => true });
    for (const name of ["list_dir", "file_info", "search_code", "lsp_diagnostics", "semantic_search"]) {
      assert.equal(t.recoveryDenial(6, name, { path: "." }, "S1", WS, () => true, SIG), undefined, name);
    }
    assert.equal(t.recoveryDenial(6, "read_file", { path: "a.ts", offset: 0, length: 10 }, "S1", WS, () => true, SIG), undefined, "byte-range read");
  });

  test("different slices of a file already read are redundant (not progress) but not a loop; the same lines three times are", () => {
    const t = ExecutionTracker.fresh();
    readObs(t, 1, { path: "a.ts" }, 300, 300, "S", () => true);
    for (let i = 0; i < 6; i++) {
      const v = readObs(t, 2 + i, { path: "a.ts", start_line: 1 + i * 20, end_line: 20 + i * 20 }, 20, 300, "S", () => true, 1 + i * 20);
      assert.equal(v.classification, "OBSERVATION_DUPLICATE");
      assert.equal(v.equivalentLoop, false, `slice ${i + 1}`);
    }
    readObs(t, 10, { path: "a.ts", start_line: 5, end_line: 9 }, 5, 300, "S", () => true, 5);
    assert.equal(readObs(t, 11, { path: "a.ts", start_line: 5, end_line: 9 }, 5, 300, "S", () => true, 5).equivalentLoop, true, "lines 5-9 obtained again twice more");
  });

  test("a pinned ledger written before v1.1.2 (no recovery, no coverage) renders without error", () => {
    const ledger = createLedger("Fix the doctor command");
    const old = createTracking() as any;
    delete old.recovery;
    delete old.coverage;
    delete old.equivalents;
    ledger.execution = old;
    ledger.verification.push({ n: 1, command: "npm test", status: "failed", inputs: "abcdef123456" } as any);
    assert.doesNotThrow(() => renderPinnedLedger(ledger, false));
  });

  test("with no recovery notes allowed the first loop exhausts recovery (existing bound kept)", () => {
    const t = ExecutionTracker.fresh();
    assert.equal(t.recordUnproductive(1, "read a", "S", 0, 1).outcome, "exhausted");
  });

  test("an unproductive observation that still executes while constrained exhausts recovery", () => {
    const t = ExecutionTracker.fresh();
    t.recordUnproductive(1, "a", "S", 1, 1);
    assert.equal(t.recoveryStage, "constrained");
    assert.equal(t.recordUnproductive(2, "a", "S", 1, 1).outcome, "exhausted");
  });

  test("recovery state and coverage survive a JSON round trip and normalize from older records", () => {
    const t = ExecutionTracker.fresh();
    readObs(t, 1, { path: "a.ts" }, 3, 3, "S", () => true);
    t.recordUnproductive(2, "a", "S", 1, 1);
    const restored = new ExecutionTracker(normalizeTracking(JSON.parse(JSON.stringify(t.data))));
    assert.equal(restored.recoveryStage, "constrained");
    assert.ok(restored.recoveryDenial(7, "read_file", { path: "a.ts" }, "S", WS, () => true, SIG));
    const old = createTracking() as any;
    delete old.recovery;
    delete old.coverage;
    delete old.equivalents;
    const norm = normalizeTracking(old);
    assert.equal(norm.recovery.stage, "normal");
    assert.deepEqual(norm.coverage, []);
    assert.equal(normalizeTracking({ ...createTracking(), recovery: { stage: "bogus" } } as any).recovery.stage, "normal");
  });

  test("coverage metadata is bounded and keeps no file content", () => {
    const t = ExecutionTracker.fresh();
    for (let i = 0; i < 700; i++) readObs(t, i, { path: `f${i}.ts` }, 2, 2, "S", () => true);
    assert.ok(t.data.coverage.length <= 512);
    assert.ok(t.data.evicted.coverage >= 188);
    assert.ok(!JSON.stringify(t.data.coverage).includes("l1\\nl2"), "only digests, never content");
  });
});
