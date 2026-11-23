import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { redactForPersistence, writeProtectedTextFile } from "./core/persistence_protection.js";
import { ensurePrivateDir } from "./core/durable_file.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";

export type KnowledgeCategory = "idiom" | "architecture" | "dependency" | "troubleshooting" | "rule";
export type KnowledgeValidationStatus = "operator_reviewed_unverified" | "legacy_unverified";

export interface KnowledgeRetention {
  policy: "until_deleted" | "expires_at";
  expiresAt?: string;
}

export interface KnowledgeProvenance {
  source: "operator_entry" | "legacy_import";
  sourceRefs: string[];
}

export interface KnowledgeEntry {
  id: string;
  category: KnowledgeCategory;
  key: string;
  value: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  scope: "repository";
  provenance: KnowledgeProvenance;
  validationStatus: KnowledgeValidationStatus;
  retention: KnowledgeRetention;
}

export interface KnowledgeGraphData {
  version: 1 | 2;
  updatedAt: string;
  entries: KnowledgeEntry[];
}

export interface KnowledgeOptions {
  readOnly?: boolean;
  trusted?: boolean;
}

/**
 * Persistent Project Knowledge Graph
 * Retains project idioms, architectural decisions, and conventions across sessions.
 */
export class KnowledgeGraph {
  private workspace: string;
  private dbPath: string;
  private readOnly: boolean;
  private explicitTrusted?: boolean;
  private entries: Map<string, KnowledgeEntry> = new Map();

  constructor(workspace: string = process.cwd(), options: KnowledgeOptions = {}) {
    this.workspace = path.resolve(workspace);
    this.readOnly = Boolean(options.readOnly);
    this.explicitTrusted = options.trusted;
    this.dbPath = path.join(this.workspace, ".nexus", "knowledge.json");
    // LAZY: no mkdir in constructor (REQ-SEC-114)
    this.load();
  }

  public setWorkspace(workspace: string, options: KnowledgeOptions = {}): void {
    this.workspace = path.resolve(workspace);
    if (options.readOnly !== undefined) this.readOnly = options.readOnly;
    if (options.trusted !== undefined) this.explicitTrusted = options.trusted;
    this.dbPath = path.join(this.workspace, ".nexus", "knowledge.json");
    this.load();
  }

  /**
   * Loads knowledge entries from persistent storage. Legacy entries are
   * explicitly labeled unverified and migrated additively on writable loads.
   */
  public load(): void {
    this.entries.clear();
    if (!fs.existsSync(this.dbPath)) return;

    let raw: string;
    let data: KnowledgeGraphData;
    try {
      raw = fs.readFileSync(this.dbPath, "utf-8");
      data = JSON.parse(raw);
    } catch {
      // Ignore parse errors on corrupt file
      return;
    }

    try {
      const protectedData = redactForPersistence(data);
      const storedVersion = (protectedData as any)?.version;
      if (typeof storedVersion !== "number" || storedVersion < 1 || storedVersion > 2) {
        throw new Error("Unsupported knowledge graph schema version");
      }
      const safeSerialized = JSON.stringify(protectedData, null, 2);
      if (safeSerialized !== JSON.stringify(data, null, 2)) {
        writeProtectedTextFile(this.dbPath, safeSerialized);
      }
      let migrated = protectedData.version !== 2;
      if (Array.isArray(protectedData.entries)) {
        for (const entry of protectedData.entries) {
          if (entry.key && entry.value) {
            const rawRefs = entry.provenance?.sourceRefs;
            const refsValid = Array.isArray(rawRefs) && rawRefs.length <= 100 && rawRefs.every((ref: unknown) => typeof ref === "string" && ref.length > 0 && ref.length <= 300 && !/[\u0000-\u001f\u007f-\u009f]/.test(ref));
            const provenanceValid = ["operator_entry", "legacy_import"].includes(entry.provenance?.source) && refsValid;
            const safeRefs = refsValid ? rawRefs.slice() : [];
            const retention = entry.retention === undefined
              ? { policy: "until_deleted" as const }
              : validRetention(entry.retention)
                ? entry.retention
                : { policy: "expires_at" as const, expiresAt: "1970-01-01T00:00:00.000Z" };
            if (!refsValid || !provenanceValid || (entry.validationStatus !== "operator_reviewed_unverified" && entry.validationStatus !== "legacy_unverified")) migrated = true;
            const normalized: KnowledgeEntry = {
              ...entry,
              scope: "repository",
              provenance: provenanceValid
                ? { source: entry.provenance.source, sourceRefs: safeRefs }
                : { source: "legacy_import", sourceRefs: [] },
              validationStatus: entry.validationStatus === "operator_reviewed_unverified" ? "operator_reviewed_unverified" : "legacy_unverified",
              retention,
            };
            if (entry.scope !== "repository" || !provenanceValid || !entry.validationStatus || !validRetention(entry.retention)) migrated = true;
            this.entries.set(normalized.key, normalized);
          }
        }
      }
      this.pruneExpired();
      if (migrated && !this.readOnly) this.save();
    } catch {
      throw new Error("Failed to protect knowledge graph during recovery");
    }
  }

  /**
   * Persists knowledge entries to disk.
   */
  public save(): void {
    if (this.readOnly) return;

    const data: KnowledgeGraphData = {
      version: 2,
      updatedAt: new Date().toISOString(),
      entries: Array.from(this.entries.values()),
    };

    try {
      const nexusDir = path.dirname(this.dbPath);
      ensurePrivateDir(nexusDir);
      const protectedData = redactForPersistence(data);
      writeProtectedTextFile(this.dbPath, JSON.stringify(protectedData, null, 2));
    } catch {
      throw new Error("Failed to protect or save knowledge graph");
    }
  }

  /**
   * Adds or updates a knowledge entry.
   */
  public set(
    key: string,
    value: string,
    category: KnowledgeCategory = "rule",
    options?: { confidence?: number; tags?: string[]; sourceRefs?: string[]; retention?: KnowledgeRetention }
  ): KnowledgeEntry {
    if (this.readOnly) {
      throw new Error("Read-only mode violation: mutating knowledge graph is blocked");
    }
    const existing = this.entries.get(key);
    const now = new Date().toISOString();
    const retention = options?.retention ?? existing?.retention ?? { policy: "until_deleted" as const };
    if (!validRetention(retention)) throw new Error("Invalid knowledge retention rule");
    if (retention.policy === "expires_at" && Date.parse(retention.expiresAt!) <= Date.now()) {
      throw new Error("Knowledge retention expiry must be in the future");
    }
    const sourceRefs = options?.sourceRefs ?? existing?.provenance.sourceRefs ?? [];
    if (!Array.isArray(sourceRefs) || sourceRefs.length > 100 || sourceRefs.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(ref))) {
      throw new Error("Invalid knowledge provenance references");
    }
    const entry: KnowledgeEntry = {
      id: existing ? existing.id : randomUUID(),
      key,
      value,
      category,
      confidence: options?.confidence ?? (existing ? Math.min(existing.confidence + 0.1, 1.0) : 0.8),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      tags: options?.tags || existing?.tags || [],
      scope: "repository",
      provenance: { source: "operator_entry", sourceRefs: sourceRefs.slice() },
      validationStatus: "operator_reviewed_unverified",
      retention,
    };

    // Sensitive content is not eligible for durable memory promotion. Do not
    // rely on the persistence layer's later redaction: the same value is also
    // available to the prompt builder in this process.
    const protectedEntry = redactForPersistence(entry);
    if (JSON.stringify(protectedEntry) !== JSON.stringify(entry)) {
      throw new Error("Sensitive content cannot be promoted to durable project knowledge");
    }

    this.entries.set(key, protectedEntry);
    this.save();
    return protectedEntry;
  }

  /**
   * Retrieves an entry by key.
   */
  public get(key: string): KnowledgeEntry | undefined {
    const entry = this.entries.get(key);
    return entry && !isExpired(entry) ? entry : undefined;
  }

  /**
   * Deletes an entry by key or ID.
   */
  public delete(keyOrId: string): boolean {
    if (this.readOnly) {
      throw new Error("Read-only mode violation: mutating knowledge graph is blocked");
    }
    if (this.entries.has(keyOrId)) {
      this.entries.delete(keyOrId);
      this.save();
      return true;
    }

    for (const [key, entry] of this.entries.entries()) {
      if (entry.id === keyOrId) {
        this.entries.delete(key);
        this.save();
        return true;
      }
    }

    return false;
  }

  /**
   * Returns all stored entries.
   */
  public list(): KnowledgeEntry[] {
    return Array.from(this.entries.values()).filter((entry) => !isExpired(entry));
  }

  /**
   * Queries knowledge entries matching search text or category.
   */
  public query(searchText?: string, category?: KnowledgeCategory): KnowledgeEntry[] {
    let result = this.list();

    if (category) {
      result = result.filter((e) => e.category === category);
    }

    if (searchText && searchText.trim()) {
      const q = searchText.toLowerCase();
      result = result.filter(
        (e) =>
          e.key.toLowerCase().includes(q) ||
          e.value.toLowerCase().includes(q) ||
          (e.tags && e.tags.some((t) => t.toLowerCase().includes(q)))
      );
    }

    return result;
  }

  /**
   * Renders knowledge entries as a markdown prompt section for agent system prompts.
   * Gated by workspace trust: returns empty string if workspace is untrusted (REQ-SEC-113).
   * Injected block is annotated with source path and trust state (partial CTX-001).
   */
  public exportPromptSection(): string {
    const isTrusted =
      this.explicitTrusted !== undefined
        ? this.explicitTrusted
        : isWorkspaceTrusted(this.workspace, this.readOnly);
    if (!isTrusted) {
      return "";
    }
    const list = this.list();
    if (list.length === 0) return "";

    const lines: string[] = [
      `### Persistent Project Knowledge & Conventions [source: ${this.dbPath}] [trust: unverified memory; not evidence]:`,
    ];
    for (const entry of list) {
      lines.push(`- [${entry.category.toUpperCase()}] [validation: ${entry.validationStatus}] **${entry.key}**: ${entry.value}`);
    }

    return lines.join("\n") + "\n";
  }

  /**
   * @deprecated Conversation-derived memory promotion is disabled. Promote
   * knowledge through an explicit operator `/knowledge set` or `nexus knowledge set` action.
   */
  public autoExtract(_prompt: string, _outcome: string): KnowledgeEntry[] {
    return [];
  }

  private pruneExpired(): void {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (isExpired(entry)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed && !this.readOnly) this.save();
  }
}

function validRetention(value: any): value is KnowledgeRetention {
  if (!value || typeof value !== "object") return false;
  if (value.policy === "until_deleted") return value.expiresAt === undefined;
  if (value.policy !== "expires_at" || typeof value.expiresAt !== "string") return false;
  return Number.isFinite(Date.parse(value.expiresAt));
}

function isExpired(entry: KnowledgeEntry, now = Date.now()): boolean {
  if (entry.retention.policy === "until_deleted") return false;
  const expiresAt = Date.parse(entry.retention.expiresAt ?? "");
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}
