import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import pc from "picocolors";
import { AutonomousAgent } from "./agent.js";
import { withDurableSync } from "./core/durable_file.js";
import { ApplicationCore } from "./core/app.js";
import { LocalLlmClient } from "./client.js";
import { HarnessConfig, ApprovalMode } from "./types.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";
import { isNexusDirPermissive } from "./doctor.js";
import { getGitInfo, scaffoldProjectRules, generateConventionalCommit, commitChanges } from "./git.js";
import { SessionManager, SessionData } from "./session.js";
import {
  appendProtectedHistoryLine,
  redactForPersistence,
  writeProtectedTextFile,
} from "./core/persistence_protection.js";
import { CheckpointManager } from "./checkpoint.js";
import { renderTokenGauge } from "./tokens.js";
import { scanAndOnboardWorkspace } from "./onboard.js";
import { PolicyContext } from "./core/approval_policy.js";
import { runTestSuiteWithExecutor, discoverVerifier, describeVerifier, verifierTimeoutSecs } from "./tester.js";
import { copyToClipboard, readFromClipboard } from "./clipboard.js";
import { encodeImageFile, formatVisionContent } from "./image.js";
import { ThemeManager } from "./theme.js";
import { TeamOrchestrator, AgentRole, TEAM_ROLES } from "./team.js";
import { TerminalDashboard } from "./tui.js";
import { HunkStager } from "./stager.js";
import { TurnResult, lifecycleStatusForTurn } from "./core/turn.js";
import { buildSessionExport } from "./session_export.js";
import { SensitivePersistenceError } from "./core/persistence_protection.js";

interface PatchHunk {
  header: string;
  lines: string[];
}

function parsePatchHunks(patch: string): { fileHeader: string; hunks: PatchHunk[] } {
  const lines = patch.split("\n");
  const fileHeaderLines: string[] = [];
  const hunks: PatchHunk[] = [];
  let currentHunk: PatchHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = { header: line, lines: [] };
    } else if (currentHunk) {
      currentHunk.lines.push(line);
    } else {
      fileHeaderLines.push(line);
    }
  }
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return { fileHeader: fileHeaderLines.join("\n"), hunks };
}

export const REPL_APPROVAL_GRACE_MS = 400;

export class InteractiveRepl {
  private app: ApplicationCore;
  private agent: AutonomousAgent;
  private config: HarnessConfig;
  private rl: readline.Interface | null = null;
  private knownModels: string[] = [];
  private approvalMode: ApprovalMode = "auto";
  private historyFile: string;
  private history: string[] = [];
  private sessionManager: SessionManager;
  private checkpointManager: CheckpointManager;
  private currentSessionId: string;
  private themeManager: ThemeManager = new ThemeManager();
  private exitResolve?: () => void;
  /** Cancels a running /team operation (Ctrl-C). */
  private teamAbort?: AbortController;

  constructor(appOrConfig: ApplicationCore | HarnessConfig, modeOrAutoApprove?: ApprovalMode | boolean, resumeSessionId?: string) {
    if ("getAgent" in appOrConfig && typeof (appOrConfig as any).getAgent === "function") {
      this.app = appOrConfig as ApplicationCore;
      this.config = this.app.getConfig();
      this.agent = this.app.getAgent();
      this.sessionManager = this.app.getSessionManager();
      this.checkpointManager = this.app.getCheckpointManager();
    } else {
      this.config = appOrConfig as HarnessConfig;
      this.app = new ApplicationCore(this.config);
      this.agent = this.app.getAgent();
      this.sessionManager = this.app.getSessionManager();
      this.checkpointManager = this.app.getCheckpointManager();
    }
    if (typeof modeOrAutoApprove === "string") {
      this.approvalMode = modeOrAutoApprove;
    } else if (typeof modeOrAutoApprove === "boolean") {
      this.approvalMode = modeOrAutoApprove ? "auto" : "review";
    } else {
      this.approvalMode = this.config.approvalMode || (isWorkspaceTrusted(this.config.workspace, Boolean(this.config.readOnly)) ? "auto" : "review");
    }
    this.config.surface = "repl";
    this.agent.setSurface("repl");
    this.agent.setApprovalMode(this.approvalMode);
    // Compaction archives the originals beside the current session before the session names it as committed.
    this.agent.setArchiveSink((compactionId, messages) => this.sessionManager.appendArchivedHistory(this.currentSessionId, messages, compactionId));
    this.historyFile = path.join(os.homedir(), ".nexus_history");
    this.loadHistory();

    if (resumeSessionId) {
      try {
        const sess = resumeSessionId === "latest"
          ? this.sessionManager.getLatestSession()
          : this.sessionManager.loadSession(resumeSessionId);
        if (sess) {
          this.currentSessionId = sess.id;
          if (sess.workspace && fs.existsSync(sess.workspace)) {
            this.config.workspace = sess.workspace;
            this.agent.setWorkspace(sess.workspace);
            this.checkpointManager = new CheckpointManager(sess.workspace);
          }
          const archiveNotice = this.agent.restoreConversation(sess, (committed) => this.sessionManager.readArchivedHistory(sess.id, committed));
          if (archiveNotice) console.log(pc.yellow(archiveNotice));
          console.log(pc.green(`✔ Restored previous session ${pc.bold(sess.id)} (${sess.messages.length} messages)`));
        } else {
          console.log(pc.red(`Session not found: ${resumeSessionId}\n`));
          this.currentSessionId = this.sessionManager.generateSessionId();
        }
      } catch (err: any) {
        console.log(pc.red(`Failed to restore session ${resumeSessionId}: ${err.message}\n`));
        this.currentSessionId = this.sessionManager.generateSessionId();
      }
    } else {
      this.currentSessionId = this.sessionManager.generateSessionId();
    }
  }

  public getApp(): ApplicationCore {
    return this.app;
  }

  public getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  public setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.agent.setApprovalMode(mode);
  }

  /** Runs one agent turn with the operator's stop authority wired to it, then records the structured result. */
  private async runInteractiveTurn(prompt: string | any[], titlePrompt?: string): Promise<TurnResult> {
    const label = titlePrompt ?? (typeof prompt === "string" ? prompt : "[multimodal]");
    let result: TurnResult;
    // Work done so far, and changes still awaiting verification, survive the process ending mid-turn.
    this.agent.setProgressListener(() => this.saveCurrentSession(label));
    try {
      result = await this.agent.runTurn(prompt, (tool, args) => this.confirmAction(tool, args));
    } finally {
      this.agent.setProgressListener(undefined);
      // Persist even if the turn threw, so the transcript of work done so far is not lost (synced: the turn ended).
      withDurableSync(() => this.saveCurrentSession(label, this.agent.getLastTurnResult()));
    }
    return result;
  }

  /** Ask before a turn when a rollback checkpoint would persist sensitive workspace content. */
  private async prepareTurnCheckpoint(name: string): Promise<boolean> {
    if (this.config.readOnly) {
      this.agent.setCheckpointReadOnlyFallback(false);
      return true;
    }

    try {
      this.checkpointManager.createCheckpoint(name);
      this.agent.setCheckpointReadOnlyFallback(false);
      return true;
    } catch (error) {
      if (!(error instanceof SensitivePersistenceError)) throw error;
    }

    console.log(pc.yellow("Sensitive content blocked the rollback checkpoint. Choose how to continue:"));
    console.log("  1. Continue this turn read-only; return to configured mode after a safe checkpoint");
    console.log("  2. Continue in the current mode without a rollback checkpoint");
    console.log("  3. Create the checkpoint anyway (may persist sensitive content)");
    console.log("  4. Cancel this turn");
    console.log("  5. Enter a different instruction");

    while (true) {
      const choice = (await this.rl!.question("Choice [1-5]: ")).trim();
      if (choice === "1") {
        this.agent.setCheckpointReadOnlyFallback(true);
        console.log(pc.yellow("Continuing this turn in read-only mode. Your configured mode resumes after a safe checkpoint succeeds.\n"));
        return true;
      }
      if (choice === "2") {
        console.log(pc.yellow("Continuing in the current mode without a rollback checkpoint.\n"));
        return true;
      }
      if (choice === "3") {
        this.checkpointManager.createCheckpoint(name, { allowSensitive: true });
        this.agent.setCheckpointReadOnlyFallback(false);
        console.log(pc.yellow("Creating a checkpoint that may persist sensitive workspace content, as requested.\n"));
        return true;
      }
      if (choice === "4") {
        console.log(pc.dim("Turn cancelled before it started.\n"));
        return false;
      }
      if (choice === "5") {
        console.log(pc.dim("Enter a different instruction at the next prompt. This turn was not started.\n"));
        return false;
      }
      console.log(pc.yellow("Enter a number from 1 to 5.\n"));
    }
  }

  private saveCurrentSession(titlePrompt?: string, turn?: TurnResult): void {
    const messages = this.agent.getMessages();
    if (messages.length <= 1) return;
    this.sessionManager.saveSession({
      id: this.currentSessionId,
      title: titlePrompt ? titlePrompt.slice(0, 60).replace(/\n/g, " ") : "Active Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspace: this.config.workspace,
      model: this.config.model,
      messages,
      unverifiedChangesPending: this.agent.hasUnverifiedChanges(),
      tokenStats: this.agent.getTokenStats(),
      activePlan: this.agent.getActivePlan(),
      objective: this.agent.getObjective() ?? null,
      findings: this.agent.getFindings(),
      history: this.agent.getHistoryCompleteness(),
      ...(turn ? { status: lifecycleStatusForTurn(turn), lastTurn: turn } : {}),
    }, this.agent.getWorkspacePathIdentity());
  }

  private loadHistory(): void {
    if (fs.existsSync(this.historyFile)) {
      let data: string;
      try {
        data = fs.readFileSync(this.historyFile, "utf-8");
      } catch {
        this.history = [];
        return;
      }
      try {
        const safeData = redactForPersistence(data);
        if (safeData !== data) writeProtectedTextFile(this.historyFile, safeData);
        this.history = safeData.split("\n").filter((l) => l.trim().length > 0);
      } catch {
        throw new Error("Failed to protect REPL history during recovery");
      }
    }
  }

  private appendHistory(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("/")) return;
    this.history.push(trimmed);
    try {
      appendProtectedHistoryLine(this.historyFile, trimmed);
    } catch {
      throw new Error("Failed to protect or persist REPL history");
    }
  }

  private getLastAssistantMessage(): string {
    const messages = this.agent.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i].content;
      if (messages[i].role === "assistant" && c) {
        return typeof c === "string" ? c : JSON.stringify(c);
      }
    }
    return "";
  }

  private printWelcome(): void {
    console.log(`\n${pc.bold(pc.black(pc.bgCyan(" NEXUS ")))} ${pc.dim("local engineering agent")}`);
    console.log(pc.dim("Describe the outcome you want. Nexus will show meaningful activity and keep full evidence in the session."));
    console.log(pc.dim("Type /help for commands · /tui for the session view\n"));
    if (isNexusDirPermissive()) {
      console.log(pc.yellow("your Nexus state is readable by other users; run `nexus doctor --fix`\n"));
    }
    this.printStatus();
  }

  private printStatus(verbose: boolean = false): void {
    const wsName = path.basename(this.config.workspace) || this.config.workspace;
    const gitInfo = getGitInfo(this.config.workspace);
    const gitBadge = gitInfo.isRepo
      ? pc.cyan(` [git: ${pc.bold(gitInfo.formattedBadge)}]`)
      : "";

    const trusted = isWorkspaceTrusted(this.config.workspace, Boolean(this.config.readOnly));
    const sandboxStatus = this.config.sandbox ? (typeof this.config.sandbox === "string" ? this.config.sandbox : "on") : "off";
    const trustStatus = trusted ? "trusted" : "untrusted (nexus trust .)";
    console.log(pc.dim(`mode: ${this.approvalMode} · sandbox: ${sandboxStatus} · workspace: ${trustStatus}`));

    console.log(`${pc.bold(pc.cyan("WORKSPACE"))}  ${pc.white(wsName)}${gitBadge}  ${pc.dim(this.config.workspace)}`);
    console.log(`${pc.bold(pc.cyan("MODEL"))}      ${pc.green(this.config.model)}  ${pc.dim(`· ${this.approvalMode === "auto" ? "autonomous" : this.approvalMode === "read-only" ? "read-only" : "review mode"}`)}`);
    if (verbose) console.log(`${pc.bold(pc.cyan("RUNTIME"))}   ${this.config.endpoint}  ·  ${this.config.shell}  ·  ${this.agent.getHistoryCount()} messages`);
    console.log(`${pc.dim(`session ${this.currentSessionId} · ${this.agent.getHistoryCount()} messages · ${this.config.shell}`)}\n`);
  }

  private printHelp(): void {
    console.log(pc.bold(pc.white("\nAvailable Slash Commands:")));
    console.log(`  ${pc.bold(pc.yellow("/help"))}               Show this commands cheatsheet`);
    console.log(`  ${pc.bold(pc.yellow("/status"))}             Show active model, workspace, endpoint, git badge`);
    console.log(`  ${pc.bold(pc.yellow("/doctor"))}             Diagnose this session's configuration and runtime (--deep, --fix [--yes])`);
    console.log(`  ${pc.bold(pc.yellow("/clear"))}              Reset conversation context memory`);
    console.log(`  ${pc.bold(pc.yellow("/compact"))}            Condense earlier messages to free token budget`);
    console.log(`  ${pc.bold(pc.yellow("/mode [auto|review]"))} Toggle autonomous execution vs human review approval`);
    console.log(`  ${pc.bold(pc.yellow("/diff"))}               Show colored git diff of uncommitted changes`);
    console.log(`  ${pc.bold(pc.yellow("/stage [reset]"))}       Inspect and stage individual diff hunks`);
    console.log(`  ${pc.bold(pc.yellow("/worktree [status|merge|discard]"))} Manage isolated ephemeral git worktrees`);
    console.log(`  ${pc.bold(pc.yellow("/tdd <issue>"))}         [experimental] Execute strict RED-GREEN-REFACTOR TDD cycle`);
    console.log(`  ${pc.bold(pc.yellow("/knowledge [set|del]"))} Manage persistent project knowledge graph`);
    console.log(`  ${pc.bold(pc.yellow("/browse <url>"))}        Verify URL in headless browser driver`);
    console.log(`  ${pc.bold(pc.yellow("/git"))}                Show current git status and modified files`);
    console.log(`  ${pc.bold(pc.yellow("/sessions"))}           List past saved sessions`);
    console.log(`  ${pc.bold(pc.yellow("/save [name]"))}        Save current session snapshot to ~/.nexus/sessions/`);
    console.log(`  ${pc.bold(pc.yellow("/resume [id]"))}        Load a past session into memory`);
    console.log(`  ${pc.bold(pc.yellow("/skills"))}             List discovered agent skills (SKILL.md)`);
    console.log(`  ${pc.bold(pc.yellow("/skill [init <name>|<name>]"))} View or scaffold specialized skill`);
    console.log(`  ${pc.bold(pc.yellow("/mcp [add|resources|prompts]"))} Manage MCP servers, tools, resources, and prompts`);
    console.log(`  ${pc.bold(pc.yellow("/plugins"))}            List loaded custom plugins and lifecycle hooks`);
    console.log(`  ${pc.bold(pc.yellow("/team <role|full> <task>"))} Multi-agent collaborative team orchestration`);
    console.log(`  ${pc.bold(pc.yellow("/image <path> [prompt]"))} Ingest multi-modal image into vision model`);
    console.log(`  ${pc.bold(pc.yellow("/theme [name]"))}       View or switch terminal color theme`);
    console.log(`  ${pc.bold(pc.yellow("/tui"))}                Launch full-screen interactive TUI dashboard`);
    console.log(`  ${pc.bold(pc.yellow("/checkpoint [name]"))}   Save rollback snapshot of current workspace`);
    console.log(`  ${pc.bold(pc.yellow("/checkpoint diff <id>"))} Inspect diff of a checkpoint vs current or another`);
    console.log(`  ${pc.bold(pc.yellow("/checkpoint prune [n]"))} Prune old checkpoints beyond retention limit`);
    console.log(`  ${pc.bold(pc.yellow("/checkpoints"))}         List all saved workspace snapshots`);
    console.log(`  ${pc.bold(pc.yellow("/undo"))}                Rollback workspace changes to last checkpoint`);
    console.log(`  ${pc.bold(pc.yellow("/audit [count]"))}       View recent tool execution history and metrics`);
    console.log(`  ${pc.bold(pc.yellow("/export [md|json]"))}    Export session transcript to file in workspace`);
    console.log(`  ${pc.bold(pc.yellow("/tokens"))}             Show context message count and token usage`);
    console.log(`  ${pc.bold(pc.yellow("/init"))}               Scaffold AGENTS.md rules file in workspace`);
    console.log(`  ${pc.bold(pc.yellow("/model [name]"))}       View or switch loaded model`);
    console.log(`  ${pc.bold(pc.yellow("/shell [bash|zsh]"))}   Switch Linux execution shell`);
    console.log(`  ${pc.bold(pc.yellow("/cd <path>"))}          Change active workspace directory`);
    console.log(`  ${pc.bold(pc.yellow("/history [query|!n]"))} Search history or re-execute item by index`);
    console.log(`  ${pc.bold(pc.yellow("/copy [diff|code|last]"))} Copy diff, code blocks, or response to clipboard`);
    console.log(`  ${pc.bold(pc.yellow("/paste"))}               Paste clipboard content into prompt`);
    console.log(`  ${pc.bold(pc.yellow("/commit [msg]"))}       Generate or execute conventional git commit\n`);
  }

  /** Asks the operator during a turn; returns null if the turn is cancelled while waiting (treated as denial). */
  private async askDuringTurn(question: string, options?: { graceMs?: number }): Promise<string | null> {
    const signal = this.agent.getActiveTurnSignal();
    if (signal?.aborted) return null;
    if (!this.rl) return null;

    // 1. Clear any typed-ahead line buffer before asking
    const hadTypedAhead = Boolean((this.rl as any).line && (this.rl as any).line.length > 0);
    try {
      this.rl.write("", { ctrl: true, name: "u" });
    } catch {}
    (this.rl as any).line = "";
    (this.rl as any).cursor = 0;
    if (hadTypedAhead) {
      console.log(pc.dim("  (typed-ahead input discarded)"));
    }

    const graceMs = options?.graceMs ?? 0;
    const out: NodeJS.WritableStream = (this.rl as any).output || process.stdout;
    if (graceMs > 0) {
      out.write(question);
      let discardedDuringGrace = false;
      const onData = () => {
        discardedDuringGrace = true;
      };

      const rawInput: NodeJS.ReadableStream = (this.rl as any).input || input;
      rawInput.on("data", onData);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          rawInput.removeListener("data", onData);
          resolve();
        }, graceMs);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            rawInput.removeListener("data", onData);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });

      if (signal?.aborted) return null;

      if (discardedDuringGrace || Boolean((this.rl as any).line && (this.rl as any).line.length > 0)) {
        try {
          this.rl.write("", { ctrl: true, name: "u" });
        } catch {}
        (this.rl as any).line = "";
        (this.rl as any).cursor = 0;
        console.log(pc.dim("\n  (keystrokes during grace window discarded)"));
        out.write(question);
      }

      try {
        return signal ? await this.rl.question("", { signal }) : await this.rl.question("");
      } catch (err: any) {
        if (signal?.aborted || err?.name === "AbortError") return null;
        throw err;
      }
    }

    try {
      return signal ? await this.rl.question(question, { signal }) : await this.rl.question(question);
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") return null;
      throw err;
    }
  }

  private async confirmAction(toolName: string, args: Record<string, any>): Promise<boolean> {
    if (this.approvalMode === "auto") return true;
    if (!this.rl) return true;

    console.log(pc.bold(pc.yellow(`\n⚠️  Action Approval Required:`)));

    // Hunk-by-hunk review for patch_file
    if (toolName === "patch_file" && typeof args.patch === "string") {
      const { fileHeader, hunks } = parsePatchHunks(args.patch);
      console.log(`  Target: ${pc.cyan(args.path)} (${hunks.length} hunks)`);

      if (hunks.length > 1) {
        const reviewMode = await this.askDuringTurn(
          pc.bold(pc.white(`  Review ${hunks.length} hunks individually? [y/N]: `)),
          { graceMs: REPL_APPROVAL_GRACE_MS }
        );
        if (reviewMode === null) return false;
        if (reviewMode.trim().toLowerCase() === "y" || reviewMode.trim().toLowerCase() === "yes") {
          const acceptedHunks: PatchHunk[] = [];
          for (let i = 0; i < hunks.length; i++) {
            const h = hunks[i];
            console.log(pc.cyan(`\n  --- Hunk ${i + 1}/${hunks.length}: ${h.header} ---`));
            for (const hl of h.lines) {
              if (hl.startsWith("+")) console.log(pc.green(`    ${hl}`));
              else if (hl.startsWith("-")) console.log(pc.red(`    ${hl}`));
              else console.log(pc.gray(`    ${hl}`));
            }
            const hunkAns = await this.askDuringTurn(
              pc.bold(pc.white(`  Accept hunk [y]es, [n]o, [a]ccept all remaining, [q]uit? [y/N/a/q]: `)),
              { graceMs: REPL_APPROVAL_GRACE_MS }
            );
            if (hunkAns === null) return false;
            const trimmedHunk = hunkAns.trim().toLowerCase();
            if (trimmedHunk === "q") {
              console.log(pc.dim("  Patch review aborted by user."));
              return false;
            }
            if (trimmedHunk === "a" || trimmedHunk === "all") {
              acceptedHunks.push(...hunks.slice(i));
              break;
            }
            if (trimmedHunk === "y" || trimmedHunk === "yes") {
              acceptedHunks.push(h);
            }
          }

          if (acceptedHunks.length === 0) {
            console.log(pc.yellow("  No hunks accepted. Skipping patch."));
            return false;
          }

          args.patch = (fileHeader ? fileHeader + "\n" : "") +
            acceptedHunks.map((h) => h.header + "\n" + h.lines.join("\n")).join("\n");
          console.log(pc.green(`  Approved ${acceptedHunks.length}/${hunks.length} hunks.`));
          return true;
        }
      }
    }

    if (toolName === "edit_file") {
      console.log(`  Target: ${pc.cyan(args.path)}`);
      console.log(pc.bold(pc.dim("  Snippet to replace:")));
      console.log(pc.red(`    ${args.old_content?.split("\n")[0] || ""}`));
      console.log(pc.bold(pc.dim("  Replacement:")));
      console.log(pc.green(`    ${args.new_content?.split("\n")[0] || ""}`));
    } else if (toolName === "write_file") {
      console.log(`  Action: Create/overwrite ${pc.cyan(args.path)} (${args.content?.length || 0} bytes)`);
    } else if (toolName === "delete_file") {
      console.log(`  Action: Delete ${pc.red(args.path)}`);
    } else if (toolName === "run_command") {
      console.log(`  Command: ${pc.bold(pc.magenta(args.command))}`);
    } else if (toolName === "verifier") {
      console.log(`  Verifier: ${pc.bold(pc.magenta(args.command))}${args.detail ? pc.dim(` (${args.detail})`) : ""}`);
      if (args.script && args.script !== args.command) {
        console.log(pc.bold(pc.dim("  Script:")));
        for (const line of args.script.split("\n").slice(0, 10)) {
          console.log(pc.dim(`    ${line}`));
        }
      }
    }

    while (true) {
      const answer = await this.askDuringTurn(
        pc.bold(pc.white(`  Approve [y]es, [n]o, [d]iff preview, [a]lways allow session? [y/N/d/a]: `)),
        { graceMs: REPL_APPROVAL_GRACE_MS }
      );

      if (answer === null) return false;
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "a" || trimmed === "always") {
        const confirmAll = await this.askDuringTurn(
          pc.bold(pc.yellow(`  Type 'all' to confirm auto-approving all actions for this session: `)),
          { graceMs: REPL_APPROVAL_GRACE_MS }
        );
        if (confirmAll?.trim().toLowerCase() === "all") {
          this.approvalMode = "auto";
          this.agent.setApprovalMode("auto");
          console.log(pc.green("  Switched to auto-approve for remainder of session.\n"));
          return true;
        } else {
          console.log(pc.dim("  Auto-approve cancelled.\n"));
          continue;
        }
      }
      if (trimmed === "d" || trimmed === "diff") {
        if (toolName === "edit_file") {
          console.log(pc.bold(pc.red("\n--- Snippet to Replace ---")));
          console.log(args.old_content);
          console.log(pc.bold(pc.green("+++ Replacement Content +++")));
          console.log(args.new_content);
          console.log();
        } else if (toolName === "write_file") {
          console.log(pc.bold(pc.cyan(`\n--- Preview: ${args.path} ---`)));
          const previewLines = (args.content || "").split("\n").slice(0, 30).join("\n");
          console.log(previewLines);
          console.log();
        } else if (toolName === "patch_file") {
          console.log(pc.bold(pc.cyan(`\n--- Patch Preview: ${args.path} ---`)));
          console.log(args.patch);
          console.log();
        } else if (toolName === "verifier" && args.script) {
          console.log(pc.bold(pc.cyan(`\n--- Verifier Script Preview: ${args.detail || args.command} ---`)));
          console.log(args.script);
          console.log();
        } else {
          console.log(pc.dim("  No detailed diff available for this action.\n"));
        }
        continue;
      }

      return trimmed === "y" || trimmed === "yes";
    }
  }

  async start(): Promise<void> {
    this.printWelcome();
    const startupWarning = await this.agent.probeStartupEndpoint();
    if (startupWarning) {
      console.log(pc.yellow(`⚠️  ${startupWarning}\n`));
    }

    this.rl = readline.createInterface({
      input,
      output,
      historySize: 200,
      prompt: "",
      completer: (line: string) => {
        const completions = [
          "/help", "/status", "/doctor", "/clear", "/reset", "/compact", "/mode",
          "/diff", "/git", "/commit", "/sessions", "/save", "/resume", "/skills",
          "/skill", "/mcp", "/plugins", "/plan", "/checkpoint",
          "/checkpoints", "/undo", "/audit", "/export", "/tokens", "/init",
          "/onboard", "/test",
          "/model", "/shell", "/cd", "/history", "/copy", "/paste",
          "/image", "/theme", "/team", "/upgrade",
          "/exit", "/quit"
        ];
        const trimmed = line.trim();
        const parts = line.split(/\s+/);
        const lastToken = parts[parts.length - 1] || "";

        // If line is starting a slash command:
        if (parts.length <= 1 && line.startsWith("/")) {
          const hits = completions.filter((c) => c.startsWith(trimmed));
          return [hits.length ? hits : completions, line] as [string[], string];
        }

        // If completing /model
        if (parts[0] === "/model") {
          const hits = this.knownModels.filter((m) => m.startsWith(lastToken));
          return [hits, lastToken] as [string[], string];
        }

        // If completing /skill
        if (parts[0] === "/skill") {
          const skills = this.agent.getSkillManager()?.listSkills().map((s) => s.name) || [];
          const hits = skills.filter((s) => s.startsWith(lastToken));
          return [hits, lastToken] as [string[], string];
        }

        // Context-aware file & directory path completion for /cd, /checkpoint diff, shell commands
        if (parts[0] === "/cd" || parts[0] === "!cat" || parts[0] === "!ls" || lastToken.includes("/")) {
          try {
            const searchDir = lastToken.includes("/")
              ? path.resolve(this.config.workspace, path.dirname(lastToken))
              : this.config.workspace;
            const filePrefix = lastToken.includes("/") ? path.basename(lastToken) : lastToken;
            const basePrefix = lastToken.includes("/") ? lastToken.slice(0, lastToken.lastIndexOf("/") + 1) : "";

            if (fs.existsSync(searchDir) && fs.statSync(searchDir).isDirectory()) {
              const entries = fs.readdirSync(searchDir, { withFileTypes: true });
              const matches: string[] = [];
              for (const entry of entries) {
                if (entry.name.startsWith(".") && !filePrefix.startsWith(".")) continue;
                if (entry.name.startsWith(filePrefix)) {
                  matches.push(basePrefix + entry.name + (entry.isDirectory() ? "/" : ""));
                }
              }
              if (matches.length > 0) {
                return [matches, lastToken] as [string[], string];
              }
            }
          } catch {
            // Ignore filesystem errors during completion
          }
        }

        return [[], lastToken] as [string[], string];
      },
    });

    // Ctrl-C is an operator authority event, not just a keystroke. While a turn is active it requests
    // cancellation (no new inference or tool dispatch is admitted); a second press terminates the process.
    // While idle it keeps its deliberate-exit meaning.
    this.rl.on("SIGINT", () => {
      if (this.teamAbort && !this.teamAbort.signal.aborted) {
        this.teamAbort.abort();
        console.log(pc.yellow("\n⏹  Stop requested: the team operation is cancelled after its current step; its state is preserved."));
        return;
      }
      if (this.agent.getTurnLifecycle()) {
        if (this.agent.requestCancel("operator Ctrl-C")) {
          const life = this.agent.getTurnLifecycle();
          const waiting = life?.phase === "tool" && life.currentTool ? ` Waiting for in-flight ${life.currentTool} to settle.` : "";
          console.log(pc.yellow(`\n⏹  Stop requested: no new work will be started.${waiting} (Ctrl-C again to terminate immediately)`));
        } else {
          console.log(pc.red("\nTerminating immediately."));
          this.agent.shutdown();
          process.exit(130);
        }
      } else {
        console.log(pc.dim("\nSession ended. Goodbye!"));
        this.exitResolve?.();
        this.rl?.close();
      }
    });

    // Populate /model completion from the endpoint's real model list (best effort, never blocks the prompt).
    new LocalLlmClient(this.config).listModels().then((models) => { this.knownModels = models; }).catch(() => {});

    this.agent.getSkillManager().startWatcher((skills) => {
      console.log(pc.dim(`\n🔄 [Hot-Reload] Skills library updated (${skills.length} available).`));
    });

    const exitRequested = new Promise<void>((resolve) => { this.exitResolve = resolve; });

    // readline emits `line` only for input that no pending `question()` consumed: pasted/piped lines that arrive in the same
    // chunk as a prompt, or typed while a turn is running. This REPL reads one line at a time, so those lines cannot become
    // prompts; they are counted so the loss is reported instead of silent.
    const ignoredLines: string[] = [];
    this.rl.on("line", (l: string) => { ignoredLines.push(l); });
    const reportIgnoredLines = () => {
      const lines = ignoredLines.splice(0);
      if (lines.length === 0) return;
      const n = lines.length;
      const first = lines.find((l) => l.trim()) ?? "";
      console.error(pc.yellow(
        `⚠ ${n} line${n === 1 ? "" : "s"} arrived while no prompt was waiting and ${n === 1 ? "was" : "were"} ignored` +
        `${first ? ` (first: "${first.slice(0, 60)}${first.length > 60 ? "…" : ""}")` : ""}. ` +
        `This REPL reads one line at a time: wrap multi-line input in """ … """, or use the default TUI (\`harness\`).`,
      ));
    };

    const promptLoop = async () => {
      while (true) {
        reportIgnoredLines();
        const wsName = path.basename(this.config.workspace) || this.config.workspace;
        const gitInfo = getGitInfo(this.config.workspace);
        const gitSegment = gitInfo.isRepo ? pc.gray(`:${pc.cyan(gitInfo.formattedBadge)}`) : "";
        const promptString = `${pc.bold(pc.cyan("nexus"))} ${pc.yellow(wsName)}${gitSegment} ${pc.bold(pc.cyan("❯"))} `;

        let line: string;
        try {
          // Raced with the deliberate-exit signal: closing readline does not reliably settle a pending question.
          line = await Promise.race([
            this.rl!.question(promptString),
            exitRequested.then((): string => { throw new Error("exit requested"); }),
          ]);
        } catch {
          break;
        }
        // Same-chunk lines were emitted before this continuation ran; yield once more for lines split across chunks.
        await new Promise<void>((resolve) => setImmediate(resolve));
        reportIgnoredLines();

        let fullInput = line;

        // Support multiline blocks: """ or ```
        if (line.trim().startsWith('"""') || line.trim().startsWith("```")) {
          const delimiter = line.trim().startsWith('"""') ? '"""' : "```";
          const firstLineTrimmed = line.trim();
          if (firstLineTrimmed.length === 3 || !firstLineTrimmed.slice(3).includes(delimiter)) {
            while (true) {
              const nextLine = await this.rl!.question(pc.dim("... "));
              fullInput += "\n" + nextLine;
              if (nextLine.trim().endsWith(delimiter)) {
                break;
              }
            }
          }
        } else {
          // Support trailing backslash continuation
          while (fullInput.endsWith("\\")) {
            fullInput = fullInput.slice(0, -1);
            const nextLine = await this.rl!.question(pc.dim("... "));
            fullInput += "\n" + nextLine;
          }
        }

        fullInput = fullInput.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
        let trimmed = fullInput.trim();
        if (!trimmed) continue;

        // History recall shortcut: !<number>
        if (/^\!\d+$/.test(trimmed)) {
          const idx = parseInt(trimmed.slice(1), 10) - 1;
          if (idx >= 0 && idx < this.history.length) {
            const recalled = this.history[idx];
            console.log(pc.cyan(`⚡ Recalled from history [#${idx + 1}]: ${pc.bold(recalled)}`));
            line = recalled;
            trimmed = recalled;
          } else {
            console.log(pc.red(`History index out of range: ${trimmed}. Type /history to view items.\n`));
            continue;
          }
        } else if (trimmed.startsWith("!")) {
          // Explicit Operator Direct Shell Domain (ACT-004, AUTH-001, F-05)
          const shellCmd = trimmed.slice(1).trim();
          if (shellCmd) {
            console.log(pc.dim(`🐚 [Direct Shell] ${shellCmd}`));
            const receipt = await this.app.executeOperatorCommand(shellCmd);

            if (receipt.output) {
              process.stdout.write(receipt.output);
            }
            if (receipt.error) {
              console.log(pc.red(receipt.error));
            }
            if (!receipt.success && receipt.status === "DENIED") {
              console.log(pc.yellow(`Execution denied by authority admission gate.`));
            }
            console.log();
          }
          continue;
        }

        // Slash command handler
        if (trimmed.startsWith("/")) {
          const parts = trimmed.slice(1).split(/\s+/);
          const cmd = parts[0].toLowerCase();
          const arg = parts.slice(1).join(" ");

          if (cmd === "exit" || cmd === "quit" || cmd === "q") {
            console.log(pc.dim("\nSession ended. Goodbye!"));
            break;
          } else if (cmd === "help" || cmd === "?") {
            this.printHelp();
            continue;
          } else if (cmd === "clear" || cmd === "reset") {
            this.agent.resetConversation();
            console.log(pc.green("✔ Conversation context reset.\n"));
            continue;
          } else if (cmd === "compact") {
            // The session record is part of the commit: the archive, the task state and this session.
            this.agent.setProgressListener(() => this.saveCurrentSession());
            try {
              const result = await this.agent.compactNow(arg.includes("--llm"));
              console.log(result.ok ? pc.green(`✔ ${result.message}\n`) : pc.red(`✖ ${result.message}\n`));
            } finally {
              this.agent.setProgressListener(undefined);
            }
            continue;
          } else if (cmd === "doctor") {
            const { runDoctor, runRepairs, renderDoctorText } = await import("./doctor.js");
            const flags = arg.split(/\s+/).filter(Boolean);
            const base = { context: "session" as const, config: this.config, flags: {}, deep: flags.includes("--deep") };
            let report = await runDoctor(base);
            if (flags.includes("--fix")) {
              report = await runRepairs(report, {
                ...base,
                readOnly: Boolean(this.config.readOnly),
                confirm: async (proposals) => flags.includes("--yes") || /^y(es)?$/i.test((await this.rl!.question(`Apply ${proposals.length} repair(s)?\n${proposals.map((p) => `  - ${p.description}`).join("\n")}\n[y/N] `)).trim()),
              });
            }
            console.log(renderDoctorText(report) + "\n");
            continue;
          } else if (cmd === "upgrade") {
            const { detectInstallation, resolveTargetRelease, compareInstallationWithRelease, performUpgrade } = await import("./upgrade.js");
            const tokens = arg.split(/\s+/).filter(Boolean);
            let isCheck = false;
            let isForce = false;
            let isYes = false;
            let allowDowngrade = false;
            let pinnedVersion: string | undefined;

            for (let i = 0; i < tokens.length; i++) {
              const t = tokens[i];
              if (t === "--check") isCheck = true;
              else if (t === "--force" || t === "-f") isForce = true;
              else if (t === "--yes" || t === "-y") isYes = true;
              else if (t === "--allow-downgrade") allowDowngrade = true;
              else if (t === "--version" || t === "-v") {
                pinnedVersion = tokens[++i];
              } else if (!t.startsWith("-") && !pinnedVersion) {
                pinnedVersion = t;
              }
            }

            const installed = detectInstallation();
            let targetRelease;
            try {
              targetRelease = await resolveTargetRelease(pinnedVersion);
            } catch (err: any) {
              console.log(pc.red(`Failed to resolve release: ${err.message || String(err)}\n`));
              continue;
            }

            const comparison = compareInstallationWithRelease(installed, targetRelease, { force: isForce });

            if (isCheck) {
              console.log(`Installed version:  ${installed.version} (${installed.provenance})`);
              console.log(`Target release:     ${targetRelease.tag_name}${targetRelease.prerelease ? " (prerelease)" : " (stable)"}${targetRelease.published_at ? ` [published ${targetRelease.published_at}]` : ""}`);
              if (installed.prefix) console.log(`Install prefix:     ${installed.prefix}`);
              if (comparison.reasons.length > 0) {
                for (const r of comparison.reasons) console.log(`Note:               ${r}`);
              }
              if (comparison.action === "upgrade") {
                console.log(pc.green(`\nUpdate available: ${installed.version} -> ${comparison.targetVersion}. Run /upgrade to install.\n`));
              } else if (comparison.action === "downgrade") {
                console.log(pc.yellow(`\nTarget ${comparison.targetVersion} is older than current ${installed.version}. Run /upgrade --version ${comparison.targetVersion} --allow-downgrade to downgrade.\n`));
              } else {
                console.log(pc.green(`\nNexus is already up to date (${installed.version}).\n`));
              }
              continue;
            }

            if (!comparison.canUpgrade) {
              console.log(pc.red(`Cannot upgrade: ${comparison.reasons.join("\n")}\n`));
              continue;
            }

            if (comparison.action === "none" && !isForce) {
              console.log(pc.green(`Nexus is already up to date (${installed.version}). Use /upgrade --force to reinstall.\n`));
              continue;
            }

            if (comparison.action === "downgrade" && !allowDowngrade && !isYes) {
              console.log(pc.yellow(`Target version ${comparison.targetVersion} is a downgrade from ${installed.version}. Specify --allow-downgrade to proceed.\n`));
              continue;
            }

            if (!isYes) {
              const answer = await this.askDuringTurn(
                pc.bold(pc.white(`Proceed with ${comparison.action} from ${installed.version} to ${comparison.targetVersion}? [y/N]: `))
              );
              if (!answer || (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes")) {
                console.log(pc.dim("Upgrade cancelled.\n"));
                continue;
              }
            }

            try {
              console.log(pc.dim(`Starting ${comparison.action}...`));
              const result = await performUpgrade(comparison, { force: isForce, allowDowngrade });
              console.log(pc.green(`✔ Nexus successfully upgraded to ${result.newVersion}.`));
              console.log(`Destination: ${result.installedPath}`);
              console.log(`Launcher:    ${result.binPath}`);
              console.log(pc.yellow(`\nNotice: ${result.restartNotice}\n`));
            } catch (err: any) {
              console.log(pc.red(`Upgrade failed: ${err.message || String(err)}\n`));
            }
            continue;
          } else if (cmd === "status") {
            this.printStatus(true);
            continue;
          } else if (cmd === "mode") {
            if (arg === "auto" || arg === "autonomous") {
              this.approvalMode = "auto";
              this.agent.setApprovalMode("auto");
              console.log(pc.green("✔ Mode switched to: auto (autonomous tool execution)\n"));
            } else if (arg === "review" || arg === "ask") {
              this.approvalMode = "review";
              this.agent.setApprovalMode("review");
              console.log(pc.yellow("✔ Mode switched to: review (requires user confirmation before changes)\n"));
            } else if (arg === "read-only" || arg === "readonly") {
              this.approvalMode = "read-only";
              this.agent.setApprovalMode("read-only");
              console.log(pc.yellow("✔ Mode switched to: read-only (rejects mutating tool executions)\n"));
            } else {
              console.log(`Current mode: ${this.approvalMode === "auto" ? pc.green("auto") : pc.yellow(this.approvalMode)}. Use: /mode auto, /mode review, or /mode read-only\n`);
            }
            continue;
          } else if (cmd === "diff") {
            const git = getGitInfo(this.config.workspace);
            if (!git.isRepo) {
              console.log(pc.yellow("Current workspace is not inside a git repository.\n"));
              continue;
            }
            try {
              const diffOut = execSync("git diff", {
                cwd: this.config.workspace,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
              });
              if (!diffOut.trim()) {
                console.log(pc.green("✔ Working tree clean (no uncommitted diffs).\n"));
              } else {
                console.log(pc.bold(pc.white("\nGit Working Tree Diff:")));
                for (const line of diffOut.split("\n")) {
                  if (line.startsWith("+") && !line.startsWith("+++")) {
                    console.log(pc.green(line));
                  } else if (line.startsWith("-") && !line.startsWith("---")) {
                    console.log(pc.red(line));
                  } else if (line.startsWith("@@")) {
                    console.log(pc.cyan(line));
                  } else {
                    console.log(line);
                  }
                }
                console.log();
              }
            } catch (err: any) {
              console.log(pc.red(`Git diff error: ${err.message}\n`));
            }
            continue;
          } else if (cmd === "stage") {
            const stager = new HunkStager(this.config.workspace);
            if (arg === "reset") {
              stager.unstage();
              console.log(pc.green("✔ Unstaged all changes.\n"));
            } else {
              const summary = stager.getStatusSummary();
              if (summary.files.length === 0) {
                console.log(pc.green("✔ No unstaged diff hunks in working directory.\n"));
              } else {
                console.log(pc.bold(pc.cyan(`\n=== Granular Hunk Stager (${summary.files.length} modified files, ${summary.unstagedHunkCount} hunks) ===\n`)));
                for (const f of summary.files) {
                  console.log(pc.bold(pc.white(`📄 ${f.newPath} (${f.hunks.length} hunks)`)));
                  f.hunks.forEach((h, idx) => {
                    console.log(`  [Hunk ${idx + 1}] ${pc.dim(h.header)}`);
                    for (const l of h.lines.slice(0, 5)) {
                      if (l.startsWith("+")) console.log(`    ${pc.green(l)}`);
                      else if (l.startsWith("-")) console.log(`    ${pc.red(l)}`);
                      else console.log(`    ${pc.dim(l)}`);
                    }
                    if (h.lines.length > 5) console.log(pc.dim(`    ... [${h.lines.length - 5} more lines]`));
                  });
                  console.log();
                }
                console.log(pc.dim("Use '/stage reset' to unstage, or '/commit' to create a commit.\n"));
              }
            }
            continue;
          } else if (cmd === "worktree") {
            const mgr = this.agent.getWorktreeManager();
            const active = this.agent.getActiveWorktree();
            if (arg === "merge") {
              if (!active) {
                console.log(pc.yellow("No active speculative worktree to merge.\n"));
              } else {
                const res = this.agent.mergeActiveWorktree();
                if (res.success) {
                  console.log(pc.green(`✔ Merged ${res.commitsMerged} speculative commit(s) from branch ${res.branch}.\n`));
                } else {
                  console.log(pc.red(`Failed to merge worktree: ${res.error}\n`));
                }
              }
            } else if (arg === "discard") {
              if (!active) {
                console.log(pc.yellow("No active speculative worktree to discard.\n"));
              } else {
                const res = this.agent.discardActiveWorktree();
                if (res.success) {
                  console.log(pc.green("✔ Discarded active speculative worktree.\n"));
                } else {
                  console.log(pc.red(`Failed to discard worktree: ${res.error}\n`));
                }
              }
            } else {
              const list = mgr.listWorktrees();
              console.log(pc.bold(pc.cyan(`\n=== Speculative Git Worktrees (${list.length}) ===\n`)));
              if (active) {
                console.log(pc.green(`* Active Worktree: ${active.branch} at ${active.worktreePath}\n`));
              }
              for (const wt of list) {
                console.log(`• Task: ${pc.bold(wt.taskId)} (branch: ${pc.cyan(wt.branch)}) at ${pc.dim(wt.path)}`);
              }
              if (list.length === 0 && !active) {
                console.log(pc.dim("No active speculative worktrees. Launch with --worktree to isolate.\n"));
              }
              console.log();
            }
            continue;
          } else if (cmd === "tdd") {
            if (!arg.trim()) {
              console.log(pc.yellow("Please provide an issue description: /tdd <issue description or reproduction target>\n"));
              continue;
            }
            console.log(pc.bold(pc.cyan(`\n🧪 Launching Autonomous TDD Session: ${arg}`)));
            const synth = this.agent.getSynthesizer();
            const res = await synth.runAutonomousTdd(this.agent, arg);
            if (res.success) {
              console.log(pc.bold(pc.green(`\n✔ TDD Cycle Completed Successfully! (RED -> GREEN -> REFACTOR)`)));
            } else {
              console.log(pc.bold(pc.yellow(`\n⚠️ TDD Cycle Ended at Phase: ${res.finalPhase} - ${res.summary}`)));
            }
            console.log();
            continue;
          } else if (cmd === "knowledge") {
            const kg = this.agent.getKnowledgeGraph();
            const subparts = arg.split(/\s+/).filter(Boolean);
            const subact = subparts[0]?.toLowerCase() || "list";
            if (subact === "set" && subparts[1]) {
              const k = subparts[1];
              const v = subparts.slice(2).join(" ");
              const entry = kg.set(k, v, "rule");
              console.log(pc.green(`✔ Saved knowledge: [${entry.category}] ${entry.key}\n`));
            } else if (subact === "delete" && subparts[1]) {
              const deleted = kg.delete(subparts[1]);
              console.log(deleted ? pc.green(`✔ Deleted: ${subparts[1]}\n`) : pc.yellow(`Not found: ${subparts[1]}\n`));
            } else {
              const list = kg.list();
              if (list.length === 0) {
                console.log(pc.dim("No persistent knowledge entries found. Use: /knowledge set <key> <rule>\n"));
              } else {
                console.log(pc.bold(pc.cyan(`\n=== Persistent Knowledge Graph (${list.length} entries) ===\n`)));
                for (const e of list) {
                  console.log(`• [${pc.cyan(e.category)}] ${pc.bold(e.key)}: ${pc.white(e.value)}`);
                }
                console.log();
              }
            }
            continue;
          } else if (cmd === "browse") {
            if (!arg.trim()) {
              console.log(pc.yellow("Please provide a target URL: /browse <url>\n"));
              continue;
            }
            const driver = this.agent.getBrowserDriver();
            console.log(pc.bold(pc.cyan(`\n🌐 Navigating headless browser to: ${arg}`)));
            const res = await driver.navigate(arg.trim());
            console.log(`Title: ${pc.bold(res.title)} | Status: ${res.status === 200 ? pc.green(res.status) : pc.yellow(res.status)}`);
            console.log(`Snippet:\n${pc.dim(res.contentSnippet.slice(0, 300))}...\n`);
            continue;
          } else if (cmd === "sessions") {
            const list = this.sessionManager.listSessions();
            if (list.length === 0) {
              console.log(pc.dim("No saved sessions found in ~/.nexus/sessions/\n"));
            } else {
              console.log(pc.bold(pc.white("\nSaved Sessions:")));
              for (const s of list.slice(0, 10)) {
                const isCurrent = s.id === this.currentSessionId;
                const marker = isCurrent ? pc.bold(pc.green("* ")) : "  ";
                console.log(`${marker}${pc.bold(pc.cyan(s.id))} (${pc.gray(s.updatedAt.slice(0, 19))})`);
                console.log(`    Title: ${pc.yellow(s.title)} | Workspace: ${pc.dim(s.workspace)} | Messages: ${s.messageCount}`);
              }
              console.log(pc.dim("\nUse '/resume <id>' to load a session into memory.\n"));
            }
            continue;
          } else if (cmd === "save") {
            if (arg) {
              this.currentSessionId = arg;
            }
            this.saveCurrentSession("Snapshot");
            console.log(pc.green(`✔ Session saved to ~/.nexus/sessions/${this.currentSessionId}.json\n`));
            continue;
          } else if (cmd === "resume") {
            try {
              const sess = arg ? this.sessionManager.loadSession(arg) : this.sessionManager.getLatestSession();
              if (!sess) {
                console.log(pc.red(`Session not found: ${arg || "latest"}\n`));
              } else {
                this.currentSessionId = sess.id;
                if (sess.workspace && fs.existsSync(sess.workspace)) {
                  this.config.workspace = sess.workspace;
                  this.agent.setWorkspace(sess.workspace);
                }
                const archiveNotice = this.agent.restoreConversation(sess, (committed) => this.sessionManager.readArchivedHistory(sess.id, committed));
                if (archiveNotice) console.log(pc.yellow(archiveNotice));
                console.log(pc.green(`✔ Resumed session ${pc.bold(sess.id)} (${sess.messages.length} messages loaded).\n`));
              }
            } catch (err: any) {
              console.log(pc.red(`Failed to resume session: ${err.message}\n`));
            }
            continue;
          } else if (cmd === "tokens" || cmd === "cost") {
            const budget = this.agent.getContextBudget();
            console.log(renderTokenGauge(budget));
            const cumulative = this.agent.getTokenStats();
            if (cumulative.total > 0) {
              console.log(
                pc.dim(
                  `  • Cumulative Session Usage: ${cumulative.prompt.toLocaleString()} prompt, ${cumulative.completion.toLocaleString()} completion (${cumulative.total.toLocaleString()} total tokens)\n`
                )
              );
            } else {
              console.log();
            }
            continue;
          } else if (cmd === "git") {
            const git = getGitInfo(this.config.workspace);
            if (!git.isRepo) {
              console.log(pc.yellow("Current workspace is not inside a git repository.\n"));
              continue;
            }
            try {
              const status = execSync("git status --short", {
                cwd: this.config.workspace,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
              }).trim();
              console.log(pc.bold(pc.white("\nGit Status:")));
              console.log(status ? status : pc.green("Working tree clean"));
            } catch (err: any) {
              console.log(pc.red(`Git status error: ${err.message}`));
            }
            console.log();
            continue;
          } else if (cmd === "commit") {
            const git = getGitInfo(this.config.workspace);
            if (!git.isRepo) {
              console.log(pc.yellow("Current workspace is not inside a git repository.\n"));
              continue;
            }
            if (git.dirtyCount === 0) {
              console.log(pc.green("Working tree clean — nothing to commit.\n"));
              continue;
            }

            let commitMsg = arg ? arg.trim() : "";
            if (!commitMsg) {
              const suggestion = generateConventionalCommit(this.config.workspace);
              console.log(pc.bold(pc.white("\nConventional Commit Generator:")));
              console.log(`  Modified files: ${pc.cyan(suggestion.files.length)} files`);
              console.log(`  Suggested message: ${pc.bold(pc.green(suggestion.message))}`);

              const answer = await this.rl!.question(
                pc.bold(pc.white(`  Accept [y], edit custom message [e], cancel [n]? [Y/e/n]: `))
              );
              const trimmedAns = answer.trim().toLowerCase();
              if (trimmedAns === "n" || trimmedAns === "no") {
                console.log(pc.dim("Commit cancelled.\n"));
                continue;
              } else if (trimmedAns === "e" || trimmedAns === "edit") {
                const custom = await this.rl!.question(pc.bold(pc.white("  Enter commit message: ")));
                commitMsg = custom.trim();
                if (!commitMsg) {
                  console.log(pc.dim("Empty message, commit cancelled.\n"));
                  continue;
                }
              } else {
                commitMsg = suggestion.message;
              }
            }

            const commitRes = commitChanges(this.config.workspace, commitMsg);
            if (commitRes.success) {
              console.log(pc.green(`✔ Committed changes: ${pc.bold(commitRes.hash || "")} - ${commitMsg}\n`));
            } else {
              console.log(pc.red(`Commit failed: ${commitRes.error}\n`));
            }
            continue;
          } else if (cmd === "init") {
            const file = scaffoldProjectRules(this.config.workspace);
            console.log(pc.green(`✔ Project instructions file ready at: ${file}\n`));
            continue;
          } else if (cmd === "skills") {
            const skills = this.agent.getSkillManager().listSkills();
            if (skills.length === 0) {
              console.log(pc.yellow("No skills found. Place skills in ~/.nexus/skills/<name>/SKILL.md or .nexus/skills/\n"));
            } else {
              console.log(pc.bold(pc.white("\nInstalled Agent Skills:")));
              for (const s of skills) {
                console.log(`  • ${pc.bold(pc.cyan(s.name))} (${pc.dim(s.path)})`);
                console.log(`    ${pc.gray(s.description)}`);
              }
              console.log(pc.dim("\nUse '/skill <name>' to view skill instructions.\n"));
            }
            continue;
          } else if (cmd === "skill") {
            if (!arg) {
              console.log("Usage: /skill <skill_name> or /skill init <skill_name>\n");
              continue;
            }
            if (arg.startsWith("init ")) {
              const skillName = arg.slice(5).trim();
              if (!skillName) {
                console.log(pc.yellow("Usage: /skill init <skill_name>\n"));
              } else {
                const res = this.agent.getSkillManager().scaffoldSkill(skillName);
                console.log(pc.green(`✔ Scaffolded new skill template at: ${pc.bold(res.skillPath)}\n`));
              }
              continue;
            }
            const skill = this.agent.getSkillManager().getSkill(arg);
            if (!skill) {
              console.log(pc.red(`Skill '${arg}' not found. Type /skills for available skills.\n`));
            } else {
              console.log(pc.bold(pc.cyan(`\n=== Skill: ${skill.name} ===`)));
              console.log(pc.dim(`Path: ${skill.path}\n`));
              console.log(skill.content);
              console.log(pc.bold(pc.cyan("===========================\n")));
            }
            continue;
          } else if (cmd === "mcp") {
            await this.agent.initExtensibility();
            const mcp = this.agent.getMcpManager();
            const subArgs = arg.trim().split(/\s+/).filter(Boolean);
            const subCmd = subArgs[0]?.toLowerCase();

            if (subCmd === "add") {
              console.log(pc.bold(pc.white("\n=== MCP Server Configuration Wizard ===")));
              const name = (await this.rl!.question(pc.bold(pc.white("  Server Identifier (e.g. sqlite-db, github): ")))).trim();
              if (!name) {
                console.log(pc.dim("Empty server name. Wizard cancelled.\n"));
                continue;
              }

              const transportInput = (await this.rl!.question(pc.bold(pc.white("  Transport [stdio/sse/websocket] (default: stdio): ")))).trim().toLowerCase();
              const transport = transportInput === "sse" || transportInput === "websocket" ? transportInput : "stdio";

              let config: any = { transport };
              if (transport === "stdio") {
                const command = (await this.rl!.question(pc.bold(pc.white("  Executable command (e.g. npx -y @modelcontextprotocol/server-sqlite): ")))).trim();
                if (!command) {
                  console.log(pc.dim("Empty command. Wizard cancelled.\n"));
                  continue;
                }
                const parts = command.split(/\s+/);
                config.command = parts[0];
                config.args = parts.slice(1);
              } else {
                const url = (await this.rl!.question(pc.bold(pc.white("  Endpoint URL (e.g. http://localhost:8000/sse): ")))).trim();
                if (!url) {
                  console.log(pc.dim("Empty URL. Wizard cancelled.\n"));
                  continue;
                }
                config.url = url;
              }

              console.log(pc.dim(`  Connecting to MCP server '${name}'...`));
              const res = await mcp.addServer(name, config, true);
              if (res.success) {
                console.log(pc.green(`✔ Connected to MCP server '${name}'!`));
                console.log(`  • Exposed Tools: ${pc.cyan(res.toolCount)}`);
                console.log(`  • Exposed Resources: ${pc.cyan(res.resourceCount)}`);
                console.log(`  • Exposed Prompts: ${pc.cyan(res.promptCount)}`);
                console.log(`  • Configuration saved to ~/.config/nexus/mcp.json\n`);
              } else {
                console.log(pc.red(`✖ MCP connection failed: ${res.error}\n`));
              }
            } else if (subCmd === "resources") {
              const resources = mcp.listResources();
              if (resources.length === 0) {
                console.log(pc.yellow("No MCP resources exposed by connected servers.\n"));
              } else {
                console.log(pc.bold(pc.white("\nExposed MCP Resources:")));
                for (const r of resources) {
                  console.log(`  • ${pc.bold(pc.cyan(r.name))} (${pc.dim(r.uri)}) [${pc.gray(r.server)}]`);
                  if (r.description) console.log(`    ${pc.gray(r.description)}`);
                }
                console.log(pc.dim("\nUse '/mcp resource <uri>' to inspect content.\n"));
              }
            } else if (subCmd === "resource") {
              const uri = subArgs.slice(1).join(" ").trim();
              if (!uri) {
                console.log(pc.yellow("Usage: /mcp resource <uri>\n"));
              } else {
                const res = await mcp.readResource(uri);
                if (res.success) {
                  console.log(pc.bold(pc.cyan(`\n=== MCP Resource: ${uri} ===`)));
                  console.log(res.content || "");
                  console.log(pc.bold(pc.cyan("================================\n")));
                } else {
                  console.log(pc.red(`Error reading resource: ${res.error}\n`));
                }
              }
            } else if (subCmd === "prompts") {
              const prompts = mcp.listPrompts();
              if (prompts.length === 0) {
                console.log(pc.yellow("No MCP prompt templates exposed by connected servers.\n"));
              } else {
                console.log(pc.bold(pc.white("\nExposed MCP Prompt Templates:")));
                for (const p of prompts) {
                  const argsDesc = p.arguments && p.arguments.length > 0
                    ? ` (args: ${p.arguments.map((a: any) => a.name).join(", ")})`
                    : "";
                  console.log(`  • ${pc.bold(pc.yellow(p.name))}${pc.dim(argsDesc)} [${pc.gray(p.server)}]`);
                  if (p.description) console.log(`    ${pc.gray(p.description)}`);
                }
                console.log(pc.dim("\nUse '/mcp prompt <name>' to inspect prompt template.\n"));
              }
            } else if (subCmd === "prompt") {
              const name = subArgs[1];
              if (!name) {
                console.log(pc.yellow("Usage: /mcp prompt <name>\n"));
              } else {
                const res = await mcp.getPrompt(name);
                if (res.success) {
                  console.log(pc.bold(pc.yellow(`\n=== MCP Prompt: ${name} ===`)));
                  if (res.description) console.log(pc.dim(res.description) + "\n");
                  console.log(JSON.stringify(res.messages, null, 2));
                  console.log(pc.bold(pc.yellow("==========================\n")));
                } else {
                  console.log(pc.red(`Error fetching prompt: ${res.error}\n`));
                }
              }
            } else {
              const servers = mcp.listServers();
              const tools = mcp.getToolDefinitions();
              if (servers.length === 0) {
                console.log(pc.yellow("No MCP servers configured. Use '/mcp add' to configure a server.\n"));
              } else {
                console.log(pc.bold(pc.white("\nConfigured MCP Servers:")));
                for (const s of servers) {
                  const status = s.connected ? pc.green("CONNECTED") : pc.red("DISCONNECTED");
                  console.log(`  • ${pc.bold(pc.cyan(s.name))} [${status} - ${pc.dim(s.transport)}] (${pc.dim(s.command)})`);
                  console.log(`    Tools: ${pc.yellow(s.toolCount)} | Resources: ${pc.cyan(s.resourceCount)} | Prompts: ${pc.magenta(s.promptCount)}`);
                }
                if (tools.length > 0) {
                  console.log(pc.bold(pc.white("\nAvailable MCP Tools:")));
                  for (const t of tools) {
                    console.log(`  ⚡ ${pc.yellow(t.function.name)}: ${pc.gray(t.function.description)}`);
                  }
                }
                console.log(pc.dim("\nCommands: /mcp add, /mcp resources, /mcp resource <uri>, /mcp prompts, /mcp prompt <name>\n"));
              }
            }
            continue;
          } else if (cmd === "plugins") {
            await this.agent.initExtensibility();
            const plugins = this.agent.getPluginManager().listPlugins();
            if (plugins.length === 0) {
              console.log(pc.yellow("No active plugins found in ~/.nexus/plugins/ or ~/.config/nexus/plugins/\n"));
            } else {
              console.log(pc.bold(pc.white("\nLoaded Custom Plugins:")));
              for (const p of plugins) {
                console.log(`  • ${pc.bold(pc.cyan(p.name))}: ${pc.gray(p.description)} (custom tools: ${p.customToolCount})`);
              }
              console.log();
            }
            continue;
          } else if (cmd === "history") {
            const query = arg.trim();
            if (query.startsWith("run ") || /^\d+$/.test(query)) {
              const rawNum = query.startsWith("run ") ? query.slice(4).trim() : query;
              const idx = parseInt(rawNum, 10) - 1;
              if (idx >= 0 && idx < this.history.length) {
                const recalled = this.history[idx];
                console.log(pc.cyan(`⚡ Running from history [#${idx + 1}]: ${pc.bold(recalled)}`));
                if (await this.prepareTurnCheckpoint(`Turn: ${recalled.slice(0, 30)}`)) {
                  await this.runInteractiveTurn(recalled);
                }
              } else {
                console.log(pc.red(`History index out of range: ${rawNum}\n`));
              }
              continue;
            }

            if (query) {
              const lowerQuery = query.toLowerCase();
              const matches = this.history
                .map((item, index) => ({ item, index }))
                .filter(({ item }) => item.toLowerCase().includes(lowerQuery));

              if (matches.length === 0) {
                console.log(pc.yellow(`No history items matching "${query}".\n`));
              } else {
                console.log(pc.bold(pc.white(`\nHistory search matches for "${query}":`)));
                for (const { item, index } of matches) {
                  const highlighted = item.replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => pc.bold(pc.yellow(m)));
                  console.log(`  ${pc.gray(`[${index + 1}]`)} ${highlighted}`);
                }
                console.log(pc.dim("\nUse '!<num>' or '/history run <num>' to re-run any item.\n"));
              }
            } else {
              console.log(pc.bold(pc.white("\nRecent Command History:")));
              const startIdx = Math.max(0, this.history.length - 20);
              for (let i = startIdx; i < this.history.length; i++) {
                console.log(`  ${pc.gray(`[${i + 1}]`)} ${this.history[i]}`);
              }
              console.log(pc.dim("\nUse '/history <query>' to search or '!<num>' to re-run.\n"));
            }
            continue;
          } else if (cmd === "copy") {
            const subArg = arg.trim().toLowerCase();
            if (subArg === "diff") {
              const git = getGitInfo(this.config.workspace);
              if (!git.isRepo) {
                console.log(pc.yellow("Current workspace is not inside a git repository.\n"));
                continue;
              }
              try {
                const diffOut = execSync("git diff", {
                  cwd: this.config.workspace,
                  encoding: "utf-8",
                  stdio: ["pipe", "pipe", "pipe"],
                });
                if (!diffOut.trim()) {
                  console.log(pc.yellow("No uncommitted git diffs to copy.\n"));
                } else {
                  const res = copyToClipboard(diffOut);
                  if (res.success) {
                    console.log(pc.green(`✔ Copied git diff (${diffOut.split("\n").length} lines) to clipboard.\n`));
                  } else {
                    console.log(pc.red(`Clipboard error: ${res.error}\n`));
                  }
                }
              } catch (err: any) {
                console.log(pc.red(`Git diff error: ${err.message}\n`));
              }
            } else if (subArg === "code") {
              const lastAssistant = this.getLastAssistantMessage();
              if (!lastAssistant) {
                console.log(pc.yellow("No assistant response available in conversation history.\n"));
                continue;
              }
              const codeBlocks: string[] = [];
              const regex = /```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
              let match: RegExpExecArray | null;
              while ((match = regex.exec(lastAssistant)) !== null) {
                codeBlocks.push(match[1].trimEnd());
              }
              const contentToCopy = codeBlocks.length > 0 ? codeBlocks.join("\n\n// ────────────────────────────\n\n") : lastAssistant;
              const res = copyToClipboard(contentToCopy);
              if (res.success) {
                console.log(pc.green(`✔ Copied ${codeBlocks.length > 0 ? `${codeBlocks.length} code block(s)` : "latest response"} to clipboard.\n`));
              } else {
                console.log(pc.red(`Clipboard error: ${res.error}\n`));
              }
            } else {
              const lastAssistant = this.getLastAssistantMessage();
              if (!lastAssistant) {
                console.log(pc.yellow("No assistant response available in conversation history.\n"));
                continue;
              }
              const res = copyToClipboard(lastAssistant);
              if (res.success) {
                console.log(pc.green(`✔ Copied last assistant response (${lastAssistant.length} chars) to clipboard.\n`));
              } else {
                console.log(pc.red(`Clipboard error: ${res.error}\n`));
              }
            }
            continue;
          } else if (cmd === "paste") {
            const res = readFromClipboard();
            if (!res.success || !res.text) {
              console.log(pc.red(`Clipboard error: ${res.error || "Clipboard is empty"}\n`));
            } else {
              const preview = res.text.length > 200 ? res.text.slice(0, 200) + "..." : res.text;
              console.log(pc.bold(pc.white(`\nClipboard contents (${res.text.length} chars):`)));
              console.log(pc.gray(preview));
              const confirm = await this.rl!.question(pc.bold(pc.white(`\nSend clipboard content as user prompt? [y/N]: `)));
              if (confirm.trim().toLowerCase() === "y" || confirm.trim().toLowerCase() === "yes") {
                if (await this.prepareTurnCheckpoint(`Turn: ${res.text.slice(0, 30)}`)) {
                  await this.runInteractiveTurn(res.text);
                }
              } else {
                console.log(pc.dim("Paste cancelled.\n"));
              }
            }
            continue;
          } else if (cmd === "image") {
            const parts = arg.trim().split(/\s+/);
            const imgPath = parts[0];
            const userPrompt = parts.slice(1).join(" ") || "Please analyze this image, describe its contents, and provide relevant technical solutions.";
            if (!imgPath) {
              console.log(pc.yellow("Usage: /image <path_to_image> [prompt]\n"));
              continue;
            }
            const encoded = encodeImageFile(imgPath, this.config.workspace);
            if (!encoded.success) {
              console.log(pc.red(`Error loading image: ${encoded.error}\n`));
              continue;
            }
            console.log(pc.cyan(`🖼️  Loaded image: ${pc.bold(path.basename(encoded.filePath))} (${(encoded.sizeBytes / 1024).toFixed(1)} KB)`));
            const visionPayload = formatVisionContent(userPrompt, encoded.dataUri);
            if (await this.prepareTurnCheckpoint(`Vision: ${userPrompt.slice(0, 30)}`)) {
              await this.runInteractiveTurn(visionPayload, userPrompt);
            }
            continue;
          } else if (cmd === "theme") {
            if (!arg) {
              const themes = this.themeManager.listThemes();
              console.log(pc.bold(pc.white("\nAvailable Color Themes:")));
              for (const t of themes) {
                const isCurrent = t === this.themeManager.getThemeName();
                const marker = isCurrent ? pc.bold(pc.green("* ")) : "  ";
                console.log(`${marker}${pc.cyan(t)}`);
              }
              console.log(pc.dim("\nUse '/theme <name>' to apply and persist a theme.\n"));
            } else {
              const ok = this.themeManager.saveConfiguredTheme(arg.trim());
              if (ok) {
                console.log(pc.green(`✔ Color theme switched to: ${pc.bold(arg.trim())}\n`));
              } else {
                console.log(pc.red(`Unknown theme '${arg}'. Options: ${this.themeManager.listThemes().join(", ")}\n`));
              }
            }
            continue;
          } else if (cmd === "tui") {
            const dashboard = new TerminalDashboard(this.agent, this.config, this.themeManager);
            await dashboard.launchInteractive();
            continue;
          } else if (cmd === "team") {
            const subParts = arg.trim().split(/\s+/);
            const subCmd = subParts[0]?.toLowerCase();
            const task = subParts.slice(1).join(" ").trim();

            const independentReview = task.startsWith("--independent-review");
            const objective = task.replace(/^--independent-review\s*/, "").trim();
            if (!subCmd || !objective) {
              console.log(pc.yellow(`Usage: /team <${[...TEAM_ROLES, "full"].join("|")}> [--independent-review] <objective>\n`));
              continue;
            }
            if (subCmd !== "full" && !TEAM_ROLES.includes(subCmd as AgentRole)) {
              console.log(pc.red(`Unknown role '${subCmd}'. Available: ${[...TEAM_ROLES, "full"].join(", ")}\n`));
              continue;
            }

            this.teamAbort = new AbortController();
            try {
              const orchestrator = new TeamOrchestrator(this.config, {
                signal: this.teamAbort.signal,
                independentReview,
                maxInProcessWaitMs: 60_000,
                onEvent: (e) => {
                  console.log((e.type.startsWith("RESOURCE_") ? pc.dim : pc.cyan)(`◆ ${e.message}`));
                },
              });
              console.log(pc.bold(pc.cyan(`\n👥 Team ${subCmd === "full" ? "workflow" : `role ${subCmd}`} as a durable operation`)));
              const result = await orchestrator.run(subCmd === "full" ? "full" : (subCmd as AgentRole), objective);
              console.log((result.success ? pc.green : pc.yellow)(`\n${result.report}\n`));
            } finally {
              this.teamAbort = undefined;
            }
            continue;
          } else if (cmd === "shell") {
            if (arg) {
              this.config.shell = arg;
              this.agent.setShell(arg);
              console.log(pc.green(`✔ Shell switched to ${arg}\n`));
            } else {
              console.log(`Active shell: ${pc.cyan(this.config.shell)}\n`);
            }
            continue;
          } else if (cmd === "plan") {
            const subArgs = arg.trim().split(/\s+/).filter(Boolean);
            const subCmd = subArgs[0]?.toLowerCase();

            if (subCmd === "add") {
              const phaseName = subArgs.slice(1).join(" ");
              if (!phaseName) {
                console.log(pc.yellow("Usage: /plan add <phase description>\n"));
              } else {
                const plan = [...this.agent.getActivePlan(), { name: phaseName, status: "pending" }];
                this.agent.setActivePlan(plan);
                console.log(pc.green(`✔ Added phase to plan: ${pc.bold(phaseName)}\n`));
                this.agent.getUi().renderPlan(plan);
              }
            } else if (subCmd === "done" || subCmd === "complete") {
              const idx = parseInt(subArgs[1], 10) - 1;
              const plan = [...this.agent.getActivePlan()];
              if (isNaN(idx) || idx < 0 || idx >= plan.length) {
                console.log(pc.red(`Invalid phase number. Usage: /plan done <1..${plan.length}>\n`));
              } else {
                plan[idx] = { ...plan[idx], status: "completed" };
                this.agent.setActivePlan(plan);
                console.log(pc.green(`✔ Phase ${idx + 1} marked as completed.\n`));
                this.agent.getUi().renderPlan(plan);
              }
            } else if (subCmd === "start") {
              const idx = parseInt(subArgs[1], 10) - 1;
              const plan = [...this.agent.getActivePlan()];
              if (isNaN(idx) || idx < 0 || idx >= plan.length) {
                console.log(pc.red(`Invalid phase number. Usage: /plan start <1..${plan.length}>\n`));
              } else {
                plan[idx] = { ...plan[idx], status: "in_progress" };
                this.agent.setActivePlan(plan);
                console.log(pc.green(`✔ Phase ${idx + 1} marked as in progress.\n`));
                this.agent.getUi().renderPlan(plan);
              }
            } else if (subCmd === "clear") {
              this.agent.setActivePlan([]);
              console.log(pc.green("✔ Active plan cleared.\n"));
            } else {
              const plan = this.agent.getActivePlan();
              if (!plan || plan.length === 0) {
                console.log(pc.yellow("No active plan currently defined. Use '/plan add <milestone>' to create phases.\n"));
              } else {
                this.agent.getUi().renderPlan(plan);
              }
            }
            continue;
          } else if (cmd === "onboard") {
            console.log(pc.dim(`🔍 Scanning workspace at ${this.config.workspace}...`));
            const report = scanAndOnboardWorkspace(this.config.workspace, true);
            console.log(pc.green(`✔ Onboarding complete for ${pc.bold(report.projectName)}!`));
            console.log(`  • Detected stack: ${pc.cyan(report.languages.join(", ") || "General")}`);
            console.log(`  • Detected commands: build: ${report.buildCommands[0] || "none"}, test: ${report.testCommands[0] || "none"}, lint: ${report.lintCommands[0] || "none"}`);
            console.log(`  • Generated customized ${pc.bold("AGENTS.md")} with architecture diagram.\n`);
            continue;
          } else if (cmd === "test") {
            const filterPattern = arg.trim() || undefined;
            const discovered = discoverVerifier(this.config.workspace, filterPattern);
            if (!discovered) {
              console.log(pc.yellow("  no verifier: no verification command is configured or discovered in this workspace.\n"));
              continue;
            }
            const commandOverride = discovered.command;
            const desc = describeVerifier(this.config.workspace, commandOverride);
            const testCmd = desc?.command || commandOverride;

            // Verifier gating under review mode / untrusted workspace
            const isTrusted = isWorkspaceTrusted(this.config.workspace, Boolean(this.config.readOnly));
            const mode = this.config.approvalMode ?? (this.config.readOnly ? "read-only" : (this.config.fullAccess ? "auto" : (isTrusted ? "auto" : "review")));
            const policyContext: PolicyContext = {
              mode,
              trusted: isTrusted,
              sandbox: this.config.sandbox,
              fullAccess: Boolean(this.config.fullAccess),
            };
            if (this.agent.getApprovalPolicy().requiresDecision("exec", policyContext)) {
              const approved = await this.confirmAction("verifier", {
                command: testCmd,
                script: desc?.script,
                detail: desc?.evidence,
                digest: desc?.digest,
              });
              if (!approved) {
                console.log(pc.yellow("  Test run aborted by user.\n"));
                continue;
              }
            }

            console.log(pc.dim(`🧪 Running automated test suite${filterPattern ? ` matching "${filterPattern}"` : ""}...`));
            const bridge = this.agent.getBridge();
            const timeoutSecs = verifierTimeoutSecs(this.config.verifierTimeoutSecs);
            const res = await runTestSuiteWithExecutor(
              this.config.workspace,
              (command) => bridge.executeTool("run_command", { command, timeout_secs: timeoutSecs }),
              commandOverride,
            );
            console.log(pc.dim(`  Command: ${res.command}`));
            if (res.success) {
              console.log(pc.green(`✔ Test suite PASSED!\n`));
            } else {
              console.log(pc.red(`✖ Test suite FAILED.`));
              if (res.failures.length > 0) {
                console.log(pc.bold(pc.red("\nFailing Tests:")));
                res.failures.slice(0, 10).forEach((f) => console.log(`  • ${pc.red(f)}`));
              }
              if (res.diagnostics.length > 0) {
                console.log(pc.bold(pc.yellow("\nParsed Diagnostics:")));
                res.diagnostics.slice(0, 5).forEach((d) => {
                  console.log(`  • [${d.severity.toUpperCase()}] ${d.file || "unknown"}:${d.line || "?"} - ${d.message}`);
                });
              }
              console.log();
            }
            continue;
          } else if (cmd === "checkpoint") {
            const subArgs = arg.trim().split(/\s+/).filter(Boolean);
            const subCmd = subArgs[0]?.toLowerCase();
            if (subCmd === "diff") {
              const cpId = subArgs[1];
              if (!cpId) {
                console.log("Usage: /checkpoint diff <checkpoint_id> [base_checkpoint_id]\n");
              } else {
                const baseId = subArgs[2];
                const res = this.checkpointManager.getDiff(cpId, baseId);
                if (res.success) {
                  console.log(pc.bold(pc.white(`\nCheckpoint Diff (${cpId}${baseId ? ` vs ${baseId}` : " vs current"}):`)));
                  this.agent.getUi().renderDiff(res.diff);
                } else {
                  console.log(pc.red(`Diff error: ${res.error}\n`));
                }
              }
            } else if (subCmd === "prune") {
              const keepCount = subArgs[1] ? parseInt(subArgs[1], 10) : 20;
              const res = this.checkpointManager.pruneCheckpoints(keepCount);
              console.log(pc.green(`✔ ${res.message}\n`));
            } else {
              const cpName = arg ? arg : undefined;
              const cp = this.checkpointManager.createCheckpoint(cpName);
              console.log(pc.green(`✔ Checkpoint saved: ${pc.bold(cp.name)} (${cp.id})\n`));
            }
            continue;
          } else if (cmd === "checkpoints") {
            const cps = this.checkpointManager.listCheckpoints();
            if (cps.length === 0) {
              console.log(pc.yellow("No saved checkpoints.\n"));
            } else {
              console.log(pc.bold(pc.white("\nSaved Workspace Checkpoints:")));
              cps.forEach((cp, idx) => {
                console.log(`  ${idx + 1}. ${pc.cyan(cp.id)} - ${pc.bold(cp.name)} ${pc.gray(`(${cp.timestamp})`)}`);
              });
              console.log(pc.dim("\nUse '/checkpoint diff <id>' to inspect changes, or '/undo' to roll back.\n"));
            }
            continue;
          } else if (cmd === "undo") {
            const res = this.checkpointManager.rollbackLast();
            if (res.success) {
              console.log(pc.green(`✔ ${res.message}\n`));
            } else {
              console.log(pc.red(`✖ ${res.message}\n`));
            }
            continue;
          } else if (cmd === "audit") {
            const auditFile = path.join(os.homedir(), ".nexus", "audit.log");
            if (!fs.existsSync(auditFile)) {
              console.log(pc.dim("No audit records found in ~/.nexus/audit.log\n"));
            } else {
              const limit = arg ? parseInt(arg, 10) : 15;
              try {
                const raw = fs.readFileSync(auditFile, "utf-8");
                const lines = raw.trim().split("\n").filter(Boolean);
                const records = lines.slice(-limit).map((l) => {
                  try { return JSON.parse(l); } catch { return null; }
                }).filter(Boolean);

                console.log(pc.bold(pc.cyan(`\n=== Recent Tool Execution Audit Log (last ${records.length}) ===\n`)));
                for (const r of records) {
                  const status = r.success ? pc.green("PASS") : pc.red("FAIL");
                  const time = pc.gray(r.timestamp?.slice(11, 19) || "");
                  const dur = pc.yellow(`${r.duration_ms || 0}ms`.padStart(6));
                  const tool = pc.bold(pc.cyan(r.tool.padEnd(16)));
                  console.log(`[${time}] [${status}] ${tool} (${dur})`);
                  if (r.error) {
                    console.log(`  ${pc.red("Error:")} ${r.error}`);
                  }
                }
                console.log();
              } catch (e: any) {
                console.log(pc.red(`Failed to read audit log: ${e.message}\n`));
              }
            }
            continue;
          } else if (cmd === "export") {
            const format = (arg || "markdown").toLowerCase();
            const sess = this.sessionManager.loadSession(this.currentSessionId);
            if (!sess || sess.messages.length === 0) {
              console.log(pc.yellow("No session conversation to export.\n"));
              continue;
            }
            const outFilename = format === "json"
              ? `nexus-session-${this.currentSessionId}.json`
              : `nexus-session-${this.currentSessionId}.md`;
            const outPath = path.join(this.config.workspace, outFilename);
            const exported = buildSessionExport(this.sessionManager, sess);
            writeProtectedTextFile(outPath, format === "json" ? JSON.stringify(exported.json, null, 2) : exported.markdown);
            console.log(pc.green(`✔ Session transcript exported to: ${pc.bold(outPath)}`));
            console.log(pc.dim(`${(exported.json.export as { history: { note: string } }).history.note}\n`));
            continue;
          } else if (cmd === "cd") {
            if (arg) {
              const newPath = path.resolve(this.config.workspace, arg);
              this.config.workspace = newPath;
              this.agent.setWorkspace(newPath);
              this.checkpointManager = new CheckpointManager(newPath);
              console.log(pc.green(`✔ Workspace changed to ${newPath}\n`));
            } else {
              console.log(`Current workspace: ${pc.cyan(this.config.workspace)}\n`);
            }
            continue;
          } else if (cmd === "model") {
            if (arg) {
              this.config.model = arg;
              this.agent.setModel(arg);
              console.log(pc.green(`✔ Active model changed to ${arg}\n`));
            } else {
              console.log(pc.dim(`Fetching available models from ${this.config.endpoint}...`));
              try {
                const client = new LocalLlmClient(this.config);
                const models = await client.listModels();
                console.log(pc.green(`Available models:`));
                for (const m of models) {
                  const indicator = m === this.config.model ? pc.bold(pc.green(`* ${m} (active)`)) : `  ${m}`;
                  console.log(indicator);
                }
              } catch (e: any) {
                console.log(pc.red(`Error fetching models: ${e.message}`));
              }
              console.log();
            }
            continue;
          } else {
            console.log(pc.red(`Unknown command: /${cmd}. Type /help for available commands.\n`));
            continue;
          }
        }

        // Regular user prompt: run agent turn
        try {
          if (await this.prepareTurnCheckpoint(`Turn: ${trimmed.slice(0, 30)}`)) {
            await this.runInteractiveTurn(trimmed);
          }
        } catch (err: any) {
          console.error(pc.red(`\nTurn error: ${err.message}\n`));
        }
      }
    };

    await promptLoop();
    this.agent.shutdown();
    this.rl.close();
  }
}
