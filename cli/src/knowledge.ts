import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
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

/**
 * Persistent Project Knowledge Graph
 * Retains project idioms, architectural decisions, and conventions across sessions.
 */
export class KnowledgeGraph {
  private workspace: string;
  private dbPath: string;
  private entries: Map<string, KnowledgeEntry> = new Map();

  constructor(workspace: string = process.cwd()) {
    this.workspace = path.resolve(workspace);
    const nexusDir = path.join(this.workspace, ".nexus");
    if (!fs.existsSync(nexusDir)) {
      try {
        fs.mkdirSync(nexusDir, { recursive: true });
      } catch {}
    }
    this.dbPath = path.join(nexusDir, "knowledge.json");
    this.load();
  }

  /**
   * Loads knowledge entries from persistent storage.
   */
  public load(): void {
    this.entries.clear();
    if (!fs.existsSync(this.dbPath)) return;

    try {
      const raw = fs.readFileSync(this.dbPath, "utf-8");
      const data: KnowledgeGraphData = JSON.parse(raw);
      if (Array.isArray(data.entries)) {
        for (const entry of data.entries) {
          if (entry.key && entry.value) {
            this.entries.set(entry.key, entry);
          }
        }
      }
    } catch {
      // Ignore parse errors on corrupt file
    }
  }

  /**
   * Persists knowledge entries to disk.
   */
  public save(): void {
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
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err: any) {
      console.warn(pc.yellow(`Warning: Failed to save knowledge graph: ${err.message}`));
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
   */
  public exportPromptSection(): string {
    const list = this.list();
    if (list.length === 0) return "";

    const lines: string[] = ["### Persistent Project Knowledge & Conventions:"];
    for (const entry of list) {
      lines.push(`- [${entry.category.toUpperCase()}] **${entry.key}**: ${entry.value}`);
    }

    return lines.join("\n") + "\n";
  }

  /**
   * Automatically extracts and learns project rules and conventions from conversation turns.
   */
  public autoExtract(prompt: string, outcome: string): KnowledgeEntry[] {
    const learned: KnowledgeEntry[] = [];
    const combined = `${prompt}\n${outcome}`;

    // Pattern 1: Explicit preference / requirement
    const alwaysNever = combined.match(/(?:always|never|do not|must)\s+([a-zA-Z0-9_\-\.\s]{10,80})/gi);
    if (alwaysNever) {
      for (const phrase of alwaysNever.slice(0, 3)) {
        const clean = phrase.trim();
        const key = `rule-${clean.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        if (!this.entries.has(key)) {
          learned.push(this.set(key, clean, "rule", { confidence: 0.7 }));
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
          learned.push(this.set(key, clean, "idiom", { confidence: 0.8 }));
        }
      }
    }

    return learned;
  }
}
