import pc from "picocolors";
import ora, { Ora } from "ora";
import { TurnResult, summarizeTurn } from "./core/turn.js";
import { highlightDiff, highlightCode, highlightMarkdownCodeBlocks } from "./syntax.js";

export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]{15,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(?:sk-|ghp_|gho_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_\-]{16,}/g, "[REDACTED_KEY]")
    .replace(/-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)([^"' \s\n\r]{6,})(["']?)/gi, "$1[REDACTED]$3");
}

export class TerminalUI {
  private spinner: Ora | null = null;

  banner(): void {
    console.log(pc.bold(pc.cyan("\n╔════════════════════════════════════════════════════════════════╗")));
    console.log(pc.bold(pc.cyan("║           NEXUS CODE HARNESS - LOCAL AI AUTONOMOUS CLI        ║")));
    console.log(pc.bold(pc.cyan("╚════════════════════════════════════════════════════════════════╝\n")));
  }

  stepHeader(step: number, maxSteps: number): void {
    console.log(
      pc.bgCyan(pc.black(` STEP ${step}/${maxSteps} `)) +
        " " +
        pc.gray("─".repeat(50))
    );
  }

  startSpinner(text: string): void {
    this.spinner = ora({
      text: pc.yellow(text),
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
      this.spinner.text = pc.yellow(text);
    }
  }

  stopSpinner(success: boolean = true, message?: string): void {
    if (this.spinner) {
      if (success) {
        this.spinner.succeed(message ? pc.green(message) : undefined);
      } else {
        this.spinner.fail(message ? pc.red(message) : undefined);
      }
      this.spinner = null;
    }
  }

  renderPlan(phases: Array<{ name: string; status: string; detail?: string }>): void {
    if (!phases || phases.length === 0) return;
    console.log(pc.bold(pc.cyan("\n📋 Active Execution Plan:")));
    phases.forEach((p, idx) => {
      let icon = pc.gray("[ ]");
      let nameStr = pc.white(p.name);
      if (p.status === "completed") {
        icon = pc.green("[✔]");
        nameStr = pc.strikethrough(pc.gray(p.name));
      } else if (p.status === "in_progress") {
        icon = pc.yellow("[►]");
        nameStr = pc.bold(pc.yellow(p.name));
      }
      const detailStr = p.detail ? pc.dim(` - ${p.detail}`) : "";
      console.log(`  ${icon} ${idx + 1}. ${nameStr}${detailStr}`);
    });
    console.log();
  }

  printThought(thought: string): void {
    if (!thought || !thought.trim()) return;
    console.log(pc.bold(pc.magenta("\n💭 Thought:")));
    const sanitized = redactSecrets(thought.trim());
    const lines = sanitized.split("\n");
    for (const line of lines) {
      console.log(pc.gray("  │ ") + line);
    }
    console.log();
  }

  printToolCall(name: string, args: Record<string, any>): void {
    const rawArgs = JSON.stringify(args);
    const sanitized = redactSecrets(rawArgs);
    console.log(
      pc.bold(pc.blue("⚡ Tool Call: ")) +
        pc.bold(pc.white(name)) +
        pc.gray(" ") +
        pc.dim(sanitized)
    );
  }

  printToolResult(toolName: string, success: boolean, output: string, error?: string): void {
    if (success) {
      console.log(pc.bold(pc.green("✔ Result:")));
      if ((toolName === "edit_file" || toolName === "patch_file") && output) {
        this.renderDiff(output);
      } else if ((toolName === "read_file" || toolName === "batch_read") && output) {
        const sanitized = redactSecrets(output);
        const preview = sanitized.length > 800 ? sanitized.substring(0, 800) + "\n... [TRUNCATED]" : sanitized;
        console.log(highlightCode(preview, undefined, { showLineNumbers: false }));
      } else {
        const sanitized = redactSecrets(output);
        const preview = sanitized.length > 500 ? sanitized.substring(0, 500) + "\n... [TRUNCATED]" : sanitized;
        const formatted = highlightMarkdownCodeBlocks(preview);
        const lines = formatted.split("\n");
        for (const line of lines) {
          console.log(pc.gray("  ") + line);
        }
      }
    } else {
      console.log(pc.bold(pc.red("✖ Tool Error:")));
      console.log(pc.red(`  ${redactSecrets(error || output)}`));
    }
    console.log();
  }

  renderDiff(diffText: string): void {
    const sanitized = redactSecrets(diffText);
    const highlighted = highlightDiff(sanitized);
    console.log(highlighted);
  }

  renderCode(code: string, lang?: string, showLineNumbers: boolean = true): void {
    const sanitized = redactSecrets(code);
    console.log(highlightCode(sanitized, lang, { showLineNumbers }));
  }

  /** Terminal projection of a TurnResult. Reads the structured result; adds no semantics of its own. */
  turnSummary(result: TurnResult, modelSummary?: { summary: string; notes?: string }): void {
    const { heading, line } = summarizeTurn(result);
    const verified = result.execution === "COMPLETED" && (result.outcome === "VERIFIED" || result.outcome === "NOT_REQUIRED");
    const paint = verified ? pc.green : result.execution === "COMPLETED" ? pc.yellow : pc.red;
    console.log(paint(pc.bold(`\n════════════════════════ ${heading} ════════════════════════`)));
    console.log(pc.dim(line));
    if (result.inferenceFailure) {
      const f = result.inferenceFailure;
      console.log(pc.red(`Inference ${f.kind} (origin: ${f.origin}${f.httpStatus ? `, HTTP ${f.httpStatus}` : ""}): ${redactSecrets(f.message).slice(0, 300)}`));
    }
    if (modelSummary && result.execution === "COMPLETED") {
      console.log(pc.bold(pc.white("\nModel-reported summary (not independently verified):")));
      console.log(redactSecrets(modelSummary.summary));
      if (modelSummary.notes && modelSummary.notes.trim()) {
        console.log(pc.bold(pc.yellow("\nNotes:")));
        console.log(redactSecrets(modelSummary.notes));
      }
    }
    console.log(paint(pc.bold("════════════════════════════════════════════════════════════════\n")));
  }
}
