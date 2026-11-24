/**
 * BG-3 trust and abuse model: the trigger trust store.
 *
 * Approvals of trigger specs are keyed by the SHA-256 of their exact bytes (`~/.config/nexus/trigger_trust.json`),
 * mirroring content_trust.ts (extension approvals). An approval names one spec: changed bytes are a different spec
 * and are not approved. A store that cannot be read safely or is malformed holds no approvals; it never fails open.
 *
 * Trust surface covered:
 *   - only a workspace the operator trusts (workspace_trust.ts) may have triggers
 *   - approving a trigger is the act of a person at a terminal (no `--yes`, no programmatic approval)
 *   - a trigger spec's bytes are pinned by hash; MISMATCH / REMOVED means the spec is not in force
 *
 * Abuse surface covered:
 *   - rate caps live on the spec (trigger_spec.ts) and are enforced by trigger_rate_limit.ts
 *   - GG-3: a trigger cannot approve a denied action, raise a verdict, widen a policy tier or remove a
 *     verification-file protection; triggers run unattended (see unattended.ts)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type TriggerSpec,
  type TriggerTrustEntry,
  type TriggerTrustStatus,
  triggerSpecSha256,
  triggerTrustEntryOf,
  triggerTrustStatus,
  type TriggerTrustStore,
  canonicalizeTriggerSpec,
} from "./trigger_spec.js";
import { writePrivateFile } from "./durable_file.js";
import { decodeStrictUtf8, parseStrictJson, readHardenedFile } from "./strict_json.js";
import { isWorkspaceTrusted } from "../workspace_trust.js";

export const TRIGGER_TRUST_VERSION = 1;
const STORE_LIMIT = 256 * 1024;

export interface TriggerTrustStoreDoc {
  version: 1;
  entries: TriggerTrustEntry[];
}

export type TriggerTrustId = Pick<TriggerTrustEntry, "scope" | "key">;

export function triggerTrustStorePath(): string {
  return path.join(os.homedir(), ".config", "nexus", "trigger_trust.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function sameTriggerId(a: TriggerTrustId, b: TriggerTrustId): boolean {
  return a.scope === b.scope && a.key === b.key;
}

/** The approvals in the store. A missing store is empty; a non-private, oversized, version-mismatched or
 * malformed store holds no approvals and `problem` says why. */
export function readTriggerTrustStore(storePath = triggerTrustStorePath()): {
  entries: TriggerTrustEntry[];
  problem?: string;
} {
  try {
    if (!fs.existsSync(storePath)) return { entries: [] };
    const file = readHardenedFile(storePath, { maxBytes: STORE_LIMIT, forbiddenMode: 0o077 });
    if (!file) return { entries: [] };
    const parsed = parseStrictJson(decodeStrictUtf8(file.bytes));
    if (!isRecord(parsed) || parsed.version !== TRIGGER_TRUST_VERSION || !Array.isArray(parsed.entries))
      return { entries: [], problem: "it is not a version 1 trigger trust store" };
    const entries: TriggerTrustEntry[] = [];
    for (const raw of parsed.entries) {
      const entry = triggerTrustEntryOf(raw);
      if (!entry) return { entries: [], problem: "it has a malformed entry" };
      entries.push(entry);
    }
    return { entries };
  } catch (error) {
    return { entries: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The approval recorded for `id` in `scope`, if any. */
export function triggerTrustEntry(
  entries: readonly TriggerTrustEntry[],
  id: TriggerTrustId,
): TriggerTrustEntry | undefined {
  return entries.find((entry) => sameTriggerId(entry, id));
}

/**
 * How `currentSha256` (undefined: there is no spec file now) stands against the approval recorded for `id` in `scope`.
 * Delegates to trigger_spec.ts's `triggerTrustStatus`.
 */

function write(storePath: string, entries: TriggerTrustEntry[]): void {
  const store: TriggerTrustStoreDoc = { version: TRIGGER_TRUST_VERSION, entries };
  writePrivateFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { durable: true });
}

/**
 * Records the approval of exactly `entry.sha256`, replacing an earlier approval of the same item. Refuses to approve
 * a trigger for a workspace the operator has not trusted: a workspace that is not in the trust store and has no
 * `NEXUS_TRUST_WORKSPACE=1` cannot run triggers.
 */
export function approveTrigger(
  entry: TriggerTrustEntry,
  options: { workspaceTrusted: boolean; storePath?: string },
): void {
  if (!options.workspaceTrusted)
    throw new Error(`approveTrigger: the workspace ${entry.scope} is not trusted; triggers cannot be registered there`);
  if (!triggerTrustEntryOf(entry))
    throw new Error("approveTrigger: the entry is not a valid approval (sha256 must be 64 lowercase hexadecimal digits)");
  const storePath = options.storePath ?? triggerTrustStorePath();
  const kept = readTriggerTrustStore(storePath).entries.filter((other) => !sameTriggerId(other, entry));
  write(storePath, [...kept, entry]);
}

/** Removes the approval of `id` in `scope`. Returns whether there was one. */
export function revokeTrigger(
  id: TriggerTrustId,
  storePath = triggerTrustStorePath(),
): boolean {
  const { entries } = readTriggerTrustStore(storePath);
  const kept = entries.filter((other) => !sameTriggerId(other, id));
  if (kept.length === entries.length) return false;
  write(storePath, kept);
  return true;
}

/** Builds a trust entry for a spec: the SHA-256 of its canonical bytes plus a one-line summary. */
export function entryForSpec(
  scope: string,
  spec: TriggerSpec,
  approvedAt: string,
): TriggerTrustEntry {
  return {
    kind: "trigger",
    scope,
    key: spec.id,
    sha256: triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(spec), "utf8")),
    approvedAt,
    summary: `${spec.event.kind} trigger ${spec.id} (${spec.action.policy}, ${spec.bounds.maxToolInvocations} tool invocations max)`,
  };
}

/** Whether the workspace at `workspace` may have triggers approved for it (the operator's trust decision). */
export function workspaceMayHaveTriggers(workspace: string): boolean {
  return isWorkspaceTrusted(workspace, false);
}

/** The trust decision shown beside a trigger: the workspace is trusted or it is not. */
export interface TriggerTrustDecision {
  /** MATCH: the spec is approved and unchanged. */
  status: TriggerTrustStatus;
  /** The approval record, if any. */
  entry?: TriggerTrustEntry;
  /** Why the trigger may or may not run. */
  reason: string;
  /** The workspace trust fact. */
  workspaceTrusted: boolean;
}

/** The trust decision for a trigger in a workspace, from the entries and the current spec bytes. */
export function decideTriggerTrust(
  entries: readonly TriggerTrustEntry[],
  workspace: string,
  spec: TriggerSpec | undefined,
  currentSha256: string | undefined,
): TriggerTrustDecision {
  const workspaceTrusted = workspaceMayHaveTriggers(workspace);
  const id: TriggerTrustId = { scope: workspace, key: spec ? spec.id : "" };
  const status = spec ? triggerTrustStatus(entries, id.key, id.scope, currentSha256) : "ABSENT";
  const entry = triggerTrustEntry(entries, id);

  let reason: string;
  if (!workspaceTrusted) reason = "the workspace is not trusted; triggers cannot run there";
  else if (status === "NEW") reason = "the trigger spec is not approved; run `nexus triggers approve` in a terminal";
  else if (status === "MISMATCH")
    reason = "the trigger spec changed since it was approved; it needs a new approval";
  else if (status === "REMOVED") reason = "the trigger spec was removed; its approval no longer applies";
  else if (status === "ABSENT")
    reason = "there is no trigger spec and no approval";
  else reason = "the trigger spec is approved and unchanged";

  return { status, entry, reason, workspaceTrusted };
}

/** Whether a trigger may run right now: trusted workspace + MATCH status. */
export function triggerMayRun(decision: TriggerTrustDecision): boolean {
  return decision.workspaceTrusted && decision.status === "MATCH" && Boolean(decision.entry);
}
