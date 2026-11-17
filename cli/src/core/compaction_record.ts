/**
 * CX-2: an auditable record of each compaction, kept beside the archive of the originals it replaced.
 *
 * A compaction replaces earlier messages with a shorter form. Its record names what it covered (a content-addressed id
 * per message, in order, and one digest over them), where the replacement was inserted and what it was, so the
 * compaction can be checked on resume and undone: the originals are in the archive, and `fullTranscript` puts them back.
 * The record rides on the first archive line of its compaction as an extra key, so builds that predate it read the same
 * file unchanged (they ignore the key) and a compaction with no record is simply not auditable.
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../types.js";

export const COMPACTION_RECORD_VERSION = 1;
/** Ids listed per record; a larger compaction keeps its count and digest and says the list was cut. */
export const MAX_COVERED_IDS = 4096;

export interface CompactionRecord {
  v: typeof COMPACTION_RECORD_VERSION;
  trigger: string;
  /** Content-addressed ids (16 hex characters of the message's SHA-256) of the messages this compaction replaced, in order. */
  coveredIds: string[];
  coveredIdsTruncated?: true;
  coveredCount: number;
  /** SHA-256 over every covered message's full id, in order: the hash of the covered prefix. */
  coveredSha256: string;
  /** Where in the compacted conversation the new messages sit (index of the first), and what they were. */
  inserted: { at: number; count: number; sha256: string; chars: number } | null;
  beforeTokens: number;
  afterTokens: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Canonical JSON of a stored message: keys in sorted order at every depth, so the same message always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((k) => record[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The full id of a message: SHA-256 of its canonical stored form. */
export const messageDigest = (message: unknown): string => sha256(canonical(message));

/** The record of a compaction. `covered` and `inserted` are in their stored (persistence-protected) form, the one the archive and the session record hold. */
export function buildCompactionRecord(input: {
  trigger: string;
  covered: ChatMessage[];
  inserted: ChatMessage[];
  insertedAt: number;
  beforeTokens: number;
  afterTokens: number;
}): CompactionRecord {
  const digests = input.covered.map(messageDigest);
  const record: CompactionRecord = {
    v: COMPACTION_RECORD_VERSION,
    trigger: input.trigger,
    coveredIds: digests.slice(0, MAX_COVERED_IDS).map((d) => d.slice(0, 16)),
    coveredCount: digests.length,
    coveredSha256: sha256(digests.join("\n")),
    inserted: input.inserted.length
      ? { at: input.insertedAt, count: input.inserted.length, sha256: sha256(input.inserted.map(messageDigest).join("\n")), chars: input.inserted.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length), 0) }
      : null,
    beforeTokens: input.beforeTokens,
    afterTokens: input.afterTokens,
  };
  if (digests.length > MAX_COVERED_IDS) record.coveredIdsTruncated = true;
  return record;
}

export function isCompactionRecord(value: unknown): value is CompactionRecord {
  const r = value as Partial<CompactionRecord> | null;
  return Boolean(r && typeof r === "object" && r.v === COMPACTION_RECORD_VERSION && Array.isArray(r.coveredIds) && typeof r.coveredCount === "number" && typeof r.coveredSha256 === "string");
}

export interface CompactionAudit {
  id: string;
  /** "ok": the archive holds exactly what the record says it covered. "unauditable": no record (older build). "corrupt": it does not. */
  status: "ok" | "unauditable" | "corrupt";
  problems: string[];
  coveredIds: string[];
}

/** Checks one compaction's archived messages against its record. */
export function auditCompaction(id: string, record: CompactionRecord | undefined, archived: ChatMessage[]): CompactionAudit {
  if (!record) return { id, status: "unauditable", problems: [], coveredIds: [] };
  const problems: string[] = [];
  const digests = archived.map(messageDigest);
  if (digests.length !== record.coveredCount) problems.push(`the record covers ${record.coveredCount} message(s), the archive holds ${digests.length}`);
  else if (sha256(digests.join("\n")) !== record.coveredSha256) {
    const changed = digests.map((d, i) => (record.coveredIds[i] !== undefined && d.slice(0, 16) !== record.coveredIds[i] ? i + 1 : 0)).filter(Boolean);
    problems.push(changed.length ? `archived message(s) ${changed.slice(0, 5).join(", ")} differ from what the record covered` : "the archive's covered prefix does not match the record's digest");
  }
  return { id, status: problems.length ? "corrupt" : "ok", problems, coveredIds: record.coveredIds };
}

/**
 * The conversation as it was before its compactions: the first system message, the verified archived originals in
 * the order they were archived, then the messages that followed the last compaction (the saved conversation without its
 * system messages, which is where compaction summaries live).
 */
export function fullTranscript(saved: ChatMessage[], archivedOriginals: ChatMessage[]): ChatMessage[] {
  const first = saved[0]?.role === "system" ? [saved[0]] : [];
  const tail = saved.slice(first.length).filter((m) => m.role !== "system");
  return [...first, ...archivedOriginals, ...tail];
}

/**
 * Whether the saved conversation still holds what a compaction inserted. False means the compaction's own output is
 * missing or altered (a damaged record), which is the case where the full transcript is restored instead. `protect` is the
 * same persistence protection the saved messages went through.
 */
export function insertedBlockPresent(record: CompactionRecord, saved: ChatMessage[]): boolean {
  if (!record.inserted) return true;
  const { at, count, sha256: expected } = record.inserted;
  const window = saved.slice(at, at + count);
  if (window.length === count && sha256(window.map(messageDigest).join("\n")) === expected) return true;
  // The compaction may have moved (a later one shifts indexes): look for the block anywhere.
  for (let i = 0; i + count <= saved.length; i++) {
    if (sha256(saved.slice(i, i + count).map(messageDigest).join("\n")) === expected) return true;
  }
  return false;
}
