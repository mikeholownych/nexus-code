/**
 * DV-3 regression obligations and the DV-4 reference gate.
 *
 * A confirmed failing test becomes a protected obligation only when the operator authorises it: nothing in the agent's
 * tool surface calls `authoriseObligation`; only operator commands do. The original failure record is immutable, so a
 * later minimisation keeps what was first seen. Each later verifier attempt of the obligation's command is a replay.
 * An edit that removes, skips or thins the obligation's test is recorded (never silently allowed, never blocked here).
 *
 * A replay passes only when the verifier output contains a recognised result line for the exact obligated test.
 * Overall suite success is not enough: the test may have been excluded or skipped. Pure data and pure functions; the
 * agent owns persistence.
 */
import type { ObjectiveLedger, VerificationAttempt } from "./objective.js";
import { normalizeOutcomeText } from "./execution_tracking.js";

export interface RegressionObligation {
  id: string;
  /** The test as currently replayed (its original name until minimised). */
  testName: string;
  /** The verifier command whose attempts replay this obligation. */
  command: string;
  authorisedAt: string;
  /** The failure as first confirmed. Never edited, including by minimisation. */
  failureRecord: { attempt: number; at: string; command: string; testName: string; failedCheck?: string; exitCode?: number; failingTests?: string[]; excerpt?: string };
  /** Earlier forms, oldest first, kept when the obligation was minimised. */
  history: Array<{ at: string; attempt: number; from: { testName: string; command: string }; to: { testName: string; command: string } }>;
  status: "active" | "retired";
  replays: Array<{ attempt: number; at: string; outcome: "pass" | "fail" | "unobserved"; observedTestName?: string }>;
  weakenings: Array<{ at: string; path: string; kind: WeakeningKind; detail: string }>;
}

export type WeakeningKind = "removed" | "skipped" | "fewer-assertions" | "unverifiable-change";

export interface ReferenceDeclaration { requirementId: string; reference: string; authorisedAt: string }

export type Authorisation = { ok: true; id: string } | { ok: false; reason: string };

const now = () => new Date().toISOString();

function requireOperator(authority: unknown): void {
  if (authority !== "operator") throw new Error("only the operator can authorise this");
}

/** A failed, candidate-attributed attempt that named the test. */
function confirmedFailure(ledger: ObjectiveLedger, attempt: number, testName: string): VerificationAttempt | string {
  const a = ledger.verification.find((v) => v.n === attempt);
  if (!a) return `no attempt ${attempt} is recorded`;
  if (a.status !== "FAILED" || a.classification !== "CANDIDATE_FAILED") return `attempt ${attempt} is not a confirmed candidate failure`;
  if (!a.failingTests?.includes(testName)) return `attempt ${attempt} did not name ${JSON.stringify(testName)} as failing`;
  return a;
}

/** Promote a confirmed failing test to an obligation. Throws unless the authority is the operator. */
export function authoriseObligation(ledger: ObjectiveLedger, req: { authority: "operator"; attempt: number; testName: string; at?: string }): Authorisation {
  requireOperator(req.authority);
  const found = confirmedFailure(ledger, req.attempt, req.testName);
  if (typeof found === "string") return { ok: false, reason: found };
  const list = (ledger.obligations ??= []);
  const existing = list.find((o) => o.status === "active" && o.testName === req.testName && o.command === found.command);
  if (existing) return { ok: true, id: existing.id };
  const at = req.at ?? now();
  const id = `RO${list.length + 1}`;
  list.push({
    id,
    testName: req.testName,
    command: found.command,
    authorisedAt: at,
    failureRecord: {
      attempt: found.n, at: found.at, command: found.command, testName: req.testName,
      ...(found.failedCheck ? { failedCheck: found.failedCheck } : {}),
      ...(found.exitCode !== undefined ? { exitCode: found.exitCode } : {}),
      ...(found.failingTests ? { failingTests: [...found.failingTests] } : {}),
      ...(found.excerpt ? { excerpt: found.excerpt } : {}),
    },
    history: [],
    status: "active",
    replays: [],
    weakenings: [],
  });
  return { ok: true, id };
}

/** Replace the replayed form with a smaller reproduction that was itself seen failing; the failure record is untouched. */
export function minimiseObligation(ledger: ObjectiveLedger, id: string, to: { attempt: number; testName: string }): Authorisation {
  const ob = ledger.obligations?.find((o) => o.id === id && o.status === "active");
  if (!ob) return { ok: false, reason: `no active obligation ${id}` };
  const found = confirmedFailure(ledger, to.attempt, to.testName);
  if (typeof found === "string") return { ok: false, reason: found };
  ob.history.push({ at: now(), attempt: to.attempt, from: { testName: ob.testName, command: ob.command }, to: { testName: to.testName, command: found.command } });
  ob.testName = to.testName;
  ob.command = found.command;
  return { ok: true, id };
}

export function retireObligation(ledger: ObjectiveLedger, id: string): Authorisation {
  const ob = ledger.obligations?.find((o) => o.id === id && o.status === "active");
  if (!ob) return { ok: false, reason: `no active obligation ${id}` };
  ob.status = "retired";
  return { ok: true, id };
}

const active = (ledger: ObjectiveLedger) => (ledger.obligations ?? []).filter((o) => o.status === "active");

/** The verifier commands the next candidate must be run with to replay every active obligation. */
export function replayCommands(ledger: ObjectiveLedger): string[] {
  return [...new Set(active(ledger).map((o) => o.command))];
}

/** Active obligations without a pass bound to the exact test name (including never replayed or older unbound passes). */
export function unmetObligations(ledger: ObjectiveLedger): RegressionObligation[] {
  return active(ledger).filter((o) => {
    const last = o.replays.at(-1);
    // Older persisted "pass" records have no binding to the exact obligated test and must not survive this change.
    return last?.outcome !== "pass" || last.observedTestName !== o.testName;
  });
}

/**
 * The refusal text for a completion while obligations are unmet, or undefined when none are. Names each obligation and
 * the command that replays it; a recorded pass of that command on the latest candidate is what discharges it.
 */
export function unmetObligationsMessage(ledger: ObjectiveLedger | undefined): string | undefined {
  const unmet = ledger ? unmetObligations(ledger) : [];
  if (!unmet.length) return undefined;
  const lines = unmet.map((o) => {
    const last = o.replays.at(-1);
    const replay = !last ? "not replayed yet" : last.outcome === "unobserved" || (last.outcome === "pass" && last.observedTestName !== o.testName)
      ? "the last verifier output did not show this test executing"
      : `last replay: ${last.outcome}`;
    return `  ${o.id}: test ${JSON.stringify(o.testName)} (${replay}); replay it with: ${o.command}`;
  });
  return `Not complete: the operator authorised regression obligations that are not met.\n${lines.join("\n")}\n` +
    `Run each command above on your current change and make the named test pass; verifier output must show a recognised result for that exact test. ` +
    `Do not remove, skip or thin the test: such an edit is recorded against the obligation. Only the operator can retire it.`;
}

/** Return results only for recognised runner lines naming one of the exact obligated tests. */
function observedTestResults(output: string | undefined, testNames: ReadonlySet<string>): Map<string, "pass" | "fail"> {
  const results = new Map<string, "pass" | "fail">();
  if (!output || !testNames.size) return results;
  const text = output.replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g, "");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let name: string | undefined;
    let status: string | undefined;
    const tap = line.match(/^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i);
    if (tap) {
      name = tap[2];
      status = tap[3] ? "skip" : tap[1].toLowerCase() === "ok" ? "pass" : "fail";
    }
    const spec = line.match(/^([✔✓√✖×✕])\s+(.+?)(?:\s+\([\d.]+\s*(?:ms|s)\))?$/);
    if (!name && spec) {
      name = spec[2];
      status = "✔✓√".includes(spec[1]) ? "pass" : "fail";
    }
    const pytest = line.match(/^(.+?)\s+(PASSED|FAILED|SKIPPED|XFAIL|XPASS)(?:\s+.*)?$/i);
    if (!name && pytest) {
      name = pytest[1];
      status = /^(PASSED)$/i.test(pytest[2]) ? "pass" : /^(FAILED)$/i.test(pytest[2]) ? "fail" : "skip";
    }
    const cargo = line.match(/^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)$/i);
    if (!name && cargo) {
      name = cargo[1];
      status = cargo[2].toLowerCase() === "ok" ? "pass" : cargo[2].toLowerCase() === "failed" ? "fail" : "skip";
    }
    const go = line.match(/^---\s+(PASS|FAIL|SKIP):\s+(\S+)/);
    if (!name && go) {
      name = go[2];
      status = go[1].toLowerCase() === "pass" ? "pass" : go[1].toLowerCase() === "fail" ? "fail" : "skip";
    }
    const unittest = line.match(/^(\S+(?:\s+\([^)]+\))?)\s+\.\.\.\s+(ok|FAIL|ERROR|skipped(?:\s+.*)?)$/i);
    if (!name && unittest) {
      name = unittest[1];
      status = /^ok$/i.test(unittest[2]) ? "pass" : /^(FAIL|ERROR)$/i.test(unittest[2]) ? "fail" : "skip";
    }
    if (!name || !testNames.has(name)) continue;
    if (status === "fail") results.set(name, "fail");
    else if (status === "pass" && !results.has(name)) results.set(name, "pass");
  }
  return results;
}

/** Called for every recorded attempt; a successful command alone is not proof that this obligation's test ran. */
export function replayObligations(ledger: ObjectiveLedger, attempt: VerificationAttempt, output?: string): void {
  if (attempt.status === "SKIPPED_UNCHANGED_INPUTS" || attempt.status === "TIMED_OUT" || attempt.classification === "ENVIRONMENT" || attempt.filtered) return;
  const obligations = active(ledger).filter((ob) => ob.command === attempt.command);
  const observed = observedTestResults(output, new Set(obligations.map((ob) => ob.testName)));
  for (const ob of obligations) {
    const result = observed.get(ob.testName);
    const outcome = result ?? "unobserved";
    ob.replays.push({ attempt: attempt.n, at: attempt.at, outcome, ...(result ? { observedTestName: ob.testName } : {}) });
  }
}

const SKIP_MARKER = /\.skip\b|\bxit\b|\bxtest\b|\bxdescribe\b|\.todo\b|@(?:pytest\.mark\.)?skip\b|\bt\.Skip(?:Now)?\(/g;
const ASSERTION = /\b(?:assert\w*|expect|require\.\w+|t\.(?:Error|Fatal)\w*)\s*[.(]|\.should\b|\bself\.assert\w*/g;
const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/**
 * Every way an edit weakens a test file, the strongest first: the test is gone, a skip marker was added, assertions were
 * removed. With `testName`, "gone" means that name no longer appears; without one, that nothing is left of the file
 * (`after` is "" when it was deleted). Heuristics over text, not proof: an empty result does not show the edit is harmless.
 */
export function classifyTestEdit(before: string, after: string, testName?: string): Array<{ kind: Exclude<WeakeningKind, "unverifiable-change">; detail: string }> {
  const found: Array<{ kind: Exclude<WeakeningKind, "unverifiable-change">; detail: string }> = [];
  if (testName !== undefined) {
    if (!after.includes(testName)) found.push({ kind: "removed", detail: "the test no longer appears in the file" });
  } else if (before.trim() && !after.trim()) found.push({ kind: "removed", detail: "nothing is left of the test file" });
  if (count(after, SKIP_MARKER) > count(before, SKIP_MARKER)) found.push({ kind: "skipped", detail: "a skip marker was added" });
  if (count(after, ASSERTION) < count(before, ASSERTION)) found.push({ kind: "fewer-assertions", detail: `assertions ${count(before, ASSERTION)} -> ${count(after, ASSERTION)}` });
  return found;
}

/** Record a weakening of any active obligation's test in an edited file. `after` is "" when the file was deleted. */
export function recordTestEdit(ledger: ObjectiveLedger, edit: { path: string; before: string; after: string; at?: string }): void {
  for (const ob of active(ledger)) {
    if (!edit.before.includes(ob.testName)) continue;
    const weakening = classifyTestEdit(edit.before, edit.after, ob.testName)[0];
    if (weakening) ob.weakenings.push({ at: edit.at ?? now(), path: edit.path, ...weakening });
  }
}

/** Record a detected test-file change when bounded snapshots cannot establish whether an authorised test was weakened. */
export function recordUnverifiableTestEdit(ledger: ObjectiveLedger, path: string, detail: string, at?: string): void {
  for (const ob of active(ledger)) {
    if (ob.weakenings.some((w) => w.kind === "unverifiable-change" && w.path === path && w.detail === detail)) continue;
    ob.weakenings.push({ at: at ?? now(), path, kind: "unverifiable-change", detail });
  }
}

/**
 * DV-4 gate: a behavioural reference (previous revision, golden cases) may be declared only by the operator, and only
 * for a requirement the operator wrote. This records authority only; `runDifferential` (VC-3) runs the comparison.
 */
export function authoriseReference(ledger: ObjectiveLedger, req: { authority: "operator"; requirementId: string; reference: string; at?: string }): Authorisation {
  requireOperator(req.authority);
  const r = ledger.requirements.find((x) => x.id === req.requirementId);
  if (!r) return { ok: false, reason: `no requirement ${req.requirementId}` };
  if (r.source === "model") return { ok: false, reason: `${r.id} was added by the model, so it cannot name a reference` };
  const refs = (ledger.references ??= []);
  const prior = refs.find((x) => x.requirementId === r.id);
  if (prior) prior.reference = req.reference;
  else refs.push({ requirementId: r.id, reference: req.reference, authorisedAt: req.at ?? now() });
  return { ok: true, id: r.id };
}

export interface DifferentialState {
  state: "no-reference" | "authorised-not-run" | "run";
  reference?: string;
  agree?: number;
  diverge?: number;
  inconclusive?: number;
  /** Wording for the result; only ever "agrees on N tested inputs, not equivalence". */
  statement?: string;
}

export function differentialStatus(ledger: ObjectiveLedger, requirementId: string): DifferentialState {
  const ref = ledger.references?.find((x) => x.requirementId === requirementId);
  if (!ref) return { state: "no-reference" };
  const run = ledger.differentials?.find((x) => x.requirementId === requirementId);
  if (!run) return { state: "authorised-not-run", reference: ref.reference };
  const agree = run.results.filter((r) => r.verdict === "agree").length;
  const diverge = run.results.filter((r) => r.verdict === "diverge").length;
  const inconclusive = run.results.length - agree - diverge;
  return { state: "run", reference: run.reference, agree, diverge, inconclusive, ...(agree > 0 ? { statement: agreementStatement(agree) } : {}) };
}

export const DIFFERENTIAL_MAX_INPUTS = 50;
export const DIFFERENTIAL_MAX_INPUT_BYTES = 64 * 1024;
export const DIFFERENTIAL_MAX_OUTPUT_CHARS = 1024 * 1024;
const FIRST_DIFF_CLIP = 200;

/** One command run on one stdin input. `timedOut` or `error` mean the run says nothing about behaviour. */
export interface DifferentialRunResult { exit: number | null; output: string; timedOut?: boolean; error?: string }
export type DifferentialExecutor = (command: string, input: string) => Promise<DifferentialRunResult>;

export interface DifferentialInputResult {
  input: number;
  verdict: "agree" | "diverge" | "inconclusive";
  referenceExit: number | null;
  candidateExit: number | null;
  /** First normalised line where the outputs differ, clipped; absent when only the exit codes differ. */
  firstDiff?: string;
}

export interface DifferentialRecord { requirementId: string; reference: string; candidate: string; at: string; results: DifferentialInputResult[] }

const clip = (s: string) => (s.length > FIRST_DIFF_CLIP ? `${s.slice(0, FIRST_DIFF_CLIP)}...` : s);
const usable = (r: DifferentialRunResult) => !r.timedOut && !r.error && r.exit !== null && r.output.length <= DIFFERENTIAL_MAX_OUTPUT_CHARS;

function firstDifferingLine(a: string, b: string): string | undefined {
  const x = normalizeOutcomeText(a).split("\n");
  const y = normalizeOutcomeText(b).split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return clip(`reference: ${x[i] ?? "(no line)"} | candidate: ${y[i] ?? "(no line)"}`);
  }
  return undefined;
}

/**
 * VC-3: run the candidate and the operator-declared reference on each declared input (stdin) through an injected
 * executor and compare normalised output plus exit code. Refused unless the reference was authorised for an
 * operator-written requirement (the same gate as `authoriseReference`). A timed-out, errored or over-cap run is
 * "inconclusive" for that input, never agreement. Agreement on finite inputs is not equivalence.
 */
export async function runDifferential(
  ledger: ObjectiveLedger,
  req: { authority: "operator"; requirementId: string; candidate: string; inputs: string[]; execute: DifferentialExecutor; at?: string },
): Promise<{ ok: true; record: DifferentialRecord } | { ok: false; reason: string }> {
  requireOperator(req.authority);
  const r = ledger.requirements.find((x) => x.id === req.requirementId);
  const ref = ledger.references?.find((x) => x.requirementId === req.requirementId);
  if (!r || !ref) return { ok: false, reason: `${req.requirementId} has no authorised reference` };
  if (r.source === "model") return { ok: false, reason: `${r.id} was added by the model, so it cannot use a reference` };
  if (!req.candidate.trim()) return { ok: false, reason: "no candidate command" };
  if (!req.inputs.length) return { ok: false, reason: "no inputs declared" };
  if (req.inputs.length > DIFFERENTIAL_MAX_INPUTS) return { ok: false, reason: `${req.inputs.length} inputs exceed the limit of ${DIFFERENTIAL_MAX_INPUTS}` };
  const big = req.inputs.findIndex((i) => Buffer.byteLength(i) > DIFFERENTIAL_MAX_INPUT_BYTES);
  if (big >= 0) return { ok: false, reason: `input ${big} exceeds ${DIFFERENTIAL_MAX_INPUT_BYTES} bytes` };

  const results: DifferentialInputResult[] = [];
  for (let i = 0; i < req.inputs.length; i++) {
    const safe = async (cmd: string): Promise<DifferentialRunResult> => {
      try { return await req.execute(cmd, req.inputs[i]); } catch (e) { return { exit: null, output: "", error: String(e) }; }
    };
    const refRun = await safe(ref.reference);
    const candRun = await safe(req.candidate);
    const base = { input: i, referenceExit: refRun.exit, candidateExit: candRun.exit };
    if (!usable(refRun) || !usable(candRun)) { results.push({ ...base, verdict: "inconclusive" }); continue; }
    const same = refRun.exit === candRun.exit && normalizeOutcomeText(refRun.output) === normalizeOutcomeText(candRun.output);
    results.push(same ? { ...base, verdict: "agree" } : { ...base, verdict: "diverge", firstDiff: firstDifferingLine(refRun.output, candRun.output) });
  }
  const record: DifferentialRecord = { requirementId: r.id, reference: ref.reference, candidate: req.candidate, at: req.at ?? now(), results };
  const runs = (ledger.differentials ??= []);
  const at = runs.findIndex((x) => x.requirementId === r.id);
  if (at >= 0) runs[at] = record; else runs.push(record);
  return { ok: true, record };
}

/** Operator-facing summary of a run; wording comes from `agreementStatement`. */
export function differentialSummary(record: DifferentialRecord): string {
  const agree = record.results.filter((x) => x.verdict === "agree").length;
  const diverge = record.results.filter((x) => x.verdict === "diverge");
  const inconclusive = record.results.filter((x) => x.verdict === "inconclusive").length;
  const lines = [`run: ${agree} agree, ${diverge.length} diverge${inconclusive ? `, ${inconclusive} inconclusive (timeout, error or output over the cap)` : ""}`];
  for (const d of diverge) lines.push(`  input ${d.input}: exit ${d.referenceExit} vs ${d.candidateExit}${d.firstDiff ? `; ${d.firstDiff}` : ""}`);
  if (agree > 0) lines.push(agreementStatement(agree));
  return lines.join("\n");
}

/** How agreement with a reference is worded: finite cases are never reported as equivalence. */
export function agreementStatement(testedInputs: number): string {
  return `Agrees with the reference on ${testedInputs} tested input${testedInputs === 1 ? "" : "s"}; this is not equivalence and says nothing about untested inputs.`;
}
