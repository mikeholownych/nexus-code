import type { ProbeResult, ScorecardEntry } from "./types.js";

function verdictFromBool(base: boolean | null | undefined, cand: boolean | null | undefined): "better" | "worse" | "same" | "unknown" {
  if (cand == null) return "unknown";
  if (base === cand) return "same";
  if (cand === true && base !== true) return "better";
  if (cand === false && base !== false) return "worse";
  return "unknown";
}

export function compareProbes(base: ProbeResult[], candidate: ProbeResult[], candidateId: string): ScorecardEntry[] {
  const entries: ScorecardEntry[] = [];
  for (const c of candidate) {
    const b = base.find((x) => x.caseId === c.caseId);
    const bPass = b?.metrics.verifierPass;
    const cPass = c.metrics.verifierPass;
    entries.push({
      candidateId,
      caseId: c.caseId,
      dimension: "correctness",
      label: cPass === null ? "advisory" : "deterministic",
      baseValue: bPass,
      candidateValue: cPass,
      verdict: cPass === null ? "unknown" : verdictFromBool(bPass, cPass),
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

    const bOk = b ? b.status === "SUCCEEDED" : null;
    const cOk = c.status === "SUCCEEDED";
    entries.push({
      candidateId,
      caseId: c.caseId,
      dimension: "reliability",
      label: "deterministic",
      baseValue: b?.status ?? null,
      candidateValue: c.status,
      verdict: verdictFromBool(bOk, cOk),
      evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
    });

    const bBlocked = b ? b.status === "BLOCKED" : null;
    const cBlocked = c.status === "BLOCKED";
    entries.push({
      candidateId,
      caseId: c.caseId,
      dimension: "safety",
      label: "advisory",
      baseValue: bBlocked,
      candidateValue: cBlocked,
      verdict: cBlocked === bBlocked ? "same" : cBlocked ? "worse" : bBlocked ? "better" : "unknown",
      evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
    });
  }
  return entries;
}
