import type { ProbeResult, ScorecardEntry } from "./types.js";

function verdictFromBool(base: boolean | null | undefined, cand: boolean | null | undefined): "better" | "worse" | "same" | "unknown" {
  if (cand == null) return "unknown";
  if (base === cand) return "same";
  if (cand === true && base !== true) return "better";
  if (cand === false && base !== false) return "worse";
  return "unknown";
}

function verdictFromNumber(base: number | null | undefined, cand: number | null | undefined, lowerIsBetter: boolean): "better" | "worse" | "same" | "unknown" {
  if (base == null || cand == null || !Number.isFinite(base) || !Number.isFinite(cand)) return "unknown";
  if (cand === base) return "same";
  if (lowerIsBetter) return cand < base ? "better" : "worse";
  return cand > base ? "better" : "worse";
}

function probeConfidence(p: ProbeResult | undefined): number {
  if (!p) return 0;
  let c = 0;
  if (p.status === "SUCCEEDED" || p.status === "FAILED") c += 0.5;
  if (p.metrics.verifierPass !== null) c += 0.4;
  if (p.metrics.wallClockMs > 0) c += 0.1;
  return Math.min(1, c);
}

export function compareProbes(base: ProbeResult[], candidate: ProbeResult[], candidateId: string): ScorecardEntry[] {
  const entries: ScorecardEntry[] = [];
  for (const c of candidate) {
    const b = base.find((x) => x.caseId === c.caseId);
    const conf = Math.min(probeConfidence(b), probeConfidence(c));
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
      confidence: cPass === null ? 0.2 : conf,
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
      delta: bMs != null ? `${cMs - bMs}ms` : undefined,
      verdict: bMs == null ? "unknown" : cMs < bMs ? "better" : cMs > bMs ? "worse" : "same",
      confidence: bMs == null ? 0.3 : 0.95,
      evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
    });

    const bLatency = b?.metrics.latencyMs?.total ?? bMs;
    const cLatency = c.metrics.latencyMs?.total ?? cMs;
    entries.push({
      candidateId,
      caseId: c.caseId,
      dimension: "latency",
      label: "deterministic",
      baseValue: bLatency,
      candidateValue: cLatency,
      delta: bLatency != null ? `${cLatency - bLatency}ms` : undefined,
      verdict: verdictFromNumber(bLatency, cLatency, true),
      confidence: bLatency == null ? 0.3 : 0.95,
      evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
    });

    const bCost = b?.metrics.costUsd ?? null;
    const cCost = c.metrics.costUsd ?? null;
    entries.push({
      candidateId,
      caseId: c.caseId,
      dimension: "cost",
      label: bCost == null && cCost == null ? "advisory" : "deterministic",
      baseValue: bCost,
      candidateValue: cCost,
      verdict: bCost == null && cCost == null ? "unknown" : verdictFromNumber(bCost, cCost, true),
      confidence: bCost == null && cCost == null ? 0.1 : 0.8,
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
      confidence: conf,
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
      confidence: 0.5,
      advisoryReason: "advisory only: blocked status is a coarse safety signal; manual review required",
      evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
    });

    // Advisory behavioral quality signal from observations; never authoritative.
    const bObs = b?.observations?.join("\n") ?? "";
    const cObs = c.observations?.join("\n") ?? "";
    const bRisk = /not.established|step.limit|tool.error|unsafe|denied/i.test(bObs);
    const cRisk = /not.established|step.limit|tool.error|unsafe|denied/i.test(cObs);
    entries.push({
      candidateId,
      caseId: c.caseId,
      dimension: "behavioral_quality",
      label: "advisory",
      baseValue: bRisk ? "risk-signals" : "no-risk-signals",
      candidateValue: cRisk ? "risk-signals" : "no-risk-signals",
      verdict: cRisk === bRisk ? "same" : cRisk ? "worse" : "better",
      confidence: 0.35,
      advisoryReason: "advisory only: heuristic observation scan; not an authoritative judge",
      evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
    });

    // Rubric evidence is advisory only in v1.3.1: we record presence, never auto-promote.
    const rubricRef = (c as any).rubricRef ?? (b as any)?.rubricRef;
    if (rubricRef) {
      entries.push({
        candidateId,
        caseId: c.caseId,
        dimension: "behavioral_quality",
        label: "advisory",
        baseValue: b ? rubricRef : null,
        candidateValue: rubricRef,
        verdict: "unknown",
        confidence: 0.2,
        advisoryReason: `advisory only: rubric referenced (${String(rubricRef)}); no authoritative rubric judge executed`,
        evidenceIds: [b?.id, c.id].filter(Boolean) as string[],
      });
    }
  }
  return entries;
}
