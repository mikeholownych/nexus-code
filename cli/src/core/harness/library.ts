import { randomUUID } from "node:crypto";
import { HarnessStore } from "./store.js";
import type { HarnessLibraryEntry, PromotionReport } from "./types.js";

function normalizeStatement(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function draftLibraryEntriesFromReport(store: HarnessStore, report: PromotionReport): HarnessLibraryEntry[] {
  const now = new Date().toISOString();
  const existing = store.listLibraryEntries();
  const entries: HarnessLibraryEntry[] = [];
  for (const c of report.changes) {
    const statement = `Candidate ${report.recommendedCandidateId ?? "unknown"} ${c.changeType} ${c.componentPath}: ${c.recommendation}. ${c.risks.join("; ")}`.slice(0, 500);
    const norm = normalizeStatement(statement);
    const dup = existing.find((e) => e.runId === report.runId && normalizeStatement(e.statement) === norm);
    if (dup) continue;
    const entry: HarnessLibraryEntry = {
      schemaVersion: 1,
      id: `hlesson_${randomUUID()}`,
      runId: report.runId,
      createdAt: now,
      updatedAt: now,
      status: "draft",
      scope: { baseHarnessId: report.baseHarnessId },
      statement,
      evidenceIds: c.evidenceIds,
      confidence: c.recommendation === "reject" ? "medium" : "low",
      recommendation: c.recommendation,
      candidateId: report.recommendedCandidateId,
      reportId: report.id,
    };
    store.saveLibraryEntry(entry);
    entries.push(entry);
    existing.push(entry);
  }
  return entries;
}

export function setLibraryEntryStatus(store: HarnessStore, id: string, status: "accepted" | "rejected"): HarnessLibraryEntry {
  const entry = store.loadLibraryEntry(id);
  entry.status = status;
  entry.updatedAt = new Date().toISOString();
  store.saveLibraryEntry(entry);
  return entry;
}

export function retrieveRelevantLibraryEntries(store: HarnessStore, opts: { baseHarnessId?: string; limit?: number; statuses?: Array<"draft" | "accepted" | "rejected">; tags?: string[]; profile?: string }): HarnessLibraryEntry[] {
  const statuses = opts.statuses ?? ["accepted", "draft"];
  const limit = Math.max(0, Math.min(opts.limit ?? 5, 20));
  const tags = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
  const entries = store.listLibraryEntries().filter((e) => statuses.includes(e.status));
  const scored = entries.map((e) => {
    let score = 0;
    if (opts.baseHarnessId && e.scope?.baseHarnessId === opts.baseHarnessId) score += 4;
    if (opts.profile && e.scope?.profile === opts.profile) score += 2;
    if (tags.size > 0) for (const t of e.scope?.tags ?? []) if (tags.has(t.toLowerCase())) score += 2;
    if (e.status === "accepted") score += 2;
    if (e.confidence === "high") score += 2;
    else if (e.confidence === "medium") score += 1;
    if (e.recommendation === "review" || e.recommendation === "apply") score += 1;
    if (e.evidenceIds?.length) score += Math.min(2, e.evidenceIds.length / 4);
    const ageDays = (Date.now() - Date.parse(e.updatedAt || e.createdAt || "0")) / 86400000;
    if (Number.isFinite(ageDays)) score += Math.max(0, 1 - Math.min(ageDays, 30) / 30);
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score || b.e.updatedAt.localeCompare(a.e.updatedAt));
  const out: HarnessLibraryEntry[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    const norm = normalizeStatement(s.e.statement);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(s.e);
    if (out.length >= limit) break;
  }
  return out;
}
