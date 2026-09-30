import { execSync } from "node:child_process";
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
