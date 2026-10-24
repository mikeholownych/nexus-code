import { execFileSync, execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface GitInfo {
  isRepo: boolean;
  branch: string;
  dirtyCount: number;
  formattedBadge: string;
}

export function getGitInfo(workspace: string): GitInfo {
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
  } catch {
    return {
      isRepo: false,
      branch: "",
      dirtyCount: 0,
      formattedBadge: "",
    };
  }
}

export function getProjectRules(workspace: string): string | null {
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
      } catch {
        // ignore read error
      }
    }
  }

  return null;
}

export function scaffoldProjectRules(workspace: string): string {
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

export function generateConventionalCommit(workspace: string): { message: string; files: string[] } {
  try {
    const statusOut = execSync("git status --porcelain", {
      cwd: workspace,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trimEnd();

    if (!statusOut) {
      return { message: "chore(repo): update repository", files: [] };
    }

    const lines = statusOut.split("\n");
    const files = lines.map((l) => l.slice(3).trim());

    // Determine primary scope
    let scope = "core";
    if (files.every((f) => f.startsWith("docs/") || f.endsWith(".md"))) {
      scope = "docs";
    } else if (files.every((f) => f.startsWith("cli/test/") || f.includes("test"))) {
      scope = "test";
    } else if (files.every((f) => f.startsWith("cli/"))) {
      scope = "cli";
    } else if (files.every((f) => f.startsWith("core/"))) {
      scope = "core";
    }

    // Determine type
    let type = "feat";
    if (scope === "docs") {
      type = "docs";
    } else if (scope === "test") {
      type = "test";
    } else if (files.some((f) => f.includes("fix") || f.includes("bug"))) {
      type = "fix";
    }

    // Identify primary topic
    let topic = "update workspace files";
    if (files.some((f) => f.includes("repl") || f.includes("prompt"))) {
      topic = "enhance interactive REPL and command UX";
    } else if (files.some((f) => f.includes("agent") || f.includes("diagnostics"))) {
      topic = "improve agent self-healing and recovery loop";
    } else if (files.some((f) => f.includes("mcp"))) {
      topic = "update MCP server and tool integrations";
    } else if (files.some((f) => f.includes("checkpoint"))) {
      topic = "enhance workspace snapshotting and rollback";
    } else if (files.some((f) => f.includes("file_ops"))) {
      topic = "robust file editing and matching";
    } else if (files.length === 1) {
      topic = `update ${path.basename(files[0])}`;
    }

    const message = `${type}(${scope}): ${topic}`;
    return { message, files };
  } catch {
    return { message: "chore(repo): update workspace", files: [] };
  }
}

export function commitChanges(workspace: string, message: string): { success: boolean; hash?: string; error?: string } {
  try {
    const gitEnv = { ...process.env };
    for (const key of ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) {
      delete gitEnv[key];
    }
    // Exclusions in `git add` do not remove paths that were already staged.
    // Restore only the internal state entries in the index, leaving their working
    // tree contents untouched, before staging the user's workspace changes.
    execFileSync("git", ["reset", "--quiet", "HEAD", "--", ":(top).nexus"], {
      cwd: workspace,
      env: gitEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Internal Nexus state must never enter an automated workspace commit, even if a user's
    // .git/info/exclude contains a malformed rule or a later negation that exposes .nexus/.
    execFileSync("git", ["add", "-A", "--", ":(top,exclude).nexus", ":(top,exclude).nexus/**"], {
      cwd: workspace,
      env: gitEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["commit", "-m", message], {
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
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
