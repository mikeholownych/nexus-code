/**
 * VR-1's minimal independent reviewer for `nexus verify`.
 *
 * It reads the same objective evidence package the receipt records - changed paths, the verification-file guard's
 * findings, the process receipts and the derived verification/typecheck evidence - and deliberately receives no
 * implementer narrative. Its structured verdict can withhold VERIFIED when the evidence contradicts itself, but it
 * never supplies evidence of its own: the deterministic gates remain the sole authority for a passing result.
 *
 * This reviewer is deterministic so the CI gate needs no gateway, model or credentials. A model-backed reviewer with
 * a cross-harness verdict-parity acceptance test is a separate VR-1 slice.
 */
import type { VerifyJsonResult, VerifyReview } from "../verify_contract.js";

export type ReviewEvidence = Pick<
  VerifyJsonResult,
  "changedFiles" | "deliverables" | "guard" | "runs" | "verification" | "typecheck" | "verifier" | "baseline"
>;

const clip = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

export type CompletedReview = Extract<VerifyReview, { status: "COMPLETE" }>;

export function reviewEvidence(evidence: ReviewEvidence): CompletedReview {
  const observations: string[] = [];
  const suspectedDefects: Array<{ path: string; description: string }> = [];
  const unprovenCriteria: string[] = [];
  const scopeViolations: string[] = [];
  const guard = evidence.guard;
  const verification = evidence.verification;
  const headRuns = evidence.runs.filter((run) => run.phase === "head");

  observations.push(`${evidence.changedFiles.length} changed file(s), ${evidence.deliverables.length} declared deliverable(s)`);
  observations.push(`guard ${guard.status} with ${guard.findings.length} finding(s)${guard.complete ? "" : " (incomplete scan)"}`);
  if (verification) {
    observations.push(`verifier ${verification.command ?? "none"} (${verification.source ?? "unselected"}): ${verification.status}`);
  } else observations.push("no verifier evidence");
  if (evidence.runs.length) observations.push(`receipts: ${evidence.runs.map((run) => `${run.phase}${run.passed ? " passed" : " failed"}`).join(", ")}`);

  // A weakening is a defect even when the operator approved reporting the result: approval never makes the change good.
  for (const finding of guard.findings) {
    if (finding.weakening?.length) {
      suspectedDefects.push({
        path: finding.path,
        description: `the change weakens ${finding.path}: ${finding.weakening.join(", ")}`,
      });
    }
    if (evidence.deliverables.includes(finding.path)) {
      scopeViolations.push(`${finding.path} is both a declared deliverable and a changed verification file (${finding.kind})`);
    }
  }

  // Contradictions between the claim and its receipts: a verdict must never rest on a pass that did not occur.
  if (verification?.status === "PASSED" && !headRuns.some((run) => run.passed)) {
    suspectedDefects.push({ path: "receipts", description: "verification claims a passing head run, but no head receipt passed" });
  }
  if (verification?.hasExecutedTests === true && !evidence.runs.some((run) => run.executedTests)) {
    suspectedDefects.push({ path: "receipts", description: "verification claims tests executed, but no receipt shows a test ran" });
  }
  if (evidence.typecheck.status === "PASSED" && !verification?.typecheck) {
    suspectedDefects.push({ path: "typecheck", description: "the type-check summary says PASSED, but the verification receipt carries no type-check evidence" });
  }
  if (guard.status === "NOT_RUN") {
    suspectedDefects.push({ path: "guard", description: "the reviewer was asked before the verification-file guard read the change" });
  }

  if (guard.status === "CLEAR" && verification?.isDeliverableBound !== true && evidence.deliverables.length) {
    unprovenCriteria.push("the declared deliverables were not shown to be covered by pre-change tests");
  }
  if (verification?.independent !== true) {
    unprovenCriteria.push("no pass of pre-change tests against the changed code established independence");
  }
  if (evidence.typecheck.status === "NOT_RUN") {
    unprovenCriteria.push("no type-check evidence was gathered");
  }
  if (evidence.baseline && !evidence.baseline.usable) {
    unprovenCriteria.push("the base verifier run cannot serve as the fail-before half of independent evidence");
  }

  const verdict = suspectedDefects.length || scopeViolations.length ? "REJECT" : "ACCEPT";
  return {
    status: "COMPLETE",
    verdict,
    detail: clip(`${verdict}: ${suspectedDefects.length} contradiction(s), ${scopeViolations.length} scope violation(s), ${unprovenCriteria.length} unproven criterion/criteria`),
    verifiedObservations: observations,
    suspectedDefects,
    unprovenCriteria,
    scopeViolations,
    reviewerConfidenceNote: "Deterministic reading of the recorded evidence package; no model or implementer narrative was consulted.",
  };
}

/** The initial, honest value: no reviewer has read anything yet. */
export const NOT_RUN_REVIEW: VerifyReview = {
  status: "NOT_RUN",
  detail: "verification ended before the independent reviewer read the evidence",
};
