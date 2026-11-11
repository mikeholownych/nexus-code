import { execFileSync, execSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { PATHSPEC_MODE_ENV, verifyCheckout } from "./core/checkout_trust.js";
import { nestedRepositoryReason, UntrustedCheckoutError } from "./worktrunk/git.js";
import * as fs from "node:fs";

export interface GitInfo {
  isRepo: boolean;
  branch: string;
  dirtyCount: number;
  formattedBadge: string;
  /** Set when Git was refused (a worktree the sandboxed agent could have tampered with), so the cause is not mistaken for "not a repository". */
  refusal?: string;
}

/**
 * Nexus's own state directories: the workspace's `.nexus` and the repository root's. Status reads the whole repository
 * without them, and commitChanges unstages and excludes exactly the same set, so the header, the model's [Git Status]
 * line, /git and /commit agree and Nexus's receipts never count as, or get committed with, a user change.
 * A file the user deliberately tracks under `.nexus/` is therefore not reported or committed by Nexus either.
 */
const NEXUS_STATE = [".nexus", ":(top).nexus"];
const NEXUS_STATE_EXCLUDED = [":(exclude).nexus", ":(exclude).nexus/**", ":(top,exclude).nexus", ":(top,exclude).nexus/**"];
const WITHOUT_NEXUS_STATE = ["--", ":/", ...NEXUS_STATE_EXCLUDED];

/** The environment for git calls that pass the pathspecs above: an inherited pathspec mode would make them literal. */
function pathspecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of PATHSPEC_MODE_ENV) delete env[key];
  return env;
}

/**
 * Host-side Git must not run in a worktree whose `.git` (or a nested repository) the sandboxed agent could have planted.
 * Returns the `--git-dir`/`--work-tree` pair to run Git against (empty for a plain repository), so a pointer rewritten
 * after this check is not re-read.
 */
export function trustedGitArgs(workspace: string): string[] {
  const checkout = verifyCheckout(workspace);
  const reason = checkout.reason ?? (checkout.gitDir ? nestedRepositoryReason(workspace) : undefined); // and any repository planted below it
  if (reason) throw new UntrustedCheckoutError(workspace, reason, []);
  return checkout.gitDir ? ["--git-dir", checkout.gitDir, "--work-tree", checkout.workTree!] : [];
}

/** `git status` in `format` for the workspace's repository, without Nexus state. Throws when git fails. */
export function workspaceStatus(workspace: string, format: "--porcelain" | "--short", pin: string[] = trustedGitArgs(workspace)): string {
  return execFileSync("git", [...pin, "status", format, ...WITHOUT_NEXUS_STATE], {
    cwd: workspace,
    env: pathspecEnv(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The current branch; on an unborn branch (no commit yet) `rev-parse` fails, so read the symbolic ref instead. */
function currentBranch(workspace: string, pin: string[]): string {
  const run = (args: string[]) =>
    execFileSync("git", [...pin, ...args], { cwd: workspace, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return run(["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return run(["symbolic-ref", "--short", "HEAD"]);
  }
}

export function getGitInfo(workspace: string): GitInfo {
  try {
    const pin = trustedGitArgs(workspace); // guards the checkout once, before any Git runs
    const statusOut = workspaceStatus(workspace, "--porcelain", pin).trim();
    const branch = currentBranch(workspace, pin);

    const lines = statusOut ? statusOut.split("\n") : [];
    const dirtyCount = lines.length;

    const formattedBadge = dirtyCount > 0 ? `${branch} *${dirtyCount}` : branch;

    return {
      isRepo: true,
      branch,
      dirtyCount,
      formattedBadge,
    };
  } catch (err) {
    return {
      isRepo: false,
      branch: "",
      dirtyCount: 0,
      formattedBadge: "",
      ...(err instanceof UntrustedCheckoutError ? { refusal: err.message } : {}),
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
    const statusOut = workspaceStatus(workspace, "--porcelain").trimEnd();

    if (!statusOut) {
      return { message: "chore(repo): update repository", files: [] };
    }

    const lines = statusOut.split("\n");
    const files = lines.map((l) => l.slice(3).trim());
    return { message: conventionalCommitMessage(files), files };
  } catch {
    return { message: "chore(repo): update workspace", files: [] };
  }
}

/** The deterministic conventional-commit subject for a list of changed paths (no Git, no shell). */
export function conventionalCommitMessage(files: string[]): string {
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
    // A file name is agent-controlled: control, C1 and bidi-override characters (a newline would start a forged trailer) never reach the message.
    const name = path.basename(files[0]);
    topic = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name) ? "update workspace files" : `update ${name}`;
  }

  return `${type}(${scope}): ${topic}`;
}

export function commitChanges(workspace: string, message: string): { success: boolean; hash?: string; error?: string } {
  try {
    const pin = trustedGitArgs(workspace);
    const gitEnv = pathspecEnv();
    // Exclusions in `git add` do not remove paths that were already staged.
    // Restore only the internal state entries in the index, leaving their working
    // tree contents untouched, before staging the user's workspace changes.
    const head = spawnSync("git", [...pin, "rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: workspace,
      env: gitEnv,
      stdio: "ignore",
    });
    if (head.error) throw head.error;
    if (head.status === 0) {
      execFileSync("git", [...pin, "reset", "--quiet", "HEAD", "--", ...NEXUS_STATE], {
        cwd: workspace,
        env: gitEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // A newly initialized repository has no HEAD tree to reset to. Confirm that
      // HEAD is a symbolic ref whose branch does not yet exist before treating it
      // as unborn; a broken or detached HEAD must still fail closed.
      const headRef = spawnSync("git", [...pin, "symbolic-ref", "-q", "HEAD"], {
        cwd: workspace,
        env: gitEnv,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (headRef.error) throw headRef.error;
      if (headRef.status !== 0 || !headRef.stdout.trim()) {
        throw new Error("Cannot resolve repository HEAD before excluding Nexus state");
      }
      const branchRef = headRef.stdout.trim();
      const branch = spawnSync("git", [...pin, "show-ref", "--verify", "--quiet", branchRef], {
        cwd: workspace,
        env: gitEnv,
        stdio: "ignore",
      });
      if (branch.error) throw branch.error;
      if (branch.status !== 1) {
        throw new Error("Repository HEAD is not an unborn branch; refusing to alter the index");
      }
      // There is no HEAD tree to restore from, so remove only staged .nexus paths
      // from the index. --cached preserves their workspace contents.
      execFileSync("git", [...pin, "rm", "--cached", "-r", "-f", "--ignore-unmatch", "--", ...NEXUS_STATE], {
        cwd: workspace,
        env: gitEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    // Internal Nexus state must never enter an automated workspace commit, even if a user's
    // .git/info/exclude contains a malformed rule or a later negation that exposes .nexus/.
    // Same exclusion set as workspaceStatus(): what the dirty count leaves out is never staged.
    execFileSync("git", [...pin, "add", "-A", "--", ...NEXUS_STATE_EXCLUDED], {
      cwd: workspace,
      env: gitEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", [...pin, "commit", "-m", message], {
      cwd: workspace,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const hash = execFileSync("git", [...pin, "rev-parse", "--short", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return { success: true, hash };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
