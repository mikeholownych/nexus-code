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
  if (anyWorse) return { recommendedCandidateId: candidateId, recommendation: "reject", reasons: ["deterministic correctness regression"] };
  if (!hasDeterministic || allUnknown) return { recommendedCandidateId: candidateId, recommendation: "review", reasons: ["no deterministic correctness evidence; advisory only"] };
  if (anyBetter) return { recommendedCandidateId: candidateId, recommendation: "review", reasons: ["deterministic improvement observed; manual promotion required in v1"] };
  return { recommendedCandidateId: candidateId, recommendation: "reject", reasons: ["no improvement over base"] };
}
