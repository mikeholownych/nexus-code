import type { PromotionReport, ScorecardEntry } from "./types.js";
import type { ComposeDecision } from "./compose.js";

export function buildPromotionReport(opts: {
  id: string;
  runId: string;
  baseHarnessId: string;
  candidateId?: string;
  decision: ComposeDecision;
  scorecard: ScorecardEntry[];
  createdAt?: string;
  candidates?: Array<{ id: string; diffRef: string; gateStatus: string }>;
}): PromotionReport {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const evidenceIds = Array.from(new Set(opts.scorecard.flatMap((s) => s.evidenceIds)));
  const changes = (opts.candidates ?? (opts.candidateId ? [{ id: opts.candidateId, diffRef: "", gateStatus: "PASS" }] : [])).map((c) => ({
    componentPath: c.diffRef || `(candidate ${c.id})`,
    changeType: "modify" as const,
    recommendation: c.id === opts.candidateId
      ? (opts.decision.recommendation === "reject" ? "reject" as const : "review" as const)
      : c.gateStatus === "FAIL" ? "reject" as const : "review" as const,
    evidenceIds,
    risks: c.id === opts.candidateId ? opts.decision.reasons : [`candidate ${c.id} not selected`],
  }));
  return {
    schemaVersion: 1,
    id: opts.id,
    runId: opts.runId,
    baseHarnessId: opts.baseHarnessId,
    recommendedCandidateId: opts.candidateId,
    status: "READY_FOR_REVIEW",
    createdAt,
    changes,
    scorecard: opts.scorecard,
    applyInstructions: [
      "Review report.json, scorecards, and candidate diff artifacts under <state>/harness/candidates/<id>/diff.txt.",
      "If accepted, manually apply approved changes to the target harness in a separate reviewed change and re-run verification.",
      "Do not auto-apply HIR output; Nexus HIR never mutates live harness state.",
    ],
    nonPromotable: ["probe-only overlays", "temporary workspace paths", "redaction/policy pins", "unsandboxed real-probe overrides"],
    noApplyWarning: "HIR does not apply changes. Operator review and manual apply required.",
  };
}

export function renderPromotionReportMd(report: PromotionReport): string {
  const lines: string[] = [];
  lines.push(`# Harness Improvement Report ${report.id}`);
  lines.push("");
  lines.push(`- Run: ${report.runId}`);
  lines.push(`- Base harness: ${report.baseHarnessId}`);
  lines.push(`- Recommended candidate: ${report.recommendedCandidateId ?? "(none)"}`);
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Created: ${report.createdAt}`);
  lines.push("");
  lines.push(`> ${report.noApplyWarning}`);
  lines.push("");
  lines.push("## Changes");
  for (const c of report.changes) {
    lines.push(`- ${c.recommendation.toUpperCase()} ${c.changeType} ${c.componentPath}`);
    for (const r of c.risks) lines.push(`  - risk: ${r}`);
  }
  if (report.changes.length === 0) lines.push("- (no candidate changes)");
  lines.push("");
  lines.push("## Scorecard");
  for (const s of report.scorecard) {
    const conf = s.confidence == null ? "" : ` conf=${s.confidence.toFixed(2)}`;
    const delta = s.delta ? ` delta=${s.delta}` : "";
    lines.push(`- [${s.label}] ${s.candidateId} ${s.caseId} ${s.dimension}: base=${JSON.stringify(s.baseValue)} candidate=${JSON.stringify(s.candidateValue)}${delta} verdict=${s.verdict}${conf}`);
  }
  if (report.scorecard.length === 0) lines.push("- (no scorecard entries)");
  lines.push("");
  lines.push("## Apply Instructions");
  for (const i of report.applyInstructions) lines.push(`- ${i}`);
  lines.push("");
  lines.push("## Non-promotable");
  for (const n of report.nonPromotable) lines.push(`- ${n}`);
  lines.push("");
  return lines.join("\n");
}
