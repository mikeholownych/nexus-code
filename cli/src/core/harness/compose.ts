import type { ScorecardEntry } from "./types.js";

export interface ComposeDecision {
  recommendedCandidateId?: string;
  recommendation: "apply" | "review" | "reject" | "defer";
  reasons: string[];
}

function avgConf(entries: ScorecardEntry[]): number {
  return entries.length ? entries.reduce((a, s) => a + (typeof s.confidence === "number" ? s.confidence : 0.5), 0) / entries.length : 0;
}

function calibratedAdvisoryPenalty(entries: ScorecardEntry[]): number {
  const advisory = entries.filter((s) => s.label === "advisory");
  if (advisory.length === 0) return 0;
  const risky = advisory.filter((s) => s.verdict === "worse" || s.verdict === "unknown").length;
  return Math.min(0.35, (risky / advisory.length) * 0.35);
}

export function composeDecision(candidateId: string, scorecard: ScorecardEntry[]): ComposeDecision {
  const correctness = scorecard.filter((s) => s.dimension === "correctness");
  const deterministicCorrectness = correctness.filter((s) => s.label === "deterministic");
  const hasDeterministic = deterministicCorrectness.length > 0;
  const anyWorse = deterministicCorrectness.some((s) => s.verdict === "worse");
  const anyBetter = deterministicCorrectness.some((s) => s.verdict === "better");
  const allUnknown = correctness.length > 0 && correctness.every((s) => s.verdict === "unknown");
  const rawCorrectnessConf = avgConf(correctness);
  const correctnessConf = Math.max(0, Math.min(1, rawCorrectnessConf - calibratedAdvisoryPenalty(scorecard)));
  if (anyWorse) return { recommendedCandidateId: candidateId, recommendation: "reject", reasons: [`deterministic correctness regression (confidence=${correctnessConf.toFixed(2)})`] };
  if (!hasDeterministic || allUnknown) return { recommendedCandidateId: candidateId, recommendation: "review", reasons: [`no deterministic correctness evidence; advisory only (confidence=${correctnessConf.toFixed(2)})`] };
  if (anyBetter) {
    const latency = scorecard.filter((s) => s.dimension === "latency");
    const cost = scorecard.filter((s) => s.dimension === "cost");
    const efficiencyNotes: string[] = [];
    if (latency.some((s) => s.verdict === "worse")) efficiencyNotes.push("latency regressed");
    if (cost.some((s) => s.verdict === "worse")) efficiencyNotes.push("cost regressed");
    const advisoryRisks = scorecard.filter((s) => s.label === "advisory" && s.verdict === "worse");
    if (advisoryRisks.length > 0) efficiencyNotes.push(`advisory risks observed (${advisoryRisks.length}); non-authoritative`);
    const calibratedRecommendation: ComposeDecision["recommendation"] = correctnessConf < 0.55 ? "review" : "review";
    return { recommendedCandidateId: candidateId, recommendation: calibratedRecommendation, reasons: [`deterministic improvement observed; manual promotion required in v1 (confidence=${correctnessConf.toFixed(2)})`, ...efficiencyNotes] };
  }
  const reasons = [`no improvement over base (confidence=${correctnessConf.toFixed(2)})`];
  if (scorecard.some((s) => s.label === "advisory" && s.verdict === "better")) reasons.push("advisory-only improvements present; insufficient for promotion");
  return { recommendedCandidateId: candidateId, recommendation: "reject", reasons };
}
