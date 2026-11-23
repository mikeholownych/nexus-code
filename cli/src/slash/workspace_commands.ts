import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SANITIZATION_FAILED, formatSafeSidecarText } from "../safe_text.js";
import { copyWithFallback, readFromClipboard } from "../clipboard.js";
import { commitChanges, generateConventionalCommit, getGitInfo, trustedGitArgs, workspaceStatus } from "../git.js";
import { HunkStager } from "../stager.js";
import { runTestSuiteWithExecutor, discoverVerifier, describeVerifier, verifierTimeoutSecs } from "../tester.js";
import { isWorkspaceTrusted } from "../workspace_trust.js";
import { PolicyContext } from "../core/approval_policy.js";
import { isLegacyWorktreeArgs, relocationAfter, runWorktreeCommandAsync, tokenizeWorktreeArgs } from "../worktrunk/command.js";
import { providerCompleter } from "../worktrunk/provider.js";
import { assessContextMaturity, buildContextInventory, compareWorkspaceState, inventorySourcesFromMessages, isContextInventorySnapshot, renderContextInventoryText, renderContextMaturityText, type ContextSourceItemInput } from "../core/context_inventory.js";
import { NOT_A_REPO, SlashContext, SlashHandler, SlashOutcome, errorText, reply } from "./catalog.js";
import { MAX_PASTE } from "../protocol.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...trustedGitArgs(cwd), ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function workspace(ctx: SlashContext): string {
  return ctx.host.app.getConfig().workspace;
}

function diff(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  { const info = getGitInfo(cwd); if (!info.isRepo) return reply("diff", info.refusal ?? NOT_A_REPO, false); }
  try {
    const out = git(cwd, ["diff", "--no-color"]);
    if (out.trim()) return reply("diff", out.trimEnd(), true, { format: "diff" });
    // `git diff` shows unstaged edits to tracked files only; say what else is uncommitted rather than calling it clean.
    const lines = workspaceStatus(cwd, "--porcelain").split("\n").filter(Boolean);
    const untracked = lines.filter((l) => l.startsWith("??")).length;
    const staged = lines.filter((l) => l[0] !== " " && l[0] !== "?").length;
    if (!untracked && !staged) return reply("diff", "Working tree clean: no uncommitted changes.");
    const parts = [untracked ? `${untracked} untracked` : "", staged ? `${staged} staged` : ""].filter(Boolean).join(", ");
    return reply("diff", `No unstaged changes to tracked files; ${parts} (see /git).`);
  } catch (err) {
    return reply("diff", `git diff failed: ${errorText(err)}`, false);
  }
}

function gitStatus(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  { const info = getGitInfo(cwd); if (!info.isRepo) return reply("git", info.refusal ?? NOT_A_REPO, false); }
  try {
    return reply("git", workspaceStatus(cwd, "--short").trimEnd() || "Working tree clean.");
  } catch (err) {
    return reply("git", `git status failed: ${errorText(err)}`, false);
  }
}

function stage(ctx: SlashContext): SlashOutcome {
  const cwd = workspace(ctx);
  { const info = getGitInfo(cwd); if (!info.isRepo) return reply("stage", info.refusal ?? NOT_A_REPO, false); }
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
  if (!info.isRepo) return reply("commit", info.refusal ?? NOT_A_REPO, false);
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

async function worktree(ctx: SlashContext): Promise<SlashOutcome> {
  const agent = ctx.host.app.getAgent();
  const active = agent.getActiveWorktree();
  const sub = ctx.args.trim().toLowerCase();
  // Legacy forms act on the speculative worktree of this run; everything else is the named-worktree command set.
  if (!isLegacyWorktreeArgs(sub)) {
    const cwd = workspace(ctx);
    const result = await runWorktreeCommandAsync(tokenizeWorktreeArgs(ctx.args), { cwd, readOnly: ctx.host.mode() === "read-only" }, {
      completer: providerCompleter(ctx.host.app.getConfig()),
      signal: ctx.signal,
    });
    // A merge removes the worktree this session may be standing in: move it to the branch it was merged into.
    const moveTo = relocationAfter(result, cwd);
    if (moveTo) ctx.host.setWorkspace(moveTo);
    return reply("worktree", moveTo ? `${result.output}\nWorkspace changed to ${moveTo}` : result.output, result.success);
  }
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

/** The sanitised form of a copy, or nothing when the sanitiser failed (it returns a placeholder then). */
export function sanitizeForTerminal(text: string): string {
  const safe = formatSafeSidecarText(text);
  return safe === SANITIZATION_FAILED ? "" : safe;
}

function copy(ctx: SlashContext): SlashOutcome {
  const what = ctx.args.trim().toLowerCase() || "last";
  let text: string;
  let label: string;
  if (what === "diff") {
    const cwd = workspace(ctx);
    { const info = getGitInfo(cwd); if (!info.isRepo) return reply("copy", info.refusal ?? NOT_A_REPO, false); }
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
  const result = copyWithFallback(text, process.env, sanitizeForTerminal);
  if (!result.success) return reply("copy", `Clipboard error: ${result.error}`, false);
  if (result.osc52 !== undefined) {
    return reply(
      "copy",
      `No clipboard tool was found, so Nexus asked your terminal to copy ${label} (OSC 52, ${Buffer.byteLength(result.osc52, "utf8")} bytes). ` +
        "Nexus cannot confirm it: if nothing arrived, the terminal ignores OSC 52 (tmux needs `set -g set-clipboard on`; GNU screen is not supported). " +
        "Credential-looking text and control characters in it are replaced, as in /paste. NEXUS_OSC52=off turns this fallback off.",
      true,
      { clipboard: result.osc52 },
    );
  }
  return reply("copy", `Copied ${label} to the clipboard.`);
}

function paste(): SlashOutcome {
  const result = readFromClipboard();
  if (!result.success || !result.text) return reply("paste", `Clipboard error: ${result.error || "the clipboard is empty"}`, false);
  if (result.text.length > MAX_PASTE) return reply("paste", `The clipboard holds ${result.text.length} characters; /paste takes at most ${MAX_PASTE}.`, false);
  return reply("paste", `Pasted ${result.text.length} characters into the composer.`, true, { composer: result.text });
}

function context({ host, args, signal }: SlashContext): SlashOutcome {
  const [view, ...flags] = args.trim().split(/\s+/).filter(Boolean);
  if (!view || !["inspect", "maturity"].includes(view)) return reply("context", "Usage: /context inspect [--json] [--record] | /context maturity [--json]", false);
  const allowed = view === "inspect" ? new Set(["--json", "--record"]) : new Set(["--json"]);
  if (flags.some((flag) => !allowed.has(flag)) || new Set(flags).size !== flags.length) return reply("context", "Invalid or duplicate option. Use /context inspect [--json] [--record] or /context maturity [--json].", false);
  if (signal.aborted) return reply("context", "Context inspection was cancelled.", false);

  const agent = host.app.getAgent();
  const config = host.app.getConfig();
  const sessionManager = host.app.getSessionManager();
  const savedSession = sessionManager.loadSession(host.sessionId());
  const previousInventory = isContextInventorySnapshot(savedSession?.contextInventory) ? savedSession.contextInventory : undefined;
  const sources: Array<{ name: string; status: "ok" | "partial" | "failed"; durationMs: number; items: ContextSourceItemInput[]; detail?: string }> = [];
  const gaps: string[] = ["The composite system prompt contains rules and other sources that are not yet split into per-item provenance."];
  if (typeof agent.getInferenceContextManifests !== "function") gaps.push("This agent instance does not expose persisted per-inference request manifests.");
  const measure = (name: string, read: () => ContextSourceItemInput[], status: "ok" | "partial" = "ok", detail?: string) => {
    const started = performance.now();
    try {
      const items = read();
      sources.push({ name, status, durationMs: performance.now() - started, items, ...(detail ? { detail } : {}) });
    } catch {
      sources.push({ name, status: "failed", durationMs: performance.now() - started, items: [], detail: "source lookup failed; no source content was recorded" });
      gaps.push(`${name} source lookup failed`);
    }
  };

  measure("session_messages", () => inventorySourcesFromMessages(agent.getMessages()));
  let workspaceFingerprint: string | undefined;
  measure("workspace_state_fingerprint", () => {
    if (typeof agent.getWorkspaceContextFingerprint !== "function") throw new Error("workspace fingerprint API unavailable");
    workspaceFingerprint = agent.getWorkspaceContextFingerprint();
    if (!workspaceFingerprint) throw new Error("workspace fingerprint unavailable");
    return [{
      sourceType: "workspace_state_fingerprint",
      sourceLocation: "repository:candidate-identity",
      scope: "repository",
      content: "bounded composite candidate identity",
      trust: "tool_output_unverified",
      retention: "session_context_inventory",
      inclusionReason: "supports equality comparison with the previous recorded workspace state; it is not evidence that repository content is correct",
      retrievalMethod: "candidate_identity",
      freshness: "current",
      freshnessRule: "computed at capture from current candidate identity; any workspace candidate change invalidates this observation",
    }];
  });
  if (typeof agent.getInferenceContextManifests === "function") {
    measure("inference_request_manifests", () => agent.getInferenceContextManifests().map((manifest: any) => ({
        sourceType: "inference_request_manifest",
        sourceLocation: `task:inference-request:${manifest.id}`,
        scope: "task" as const,
        content: JSON.stringify({ sequence: manifest.sequence, capturedAt: manifest.capturedAt, status: manifest.status, coverage: manifest.coverage, messageCount: manifest.messages.length, toolCount: manifest.tools.count, requestEstimateTokens: manifest.budget.requestEstimateTokens }),
        trust: "persisted_unverified" as const,
        retention: "bounded_latest_24_session_records",
        inclusionReason: "client-side record of message and tool-schema arrays handed to the adapter; dispatch status does not prove provider processing",
        retrievalMethod: "agent_submit_wrapper",
        sourceRefs: manifest.messages.slice(0, 100).map((item: any) => item.sourceRef),
      })));
  } else {
    measure("inference_request_manifests", () => [], "partial", "request manifest history is unavailable from this agent instance");
  }
  measure("task_ledger", () => {
    const objective = agent.getObjective();
    if (!objective) return [];
    return [{ sourceType: "objective_ledger", sourceLocation: "task:objective-ledger", scope: "task", content: JSON.stringify(objective), trust: "persisted_unverified", retention: "task", inclusionReason: "pinned objective and acceptance state", retrievalMethod: "durable_task_state", freshness: "current", freshnessRule: "read from the live task ledger at inspection time", sourceRefs: objective.requirements?.map((requirement) => `requirement:${requirement.id}`) }];
  });
  measure("plan", () => {
    const plan = agent.getActivePlan();
    return plan.length ? [{ sourceType: "active_plan", sourceLocation: "task:active-plan", scope: "task", content: JSON.stringify(plan), trust: "persisted_unverified", retention: "task", inclusionReason: "current task plan", retrievalMethod: "durable_task_state", freshness: "current", freshnessRule: "read from the live task plan at inspection time" }] : [];
  });
  measure("durable_session_state", () => {
    if (!savedSession) return [];
    const items: ContextSourceItemInput[] = [];
    savedSession.durableNotes?.forEach((note, index) => items.push({
      sourceType: "durable_note",
      sourceLocation: `task:durable-note:${index}`,
      scope: "task",
      content: note,
      trust: "persisted_unverified",
      retention: "task",
      inclusionReason: "durable task note retained in session state",
      retrievalMethod: "session_store",
    }));
    if (savedSession.compactionProvenance) items.push({
      sourceType: "compaction_provenance",
      sourceLocation: `session:compaction:${savedSession.compactionProvenance.recordId}`,
      scope: "session",
      content: savedSession.compactionProvenance.summaryContent ?? "compaction summary; content reference only",
      trust: "persisted_unverified",
      retention: "session_archive",
      inclusionReason: "compaction record links the summary to archived predecessor messages",
      retrievalMethod: "session_store",
      sourceRefs: [savedSession.compactionProvenance.recordId, ...savedSession.compactionProvenance.predecessorIds],
    });
    return items;
  }, "partial", "saved durable notes and compaction links only; full session messages are inventoried separately");
  measure("project_knowledge", () => agent.getKnowledgeGraph().list().map((entry, index) => ({
    sourceType: "durable_knowledge",
    sourceLocation: `repository:knowledge:${entry.id || index + 1}`,
    scope: "repository" as const,
    content: `${entry.category}\n${entry.key}\n${entry.value}`,
    trust: "persisted_unverified" as const,
    retention: entry.retention?.policy === "expires_at" ? `expires_at:${entry.retention.expiresAt}` : "until_deleted",
    inclusionReason: `persistent project memory is available to the prompt builder; validation=${entry.validationStatus ?? "legacy_unverified"}`,
    retrievalMethod: "knowledge_graph",
    sourceRefs: [`knowledge:${entry.id}`, ...(entry.provenance?.sourceRefs ?? [])],
  })));
  measure("skills", () => agent.getSkillManager().listSkills().map((skill) => ({
    sourceType: "skill_catalog_entry",
    sourceLocation: skill.isWorkspaceSkill ? `repository:skill:${path.relative(config.workspace, skill.path)}` : `profile:skill:${skill.name}`,
    scope: "profile" as const,
    content: `${skill.name}\n${skill.description}`,
    trust: "persisted_unverified" as const,
    retention: "skill_source_policy",
    inclusionReason: `skill catalog is eligible for prompt discovery; activation is separate${skill.trusted === false ? "; source is not trusted" : "; source trust is recorded by SkillManager"}`,
    retrievalMethod: "skill_manager",
    ...(skill.isWorkspaceSkill ? { sourceRefs: [path.relative(config.workspace, skill.path)] } : {}),
  })), "partial");
  measure("tool_schemas", () => agent.getEffectiveTools().map((tool, index) => ({
    sourceType: "tool_schema",
    sourceLocation: `request:tool:${String(tool.function?.name ?? index + 1).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)}`,
    scope: "turn" as const,
    content: JSON.stringify(tool),
    trust: "persisted_unverified" as const,
    retention: "request_only",
    inclusionReason: "effective tools are serialized with the inference request",
    retrievalMethod: "tool_registry",
    freshness: "current" as const,
    freshnessRule: "effective runtime tool schema as observed at inspection time; invalidate after tool registry or policy changes",
  })));
  measure("repository_state", () => {
    const info = getGitInfo(config.workspace);
    return [{ sourceType: "repository_state", sourceLocation: "repository:git-status", scope: "repository", content: JSON.stringify({ isRepo: info.isRepo, branch: info.branch, dirtyCount: info.dirtyCount }), trust: "tool_output_unverified", retention: "capture_only", inclusionReason: "current workspace state snapshot", retrievalMethod: "git_status", freshness: "current", freshnessRule: "live git status at observedAt; invalidate after any workspace or repository mutation" }];
  });

  const caps = agent.getProviderCapabilities();
  const last = agent.getLastRequestCount();
  let contextLimit: number | undefined;
  try { contextLimit = agent.getContextBudget().contextLimit; } catch { gaps.push("context budget could not be read"); }
  const snapshot = buildContextInventory({
    sessionId: host.sessionId(), taskId: agent.getTaskId(), workspace: config.workspace,
    workspaceState: compareWorkspaceState(previousInventory, workspaceFingerprint),
    sources,
    coverageGaps: gaps,
    contextLimit,
    contextLimitSource: caps?.contextSource ?? (config.contextLimit ? "operator" : "client_default_or_unknown"),
    ...(last ? { lastRequestTokens: last.promptTokens, lastRequestTokenSource: last.source } : {}),
  });

  if (flags.includes("--record")) {
    if (!savedSession) return reply("context", "No saved session exists to attach this inventory to. Run /save first, then /context inspect --record.", false);
    sessionManager.saveSession({ ...savedSession, contextInventory: snapshot });
  }

  if (view === "inspect") {
    return flags.includes("--json")
      ? reply("context", JSON.stringify(snapshot, null, 2))
      : reply("context", `${renderContextInventoryText(snapshot)}${flags.includes("--record") ? "\n\nInventory recorded in the current session." : ""}`);
  }

  const assessment = assessContextMaturity(snapshot, {
    hasDurableKnowledge: Boolean(sources.find((source) => source.name === "project_knowledge")?.items.length),
    hasActiveSkills: Boolean(sources.find((source) => source.name === "skills")?.items.length),
  });
  return flags.includes("--json")
    ? reply("context", JSON.stringify(assessment, null, 2))
    : reply("context", renderContextMaturityText(assessment));
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
  context,
};
