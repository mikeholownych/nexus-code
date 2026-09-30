import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
export function getGitInfo(workspace) {
    try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
            cwd: workspace,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();
        const statusOut = execSync("git status --porcelain", {
            cwd: workspace,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();
        const lines = statusOut ? statusOut.split("\n") : [];
        const dirtyCount = lines.length;
        const formattedBadge = dirtyCount > 0 ? `${branch} *${dirtyCount}` : branch;
        return {
            isRepo: true,
            branch,
            dirtyCount,
            formattedBadge,
        };
    }
    catch {
        return {
            isRepo: false,
            branch: "",
            dirtyCount: 0,
            formattedBadge: "",
        };
    }
}
export function getProjectRules(workspace) {
    const candidates = [
        "AGENTS.md",
        "CLAUDE.md",
        "CODEX.md",
        ".nexusrules",
    ];
    for (const filename of candidates) {
        const fullPath = path.join(workspace, filename);
        if (fs.existsSync(fullPath)) {
            try {
                const content = fs.readFileSync(fullPath, "utf-8").trim();
                if (content) {
                    return `### Project Instructions (loaded from ${filename}):\n${content}`;
                }
            }
            catch {
                // ignore read error
            }
        }
    }
    return null;
}
export function scaffoldProjectRules(workspace) {
    const target = path.join(workspace, "AGENTS.md");
    if (fs.existsSync(target)) {
        return target;
    }
    const template = `# Project Guidelines & Agent Instructions

## Commands
- Build: \`make build\` or \`cargo build\` or \`npm run build\`
- Test: \`make test\` or \`cargo test\` or \`npm test\`
- Lint: \`cargo clippy\` or \`npm run lint\`

## Code Conventions
- Maintain documentation integrity and keep existing comments.
- Always run tests after making changes to verify correctness.
- Keep functions modular and clearly typed.
`;
    fs.writeFileSync(target, template, "utf-8");
    return target;
}
export function generateConventionalCommit(workspace) {
    try {
        const statusOut = execSync("git status --porcelain", {
            cwd: workspace,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();
        if (!statusOut) {
            return { message: "chore(repo): update repository", files: [] };
        }
        const lines = statusOut.split("\n");
        const files = lines.map((l) => l.slice(3).trim());
        // Determine primary scope
        let scope = "core";
        if (files.every((f) => f.startsWith("docs/") || f.endsWith(".md"))) {
            scope = "docs";
        }
        else if (files.every((f) => f.startsWith("cli/test/") || f.includes("test"))) {
            scope = "test";
        }
        else if (files.every((f) => f.startsWith("cli/"))) {
            scope = "cli";
        }
        else if (files.every((f) => f.startsWith("core/"))) {
            scope = "core";
        }
        // Determine type
        let type = "feat";
        if (scope === "docs") {
            type = "docs";
        }
        else if (scope === "test") {
            type = "test";
        }
        else if (files.some((f) => f.includes("fix") || f.includes("bug"))) {
            type = "fix";
        }
        // Identify primary topic
        let topic = "update workspace files";
        if (files.some((f) => f.includes("repl") || f.includes("prompt"))) {
            topic = "enhance interactive REPL and command UX";
        }
        else if (files.some((f) => f.includes("agent") || f.includes("diagnostics"))) {
            topic = "improve agent self-healing and recovery loop";
        }
        else if (files.some((f) => f.includes("mcp"))) {
            topic = "update MCP server and tool integrations";
        }
        else if (files.some((f) => f.includes("checkpoint"))) {
            topic = "enhance workspace snapshotting and rollback";
        }
        else if (files.some((f) => f.includes("file_ops"))) {
            topic = "robust file editing and matching";
        }
        else if (files.length === 1) {
            topic = `update ${path.basename(files[0])}`;
        }
        const message = `${type}(${scope}): ${topic}`;
        return { message, files };
    }
    catch {
        return { message: "chore(repo): update workspace", files: [] };
    }
}
export function commitChanges(workspace, message) {
    try {
        execSync("git add -A", { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
        execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
            cwd: workspace,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const hash = execSync("git rev-parse --short HEAD", {
            cwd: workspace,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        }).trim();
        return { success: true, hash };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
