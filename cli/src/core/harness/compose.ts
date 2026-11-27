import type { ScorecardEntry } from "./types.js";

export interface ComposeDecision {
  recommendedCandidateId?: string;
  recommendation: "apply" | "review" | "reject" | "defer";
  reasons: string[];
}

export function composeDecision(candidateId: string, scorecard: ScorecardEntry[]): ComposeDecision {
  const correctness = scorecard.filter((s) => s.dimension === "correctness");
  const hasDeterministic = correctness.some((s) => s.label === "deterministic");
  const anyWorse = correctness.some((s) => s.label === "deterministic" && s.verdict === "worse");
  const anyBetter = correctness.some((s) => s.label === "deterministic" && s.verdict === "better");
  const allUnknown = correctness.length > 0 && correctness.every((s) => s.verdict === "unknown");
  const avgConf = (entries: ScorecardEntry[]) => entries.length ? entries.reduce((a, s) => a + (s.confidence ?? 0.5), 0) / entries.length : 0;
  const correctnessConf = avgConf(correctness);
  if (anyWorse) return { recommendedCandidateId: candidateId, recommendation: "reject", reasons: [`deterministic correctness regression (confidence=${correctnessConf.toFixed(2)})`] };
  if (!hasDeterministic || allUnknown) return { recommendedCandidateId: candidateId, recommendation: "review", reasons: [`no deterministic correctness evidence; advisory only (confidence=${correctnessConf.toFixed(2)})`] };
  if (anyBetter) {
    const latency = scorecard.filter((s) => s.dimension === "latency");
    const cost = scorecard.filter((s) => s.dimension === "cost");
    const efficiencyNotes: string[] = [];
    if (latency.some((s) => s.verdict === "worse")) efficiencyNotes.push("latency regressed");
    if (cost.some((s) => s.verdict === "worse")) efficiencyNotes.push("cost regressed");
    return { recommendedCandidateId: candidateId, recommendation: "review", reasons: [`deterministic improvement observed; manual promotion required in v1 (confidence=${correctnessConf.toFixed(2)})`, ...efficiencyNotes] };
  }
  return { recommendedCandidateId: candidateId, recommendation: "reject", reasons: [`no improvement over base (confidence=${correctnessConf.toFixed(2)})`] };
}
