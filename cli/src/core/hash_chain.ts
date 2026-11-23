/**
 * Hash chain for append-only records (GV-3). Each record carries a link: its position, the hash of the record before
 * it, and its own hash over (position, previous hash, canonical content). Changing, removing or reordering a record
 * breaks every link after it, so the damage is found by reading the log, without a separate index.
 *
 * What a chain cannot show by itself: records removed from the END leave a shorter chain that is still consistent.
 * A log with a defined last record (a flight's `session_end`) reports whether it is closed; anything stronger needs
 * a copy of the head hash kept somewhere else (the signed audit export, GV-2).
 *
 * This is tamper evidence, not tamper proofing: someone who can rewrite the whole file can recompute every hash.
 */
import { createHash } from "node:crypto";

export interface ChainLink {
  /** Position in the log, from 0. */
  seq: number;
  /** `hash` of the previous record; CHAIN_GENESIS for the first. */
  prev: string;
  /** SHA-256 over `${seq}\n${prev}\n${canonicalJson(record without its chain)}`, hex. */
  hash: string;
}

export const CHAIN_GENESIS = "0".repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * JSON with object keys sorted at every depth, so a record hashes the same after it has been written and parsed
 * again. Follows JSON.stringify for everything else (undefined members dropped, non-finite numbers as null).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const toJson = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof toJson === "function") return canonicalJson(toJson.call(value));
  const members: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined || typeof member === "function" || typeof member === "symbol") continue;
    members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${members.join(",")}}`;
}

function linkHash(seq: number, prev: string, content: unknown): string {
  return createHash("sha256").update(`${seq}\n${prev}\n${canonicalJson(content)}`, "utf8").digest("hex");
}

function withoutChain(record: object): Record<string, unknown> {
  const { chain: _chain, ...content } = record as Record<string, unknown>;
  return content;
}

/** The record with its link to `previous` (the link of the record before it; undefined for the first). */
export function linkRecord<T extends object>(record: T, previous: ChainLink | undefined): T & { chain: ChainLink } {
  const seq = previous ? previous.seq + 1 : 0;
  const prev = previous ? previous.hash : CHAIN_GENESIS;
  return { ...record, chain: { seq, prev, hash: linkHash(seq, prev, withoutChain(record)) } };
}

export type ChainProblem =
  /** The record's content does not match its hash: it was changed after it was written. */
  | "edited"
  /** The record does not follow the one before it: something was removed, inserted or reordered here. */
  | "out_of_order"
  /** A record without a link inside a chained log, or a line that is not a record at all. */
  | "unlinked";

export type ChainVerdict =
  /** Every record links to the one before it. `head` is the last link (absent for an empty log). */
  | { status: "intact"; records: number; head?: ChainLink }
  /** No record carries a link: written before chaining existed. Nothing can be said about its integrity. */
  | { status: "unchained"; records: number }
  /** The first record that fails, by position in the input. Records before it verified; nothing after it was trusted. */
  | { status: "broken"; records: number; at: number; problem: ChainProblem; detail: string };

function readLink(record: unknown): ChainLink | undefined {
  const chain = record && typeof record === "object" ? (record as { chain?: unknown }).chain : undefined;
  if (!chain || typeof chain !== "object") return undefined;
  const { seq, prev, hash } = chain as Record<string, unknown>;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0 || typeof prev !== "string" || typeof hash !== "string") return undefined;
  if (!HEX64.test(prev) || !HEX64.test(hash)) return undefined;
  return { seq: seq as number, prev, hash };
}

function hasChainField(record: unknown): boolean {
  return record !== null && typeof record === "object" && Object.prototype.hasOwnProperty.call(record, "chain");
}

/**
 * Check a log read back from disk. `records` are the parsed records in file order; pass `null` for a line that could
 * not be parsed, so it is reported at its position instead of being skipped.
 */
export function verifyChain(records: ReadonlyArray<unknown>): ChainVerdict {
  const total = records.length;
  if (total === 0) return { status: "intact", records: 0 };
  if (records.every((record) => record !== null && readLink(record) === undefined && !hasChainField(record))) {
    return { status: "unchained", records: total };
  }
  let previous: ChainLink | undefined;
  for (let at = 0; at < total; at++) {
    const record = records[at];
    const link = readLink(record);
    if (!link) {
      const detail = record === null
        ? "this line is not a readable record"
        : hasChainField(record)
          ? "this record has a malformed chain link"
          : "this record has no chain link, but the log is chained";
      return { status: "broken", records: total, at, problem: "unlinked", detail };
    }
    const expectedSeq = previous ? previous.seq + 1 : 0;
    const expectedPrev = previous ? previous.hash : CHAIN_GENESIS;
    if (link.seq !== expectedSeq || link.prev !== expectedPrev) {
      const detail = link.seq !== expectedSeq
        ? `expected record ${expectedSeq} here, found record ${link.seq}`
        : `record ${link.seq} does not follow the record before it`;
      return { status: "broken", records: total, at, problem: "out_of_order", detail };
    }
    if (linkHash(link.seq, link.prev, withoutChain(record as object)) !== link.hash) {
      return { status: "broken", records: total, at, problem: "edited", detail: `record ${link.seq} was changed after it was written` };
    }
    previous = link;
  }
  return { status: "intact", records: total, head: previous };
}

/** One line an operator can read. */
export function describeChain(verdict: ChainVerdict): string {
  switch (verdict.status) {
    case "intact":
      return verdict.records === 0 ? "empty" : `chain intact (${verdict.records} record${verdict.records === 1 ? "" : "s"})`;
    case "unchained":
      return `not chained (${verdict.records} record${verdict.records === 1 ? "" : "s"} written before hash chaining; integrity cannot be checked)`;
    case "broken":
      return `CHAIN BROKEN at position ${verdict.at + 1} of ${verdict.records}: ${verdict.detail}`;
  }
}
