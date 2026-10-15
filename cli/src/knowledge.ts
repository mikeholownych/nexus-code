import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { redactForPersistence, writeProtectedTextFile } from "./core/persistence_protection.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";
import pc from "picocolors";

export type KnowledgeCategory = "idiom" | "architecture" | "dependency" | "troubleshooting" | "rule";

export interface KnowledgeEntry {
  id: string;
  category: KnowledgeCategory;
  key: string;
  value: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

export interface KnowledgeGraphData {
  version: number;
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
   * Loads knowledge entries from persistent storage.
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
      const safeSerialized = JSON.stringify(protectedData, null, 2);
      if (safeSerialized !== JSON.stringify(data, null, 2)) {
        writeProtectedTextFile(this.dbPath, safeSerialized);
      }
      if (Array.isArray(protectedData.entries)) {
        for (const entry of protectedData.entries) {
          if (entry.key && entry.value) {
            this.entries.set(entry.key, entry);
          }
        }
      }
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
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: Array.from(this.entries.values()),
    };

    try {
      const nexusDir = path.dirname(this.dbPath);
      if (!fs.existsSync(nexusDir)) {
        fs.mkdirSync(nexusDir, { recursive: true });
      }
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
    options?: { confidence?: number; tags?: string[] }
  ): KnowledgeEntry {
    if (this.readOnly) {
      throw new Error("Read-only mode violation: mutating knowledge graph is blocked");
    }
    const existing = this.entries.get(key);
    const now = new Date().toISOString();
    const entry: KnowledgeEntry = {
      id: existing ? existing.id : randomUUID(),
      key,
      value,
      category,
      confidence: options?.confidence ?? (existing ? Math.min(existing.confidence + 0.1, 1.0) : 0.8),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      tags: options?.tags || existing?.tags || [],
    };

    this.entries.set(key, entry);
    this.save();
    return entry;
  }

  /**
   * Retrieves an entry by key.
   */
  public get(key: string): KnowledgeEntry | undefined {
    return this.entries.get(key);
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
    return Array.from(this.entries.values());
  }

  /**
   * Queries knowledge entries matching search text or category.
   */
  public query(searchText?: string, category?: KnowledgeCategory): KnowledgeEntry[] {
    let result = Array.from(this.entries.values());

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
      `### Persistent Project Knowledge & Conventions [source: ${this.dbPath}] [trust: trusted]:`,
    ];
    for (const entry of list) {
      lines.push(`- [${entry.category.toUpperCase()}] **${entry.key}**: ${entry.value}`);
    }

    return lines.join("\n") + "\n";
  }

  /**
   * Automatically extracts and learns project rules and conventions from conversation turns.
   * Opt-in only via NEXUS_KNOWLEDGE_AUTOEXTRACT=1 (REQ-SEC-114).
   * Gated by workspace trust and read-only mode.
   */
  public autoExtract(prompt: string, outcome: string): KnowledgeEntry[] {
    if (this.readOnly || process.env.NEXUS_KNOWLEDGE_AUTOEXTRACT !== "1") {
      return [];
    }
    const isTrusted =
      this.explicitTrusted !== undefined
        ? this.explicitTrusted
        : isWorkspaceTrusted(this.workspace, this.readOnly);
    if (!isTrusted) {
      return [];
    }

    const learned: KnowledgeEntry[] = [];
    const combined = `${prompt}\n${outcome}`;

    // Pattern 1: Explicit preference / requirement
    const alwaysNever = combined.match(/(?:always|never|do not|must)\s+([a-zA-Z0-9_\-\.\s]{10,80})/gi);
    if (alwaysNever) {
      for (const phrase of alwaysNever.slice(0, 3)) {
        const clean = phrase.trim();
        const key = `rule-${clean.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        if (!this.entries.has(key)) {
          const entry = this.set(key, clean, "rule", { confidence: 0.7 });
          learned.push(entry);
          console.log(pc.yellow(`[knowledge] Learned project rule: ${clean}`));
        }
      }
    }

    // Pattern 2: Tool or dependency idioms (e.g. "use pnpm", "run pytest with -k")
    const toolIdioms = combined.match(/(?:use|run|prefer)\s+(pnpm|yarn|npm|cargo|pytest|poetry|pipenv|bun|make)\b[^\.\n]*/gi);
    if (toolIdioms) {
      for (const phrase of toolIdioms.slice(0, 2)) {
        const clean = phrase.trim();
        const key = `idiom-${clean.slice(0, 25).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        if (!this.entries.has(key)) {
          const entry = this.set(key, clean, "idiom", { confidence: 0.8 });
          learned.push(entry);
          console.log(pc.yellow(`[knowledge] Learned project idiom: ${clean}`));
        }
      }
    }

    return learned;
  }
}
