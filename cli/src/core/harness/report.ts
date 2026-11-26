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
}): PromotionReport {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    id: opts.id,
    runId: opts.runId,
    baseHarnessId: opts.baseHarnessId,
    recommendedCandidateId: opts.candidateId,
    status: "READY_FOR_REVIEW",
    createdAt,
    changes: opts.candidateId ? [{
      componentPath: "(candidate tree)",
      changeType: "modify",
      recommendation: opts.decision.recommendation === "reject" ? "reject" : "review",
      evidenceIds: Array.from(new Set(opts.scorecard.flatMap((s) => s.evidenceIds))),
      risks: opts.decision.reasons,
    }] : [],
    scorecard: opts.scorecard,
    applyInstructions: [
      "Review report.json and candidate diff/artifacts.",
      "If accepted, manually apply approved changes to the target harness in a separate reviewed change.",
      "Do not auto-apply HIR output; Nexus HIR never mutates live harness state.",
    ],
    nonPromotable: ["probe-only overlays", "temporary workspace paths", "redaction/policy pins"],
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
  lines.push("## Scorecard");
  for (const s of report.scorecard) {
    lines.push(`- [${s.label}] ${s.candidateId} ${s.caseId} ${s.dimension}: base=${JSON.stringify(s.baseValue)} candidate=${JSON.stringify(s.candidateValue)} verdict=${s.verdict}`);
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
