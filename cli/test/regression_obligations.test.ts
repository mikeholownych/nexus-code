import { test } from "node:test";
import assert from "node:assert/strict";
import { createLedger, recordAttempt, type ObjectiveLedger } from "../src/core/objective.js";
import {
  authoriseObligation, minimiseObligation, recordTestEdit, replayCommands, unmetObligations,
  authoriseReference, agreementStatement, differentialStatus,
} from "../src/core/regression_obligations.js";

const CMD = "npm test";
const failing = (ledger: ObjectiveLedger, tests: string[], inputs: string, extra: object = {}) =>
  recordAttempt(ledger, { command: CMD, inputs, status: "FAILED", classification: "CANDIDATE_FAILED", exitCode: 1, failingTests: tests, failedCheck: tests[0], ...extra });
const passing = (ledger: ObjectiveLedger, inputs: string, command = CMD) =>
  recordAttempt(ledger, { command, inputs, status: "PASSED" });

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
  assert.equal(ob.replays.at(-1)?.outcome, "pass", "the obligation's own test still passes when another fails");
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
