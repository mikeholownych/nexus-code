import { randomUUID } from "node:crypto";
import { HarnessStore } from "./store.js";
import type { HarnessLibraryEntry, PromotionReport } from "./types.js";

export function draftLibraryEntriesFromReport(store: HarnessStore, report: PromotionReport): HarnessLibraryEntry[] {
  const now = new Date().toISOString();
  const entries: HarnessLibraryEntry[] = report.changes.map((c, i) => ({
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
