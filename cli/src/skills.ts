import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isWorkspaceTrusted } from "./workspace_trust.js";

export interface Skill {
  name: string;
  description: string;
  path: string;
  content: string;
  trusted?: boolean;
  isWorkspaceSkill?: boolean;
}

export interface SkillManagerOptions {
  readOnly?: boolean;
  trusted?: boolean;
}

export class SkillManager {
  private workspace: string;
  private readOnly: boolean;
  private explicitTrusted?: boolean;
  private skills: Map<string, Skill> = new Map();
  private untrustedSkills: Map<string, Skill> = new Map();

  constructor(workspace: string, options: SkillManagerOptions = {}) {
    this.workspace = path.resolve(workspace);
    this.readOnly = Boolean(options.readOnly);
    this.explicitTrusted = options.trusted;
    this.refresh();
  }

  public setWorkspace(workspace: string, options: SkillManagerOptions = {}): void {
    this.workspace = path.resolve(workspace);
    if (options.readOnly !== undefined) this.readOnly = options.readOnly;
    if (options.trusted !== undefined) this.explicitTrusted = options.trusted;
    this.refresh();
  }

  public refresh(): void {
    this.skills.clear();
    this.untrustedSkills.clear();

    const isTrusted =
      this.explicitTrusted !== undefined
        ? this.explicitTrusted
        : isWorkspaceTrusted(this.workspace, this.readOnly);

    // Real paths already scanned: skill installers link one skill into several agent directories,
    // and a symlink cycle must not recurse forever.
    const visited = new Set<string>();

    // User home locations (always loaded & trusted)
    const homeDirs = [
      path.join(os.homedir(), ".nexus", "skills"),
      path.join(os.homedir(), ".config", "nexus", "skills"),
      // Shared Agent Skills location (`npx skills add -g --agent nexus` installs here)
      path.join(os.homedir(), ".agents", "skills"),
      path.join(os.homedir(), ".config", "opencode", "skills"),
      path.join(os.homedir(), ".claude", "skills"),
    ];

    for (const dir of homeDirs) {
      if (fs.existsSync(dir)) {
        this.scanDir(dir, { isWorkspace: false, trusted: true }, visited);
      }
    }

    // Project workspace locations (gated by workspace trust)
    const workspaceDirs = [
      path.join(this.workspace, ".nexus", "skills"),
      // Shared Agent Skills location (`npx skills add --agent nexus` installs here)
      path.join(this.workspace, ".agents", "skills"),
      path.join(this.workspace, ".claude", "skills"),
      path.join(this.workspace, "skills"),
    ];

    for (const dir of workspaceDirs) {
      if (fs.existsSync(dir)) {
        this.scanDir(dir, { isWorkspace: true, trusted: isTrusted }, visited);
      }
    }
  }

  private scanDir(baseDir: string, context: { isWorkspace: boolean; trusted: boolean }, visited: Set<string>): void {
    try {
      const real = fs.realpathSync(baseDir);
      if (visited.has(real)) return;
      visited.add(real);
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(baseDir, entry.name);
        // Skill installers (e.g. `npx skills add`) link skill directories rather than copy them.
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const target = fs.statSync(fullPath);
            isDirectory = target.isDirectory();
            isFile = target.isFile();
          } catch {
            continue; // dangling link
          }
        }

        if (isDirectory) {
          // Check for SKILL.md inside directory
          const skillFile = path.join(fullPath, "SKILL.md");
          if (fs.existsSync(skillFile)) {
            this.loadSkillFile(skillFile, entry.name, context);
          } else {
            // Also check single-level subdirectories
            this.scanDir(fullPath, context, visited);
          }
        } else if (isFile && entry.name === "SKILL.md") {
          const parentDirName = path.basename(baseDir);
          this.loadSkillFile(fullPath, parentDirName, context);
        } else if (isFile && entry.name.endsWith(".skill.md")) {
          const skillName = entry.name.replace(/\.skill\.md$/, "");
          this.loadSkillFile(fullPath, skillName, context);
        }
      }
    } catch {
      // Ignore permission or read errors
    }
  }

  private loadSkillFile(
    filePath: string,
    fallbackName: string,
    context: { isWorkspace: boolean; trusted: boolean }
  ): void {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { metadata, body } = this.parseFrontmatter(content);

      const name = metadata.name || fallbackName;
      const description = metadata.description || "Specialized skill instructions";

      const skillItem: Skill = {
        name,
        description,
        path: filePath,
        content: body.trim(),
        trusted: context.trusted,
        isWorkspaceSkill: context.isWorkspace,
      };

      if (context.trusted) {
        if (!this.skills.has(name)) {
          this.skills.set(name, skillItem);
        }
      } else {
        if (!this.untrustedSkills.has(name)) {
          this.untrustedSkills.set(name, skillItem);
        }
      }
    } catch {
      // Ignore corrupted skill files
    }
  }

  /**
   * Reads the top-level scalar keys of a SKILL.md YAML frontmatter block. Only `name` and `description` are used;
   * no other key (e.g. `allowed-tools`) has any effect. Supports plain, quoted, multi-line plain, and block
   * (`|`, `>`, with `-`/`+` chomping) scalars; nested mappings are skipped, never merged into the top level.
   */
  private parseFrontmatter(text: string): { metadata: Record<string, string>; body: string } {
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim().split("\n");
    if (lines[0]?.trim() !== "---") {
      return { metadata: {}, body: text };
    }
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (close === -1) {
      return { metadata: {}, body: text };
    }

    const yamlLines = lines.slice(1, close);
    const body = lines.slice(close + 1).join("\n").trim();
    const metadata: Record<string, string> = {};

    for (let i = 0; i < yamlLines.length; i++) {
      const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(yamlLines[i].trimEnd());
      if (!match) continue; // indented (nested or continuation) lines, comments, list items
      const key = match[1];
      let val = (match[2] ?? "").trim();
      const continuation: string[] = [];
      while (i + 1 < yamlLines.length && (/^\s/.test(yamlLines[i + 1]) || yamlLines[i + 1].trim() === "")) {
        continuation.push(yamlLines[++i]);
      }
      const block = /^([|>])([+-]?)$/.exec(val);
      if (block) {
        const indent = Math.min(...continuation.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
        const content = continuation.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).trimEnd());
        while (content.length && content[content.length - 1] === "") content.pop();
        val = block[1] === "|" ? content.join("\n") : content.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
      } else if (val === "" || !/^["'{[]/.test(val)) {
        val = [val, ...continuation.map((l) => l.trim())].filter(Boolean).join(" ");
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      metadata[key] = val;
    }

    return { metadata, body };
  }

  public listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  public listUntrustedSkills(): Skill[] {
    return Array.from(this.untrustedSkills.values());
  }

  public getSkill(name: string): Skill | null {
    return this.skills.get(name) || null;
  }

  public getUntrustedSkill(name: string): Skill | null {
    return this.untrustedSkills.get(name) || null;
  }

  public getPromptSection(): string {
    const skills = this.listSkills();
    if (skills.length === 0) {
      return "";
    }

    let out = "### Specialized Agent Skills Available:\n";
    out += "You have access to specialized skills. If a user task matches a skill's description, call the `activate_skill` tool with the skill's name to load its specialized workflows and guidelines into context.\n\n";

    for (const s of skills) {
      out += `- **${s.name}** [source: ${s.path}] [trust: ${s.trusted ? "trusted" : "untrusted"}]: ${s.description}\n`;
    }

    return out;
  }

  private watchers: fs.FSWatcher[] = [];
  private reloadDebounceTimer: NodeJS.Timeout | null = null;

  public startWatcher(onReload?: (skills: Skill[]) => void): void {
    this.stopWatcher();

    const watchDirs = [
      path.join(this.workspace, ".nexus", "skills"),
      path.join(this.workspace, ".agents", "skills"),
      path.join(this.workspace, "skills"),
      path.join(os.homedir(), ".nexus", "skills"),
      path.join(os.homedir(), ".agents", "skills"),
    ];

    for (const dir of watchDirs) {
      if (fs.existsSync(dir)) {
        try {
          const watcher = fs.watch(dir, { recursive: true }, () => {
            if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
            this.reloadDebounceTimer = setTimeout(() => {
              this.refresh();
              if (onReload) onReload(this.listSkills());
            }, 250);
          });
          this.watchers.push(watcher);
        } catch {
          // Ignore watcher errors
        }
      }
    }
  }

  public stopWatcher(): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
  }

  public scaffoldSkill(name: string, description?: string, inWorkspace: boolean = true): { skillPath: string; dirPath: string } {
    const targetDir = inWorkspace
      ? path.join(this.workspace, ".nexus", "skills")
      : path.join(os.homedir(), ".nexus", "skills");
    const res = scaffoldSkill(name, description, targetDir);
    this.refresh();
    return res;
  }
}

/**
 * Scaffold a new agent skill directory and SKILL.md template (Candidate #40)
 */
export function scaffoldSkill(
  name: string,
  description: string = "Specialized engineering instructions and workflows",
  targetDir?: string
): { skillPath: string; dirPath: string } {
  const cleanName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  const baseDir = targetDir || path.join(process.cwd(), ".nexus", "skills");
  const skillDir = path.join(baseDir, cleanName);

  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }

  const skillFile = path.join(skillDir, "SKILL.md");
  const template = `---
name: ${cleanName}
description: ${description}
---

# ${cleanName} Skill

## Overview
${description}

## Workflows & Instructions
1. Step 1: Analyze context and verify preconditions.
2. Step 2: Apply changes adhering to project conventions.
3. Step 3: Run automated test suite to confirm correctness.

## Guidelines
- Always verify outputs with diagnostic tools.
- Maintain existing codebase comments and formatting.
`;

  fs.writeFileSync(skillFile, template, "utf-8");
  return { skillPath: skillFile, dirPath: skillDir };
}
