import { test } from "node:test";
import assert from "node:assert/strict";
import { createLedger, recordAttempt, type ObjectiveLedger } from "../src/core/objective.js";
import {
  authoriseObligation, minimiseObligation, recordTestEdit, replayCommands, unmetObligations, unmetObligationsMessage,
  authoriseReference, agreementStatement, differentialStatus,
} from "../src/core/regression_obligations.js";

const CMD = "npm test";
const failing = (ledger: ObjectiveLedger, tests: string[], inputs: string, extra: object = {}) =>
  recordAttempt(ledger, { command: CMD, inputs, status: "FAILED", classification: "CANDIDATE_FAILED", exitCode: 1, failingTests: tests, failedCheck: tests[0], ...extra }, undefined,
    tests.map((name, i) => `not ok ${i + 1} - ${name}`).join("\n"));
const passing = (ledger: ObjectiveLedger, inputs: string, command = CMD) =>
  recordAttempt(ledger, { command, inputs, status: "PASSED" }, undefined, "ok 1 - parses empty input\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n");

test("an unauthorised promotion cannot happen", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["parses empty input"], "c1");
  assert.equal(ledger.obligations, undefined, "a failing attempt alone creates nothing");
  assert.throws(() => authoriseObligation(ledger, { authority: "model" as never, attempt: a.n, testName: "parses empty input" }), /operator/);
  assert.equal(ledger.obligations, undefined);
  // not a confirmed failure
  const env = recordAttempt(ledger, { command: CMD, inputs: "c2", status: "FAILED", classification: "ENVIRONMENT", exitCode: 127, failingTests: ["x"] });
  assert.equal(authoriseObligation(ledger, { authority: "operator", attempt: env.n, testName: "x" }).ok, false);
  const p = passing(ledger, "c3");
  assert.equal(authoriseObligation(ledger, { authority: "operator", attempt: p.n, testName: "parses empty input" }).ok, false);
  assert.equal(authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "no such test" }).ok, false);
  assert.equal(ledger.obligations, undefined);
});

test("an authorised obligation keeps its failure record and is replayed on the next candidate", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["parses empty input"], "c1", { excerpt: "AssertionError" });
  const res = authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "parses empty input" });
  assert.equal(res.ok, true);
  const ob = ledger.obligations![0];
  assert.equal(ob.failureRecord.attempt, a.n);
  assert.equal(ob.failureRecord.excerpt, "AssertionError");
  assert.deepEqual(replayCommands(ledger), [CMD]);
  assert.equal(unmetObligations(ledger).length, 1, "never replayed yet");
  failing(ledger, ["parses empty input"], "c2");
  assert.equal(ob.replays.at(-1)?.outcome, "fail");
  passing(ledger, "c3", "other command");
  assert.equal(ob.replays.length, 1, "a different command is not a replay");
  recordAttempt(ledger, { command: CMD, inputs: "c4", status: "FAILED", classification: "ENVIRONMENT", exitCode: 127, failingTests: ["unrelated"] });
  assert.equal(ob.replays.length, 1, "an environment failure is not a replay");
  passing(ledger, "c5");
  assert.equal(ob.replays.at(-1)?.outcome, "pass");
  assert.equal(unmetObligations(ledger).length, 0);
  failing(ledger, ["something else"], "c6");
  assert.equal(ob.replays.at(-1)?.outcome, "unobserved", "an unrelated failure does not prove this test ran");
});

test("a passing suite that does not report the obligated test is not a replay pass", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["parses empty input"], "c1");
  authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "parses empty input" });
  recordAttempt(ledger, { command: CMD, inputs: "c2", status: "PASSED" }, undefined,
    "ok 1 - unrelated test\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n");
  assert.equal(ledger.obligations![0].replays.at(-1)?.outcome, "unobserved");
  assert.equal(unmetObligations(ledger).length, 1);
});

test("a recognised pass line for the exact obligated test discharges it", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["parses empty input"], "c1");
  authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "parses empty input" });
  recordAttempt(ledger, { command: CMD, inputs: "c2", status: "PASSED" }, undefined,
    "✓ parses empty input (2ms)\nTests 1 passed\n");
  assert.equal(ledger.obligations![0].replays.at(-1)?.outcome, "pass");
  assert.equal(unmetObligations(ledger).length, 0);
});

test("legacy passes without the observed test name do not discharge an obligation", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["parses empty input"], "c1");
  authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "parses empty input" });
  ledger.obligations![0].replays.push({ attempt: 2, at: "2026-01-01T00:00:00.000Z", outcome: "pass" });
  assert.equal(unmetObligations(ledger).length, 1);
  assert.match(unmetObligationsMessage(ledger)!, /did not show this test executing/);
});

test("a skipped result for the exact obligated test does not discharge it", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["parses empty input"], "c1");
  authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "parses empty input" });
  recordAttempt(ledger, { command: CMD, inputs: "c2", status: "PASSED" }, undefined,
    "ok 1 - parses empty input # SKIP intentionally\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n");
  assert.equal(ledger.obligations![0].replays.at(-1)?.outcome, "unobserved");
  assert.equal(unmetObligations(ledger).length, 1);
});

test("minimising keeps the original failure record", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["big scenario"], "c1");
  authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "big scenario" });
  const b = failing(ledger, ["tiny scenario"], "c2");
  assert.equal(minimiseObligation(ledger, "RO1", { attempt: b.n, testName: "tiny scenario" }).ok, true);
  const ob = ledger.obligations![0];
  assert.equal(ob.testName, "tiny scenario");
  assert.equal(ob.failureRecord.failingTests?.[0], "big scenario");
  assert.equal(ob.failureRecord.testName, "big scenario");
  assert.equal(ob.history[0].from.testName, "big scenario");
  assert.equal(minimiseObligation(ledger, "RO1", { attempt: b.n, testName: "never failed" }).ok, false);
});

test("weakening edits to an obligation's test are recorded; strengthening is not", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["parses empty input"], "c1");
  authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "parses empty input" });
  const ob = ledger.obligations![0];
  const base = `test("parses empty input", () => {\n  assert.equal(f(""), 1);\n  assert.equal(f(" "), 1);\n});\n`;
  recordTestEdit(ledger, { path: "t.test.ts", before: base, after: base.replace("  assert.equal(f(\" \"), 1);\n", "  assert.equal(f(\" \"), 1);\n  assert.equal(f(\"a\"), 1);\n") });
  assert.equal(ob.weakenings.length, 0);
  recordTestEdit(ledger, { path: "t.test.ts", before: base, after: base.replace("  assert.equal(f(\" \"), 1);\n", "") });
  assert.equal(ob.weakenings.at(-1)?.kind, "fewer-assertions");
  recordTestEdit(ledger, { path: "t.test.ts", before: base, after: base.replace("test(", "test.skip(") });
  assert.equal(ob.weakenings.at(-1)?.kind, "skipped");
  recordTestEdit(ledger, { path: "t.test.ts", before: base, after: "" });
  assert.equal(ob.weakenings.at(-1)?.kind, "removed");
  assert.equal(ob.weakenings.length, 3);
  recordTestEdit(ledger, { path: "other.ts", before: "const x = 1;", after: "" });
  assert.equal(ob.weakenings.length, 3, "an unrelated file is not a weakening");
});

test("a ledger from before obligations behaves as before", () => {
  const ledger = createLedger("old");
  assert.deepEqual(replayCommands(ledger), []);
  assert.deepEqual(unmetObligations(ledger), []);
  recordTestEdit(ledger, { path: "a", before: "x", after: "" });
  assert.equal(ledger.obligations, undefined);
});

test("VC-3: each attempt records its parent and the diff hash between candidates", () => {
  const ledger = createLedger("work");
  const a = failing(ledger, ["t"], "c1");
  const b = failing(ledger, ["t"], "c2");
  const s = recordAttempt(ledger, { command: CMD, inputs: "c2", status: "SKIPPED_UNCHANGED_INPUTS" });
  const c = passing(ledger, "c3");
  assert.equal(a.parent, undefined);
  assert.equal(a.diffHash, undefined);
  assert.equal(b.parent, a.n);
  assert.match(b.diffHash!, /^[0-9a-f]{64}$/);
  assert.equal(s.parent, b.n);
  assert.equal(c.parent, b.n, "a skipped re-report is not a parent");
  assert.notEqual(c.diffHash, b.diffHash);
});

test("VC-3: a reference is only named by an authorised requirement; agreement is never equivalence", () => {
  const ledger = createLedger("1. keep behaviour\n2. be fast");
  assert.equal(authoriseReference(ledger, { authority: "operator", requirementId: "R1", reference: "git:HEAD~1" }).ok, true);
  assert.throws(() => authoriseReference(ledger, { authority: "model" as never, requirementId: "R2", reference: "x" }), /operator/);
  assert.equal(authoriseReference(ledger, { authority: "operator", requirementId: "R9", reference: "x" }).ok, false);
  ledger.requirements[1].source = "model";
  assert.equal(authoriseReference(ledger, { authority: "operator", requirementId: "R2", reference: "x" }).ok, false, "a model-added requirement cannot name a reference");
  assert.equal(differentialStatus(ledger, "R1").state, "authorised-not-run");
  assert.equal(differentialStatus(ledger, "R2").state, "no-reference");
  assert.match(agreementStatement(12), /12 tested input.*not equivalence/);
});

test("the operator verbs on /requirements are the only path to an obligation", async () => {
  const { SESSION_HANDLERS } = await import("../src/slash/session_commands.js");
  const ledger = createLedger("1. keep behaviour\n2. be fast");
  const a = failing(ledger, ["parses empty input"], "c1");
  let saves = 0;
  const host = { app: { getAgent: () => ({ getObjective: () => ledger }) }, saveSession: () => { saves++; } } as never;
  const run = (args: string) => SESSION_HANDLERS.requirements({ host, args } as never) as Promise<{ output: string; ok?: boolean }>;
  assert.equal(ledger.obligations, undefined);
  assert.match((await run(`obligate ${a.n} no such test`)).output, /Not done/);
  assert.equal(ledger.obligations, undefined);
  assert.match((await run(`obligate ${a.n} parses empty input`)).output, /RO1/);
  assert.equal(ledger.obligations?.length, 1);
  assert.match((await run("reference R2 git:HEAD~1")).output, /R2/);
  assert.equal(ledger.references?.[0].reference, "git:HEAD~1");
  assert.match((await run("retire RO1")).output, /RO1/);
  assert.equal(ledger.obligations?.[0].status, "retired");
  assert.ok(saves >= 3);
});

test("a timed-out attempt and a skipped re-report of unchanged inputs are not replays", () => {
  const ledger = createLedger("fix it");
  const a = failing(ledger, ["parses empty input"], "c1");
  assert.equal(authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "parses empty input" }).ok, true);
  const ob = ledger.obligations![0];
  recordAttempt(ledger, { command: CMD, inputs: "c2", status: "TIMED_OUT", failingTests: ["parses empty input"] } as never);
  assert.equal(ob.replays.length, 0, "a run that was cut off says nothing about the test");
  recordAttempt(ledger, { command: CMD, inputs: "c1", status: "SKIPPED_UNCHANGED_INPUTS", failingTests: ["parses empty input"] } as never);
  assert.equal(ob.replays.length, 0, "a skipped re-report of unchanged inputs ran nothing");
  failing(ledger, ["parses empty input"], "c3");
  assert.equal(ob.replays.length, 1, "a real run of the changed candidate is a replay");
});

test("the completion refusal names each unmet obligation and its replay command, and is silent once replayed", async () => {
  const { unmetObligationsMessage } = await import("../src/core/regression_obligations.js");
  const ledger = createLedger("fix it");
  assert.equal(unmetObligationsMessage(ledger), undefined, "no obligations: nothing to say");
  assert.equal(unmetObligationsMessage(undefined), undefined);
  const a = failing(ledger, ["parses empty input"], "c1");
  authoriseObligation(ledger, { authority: "operator", attempt: a.n, testName: "parses empty input" });
  const msg = unmetObligationsMessage(ledger)!;
  assert.match(msg, /RO1/);
  assert.match(msg, /parses empty input/);
  assert.match(msg, /npm test/);
  recordAttempt(ledger, { command: CMD, inputs: "c2", status: "PASSED" }, undefined, "ok 1 - unrelated test\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n");
  assert.match(unmetObligationsMessage(ledger)!, /did not show this test executing/);
  failing(ledger, ["parses empty input"], "c3");
  assert.match(unmetObligationsMessage(ledger)!, /last replay: fail/);
  passing(ledger, "c4");
  assert.equal(unmetObligationsMessage(ledger), undefined);
});

// VC-3 behavioural differential (fake executor; the real one is sandboxed and exercised below).
import {
  runDifferential, differentialSummary, DIFFERENTIAL_MAX_INPUTS, DIFFERENTIAL_MAX_INPUT_BYTES,
  type DifferentialExecutor,
} from "../src/core/regression_obligations.js";

const REF = "ref-cmd";
const CAND = "cand-cmd";
const withRef = () => {
  const ledger = createLedger("1. keep behaviour\n2. be fast");
  authoriseReference(ledger, { authority: "operator", requirementId: "R1", reference: REF });
  return ledger;
};
const exec = (f: (cmd: string, input: string) => { exit: number | null; output: string; timedOut?: boolean; error?: string }): DifferentialExecutor =>
  async (cmd, input) => f(cmd, input);
const run = (ledger: ObjectiveLedger, inputs: string[], execute: DifferentialExecutor) =>
  runDifferential(ledger, { authority: "operator", requirementId: "R1", candidate: CAND, inputs, execute });
const BANNED = /\b(equivalent|identical|correct)\b/i;

test("VC-3 differential: all inputs agree, worded as finite agreement", async () => {
  const ledger = withRef();
  const r = await run(ledger, ["a", "b", "c"], exec((_c, i) => ({ exit: 0, output: `out ${i}` })));
  assert.ok(r.ok);
  const s = differentialStatus(ledger, "R1");
  assert.deepEqual([s.state, s.agree, s.diverge, s.inconclusive], ["run", 3, 0, 0]);
  assert.match(s.statement!, /3 tested inputs.*not equivalence/);
  const text = differentialSummary(r.record);
  assert.match(text, /^run: 3 agree, 0 diverge/);
  assert.doesNotMatch(text + s.statement, BANNED);
});

test("VC-3 differential: a divergence names the input, both exits and the first differing line", async () => {
  const ledger = withRef();
  const r = await run(ledger, ["a", "b"], exec((c, i) => ({ exit: c === CAND && i === "b" ? 1 : 0, output: i === "b" ? `one\n${c === CAND ? "candidate says no" : "reference says yes"}` : "same" })));
  assert.ok(r.ok);
  assert.equal(r.record.results[0].verdict, "agree");
  const d = r.record.results[1];
  assert.deepEqual([d.input, d.verdict, d.referenceExit, d.candidateExit], [1, "diverge", 0, 1]);
  assert.match(d.firstDiff!, /reference: reference says yes \| candidate: candidate says no/);
  assert.equal(differentialStatus(ledger, "R1").diverge, 1);
  assert.match(differentialSummary(r.record), /^run: 1 agree, 1 diverge/);
});

test("VC-3 differential: a different exit code alone is a divergence", async () => {
  const r = await run(withRef(), ["a"], exec((c) => ({ exit: c === CAND ? 2 : 0, output: "same" })));
  assert.ok(r.ok);
  assert.equal(r.record.results[0].verdict, "diverge");
});

test("VC-3 differential: first differing line is clipped to 200 characters", async () => {
  const r = await run(withRef(), ["a"], exec((c) => ({ exit: 0, output: (c === CAND ? "c" : "r").repeat(5000) })));
  assert.ok(r.ok);
  assert.ok(r.record.results[0].firstDiff!.length <= 203);
});

test("VC-3 differential: volatile text is normalised so timestamps and ids still agree", async () => {
  const r = await run(withRef(), ["a"], exec((c) => ({ exit: 0, output: c === CAND ? "done at 2026-11-18T10:00:01Z in 12ms request_id=abc111" : "done at 2025-01-02T03:04:05Z in 340ms request_id=zzz999" })));
  assert.ok(r.ok);
  assert.equal(r.record.results[0].verdict, "agree");
});

test("VC-3 differential: timeout, error, thrown executor and over-cap output are inconclusive, never agree", async () => {
  const ledger = withRef();
  const r = await run(ledger, ["t", "e", "x", "big", "ok"], async (c, i) => {
    if (i === "t") return { exit: null, output: "", timedOut: true };
    if (i === "e") return { exit: 0, output: "same", error: "spawn failed" };
    if (i === "x") throw new Error("boom");
    if (i === "big") return { exit: 0, output: "z".repeat(1024 * 1024 + 1) };
    return { exit: 0, output: "same" };
  });
  assert.ok(r.ok);
  assert.deepEqual(r.record.results.map((x) => x.verdict), ["inconclusive", "inconclusive", "inconclusive", "inconclusive", "agree"]);
  const s = differentialStatus(ledger, "R1");
  assert.deepEqual([s.agree, s.inconclusive], [1, 4]);
  assert.match(differentialSummary(r.record), /4 inconclusive/);
  const one = await run(withRef(), ["t"], exec((c) => (c === REF ? { exit: 0, output: "x", timedOut: true } : { exit: 0, output: "x" })));
  assert.ok(one.ok);
  assert.equal(one.record.results[0].verdict, "inconclusive", "a timed-out reference alone is enough");
});

test("VC-3 differential: refused without an authorised reference, for a model-sourced requirement, and for a non-operator", async () => {
  const never = exec(() => { throw new Error("must not run"); });
  const ledger = createLedger("1. keep behaviour\n2. be fast");
  const none = await run(ledger, ["a"], never);
  assert.equal(none.ok, false);
  authoriseReference(ledger, { authority: "operator", requirementId: "R1", reference: REF });
  ledger.requirements[0].source = "model";
  const model = await run(ledger, ["a"], never);
  assert.equal(model.ok, false);
  assert.match((model as { reason: string }).reason, /model/);
  assert.equal(ledger.differentials, undefined);
  await assert.rejects(runDifferential(withRef(), { authority: "model" as never, requirementId: "R1", candidate: CAND, inputs: ["a"], execute: never }), /operator/);
  const other = await runDifferential(withRef(), { authority: "operator", requirementId: "R2", candidate: CAND, inputs: ["a"], execute: never });
  assert.equal(other.ok, false, "R2 has no reference");
});

test("VC-3 differential: input count and size caps refuse the whole run before executing anything", async () => {
  let calls = 0;
  const counting = exec(() => { calls++; return { exit: 0, output: "" }; });
  const ledger = withRef();
  const many = await run(ledger, Array.from({ length: DIFFERENTIAL_MAX_INPUTS + 1 }, (_, i) => `i${i}`), counting);
  assert.equal(many.ok, false);
  assert.ok((await run(ledger, Array.from({ length: DIFFERENTIAL_MAX_INPUTS }, (_, i) => `i${i}`), counting)).ok, "exactly the cap is allowed");
  const callsAtCap = calls;
  const big = await run(ledger, ["a", "x".repeat(DIFFERENTIAL_MAX_INPUT_BYTES + 1)], counting);
  assert.equal(big.ok, false);
  assert.ok((await run(ledger, ["x".repeat(DIFFERENTIAL_MAX_INPUT_BYTES)], counting)).ok, "exactly the size cap is allowed");
  assert.equal(calls, callsAtCap + 2, "refused runs executed nothing");
  assert.equal((await run(ledger, [], counting)).ok, false);
  const multi = await run(ledger, ["é".repeat(DIFFERENTIAL_MAX_INPUT_BYTES / 2 + 1)], counting);
  assert.equal(multi.ok, false, "the cap counts bytes, not characters");
});

test("VC-3 differential: the operator verb runs it with the real sandboxed executor, or reports inconclusive when no sandbox exists", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { SESSION_HANDLERS } = await import("../src/slash/session_commands.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc3-"));
  try {
    fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify(["hello", "world"]));
    const ledger = createLedger("1. keep behaviour");
    recordAttempt(ledger, { command: "cat", inputs: "c1", status: "PASSED" } as never);
    let saves = 0;
    const host = { app: { getAgent: () => ({ getObjective: () => ledger }), getConfig: () => ({ workspace: dir }) }, saveSession: () => { saves++; } } as never;
    const cmd = (args: string) => SESSION_HANDLERS.requirements({ host, args } as never) as Promise<{ output: string; success?: boolean }>;
    assert.match((await cmd("differential R1 --inputs inputs.json")).output, /Not done.*no authorised reference/);
    await cmd(`reference R1 cat`);
    assert.match((await cmd("differential R1")).output, /Usage/);
    const out = (await cmd("differential R1 --inputs inputs.json")).output;
    assert.match(out, /^Differential for R1/);
    assert.match(out, /run: \d+ agree, \d+ diverge/);
    assert.doesNotMatch(out, BANNED);
    assert.equal(ledger.differentials?.length, 1);
    assert.ok(saves >= 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
