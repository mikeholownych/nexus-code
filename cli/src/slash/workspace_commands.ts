import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { copyToClipboard, readFromClipboard } from "../clipboard.js";
import { commitChanges, generateConventionalCommit, getGitInfo } from "../git.js";
import { HunkStager } from "../stager.js";
import { runTestSuiteWithExecutor, discoverVerifier, describeVerifier, verifierTimeoutSecs } from "../tester.js";
import { isWorkspaceTrusted } from "../workspace_trust.js";
import { PolicyContext } from "../core/approval_policy.js";
import { NOT_A_REPO, SlashContext, SlashHandler, SlashOutcome, errorText, reply } from "./catalog.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function workspace(ctx: SlashContext): string {
  return ctx.host.app.getConfig().workspace;
}

function diff(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  if (!getGitInfo(cwd).isRepo) return reply("diff", NOT_A_REPO, false);
  try {
    const out = git(cwd, ["diff", "--no-color"]);
    return out.trim() ? reply("diff", out.trimEnd(), true, { format: "diff" }) : reply("diff", "Working tree clean: no uncommitted changes.");
  } catch (err) {
    return reply("diff", `git diff failed: ${errorText(err)}`, false);
  }
}

function gitStatus(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  if (!getGitInfo(cwd).isRepo) return reply("git", NOT_A_REPO, false);
  try {
    return reply("git", git(cwd, ["status", "--short"]).trimEnd() || "Working tree clean.");
  } catch (err) {
    return reply("git", `git status failed: ${errorText(err)}`, false);
  }
}

function stage(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  if (!getGitInfo(cwd).isRepo) return reply("stage", NOT_A_REPO, false);
  const stager = new HunkStager(cwd);
  if (ctx.args.trim() === "reset") {
    stager.unstage();
    return reply("stage", "Unstaged all changes.");
  }
  const summary = stager.getStatusSummary();
  if (!summary.files.length) return reply("stage", "No unstaged hunks in the working tree.");
  const lines = [`${summary.files.length} modified files, ${summary.unstagedHunkCount} hunks`];
  for (const file of summary.files) {
    lines.push("", `${file.newPath} (${file.hunks.length} hunks)`);
    file.hunks.forEach((hunk, index) => {
      lines.push(`  [hunk ${index + 1}] ${hunk.header}`);
      lines.push(...hunk.lines.slice(0, 5).map((line) => `    ${line}`));
      if (hunk.lines.length > 5) lines.push(`    … ${hunk.lines.length - 5} more lines`);
    });
  }
  lines.push("", "Unstage with /stage reset, or commit with /commit.");
  return reply("stage", lines.join("\n"));
}

function commit(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  const info = getGitInfo(cwd);
  if (!info.isRepo) return reply("commit", NOT_A_REPO, false);
  if (info.dirtyCount === 0) return reply("commit", "Working tree clean: nothing to commit.");
  const message = ctx.args.trim();
  if (!message) {
    const suggestion = generateConventionalCommit(cwd);
    return reply(
      "commit",
      `${suggestion.files.length} changed files. Suggested message:\n  ${suggestion.message}\n\nThe composer now holds /commit with this message: edit it and press enter to commit.`,
      true,
      { composer: `/commit ${suggestion.message}` },
    );
  }
  const result = commitChanges(cwd, message);
  return result.success ? reply("commit", `Committed ${result.hash ?? ""}: ${message}`) : reply("commit", `Commit failed: ${result.error}`, false);
}

function checkpoint(ctx: SlashContext): SlashOutcome {
  const manager = ctx.host.checkpoints();
  const [sub, ...rest] = ctx.args.trim().split(/\s+/).filter(Boolean);
  if (sub?.toLowerCase() === "diff") {
    const [id, base] = rest;
    if (!id) return reply("checkpoint", "Usage: /checkpoint diff <id> [base-id]", false);
    const result = manager.getDiff(id, base);
    if (!result.success) return reply("checkpoint", `Diff failed: ${result.error}`, false);
    return result.diff.trim()
      ? reply("checkpoint", result.diff.trimEnd(), true, { format: "diff" })
      : reply("checkpoint", `No changes between ${id} and ${base ?? "the working tree"}.`);
  }
  if (sub?.toLowerCase() === "prune") {
    const keep = Number.parseInt(rest[0] ?? "20", 10);
    return reply("checkpoint", manager.pruneCheckpoints(Number.isNaN(keep) ? 20 : keep).message);
  }
  const created = manager.createCheckpoint(ctx.args.trim() || undefined);
  return reply("checkpoint", `Checkpoint saved: ${created.name} (${created.id})`);
}

function checkpoints(ctx: SlashContext): SlashOutcome {
  const list = ctx.host.checkpoints().listCheckpoints();
  if (!list.length) return reply("checkpoints", "No saved checkpoints.");
  const rows = list.map((cp, index) => `${index + 1}. ${cp.id}  ${cp.name}  (${cp.timestamp})`);
  return reply("checkpoints", [...rows, "", "Compare with /checkpoint diff <id>, roll back with /undo."].join("\n"));
}

function undo(ctx: SlashContext): SlashOutcome {
  const result = ctx.host.checkpoints().rollbackLast();
  return reply("undo", result.message, result.success);
}

function worktree(ctx: SlashContext): SlashOutcome {
  const agent = ctx.host.app.getAgent();
  const active = agent.getActiveWorktree();
  const sub = ctx.args.trim().toLowerCase();
  if (sub === "merge" || sub === "discard") {
    if (!active) return reply("worktree", `No active speculative worktree to ${sub}.`, false);
    if (sub === "merge") {
      const result = agent.mergeActiveWorktree();
      return result.success
        ? reply("worktree", `Merged ${result.commitsMerged} speculative commit(s) from ${result.branch}.`)
        : reply("worktree", `Merge failed: ${result.error}`, false);
    }
    const result = agent.discardActiveWorktree();
    return result.success ? reply("worktree", "Discarded the active speculative worktree.") : reply("worktree", `Discard failed: ${result.error}`, false);
  }
  const lines: string[] = [];
  if (active) lines.push(`* active: ${active.branch} at ${active.worktreePath}`);
  lines.push(...agent.getWorktreeManager().listWorktrees().map((wt) => `• ${wt.taskId}  ${wt.branch}  ${wt.path}`));
  return reply("worktree", lines.length ? lines.join("\n") : "No speculative worktrees. Start Nexus with --worktree to isolate changes.");
}

function audit(ctx: SlashContext): SlashOutcome {
  const file = path.join(os.homedir(), ".nexus", "audit.log");
  if (!fs.existsSync(file)) return reply("audit", "No audit records yet.");
  const limit = Number.parseInt(ctx.args.trim(), 10) || 15;
  const records = fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const rows = records.map((r) => {
    const row = `${String(r.timestamp ?? "").slice(11, 19)}  ${r.success ? "PASS" : "FAIL"}  ${String(r.tool ?? "").padEnd(16)} ${String(r.duration_ms ?? 0).padStart(6)}ms`;
    return r.error ? `${row}\n    error: ${r.error}` : row;
  });
  return reply("audit", rows.join("\n") || "No audit records yet.");
}

async function test(ctx: SlashContext): Promise<SlashOutcome> {
  const ws = workspace(ctx);
  const filter = ctx.args.trim() || undefined;
  const discovered = discoverVerifier(ws, filter);
  if (!discovered) {
    return reply("test", "no verifier: no verification command is configured or discovered in this workspace.", false);
  }
  const description = describeVerifier(ws, discovered.command);
  const testCommand = description?.command || discovered.command;
  const agent = ctx.host.app.getAgent();
  const bridge = agent.getBridge();
  const config = ctx.host.app.getConfig();
  const policyContext: PolicyContext = {
    mode: ctx.host.mode(),
    trusted: isWorkspaceTrusted(ws, Boolean(config.readOnly)),
    sandbox: config.sandbox,
    fullAccess: Boolean(config.fullAccess),
  };
  if (agent.getApprovalPolicy().requiresDecision("exec", policyContext)) {
    const approved = ctx.host.requestApproval
      ? await ctx.host.requestApproval("verifier", {
          command: testCommand,
          script: description?.script,
          detail: description?.evidence ?? discovered.evidence,
          digest: description?.digest,
        }, ctx.signal)
      : false;
    if (!approved) return reply("test", "Test run aborted by user.", false);
  }
  const timeoutSecs = verifierTimeoutSecs(ctx.host.app.getConfig().verifierTimeoutSecs);
  bridge.setTurnSignal(ctx.signal);
  let result;
  try {
    result = await runTestSuiteWithExecutor(
      ws,
      (command) => bridge.executeTool("run_command", { command, timeout_secs: timeoutSecs }),
      testCommand,
    );
  } finally {
    bridge.setTurnSignal(undefined);
  }
  const lines = [`$ ${result.command}`, result.success ? "Test suite passed." : "Test suite failed."];
  if (!result.success && result.failures.length) lines.push("", "Failing tests:", ...result.failures.slice(0, 10).map((f) => `  • ${f}`));
  if (!result.success && result.diagnostics.length) {
    lines.push("", "Diagnostics:", ...result.diagnostics.slice(0, 5).map((d) => `  • [${d.severity.toUpperCase()}] ${d.file || "unknown"}:${d.line || "?"} ${d.message}`));
  }
  return reply("test", lines.join("\n"), result.success);
}

function lastAssistant(ctx: SlashContext): string {
  const messages = ctx.host.app.getAgent().getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (messages[i].role === "assistant" && content) return typeof content === "string" ? content : JSON.stringify(content);
  }
  return "";
}

function copy(ctx: SlashContext): SlashOutcome {
  const what = ctx.args.trim().toLowerCase() || "last";
  let text: string;
  let label: string;
  if (what === "diff") {
    const cwd = workspace(ctx);
    if (!getGitInfo(cwd).isRepo) return reply("copy", NOT_A_REPO, false);
    text = git(cwd, ["diff"]);
    if (!text.trim()) return reply("copy", "No uncommitted changes to copy.", false);
    label = `the git diff (${text.split("\n").length} lines)`;
  } else {
    const last = lastAssistant(ctx);
    if (!last) return reply("copy", "No assistant reply to copy yet.", false);
    const blocks = what === "code" ? [...last.matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g)].map((m) => m[1].trimEnd()) : [];
    text = blocks.length ? blocks.join("\n\n// ────────────────────────────\n\n") : last;
    label = blocks.length ? `${blocks.length} code block(s)` : `the last reply (${last.length} chars)`;
  }
  const result = copyToClipboard(text);
  return result.success ? reply("copy", `Copied ${label} to the clipboard.`) : reply("copy", `Clipboard error: ${result.error}`, false);
}

/** Keeps the escaped `slash.result` line under the TUI's 1 MiB protocol line cap. */
const MAX_PASTE = 100_000;

function paste(): SlashOutcome {
  const result = readFromClipboard();
  if (!result.success || !result.text) return reply("paste", `Clipboard error: ${result.error || "the clipboard is empty"}`, false);
  if (result.text.length > MAX_PASTE) return reply("paste", `The clipboard holds ${result.text.length} characters; /paste takes at most ${MAX_PASTE}.`, false);
  return reply("paste", `Pasted ${result.text.length} characters into the composer.`, true, { composer: result.text });
}

export const WORKSPACE_HANDLERS: Record<string, SlashHandler> = {
  diff,
  git: gitStatus,
  stage,
  commit,
  checkpoint,
  checkpoints,
  undo,
  worktree,
  audit,
  test,
  copy,
  paste,
};
