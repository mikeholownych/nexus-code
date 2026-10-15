import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isWorkspaceTrusted } from "./workspace_trust.js";
export class SkillManager {
    workspace;
    readOnly;
    explicitTrusted;
    skills = new Map();
    untrustedSkills = new Map();
    constructor(workspace, options = {}) {
        this.workspace = path.resolve(workspace);
        this.readOnly = Boolean(options.readOnly);
        this.explicitTrusted = options.trusted;
        this.refresh();
    }
    setWorkspace(workspace, options = {}) {
        this.workspace = path.resolve(workspace);
        if (options.readOnly !== undefined)
            this.readOnly = options.readOnly;
        if (options.trusted !== undefined)
            this.explicitTrusted = options.trusted;
        this.refresh();
    }
    refresh() {
        this.skills.clear();
        this.untrustedSkills.clear();
        const isTrusted = this.explicitTrusted !== undefined
            ? this.explicitTrusted
            : isWorkspaceTrusted(this.workspace, this.readOnly);
        // User home locations (always loaded & trusted)
        const homeDirs = [
            path.join(os.homedir(), ".nexus", "skills"),
            path.join(os.homedir(), ".config", "nexus", "skills"),
            path.join(os.homedir(), ".config", "opencode", "skills"),
            path.join(os.homedir(), ".claude", "skills"),
        ];
        for (const dir of homeDirs) {
            if (fs.existsSync(dir)) {
                this.scanDir(dir, { isWorkspace: false, trusted: true });
            }
        }
        // Project workspace locations (gated by workspace trust)
        const workspaceDirs = [
            path.join(this.workspace, ".nexus", "skills"),
            path.join(this.workspace, ".claude", "skills"),
            path.join(this.workspace, "skills"),
        ];
        for (const dir of workspaceDirs) {
            if (fs.existsSync(dir)) {
                this.scanDir(dir, { isWorkspace: true, trusted: isTrusted });
            }
        }
    }
    scanDir(baseDir, context) {
        try {
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(baseDir, entry.name);
                if (entry.isDirectory()) {
                    // Check for SKILL.md inside directory
                    const skillFile = path.join(fullPath, "SKILL.md");
                    if (fs.existsSync(skillFile)) {
                        this.loadSkillFile(skillFile, entry.name, context);
                    }
                    else {
                        // Also check single-level subdirectories
                        this.scanDir(fullPath, context);
                    }
                }
                else if (entry.isFile() && entry.name === "SKILL.md") {
                    const parentDirName = path.basename(baseDir);
                    this.loadSkillFile(fullPath, parentDirName, context);
                }
                else if (entry.isFile() && entry.name.endsWith(".skill.md")) {
                    const skillName = entry.name.replace(/\.skill\.md$/, "");
                    this.loadSkillFile(fullPath, skillName, context);
                }
            }
        }
        catch {
            // Ignore permission or read errors
        }
    }
    loadSkillFile(filePath, fallbackName, context) {
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const { metadata, body } = this.parseFrontmatter(content);
            const name = metadata.name || fallbackName;
            const description = metadata.description || "Specialized skill instructions";
            const skillItem = {
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
            }
            else {
                if (!this.untrustedSkills.has(name)) {
                    this.untrustedSkills.set(name, skillItem);
                }
            }
        }
        catch {
            // Ignore corrupted skill files
        }
    }
    parseFrontmatter(text) {
        const trimmed = text.trim();
        if (!trimmed.startsWith("---")) {
            return { metadata: {}, body: text };
        }
        const secondIndex = trimmed.indexOf("---", 3);
        if (secondIndex === -1) {
            return { metadata: {}, body: text };
        }
        const yamlBlock = trimmed.slice(3, secondIndex).trim();
        const body = trimmed.slice(secondIndex + 3).trim();
        const metadata = {};
        for (const line of yamlBlock.split("\n")) {
            const colonIdx = line.indexOf(":");
            if (colonIdx > 0) {
                const key = line.slice(0, colonIdx).trim();
                let val = line.slice(colonIdx + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                metadata[key] = val;
            }
        }
        return { metadata, body };
    }
    listSkills() {
        return Array.from(this.skills.values());
    }
    listUntrustedSkills() {
        return Array.from(this.untrustedSkills.values());
    }
    getSkill(name) {
        return this.skills.get(name) || null;
    }
    getUntrustedSkill(name) {
        return this.untrustedSkills.get(name) || null;
    }
    getPromptSection() {
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
    watchers = [];
    reloadDebounceTimer = null;
    startWatcher(onReload) {
        this.stopWatcher();
        const watchDirs = [
            path.join(this.workspace, ".nexus", "skills"),
            path.join(this.workspace, "skills"),
            path.join(os.homedir(), ".nexus", "skills"),
        ];
        for (const dir of watchDirs) {
            if (fs.existsSync(dir)) {
                try {
                    const watcher = fs.watch(dir, { recursive: true }, () => {
                        if (this.reloadDebounceTimer)
                            clearTimeout(this.reloadDebounceTimer);
                        this.reloadDebounceTimer = setTimeout(() => {
                            this.refresh();
                            if (onReload)
                                onReload(this.listSkills());
                        }, 250);
                    });
                    this.watchers.push(watcher);
                }
                catch {
                    // Ignore watcher errors
                }
            }
        }
    }
    stopWatcher() {
        if (this.reloadDebounceTimer) {
            clearTimeout(this.reloadDebounceTimer);
            this.reloadDebounceTimer = null;
        }
        for (const w of this.watchers) {
            try {
                w.close();
            }
            catch { }
        }
        this.watchers = [];
    }
    scaffoldSkill(name, description, inWorkspace = true) {
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
export function scaffoldSkill(name, description = "Specialized engineering instructions and workflows", targetDir) {
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
