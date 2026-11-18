/**
 * DV-3 regression obligations and the DV-4 reference gate.
 *
 * A confirmed failing test becomes a protected obligation only when the operator authorises it: nothing in the agent's
 * tool surface calls `authoriseObligation`; only operator commands do. The original failure record is immutable, so a
 * later minimisation keeps what was first seen. Each later verifier attempt of the obligation's command is a replay.
 * An edit that removes, skips or thins the obligation's test is recorded (never silently allowed, never blocked here).
 *
 * Limits: a replay says the verifier's output did or did not name the test as failing; a verifier that never runs the
 * test passes it vacuously, which Nexus cannot see. Pure data and pure functions; the agent owns persistence.
 */
import type { ObjectiveLedger, VerificationAttempt } from "./objective.js";

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
  replays: Array<{ attempt: number; at: string; outcome: "pass" | "fail" }>;
  weakenings: Array<{ at: string; path: string; kind: WeakeningKind; detail: string }>;
}

export type WeakeningKind = "removed" | "skipped" | "fewer-assertions";

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

/** Active obligations whose latest replay is not a pass (including never replayed). */
export function unmetObligations(ledger: ObjectiveLedger): RegressionObligation[] {
  return active(ledger).filter((o) => o.replays.at(-1)?.outcome !== "pass");
}

/** Called for every recorded attempt: a replay is an attempt of the obligation's command that can say whether its test failed. */
export function replayObligations(ledger: ObjectiveLedger, attempt: VerificationAttempt): void {
  if (attempt.status === "SKIPPED_UNCHANGED_INPUTS" || attempt.status === "TIMED_OUT" || attempt.classification === "ENVIRONMENT" || attempt.filtered) return;
  for (const ob of active(ledger)) {
    if (ob.command !== attempt.command) continue;
    let outcome: "pass" | "fail" | undefined;
    if (attempt.status === "PASSED") outcome = "pass";
    else if (attempt.failingTests?.length && !attempt.failingTruncated) outcome = attempt.failingTests.includes(ob.testName) ? "fail" : "pass";
    else if (attempt.failingTests?.includes(ob.testName)) outcome = "fail";
    if (outcome) ob.replays.push({ attempt: attempt.n, at: attempt.at, outcome });
  }
}

const SKIP_MARKER = /\.skip\b|\bxit\b|\bxtest\b|\bxdescribe\b|\.todo\b|@(?:pytest\.mark\.)?skip\b|\bt\.Skip(?:Now)?\(/g;
const ASSERTION = /\b(?:assert\w*|expect|require\.\w+|t\.(?:Error|Fatal)\w*)\s*[.(]|\.should\b|\bself\.assert\w*/g;
const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/** Record a weakening of any active obligation's test in an edited file. `after` is "" when the file was deleted. */
export function recordTestEdit(ledger: ObjectiveLedger, edit: { path: string; before: string; after: string; at?: string }): void {
  for (const ob of active(ledger)) {
    if (!edit.before.includes(ob.testName)) continue;
    let weakening: { kind: WeakeningKind; detail: string } | undefined;
    if (!edit.after.includes(ob.testName)) weakening = { kind: "removed", detail: "the test no longer appears in the file" };
    else if (count(edit.after, SKIP_MARKER) > count(edit.before, SKIP_MARKER)) weakening = { kind: "skipped", detail: "a skip marker was added" };
    else if (count(edit.after, ASSERTION) < count(edit.before, ASSERTION)) weakening = { kind: "fewer-assertions", detail: `assertions ${count(edit.before, ASSERTION)} -> ${count(edit.after, ASSERTION)}` };
    if (weakening) ob.weakenings.push({ at: edit.at ?? now(), path: edit.path, ...weakening });
  }
}

/**
 * DV-4 gate: a behavioural reference (previous revision, golden cases) may be declared only by the operator, and only
 * for a requirement the operator wrote. The differential itself is NOT implemented: this records authority only.
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

export function differentialStatus(ledger: ObjectiveLedger, requirementId: string): { state: "no-reference" | "authorised-not-run"; reference?: string } {
  const ref = ledger.references?.find((x) => x.requirementId === requirementId);
  return ref ? { state: "authorised-not-run", reference: ref.reference } : { state: "no-reference" };
}

/** How agreement with a reference is worded: finite cases are never reported as equivalence. */
export function agreementStatement(testedInputs: number): string {
  return `Agrees with the reference on ${testedInputs} tested input${testedInputs === 1 ? "" : "s"}; this is not equivalence and says nothing about untested inputs.`;
}
