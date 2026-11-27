import { HarnessStore } from "./store.js";
import type { HirEvidenceRecord, HirEvent } from "./types.js";

export function recordEvent(store: HarnessStore, runId: string, type: string, message: string, data?: Record<string, unknown>): HirEvent {
  return store.appendEvent(runId, { type, message, data });
}

export function recordEvidence(store: HarnessStore, runId: string, rec: Omit<HirEvidenceRecord, "schemaVersion" | "id" | "runId" | "createdAt">): HirEvidenceRecord {
  return store.appendEvidence(runId, rec);
}
