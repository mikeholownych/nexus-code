import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeCandidateIdentitySync } from "./core/candidate.js";
import { ensurePrivateDir } from "./core/durable_file.js";
import { acquireFileGuard, releaseFileGuard } from "./core/file_guard.js";
import { assertNoSensitivePersistenceContent, redactForPersistence, writeProtectedTextFile } from "./core/persistence_protection.js";
import { assertPrivateDir, readPrivateJson } from "./core/runner_store.js";
import type { KnowledgeCategory } from "./knowledge.js";
import { resolveKnowledgeSessionEvidence } from "./knowledge_session_evidence.js";
import { isPathStrictlyWithin } from "./path_within.js";
import { currentEntry, openRepo } from "./worktrunk/repo.js";

const MAX_RECORDS = 100;
const MAX_STORE_BYTES = 1024 * 1024;
const RETENTION_MS = 30 * 86_400_000;
const CATEGORIES: readonly KnowledgeCategory[] = ["idiom", "architecture", "dependency", "troubleshooting", "rule"];
const SOURCE_CLASSES = ["operator", "model", "tool", "verified_evidence"] as const;
const STATES = ["candidate", "reviewed", "promoted", "rejected", "expired", "deleted"] as const;

export interface KnowledgeEvidence {
  source: typeof SOURCE_CLASSES[number];
  /** Digest of a durable record already scoped by the trusted resolver to this workspace. */
  revision: string;
}

interface EvidenceReference extends KnowledgeEvidence { ref: string }

export interface KnowledgeProposal {
  key: string;
  value: string;
  category: KnowledgeCategory;
  sourceRefs: string[];
  paths?: string[];
}

interface SuggestionScope {
  repository: string;
  workspace: string;
  worktree: string;
  candidate: string;
}

type SuggestionState = typeof STATES[number];

interface StoredSuggestion {
  id: string;
  contentDigest: string;
  state: SuggestionState;
  proposal?: KnowledgeProposal;
  evidence?: EvidenceReference[];
  scope: SuggestionScope;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  actor?: string;
}

export interface KnowledgeSuggestion extends StoredSuggestion {
  validationStatus: "model_suggestion_unverified";
  redactionStatus: "screened";
  freshness: "current" | "stale" | "unknown";
}

export interface KnowledgeSuggestionOptions {
  /** Read-only workspace posture also applies to private suggestion state. */
  readOnly?: boolean;
  stateDir?: string;
  /** Production callers must resolve canonical references from durable records in this exact workspace. */
  resolveEvidence?: (ref: string) => KnowledgeEvidence | undefined;
  now?: () => number;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(value);
}

function isList(value: unknown, max: number, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item: unknown) => isText(item, limit));
}

function directoryId(directory: string): string {
  const stat = fs.statSync(directory);
  return sha256([directory, stat.dev, stat.ino]);
}

function inspectScope(workspace: string): SuggestionScope {
  const repo = openRepo(workspace);
  const worktree = currentEntry(repo);
  if (!worktree?.head) throw new Error("Knowledge suggestions require a Git worktree with a committed base");
  const candidate = computeCandidateIdentitySync(repo.cwd, { baseRef: worktree.head, includeUntracked: true });
  return {
    repository: directoryId(repo.commonDir),
    workspace: directoryId(repo.cwd),
    worktree: directoryId(fs.realpathSync(worktree.path)),
    candidate: candidate.candidateId,
  };
}

function checkProtectedContent(value: unknown): void {
  assertNoSensitivePersistenceContent(value, "project knowledge suggestions");
  if (JSON.stringify(redactForPersistence(value)) !== JSON.stringify(value)) {
    throw new Error("Sensitive content cannot be persisted as a knowledge suggestion");
  }
}

function normalizeProposal(value: unknown): KnowledgeProposal {
  const item = value as Partial<KnowledgeProposal> | null;
  if (!item || typeof item !== "object" || Array.isArray(item) ||
    !isText(item.key, 120) || !isText(item.value, 3000) || !CATEGORIES.includes(item.category as KnowledgeCategory)) {
    throw new Error("Invalid knowledge suggestion");
  }
  if (!isList(item.sourceRefs, 12, 240) || item.sourceRefs.length === 0) {
    throw new Error("Invalid knowledge suggestion provenance references");
  }
  if (item.paths !== undefined && !isList(item.paths, 20, 240)) throw new Error("Invalid knowledge suggestion path scope");
  const paths = [...new Set(item.paths ?? [])].sort();
  if (paths.some((value) => value.includes("\\") || value.split("/").some((component) => !component || component === "." || component === ".."))) {
    throw new Error("Invalid knowledge suggestion path scope");
  }
  return {
    key: item.key.trim(),
    value: item.value.trim(),
    category: item.category!,
    sourceRefs: [...new Set(item.sourceRefs)].sort(),
    paths,
  };
}

function checkPathScopes(workspace: string, paths: string[]): void {
  for (const scope of paths) {
    const fullPath = path.resolve(workspace, scope);
    if (!isPathStrictlyWithin(fullPath, workspace)) throw new Error("Invalid knowledge suggestion path scope");
    let cursor = fullPath;
    while (cursor !== workspace) {
      const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error("Invalid knowledge suggestion path scope through a symbolic link");
      cursor = path.dirname(cursor);
    }
  }
}

function validEvidence(value: unknown): value is KnowledgeEvidence {
  const evidence = value as KnowledgeEvidence | null;
  return Boolean(evidence && SOURCE_CLASSES.includes(evidence.source) && isDigest(evidence.revision));
}

function suggestionId(contentDigest: string, scope: SuggestionScope, evidence: EvidenceReference[]): string {
  return sha256([contentDigest, scope.repository, scope.workspace, scope.worktree, evidence]);
}

function validateStored(value: unknown): StoredSuggestion {
  const item = value as StoredSuggestion | null;
  if (!item || typeof item !== "object" || !isDigest(item.id) || !isDigest(item.contentDigest) || !STATES.includes(item.state) ||
    !item.scope || ![item.scope.repository, item.scope.workspace, item.scope.worktree, item.scope.candidate].every(isDigest) ||
    ![item.createdAt, item.updatedAt, item.expiresAt].every((v) => typeof v === "string" && Number.isFinite(Date.parse(v))) ||
    (item.actor !== undefined && !isText(item.actor, 120))) {
    throw new Error("Invalid stored knowledge suggestion");
  }
  if (item.state === "deleted") {
    if (item.proposal !== undefined || item.evidence !== undefined) throw new Error("Invalid deleted knowledge suggestion");
    checkProtectedContent(item);
    return item;
  }
  const proposal = normalizeProposal(item.proposal);
  if (JSON.stringify(item.proposal) !== JSON.stringify(proposal) || item.contentDigest !== sha256(proposal) ||
    !Array.isArray(item.evidence) || item.evidence.length !== proposal.sourceRefs.length ||
    !item.evidence.every((evidence, index) => validEvidence(evidence) && evidence.ref === proposal.sourceRefs[index]) ||
    item.id !== suggestionId(item.contentDigest, item.scope, item.evidence)) {
    throw new Error("Invalid stored knowledge suggestion provenance or content digest");
  }
  checkProtectedContent(item);
  return item;
}

/** Private repository-worktree suggestion records. Model responses supply proposal data only. */
export class KnowledgeSuggestions {
  private readonly workspace: string;
  private readonly dir: string;
  private readonly file: string;

  constructor(workspace: string, private readonly options: KnowledgeSuggestionOptions = {}) {
    this.workspace = fs.realpathSync(workspace);
    this.dir = path.join(options.stateDir ?? process.env.NEXUS_STATE_DIR ?? path.join(os.homedir(), ".nexus"), "knowledge-suggestions");
    this.file = path.join(this.dir, `${sha256(this.workspace)}.json`);
  }

  propose(input: unknown): KnowledgeSuggestion {
    const proposal = normalizeProposal(input);
    checkProtectedContent(proposal);
    return this.update((records, now) => {
      checkPathScopes(this.workspace, proposal.paths ?? []);
      const scope = inspectScope(this.workspace);
      const evidence = proposal.sourceRefs.map((ref): EvidenceReference => {
        const resolved = this.resolveEvidence(ref);
        if (!validEvidence(resolved)) throw new Error("Knowledge suggestion provenance could not be resolved");
        return { ref, source: resolved.source, revision: resolved.revision };
      });
      const contentDigest = sha256(proposal);
      const id = suggestionId(contentDigest, scope, evidence);
      const prior = records.find((entry) => entry.id === id);
      if (prior) return this.present(prior, scope);
      if (records.length >= MAX_RECORDS) throw new Error("Knowledge suggestion store has reached its retention limit");
      const createdAt = new Date(now).toISOString();
      const record: StoredSuggestion = {
        id, contentDigest, scope, proposal, evidence,
        state: "candidate", createdAt, updatedAt: createdAt, expiresAt: new Date(now + RETENTION_MS).toISOString(),
      };
      records.push(record);
      return this.present(record, scope);
    });
  }

  list(options: { state?: SuggestionState } = {}): KnowledgeSuggestion[] {
    const records = this.load();
    this.expire(records, this.now());
    const selected = options.state ? records.filter((record) => record.state === options.state) : records;
    if (!selected.length) return [];
    let scope: SuggestionScope | undefined;
    try { scope = inspectScope(this.workspace); } catch {}
    return selected.map((record) => this.present(record, scope));
  }

  review(id: string, actor: string): KnowledgeSuggestion {
    return this.transition(id, actor, "reviewed", ["candidate"]);
  }

  reject(id: string, actor: string): KnowledgeSuggestion {
    return this.transition(id, actor, "rejected", ["candidate", "reviewed"]);
  }

  promote(id: string, actor: string): KnowledgeSuggestion {
    return this.transition(id, actor, "promoted", ["reviewed"]);
  }

  delete(id: string, actor: string): KnowledgeSuggestion {
    return this.transition(id, actor, "deleted", ["candidate", "reviewed", "rejected", "expired", "promoted"]);
  }

  /** Persist deadline-based expiry without changing read-only inspection. */
  reconcile(): KnowledgeSuggestion[] {
    this.update(() => undefined);
    return this.list();
  }

  private transition(id: string, actor: string, state: SuggestionState, allowed: SuggestionState[]): KnowledgeSuggestion {
    if (!isText(actor, 120)) throw new Error("A valid operator identity is required");
    checkProtectedContent(actor);
    return this.update((records, now) => {
      const item = records.find((entry) => entry.id === id);
      if (!item) throw new Error("Knowledge suggestion not found");
      let scope: SuggestionScope | undefined;
      try { scope = inspectScope(this.workspace); } catch {}
      if (item.state === state) return this.present(item, scope);
      if (!allowed.includes(item.state)) throw new Error(`Cannot transition a ${item.state} knowledge suggestion to ${state}`);
      if ((state === "reviewed" || state === "promoted") && this.present(item, scope).freshness !== "current") {
        throw new Error("Knowledge suggestion review or promotion requires fresh evidence");
      }
      if (state === "promoted" && records.some((other) => other.state === "promoted" && other.id !== item.id && other.proposal?.key === item.proposal?.key && this.present(other, scope).freshness === "current")) {
        throw new Error("A current promoted suggestion already uses that knowledge key");
      }
      item.state = state;
      item.actor = actor;
      item.updatedAt = new Date(now).toISOString();
      if (state === "deleted") {
        delete item.proposal;
        delete item.evidence;
      }
      return this.present(item, scope);
    });
  }

  private present(item: StoredSuggestion, scope?: SuggestionScope): KnowledgeSuggestion {
    const freshness = this.freshness(item, scope);
    return { ...item, freshness, validationStatus: "model_suggestion_unverified", redactionStatus: "screened" };
  }

  private freshness(item: StoredSuggestion, scope?: SuggestionScope): KnowledgeSuggestion["freshness"] {
    if (!scope || !item.evidence) return "unknown";
    if (item.scope.repository !== scope.repository || item.scope.workspace !== scope.workspace ||
      item.scope.worktree !== scope.worktree || item.scope.candidate !== scope.candidate) return "stale";
    for (const evidence of item.evidence) {
      let current: KnowledgeEvidence | undefined;
      try { current = this.resolveEvidence(evidence.ref); } catch { return "unknown"; }
      if (!validEvidence(current)) return "unknown";
      if (evidence.revision !== current.revision || evidence.source !== current.source) return "stale";
    }
    return "current";
  }

  private resolveEvidence(ref: string): KnowledgeEvidence | undefined {
    return this.options.resolveEvidence ? this.options.resolveEvidence(ref) : resolveKnowledgeSessionEvidence(this.workspace, ref);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private expire(records: StoredSuggestion[], now: number): void {
    for (const item of records) {
      if ((item.state === "candidate" || item.state === "reviewed" || item.state === "promoted") && now >= Date.parse(item.expiresAt)) {
        item.state = "expired";
        item.updatedAt = new Date(now).toISOString();
      }
    }
  }

  private load(): StoredSuggestion[] {
    if (!fs.lstatSync(this.dir, { throwIfNoEntry: false })) return [];
    assertPrivateDir(this.dir);
    const raw = readPrivateJson(this.file, { label: "Knowledge suggestions", limit: MAX_STORE_BYTES });
    if (raw === undefined) return [];
    const data = raw as { version?: unknown; records?: unknown } | null;
    if (data?.version !== 1 || !Array.isArray(data.records) || data.records.length > MAX_RECORDS) {
      throw new Error("Invalid knowledge suggestion store schema");
    }
    const records = data.records.map(validateStored);
    if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("Duplicate knowledge suggestion records");
    return records;
  }

  private update<T>(callback: (records: StoredSuggestion[], now: number) => T): T {
    if (this.options.readOnly) throw new Error("Read-only mode blocks changes to knowledge suggestions");
    ensurePrivateDir(this.dir);
    assertPrivateDir(this.dir);
    const guard = acquireFileGuard(`${this.file}.guard`, { label: "Knowledge suggestions guard", waitMs: 1000 });
    if (!guard) throw new Error("Another operator command is updating knowledge suggestions");
    try {
      const records = this.load();
      const previous = JSON.stringify({ version: 1, records });
      const now = this.now();
      this.expire(records, now);
      const result = callback(records, now);
      const serialized = JSON.stringify({ version: 1, records });
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("Knowledge suggestion store size limit reached");
      if (serialized !== previous) writeProtectedTextFile(this.file, serialized);
      return result;
    } finally {
      releaseFileGuard(guard);
    }
  }
}
