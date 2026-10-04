import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { AutonomousAgent } from "./agent.js";
import { ApplicationCore } from "./core/app.js";
import { HarnessConfig, ChatMessage } from "./types.js";
import { ThemeManager } from "./theme.js";
import { redactSecrets } from "./ui.js";

interface ActivityProjection {
  kind: string;
  title: string;
  summary: string;
  detail: string;
}

/** Ratatui viewer fed by the existing application and agent state. */
export class TerminalDashboard {
  private app?: ApplicationCore;
  private agent: AutonomousAgent;
  private config: HarnessConfig;
  private themeManager: ThemeManager;

  constructor(target: ApplicationCore | AutonomousAgent, config?: HarnessConfig, themeManager?: ThemeManager) {
    if ("getAgent" in target && typeof (target as any).getAgent === "function") {
      this.app = target as ApplicationCore;
      this.agent = this.app.getAgent();
      this.config = config || this.app.getConfig();
    } else {
      this.agent = target as AutonomousAgent;
      this.config = config || this.agent.getConfig();
    }
    this.themeManager = themeManager || new ThemeManager();
  }

  /** Text rendering for non-interactive terminals and deterministic client tests. */
  public renderSnapshot(width = 100, height = 28): string {
    const data = this.projectState();
    const safeWidth = Math.max(40, width);
    const output = [
      `${pc.bold(pc.cyan("NEXUS"))}  ${pc.dim("WORKSPACE")}  ${this.clip(path.basename(data.workspace), 30)}  ${pc.dim(data.model)}  ${pc.green(data.status)}`,
      `${pc.bold(pc.cyan("OBJECTIVE"))}  ${this.clip(data.objective || "No objective yet · start with a prompt in the REPL", safeWidth - 14)}`,
      "",
      pc.bold(pc.cyan("RECENT SIGNAL")),
      ...(data.activity.length ? data.activity.slice(-Math.max(1, height - 12)).map((item) => `  ${this.glyph(item.kind)} ${item.title}  ${pc.dim(this.clip(item.summary, safeWidth - 12))}`) : [`  ${pc.dim("No work recorded yet.")}`]),
      "",
      `${pc.bold(pc.cyan("PLAN"))}  ${data.plan.length ? data.plan.map((item) => `${item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○"} ${item.name}`).join("  ·  ") : pc.dim("No milestones")}`,
      `${pc.bold(pc.cyan("VALIDATION"))}  ${data.validation?.status ?? pc.dim("Not verified")}${data.validation?.candidate_id ? `  ·  ${data.validation.candidate_id}` : ""}`,
      `${pc.bold(pc.cyan("CONTEXT"))}  ${data.context}  ·  ${pc.dim(`task ${data.task_id}`)}`,
      "",
      pc.dim("↑↓ navigate   enter detail   ? help   q return to REPL"),
    ];
    return output.join("\n");
  }

  public async launchInteractive(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(this.renderSnapshot());
      return;
    }

    const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const binary = path.join(cliRoot, "core", "target", "release", process.platform === "win32" ? "nexus-tui.exe" : "nexus-tui");
    if (!fs.existsSync(binary)) {
      const build = spawnSync("cargo", ["build", "--release", "--manifest-path", path.join(cliRoot, "core/Cargo.toml"), "--bin", "nexus-tui"], { cwd: cliRoot, stdio: "inherit" });
      if (build.error || build.status !== 0 || !fs.existsSync(binary)) {
        throw new Error(`Unable to build the Ratatui client: ${build.error?.message ?? `cargo exited ${build.status}`}`);
      }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tui-"));
    const snapshotPath = path.join(tempDir, "session.json");
    try {
      fs.writeFileSync(snapshotPath, JSON.stringify(this.projectState()), { mode: 0o600, flag: "wx" });
      const child = spawnSync(binary, [snapshotPath], { cwd: cliRoot, stdio: "inherit" });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`Ratatui client exited with status ${child.status}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private projectState() {
    const messages = this.agent.getMessages() as ChatMessage[];
    let objective = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        objective = redactSecrets(this.messageText(messages[i])).replace(/\s+/g, " ").trim();
        break;
      }
    }
    const activity = this.projectActivity(messages).slice(-24);
    const lifecycle = this.agent.getTurnLifecycle();
    const receipt = this.app?.getActiveValidationReceipt() ?? this.agent.getActiveValidationReceipt();
    const tokens = this.agent.getTokenStats();
    const lastTurn = this.agent.getLastTurnResult();
    let status = "IDLE";
    if (lifecycle) {
      status = lifecycle.cancellationRequested ? "STOPPING" : lifecycle.currentTool ? `RUNNING · ${lifecycle.currentTool}` : "THINKING";
    } else if (lastTurn) {
      status = lastTurn.execution === "COMPLETED"
        ? lastTurn.outcome === "VERIFIED" ? "VERIFIED" : lastTurn.outcome === "UNVERIFIED" ? "UNVERIFIED" : lastTurn.outcome === "NOT_REQUIRED" ? "NO CHANGES" : "INCOMPLETE"
        : lastTurn.execution;
    }
    return {
      model: this.config.model,
      workspace: this.config.workspace || process.cwd(),
      task_id: this.app?.getTaskId() ?? this.agent.getTaskId(),
      objective,
      activity,
      plan: this.agent.getActivePlan().map((item) => ({ name: item.name, status: item.status })),
      validation: receipt ? {
        status: receipt.status,
        candidate_id: receipt.candidateId,
        verifier: receipt.verifierCommand,
      } : null,
      context: `${this.agent.getHistoryCount()} messages · ${tokens.total.toLocaleString()} tokens`,
      status,
      theme: this.themeManager.getThemeName(),
    };
  }

  private projectActivity(messages: ChatMessage[]): ActivityProjection[] {
    const activity: ActivityProjection[] = [];
    for (const message of messages) {
      if (message.role === "assistant" && message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          const args = this.parseArgs(call.function.arguments);
          const subject = args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? "";
          activity.push({ kind: "tool", title: this.titleForTool(call.function.name), summary: redactSecrets(String(subject)), detail: redactSecrets(`${call.function.name}\n${JSON.stringify(args, null, 2)}`) });
        }
      } else if (message.role === "tool") {
        const detail = redactSecrets(this.messageText(message));
        const failed = /^(Error executing|error:|failed|cancelled)/i.test(detail.trim());
        const tool = message.name || "Tool result";
        activity.push({ kind: failed ? "failure" : this.isMutationTool(tool) ? "change" : "tool", title: failed ? `${tool} needs attention` : `${this.titleForTool(tool)} complete`, summary: this.firstLine(detail), detail });
      } else if (message.role === "assistant" && this.messageText(message).trim()) {
        const detail = redactSecrets(this.messageText(message).replace(/<thought>[\s\S]*?<\/thought>/g, "").trim());
        if (detail) activity.push({ kind: "finding", title: "Model response", summary: this.firstLine(detail), detail: `Model-reported response · not independently verified\n\n${detail}` });
      }
    }
    return activity;
  }

  private messageText(message: ChatMessage): string {
    if (typeof message.content === "string") return message.content;
    return Array.isArray(message.content) ? message.content.map((part: any) => typeof part?.text === "string" ? part.text : "[multimodal content]").join("\n") : "";
  }

  private parseArgs(raw: string): Record<string, any> {
    try { const value = JSON.parse(raw || "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
  }

  private firstLine(text: string): string { return text.split(/\r?\n/, 1)[0]?.trim() ?? ""; }
  private clip(text: string, width: number): string { return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`; }
  private isMutationTool(name: string): boolean { return /write|edit|patch|delete|move|commit|stage/i.test(name); }
  private titleForTool(name: string): string {
    const labels: Record<string, string> = { read_file: "Reading file", batch_read: "Reading files", list_dir: "Exploring workspace", run_command: "Running command", run_tests: "Validating", write_file: "Writing file", edit_file: "Updating file", patch_file: "Applying change", search_files: "Searching workspace", git_diff: "Reviewing diff" };
    return labels[name] || name.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  private glyph(kind: string): string { return kind === "failure" ? pc.red("×") : kind === "change" ? pc.cyan("▸") : kind === "finding" ? pc.yellow("✳") : pc.dim("·"); }
}
