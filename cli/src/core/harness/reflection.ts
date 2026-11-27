import type { ProbeResult, ScorecardEntry } from "./types.js";

export interface ReflectionSummary {
  candidateId: string;
  round: number;
  recommendation: string;
  strengths: string[];
  weaknesses: string[];
  evidenceIds: string[];
}

export function reflectCandidate(opts: {
  candidateId: string;
  round: number;
  recommendation: string;
  scorecard: ScorecardEntry[];
  probes: ProbeResult[];
}): ReflectionSummary {
  const evidenceIds = Array.from(new Set([...opts.scorecard.flatMap((s) => s.evidenceIds), ...opts.probes.map((p) => p.id)]));
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  for (const s of opts.scorecard) {
    if (s.dimension !== "correctness") continue;
    if (s.verdict === "better") strengths.push(`${s.caseId}: improved over base`);
    if (s.verdict === "worse") weaknesses.push(`${s.caseId}: regressed vs base`);
    if (s.verdict === "unknown") weaknesses.push(`${s.caseId}: no deterministic verdict`);
  }
  for (const p of opts.probes) {
    if (p.status !== "SUCCEEDED") weaknesses.push(`${p.caseId}: probe ${p.status.toLowerCase()}`);
  }
  if (strengths.length === 0) strengths.push("no deterministic correctness improvements observed");
  if (weaknesses.length === 0) weaknesses.push("no deterministic regressions observed");
  return { candidateId: opts.candidateId, round: opts.round, recommendation: opts.recommendation, strengths, weaknesses, evidenceIds };
}
