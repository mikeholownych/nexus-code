import * as path from "node:path";
import pc from "picocolors";
import { ThemeManager } from "./theme.js";
/**
 * Full-Screen Terminal User Interface (TUI) Dashboard (Candidate #19)
 * Features alternate screen buffer mode, split-pane dashboard, and real-time state visualization.
 */
export class TerminalDashboard {
    agent;
    config;
    themeManager;
    constructor(agent, config, themeManager) {
        this.agent = agent;
        this.config = config;
        this.themeManager = themeManager || new ThemeManager();
    }
    /**
     * Render a snapshot of the TUI dashboard layout into a string
     */
    renderSnapshot(width = 100, height = 28) {
        const termWidth = Math.max(80, width);
        const colLeftWidth = Math.floor(termWidth * 0.54);
        const colRightWidth = termWidth - colLeftWidth - 3;
        const scheme = this.themeManager.getScheme();
        const lines = [];
        // 1. Header Banner
        const title = "⚡ NEXUS CODE FULL-SCREEN TUI DASHBOARD";
        const meta = `Model: ${this.config.model} │ Workspace: ${path.basename(this.config.workspace || process.cwd())}`;
        const topBar = "╔" + "═".repeat(termWidth - 2) + "╗";
        const botBar = "╚" + "═".repeat(termWidth - 2) + "╝";
        lines.push(scheme.primary(topBar));
        const headerContent = `  ${pc.bold(title)}   ${pc.dim(meta)}`;
        const headerPadded = headerContent + " ".repeat(Math.max(0, termWidth - 2 - this.stripAnsi(headerContent).length));
        lines.push(scheme.primary("║") + headerPadded + scheme.primary("║"));
        lines.push(scheme.primary(botBar));
        // 2. Compute Left Column Content (Conversation Transcript & Thoughts)
        const leftLines = [];
        leftLines.push(pc.bold(pc.cyan("── Recent Agent Activity & Thoughts ──")));
        const messages = this.agent.getMessages();
        const recentMessages = messages.slice(-5);
        if (recentMessages.length === 0) {
            leftLines.push(pc.dim("No turns executed yet. Type a task in the REPL."));
        }
        else {
            for (const msg of recentMessages) {
                if (msg.role === "user") {
                    const text = typeof msg.content === "string" ? msg.content : "[multimodal]";
                    leftLines.push(pc.bold(pc.green("User: ")) + this.truncate(text, colLeftWidth - 8));
                }
                else if (msg.role === "assistant") {
                    const text = typeof msg.content === "string" ? msg.content : "";
                    if (text) {
                        leftLines.push(pc.bold(pc.magenta("Assistant: ")) + this.truncate(text.replace(/<thought>[\s\S]*?<\/thought>/g, "").trim(), colLeftWidth - 13));
                    }
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        for (const tc of msg.tool_calls) {
                            leftLines.push(pc.dim(`  ⚡ Tool: `) + pc.yellow(tc.function.name));
                        }
                    }
                }
                else if (msg.role === "tool") {
                    const out = typeof msg.content === "string" ? msg.content : "";
                    leftLines.push(pc.dim(`    ✔ Result: `) + this.truncate(out.replace(/\n/g, " "), colLeftWidth - 16));
                }
            }
        }
        // 3. Compute Right Column Content (Workspace Git, Plan, Tokens, Extensibility)
        const rightLines = [];
        rightLines.push(pc.bold(pc.cyan("── Project Status & Engine ──")));
        // Active Plan
        const plan = this.agent.getActivePlan();
        rightLines.push(pc.bold(pc.white("Execution Plan:")));
        if (plan.length === 0) {
            rightLines.push(pc.dim("  (No active milestones defined)"));
        }
        else {
            for (let i = 0; i < Math.min(plan.length, 4); i++) {
                const p = plan[i];
                const icon = p.status === "completed" ? pc.green("✔") : p.status === "in_progress" ? pc.yellow("⏳") : pc.dim("○");
                rightLines.push(`  ${icon} ${this.truncate(p.name, colRightWidth - 6)}`);
            }
        }
        rightLines.push("");
        rightLines.push(pc.bold(pc.white("Context & Tokens:")));
        const tokenStats = this.agent.getTokenStats();
        const limit = this.config.contextLimit || 32768;
        const total = tokenStats.total;
        const pct = Math.min(100, Math.round((total / limit) * 100));
        const filled = Math.min(14, Math.round((total / limit) * 14));
        const empty = Math.max(0, 14 - filled);
        const bar = (pct > 80 ? pc.red : pct > 60 ? pc.yellow : pc.green)("█".repeat(filled)) + pc.dim("░".repeat(empty));
        rightLines.push(`  [${bar}] ${pct}% (${total.toLocaleString()} / ${limit.toLocaleString()})`);
        rightLines.push("");
        rightLines.push(pc.bold(pc.white("Active Subsystems:")));
        rightLines.push(pc.dim(`  • Theme: `) + pc.cyan(this.themeManager.getThemeName()));
        rightLines.push(pc.dim(`  • History: `) + pc.cyan(`${this.agent.getHistoryCount()} messages`));
        rightLines.push(pc.dim(`  • Sandbox: `) + pc.cyan(this.config.sandbox ? "Enabled" : "Off"));
        // 4. Merge Left and Right Columns side-by-side
        const maxContentLines = Math.max(leftLines.length, rightLines.length, 12);
        for (let i = 0; i < maxContentLines; i++) {
            const left = leftLines[i] || "";
            const right = rightLines[i] || "";
            const leftStrippedLen = this.stripAnsi(left).length;
            const leftPadding = " ".repeat(Math.max(0, colLeftWidth - leftStrippedLen));
            const rightStrippedLen = this.stripAnsi(right).length;
            const rightPadding = " ".repeat(Math.max(0, colRightWidth - rightStrippedLen));
            lines.push(`${left}${leftPadding} │ ${right}${rightPadding}`);
        }
        // 5. Status Bar / Footer
        const footerBar = "─".repeat(termWidth);
        lines.push(pc.dim(footerBar));
        const statusText = ` [q/Esc] Return to REPL  │  [/help] Help  │  [/plan] Plan  │  [/tokens] Budget  │  Theme: ${this.themeManager.getThemeName()}`;
        lines.push(pc.bold(pc.black(pc.bgCyan(statusText.padEnd(termWidth)))));
        return lines.join("\n");
    }
    /**
     * Launch interactive TUI session with alternate screen buffer
     */
    async launchInteractive() {
        const isTty = process.stdin.isTTY && process.stdout.isTTY;
        if (!isTty) {
            console.log(this.renderSnapshot());
            return;
        }
        // Switch to alternate screen buffer and hide cursor
        process.stdout.write("\x1b[?1049h\x1b[?25l");
        const render = () => {
            process.stdout.write("\x1b[H\x1b[2J");
            const width = process.stdout.columns || 100;
            const height = process.stdout.rows || 30;
            process.stdout.write(this.renderSnapshot(width, height) + "\n");
        };
        render();
        return new Promise((resolve) => {
            const onResize = () => render();
            process.stdout.on("resize", onResize);
            const onKeypress = (chunk) => {
                const key = chunk.toString("utf-8");
                // 'q', 'Q', Escape ('\x1b'), or Ctrl+C ('\u0003')
                if (key === "q" || key === "Q" || key === "\x1b" || key === "\u0003" || key === "\r" || key === "\n") {
                    cleanup();
                    resolve();
                }
            };
            const cleanup = () => {
                process.stdout.off("resize", onResize);
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
                process.stdin.off("data", onKeypress);
                // Switch back to primary screen buffer and show cursor
                process.stdout.write("\x1b[?1049l\x1b[?25h");
            };
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
                process.stdin.resume();
            }
            process.stdin.on("data", onKeypress);
        });
    }
    stripAnsi(text) {
        return text.replace(/\x1b\[[0-9;]*m/g, "");
    }
    truncate(text, maxLen) {
        const clean = text.replace(/[\r\n]+/g, " ").trim();
        if (clean.length <= maxLen)
            return clean;
        return clean.slice(0, Math.max(0, maxLen - 3)) + "...";
    }
}
