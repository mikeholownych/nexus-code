import pc from "picocolors";
import ora, { Ora } from "ora";
import { TurnResult, summarizeTurn } from "./core/turn.js";
import { highlightDiff, highlightCode } from "./syntax.js";
import { InformationFlowBoundary } from "./core/egress.js";
import { visibleControls } from "./file_diff.js";
import { isNexusDirPermissive } from "./core/durable_file.js";

export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  try {
    const boundary = InformationFlowBoundary.getGlobalInstance();
    const redacted = boundary.redactForTelemetry(text);
    if (typeof redacted === "string") {
      result = redacted;
    }
  } catch {}
  return result
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]{15,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:basic|bearer|token)\s+["']?)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .replace(/(?:sk-|ghp_|gho_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_\-]{16,}/g, "[REDACTED_KEY]")
    .replace(/-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)([^"' \s\n\r]{6,})(["']?)/gi, "$1[REDACTED]$3");
}

/** Text safe to write to a terminal: secrets redacted, then every terminal control/bidi character made visible. */
function safeTerminal(text: string): string {
  return visibleControls(redactSecrets(text));
}

export class TerminalUI {
  private spinner: Ora | null = null;

  banner(): void {
    console.log(`\n${pc.bold(pc.black(pc.bgCyan(" NEXUS ")))} ${pc.dim("local engineering agent")}`);
    console.log(pc.dim("Understand the work. Inspect the evidence. Keep the decision yours.\n"));
    if (isNexusDirPermissive()) {
      console.log(pc.yellow("your Nexus state is readable by other users; run `nexus doctor --fix`\n"));
    }
  }

  stepHeader(step: number, maxSteps: number): void {
    if (process.env.NEXUS_DEBUG === "1") console.log(pc.dim(`\nwork step ${step}${Number.isFinite(maxSteps) ? `/${maxSteps}` : ""}`));
  }

  startSpinner(text: string): void {
    this.spinner = ora({
      text: pc.cyan(safeTerminal(this.humanActivity(text))),
      spinner: "dots",
      // ora's default stdin discarding puts stdin in raw mode and leaves readline paused afterwards,
      // which kills the REPL prompt after the first agent turn.
      discardStdin: false,
      // A TTY that reports no width makes ora compute an unbounded number of lines to clear and spin forever.
      isEnabled: Boolean(process.stdout.isTTY && (process.stdout.columns ?? 0) > 0),
    }).start();
  }

  updateSpinner(text: string): void {
    if (this.spinner) {
      this.spinner.text = pc.cyan(safeTerminal(this.humanActivity(text)));
    }
  }

  stopSpinner(success: boolean = true, message?: string): void {
    if (this.spinner) {
      if (success) {
        this.spinner.succeed(message ? pc.green(safeTerminal(message)) : undefined);
      } else {
        this.spinner.fail(message ? pc.red(safeTerminal(message)) : undefined);
      }
      this.spinner = null;
    }
  }

  renderPlan(phases: Array<{ name: string; status: string; detail?: string }>): void {
    if (!phases || phases.length === 0) return;
    console.log(pc.bold(pc.cyan("\n📋 Active Execution Plan:")));
    phases.forEach((p, idx) => {
      let icon = pc.gray("[ ]");
      const safeName = safeTerminal(p.name);
      let nameStr = pc.white(safeName);
      if (p.status === "completed") {
        icon = pc.green("[✔]");
        nameStr = pc.strikethrough(pc.gray(safeName));
      } else if (p.status === "in_progress") {
        icon = pc.yellow("[►]");
        nameStr = pc.bold(pc.yellow(safeName));
      }
      const detailStr = p.detail ? pc.dim(` - ${safeTerminal(p.detail)}`) : "";
      console.log(`  ${icon} ${idx + 1}. ${nameStr}${detailStr}`);
    });
    console.log();
  }

  printThought(thought: string): void {
    if (process.env.NEXUS_DEBUG !== "1" || !thought || !thought.trim()) return;
    console.log(pc.bold(pc.magenta("\nModel rationale (unverified):")));
    const sanitized = safeTerminal(thought.trim());
    const lines = sanitized.split("\n");
    for (const line of lines) {
      console.log(pc.gray("  │ ") + line);
    }
    console.log();
  }

  printToolCall(name: string, args: Record<string, any>): void {
    const subject = args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? args.name ?? "";
    console.log(pc.cyan("  · ") + pc.white(safeTerminal(this.humanTool(name))) + (subject ? pc.dim(`  ${safeTerminal(String(subject)).replace(/\s+/g, " ").slice(0, 100)}`) : ""));
  }

  printToolResult(toolName: string, success: boolean, output: string, error?: string): void {
    if (success) {
      const compact = safeTerminal(output).trim();
      const first = compact.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Completed";
      const count = compact ? `${compact.split(/\r?\n/).length} lines` : "no output";
      const material = /^(write|edit|patch|delete|move|commit|stage)/i.test(toolName) ? pc.cyan("change") : pc.green("done");
      console.log(`  ${material} ${pc.dim(count)}${first ? `  ${first.replace(/\s+/g, " ").slice(0, 150)}` : ""}`);
      if (compact.length > 180 || compact.split(/\r?\n/).length > 2) console.log(pc.dim("    Full output retained in session evidence; use /tui and open this activity."));
    } else {
      console.log(pc.bold(pc.red("✖ Tool Error:")));
      console.log(pc.red(`  ${safeTerminal(error || output)}`));
    }
    console.log();
  }

  renderDiff(diffText: string): void {
    const sanitized = safeTerminal(diffText);
    const highlighted = highlightDiff(sanitized);
    console.log(highlighted);
  }

  renderCode(code: string, lang?: string, showLineNumbers: boolean = true): void {
    const sanitized = safeTerminal(code);
    console.log(highlightCode(sanitized, lang, { showLineNumbers }));
  }

  private humanActivity(text: string): string {
    if (/Thinking and analyzing/i.test(text)) return "Nexus is considering the next step";
    return text.replace(/^Executing /, "Working: ").replace(/\.\.\.$/, "");
  }

  private humanTool(name: string): string {
    const labels: Record<string, string> = {
      read_file: "Reading file", batch_read: "Reading files", list_dir: "Exploring workspace",
      run_command: "Running command", run_tests: "Validating", write_file: "Writing file",
      edit_file: "Updating file", patch_file: "Applying change", search_files: "Searching workspace",
      git_status: "Checking changes", git_diff: "Reviewing diff",
    };
    return labels[name] || name.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  /** Terminal projection of a TurnResult. Reads the structured result; adds no semantics of its own. */
  turnSummary(result: TurnResult, modelSummary?: { summary: string; notes?: string }): void {
    const { heading, line } = summarizeTurn(result);
    const verified = result.execution === "COMPLETED" && (result.outcome === "VERIFIED" || result.outcome === "NOT_REQUIRED");
    // A failing or timed-out verifier is a failure; an operator's cancel or a budget stop is not (same as the live TUI).
    const verifierFailed = result.execution === "COMPLETED" && (result.reason === "VERIFIER_FAILED" || result.reason === "VERIFIER_TIMED_OUT");
    const caution = !verifierFailed && (result.execution === "COMPLETED" || result.execution === "INTERRUPTED" || result.execution === "LIMIT_REACHED");
    const paint = verified ? pc.green : caution ? pc.yellow : pc.red;
    console.log(`\n${paint(pc.bold(safeTerminal(`${verified ? "✓" : caution ? "!" : "×"} ${heading}`)))}  ${pc.dim(safeTerminal(line))}`);
    if (result.inferenceFailure) {
      const f = result.inferenceFailure;
      console.log(pc.red(`Inference ${f.kind} (origin: ${safeTerminal(f.origin)}${f.httpStatus ? `, HTTP ${f.httpStatus}` : ""}): ${safeTerminal(f.message).slice(0, 300)}`));
    }
    if (modelSummary && result.execution === "COMPLETED") {
      console.log(pc.bold(pc.white("\nModel-reported summary (not independently verified):")));
      console.log(safeTerminal(modelSummary.summary));
      if (modelSummary.notes && modelSummary.notes.trim()) {
        console.log(pc.bold(pc.yellow("\nNotes:")));
        console.log(safeTerminal(modelSummary.notes));
      }
    }
    console.log();
  }
}
