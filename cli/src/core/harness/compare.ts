import type { ProbeResult, ScorecardEntry } from "./types.js";

export function compareProbes(base: ProbeResult[], candidate: ProbeResult[], candidateId: string): ScorecardEntry[] {
  const entries: ScorecardEntry[] = [];
  for (const c of candidate) {
    const b = base.find((x) => x.caseId === c.caseId);
    const bPass = b?.metrics.verifierPass;
    const cPass = c.metrics.verifierPass;
    const verdict = bPass === cPass ? "same" : cPass === true && bPass !== true ? "better" : cPass === false && bPass !== false ? "worse" : "unknown";
    entries.push({
      candidateId,
      caseId: c.caseId,
      dimension: "correctness",
      label: cPass === null ? "advisory" : "deterministic",
      baseValue: bPass,
      candidateValue: cPass,
      verdict: cPass === null ? "unknown" : verdict,
      evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
    });
    const bMs = b?.metrics.wallClockMs ?? null;
    const cMs = c.metrics.wallClockMs;
    entries.push({
      candidateId,
      caseId: c.caseId,
      dimension: "efficiency",
      label: "deterministic",
      baseValue: bMs,
      candidateValue: cMs,
      verdict: bMs == null ? "unknown" : cMs < bMs ? "better" : cMs > bMs ? "worse" : "same",
      evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
    });
  }
  return entries;
}
