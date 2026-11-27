import { randomUUID } from "node:crypto";
import { HarnessStore } from "./store.js";
import type { HarnessLibraryEntry, PromotionReport } from "./types.js";

export function draftLibraryEntriesFromReport(store: HarnessStore, report: PromotionReport): HarnessLibraryEntry[] {
  const now = new Date().toISOString();
  const entries: HarnessLibraryEntry[] = report.changes.map((c) => ({
    schemaVersion: 1,
    id: `hlesson_${randomUUID()}`,
    runId: report.runId,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    scope: { baseHarnessId: report.baseHarnessId },
    statement: `Candidate ${report.recommendedCandidateId ?? "unknown"} ${c.changeType} ${c.componentPath}: ${c.recommendation}. ${c.risks.join("; ")}`.slice(0, 500),
    evidenceIds: c.evidenceIds,
    confidence: c.recommendation === "reject" ? "medium" : "low",
    recommendation: c.recommendation,
    candidateId: report.recommendedCandidateId,
    reportId: report.id,
  }));
  for (const e of entries) store.saveLibraryEntry(e);
  return entries;
}

export function setLibraryEntryStatus(store: HarnessStore, id: string, status: "accepted" | "rejected"): HarnessLibraryEntry {
  const entry = store.loadLibraryEntry(id);
  entry.status = status;
  entry.updatedAt = new Date().toISOString();
  store.saveLibraryEntry(entry);
  return entry;
}

export function retrieveRelevantLibraryEntries(store: HarnessStore, opts: { baseHarnessId?: string; limit?: number; statuses?: Array<"draft" | "accepted" | "rejected"> }): HarnessLibraryEntry[] {
  const statuses = opts.statuses ?? ["accepted", "draft"];
  const limit = Math.max(0, Math.min(opts.limit ?? 5, 20));
  const entries = store.listLibraryEntries().filter((e) => statuses.includes(e.status));
  const scored = entries.map((e) => {
    let score = 0;
    if (opts.baseHarnessId && e.scope?.baseHarnessId === opts.baseHarnessId) score += 3;
    if (e.status === "accepted") score += 2;
    if (e.confidence === "high") score += 2;
    else if (e.confidence === "medium") score += 1;
    if (e.recommendation === "review" || e.recommendation === "apply") score += 1;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score || b.e.updatedAt.localeCompare(a.e.updatedAt));
  return scored.slice(0, limit).map((s) => s.e);
}
