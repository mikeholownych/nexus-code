import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import pc from "picocolors";
import { AutonomousAgent } from "./agent.js";
import { LocalLlmClient } from "./client.js";
import { getGitInfo, scaffoldProjectRules, generateConventionalCommit, commitChanges } from "./git.js";
import { SessionManager } from "./session.js";
import { CheckpointManager } from "./checkpoint.js";
import { renderTokenGauge } from "./tokens.js";
import { scanAndOnboardWorkspace } from "./onboard.js";
import { runTestSuite } from "./tester.js";
import { copyToClipboard, readFromClipboard } from "./clipboard.js";
import { encodeImageFile, formatVisionContent } from "./image.js";
import { ThemeManager } from "./theme.js";
import { TeamOrchestrator } from "./team.js";
function parsePatchHunks(patch) {
    const lines = patch.split("\n");
    const fileHeaderLines = [];
    const hunks = [];
    let currentHunk = null;
    for (const line of lines) {
        if (line.startsWith("@@")) {
            if (currentHunk) {
                hunks.push(currentHunk);
            }
            currentHunk = { header: line, lines: [] };
        }
        else if (currentHunk) {
            currentHunk.lines.push(line);
        }
        else {
            fileHeaderLines.push(line);
        }
    }
    if (currentHunk) {
        hunks.push(currentHunk);
    }
    return { fileHeader: fileHeaderLines.join("\n"), hunks };
}
export class InteractiveRepl {
    agent;
    config;
    rl = null;
    autoApprove = true;
    historyFile;
    history = [];
    sessionManager;
    checkpointManager;
    currentSessionId;
    themeManager = new ThemeManager();
    constructor(config, autoApprove = true, resumeSessionId) {
        this.config = config;
        this.autoApprove = autoApprove;
        this.agent = new AutonomousAgent(config);
        this.sessionManager = new SessionManager();
        this.checkpointManager = new CheckpointManager(config.workspace);
        this.historyFile = path.join(os.homedir(), ".nexus_history");
        this.loadHistory();
        if (resumeSessionId) {
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
                this.agent.setMessages(sess.messages);
                console.log(pc.green(`✔ Restored previous session ${pc.bold(sess.id)} (${sess.messages.length} messages)`));
            }
            else {
                this.currentSessionId = this.sessionManager.generateSessionId();
            }
        }
        else {
            this.currentSessionId = this.sessionManager.generateSessionId();
        }
    }
    saveCurrentSession(titlePrompt) {
        const messages = this.agent.getMessages();
        if (messages.length <= 1)
            return;
        this.sessionManager.saveSession({
            id: this.currentSessionId,
            title: titlePrompt ? titlePrompt.slice(0, 60).replace(/\n/g, " ") : "Active Session",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            workspace: this.config.workspace,
            model: this.config.model,
            messages,
            tokenStats: this.agent.getTokenStats(),
        });
    }
    loadHistory() {
        if (fs.existsSync(this.historyFile)) {
            try {
                const data = fs.readFileSync(this.historyFile, "utf-8");
                this.history = data.split("\n").filter((l) => l.trim().length > 0);
            }
            catch {
                this.history = [];
            }
        }
    }
    appendHistory(line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("/"))
            return;
        this.history.push(trimmed);
        try {
            fs.appendFileSync(this.historyFile, `${trimmed}\n`, "utf-8");
        }
        catch {
            // ignore
        }
    }
    getLastAssistantMessage() {
        const messages = this.agent.getMessages();
        for (let i = messages.length - 1; i >= 0; i--) {
            const c = messages[i].content;
            if (messages[i].role === "assistant" && c) {
                return typeof c === "string" ? c : JSON.stringify(c);
            }
        }
        return "";
    }
    printWelcome() {
        console.log(pc.bold(pc.cyan("\n╔════════════════════════════════════════════════════════════════╗")));
        console.log(pc.bold(pc.cyan("║           NEXUS CODE HARNESS - CODEX / CLAUDE-CODE REPL        ║")));
        console.log(pc.bold(pc.cyan("╚════════════════════════════════════════════════════════════════╝")));
        console.log(pc.dim("Type your prompt or task, or type ") + pc.bold(pc.yellow("/help")) + pc.dim(" for slash commands.\n"));
        this.printStatus();
    }
    printStatus() {
        const wsName = path.basename(this.config.workspace) || this.config.workspace;
        const gitInfo = getGitInfo(this.config.workspace);
        const gitBadge = gitInfo.isRepo
            ? pc.cyan(` [git: ${pc.bold(gitInfo.formattedBadge)}]`)
            : "";
        console.log(pc.bold(pc.white("Session Status:")));
        console.log(`  • ${pc.bold("Workspace:")}   ${pc.cyan(this.config.workspace)} (${pc.yellow(wsName)})${gitBadge}`);
        console.log(`  • ${pc.bold("Model:")}       ${pc.green(this.config.model)}`);
        console.log(`  • ${pc.bold("Endpoint:")}    ${pc.dim(this.config.endpoint)}`);
        console.log(`  • ${pc.bold("Shell:")}       ${pc.magenta(this.config.shell)}`);
        console.log(`  • ${pc.bold("Mode:")}        ${this.autoApprove ? pc.green("auto (autonomous execution)") : pc.yellow("review (confirm destructive actions)")}`);
        console.log(`  • ${pc.bold("Session ID:")}   ${pc.dim(this.currentSessionId)}`);
        console.log(`  • ${pc.bold("Context:")}     ${this.agent.getHistoryCount()} messages in memory\n`);
    }
    printHelp() {
        console.log(pc.bold(pc.white("\nAvailable Slash Commands:")));
        console.log(`  ${pc.bold(pc.yellow("/help"))}               Show this commands cheatsheet`);
        console.log(`  ${pc.bold(pc.yellow("/status"))}             Show active model, workspace, endpoint, git badge`);
        console.log(`  ${pc.bold(pc.yellow("/clear"))}              Reset conversation context memory`);
        console.log(`  ${pc.bold(pc.yellow("/compact"))}            Condense earlier messages to free token budget`);
        console.log(`  ${pc.bold(pc.yellow("/mode [auto|review]"))} Toggle autonomous execution vs human review approval`);
        console.log(`  ${pc.bold(pc.yellow("/diff"))}               Show colored git diff of uncommitted changes`);
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
    async confirmAction(toolName, args) {
        if (this.autoApprove)
            return true;
        if (!this.rl)
            return true;
        console.log(pc.bold(pc.yellow(`\n⚠️  Action Approval Required:`)));
        // Hunk-by-hunk review for patch_file
        if (toolName === "patch_file" && typeof args.patch === "string") {
            const { fileHeader, hunks } = parsePatchHunks(args.patch);
            console.log(`  Target: ${pc.cyan(args.path)} (${hunks.length} hunks)`);
            if (hunks.length > 1) {
                const reviewMode = await this.rl.question(pc.bold(pc.white(`  Review ${hunks.length} hunks individually? [y/N]: `)));
                if (reviewMode.trim().toLowerCase() === "y") {
                    const acceptedHunks = [];
                    for (let i = 0; i < hunks.length; i++) {
                        const h = hunks[i];
                        console.log(pc.cyan(`\n  --- Hunk ${i + 1}/${hunks.length}: ${h.header} ---`));
                        for (const hl of h.lines) {
                            if (hl.startsWith("+"))
                                console.log(pc.green(`    ${hl}`));
                            else if (hl.startsWith("-"))
                                console.log(pc.red(`    ${hl}`));
                            else
                                console.log(pc.gray(`    ${hl}`));
                        }
                        const hunkAns = await this.rl.question(pc.bold(pc.white(`  Accept hunk [y]es, [n]o, [a]ccept all remaining, [q]uit? [Y/n/a/q]: `)));
                        const trimmedHunk = hunkAns.trim().toLowerCase();
                        if (trimmedHunk === "q") {
                            console.log(pc.dim("  Patch review aborted by user."));
                            return false;
                        }
                        if (trimmedHunk === "a") {
                            acceptedHunks.push(...hunks.slice(i));
                            break;
                        }
                        if (trimmedHunk === "" || trimmedHunk === "y") {
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
        }
        else if (toolName === "write_file") {
            console.log(`  Action: Create/overwrite ${pc.cyan(args.path)} (${args.content?.length || 0} bytes)`);
        }
        else if (toolName === "delete_file") {
            console.log(`  Action: Delete ${pc.red(args.path)}`);
        }
        else if (toolName === "run_command") {
            console.log(`  Command: ${pc.bold(pc.magenta(args.command))}`);
        }
        while (true) {
            const answer = await this.rl.question(pc.bold(pc.white(`  Approve [y]es, [n]o, [d]iff preview, [a]lways allow session? [Y/n/d/a]: `)));
            const trimmed = answer.trim().toLowerCase();
            if (trimmed === "a" || trimmed === "always") {
                this.autoApprove = true;
                console.log(pc.green("  Switched to auto-approve for remainder of session."));
                return true;
            }
            if (trimmed === "d" || trimmed === "diff") {
                if (toolName === "edit_file") {
                    console.log(pc.bold(pc.red("\n--- Snippet to Replace ---")));
                    console.log(args.old_content);
                    console.log(pc.bold(pc.green("+++ Replacement Content +++")));
                    console.log(args.new_content);
                    console.log();
                }
                else if (toolName === "write_file") {
                    console.log(pc.bold(pc.cyan(`\n--- Preview: ${args.path} ---`)));
                    const previewLines = (args.content || "").split("\n").slice(0, 30).join("\n");
                    console.log(previewLines);
                    console.log();
                }
                else if (toolName === "patch_file") {
                    console.log(pc.bold(pc.cyan(`\n--- Patch Preview: ${args.path} ---`)));
                    console.log(args.patch);
                    console.log();
                }
                else {
                    console.log(pc.dim("  No detailed diff available for this action.\n"));
                }
                continue;
            }
            return trimmed === "" || trimmed === "y" || trimmed === "yes";
        }
    }
    async start() {
        this.printWelcome();
        this.rl = readline.createInterface({
            input,
            output,
            historySize: 200,
            prompt: "",
            completer: (line) => {
                const completions = [
                    "/help", "/status", "/clear", "/reset", "/compact", "/mode",
                    "/diff", "/git", "/commit", "/sessions", "/save", "/resume", "/skills",
                    "/skill", "/mcp", "/plugins", "/plan", "/checkpoint",
                    "/checkpoints", "/undo", "/audit", "/export", "/tokens", "/init",
                    "/onboard", "/test",
                    "/model", "/shell", "/cd", "/history", "/copy", "/paste",
                    "/image", "/theme", "/team",
                    "/exit", "/quit"
                ];
                const trimmed = line.trim();
                const parts = line.split(/\s+/);
                const lastToken = parts[parts.length - 1] || "";
                // If line is starting a slash command:
                if (parts.length <= 1 && line.startsWith("/")) {
                    const hits = completions.filter((c) => c.startsWith(trimmed));
                    return [hits.length ? hits : completions, line];
                }
                // If completing /model
                if (parts[0] === "/model") {
                    const models = ["qwen2.5-coder", "deepseek-coder", "llama-3.1", "claude-3-7-sonnet", "gpt-4o", "mistral-large"];
                    const hits = models.filter((m) => m.startsWith(lastToken));
                    return [hits, lastToken];
                }
                // If completing /skill
                if (parts[0] === "/skill") {
                    const skills = this.agent.getSkillManager()?.listSkills().map((s) => s.name) || [];
                    const hits = skills.filter((s) => s.startsWith(lastToken));
                    return [hits, lastToken];
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
                            const matches = [];
                            for (const entry of entries) {
                                if (entry.name.startsWith(".") && !filePrefix.startsWith("."))
                                    continue;
                                if (entry.name.startsWith(filePrefix)) {
                                    matches.push(basePrefix + entry.name + (entry.isDirectory() ? "/" : ""));
                                }
                            }
                            if (matches.length > 0) {
                                return [matches, lastToken];
                            }
                        }
                    }
                    catch {
                        // Ignore filesystem errors during completion
                    }
                }
                return [[], lastToken];
            },
        });
        this.agent.getSkillManager().startWatcher((skills) => {
            console.log(pc.dim(`\n🔄 [Hot-Reload] Skills library updated (${skills.length} available).`));
        });
        const promptLoop = async () => {
            while (true) {
                const wsName = path.basename(this.config.workspace) || this.config.workspace;
                const gitInfo = getGitInfo(this.config.workspace);
                const gitSegment = gitInfo.isRepo ? pc.gray(`:${pc.cyan(gitInfo.formattedBadge)}`) : "";
                const promptString = `${pc.bold(pc.cyan("nexus"))} ${pc.gray("(")}${pc.green(this.config.model)}${pc.gray(")")} ${pc.yellow(wsName)}${gitSegment} ${pc.bold(pc.cyan("❯"))} `;
                let line;
                try {
                    line = await this.rl.question(promptString);
                }
                catch {
                    break;
                }
                let fullInput = line;
                // Support multiline blocks: """ or ```
                if (line.trim().startsWith('"""') || line.trim().startsWith("```")) {
                    const delimiter = line.trim().startsWith('"""') ? '"""' : "```";
                    const firstLineTrimmed = line.trim();
                    if (firstLineTrimmed.length === 3 || !firstLineTrimmed.slice(3).includes(delimiter)) {
                        while (true) {
                            const nextLine = await this.rl.question(pc.dim("... "));
                            fullInput += "\n" + nextLine;
                            if (nextLine.trim().endsWith(delimiter)) {
                                break;
                            }
                        }
                    }
                }
                else {
                    // Support trailing backslash continuation
                    while (fullInput.endsWith("\\")) {
                        fullInput = fullInput.slice(0, -1);
                        const nextLine = await this.rl.question(pc.dim("... "));
                        fullInput += "\n" + nextLine;
                    }
                }
                fullInput = fullInput.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
                let trimmed = fullInput.trim();
                if (!trimmed)
                    continue;
                // History recall shortcut: !<number>
                if (/^\!\d+$/.test(trimmed)) {
                    const idx = parseInt(trimmed.slice(1), 10) - 1;
                    if (idx >= 0 && idx < this.history.length) {
                        const recalled = this.history[idx];
                        console.log(pc.cyan(`⚡ Recalled from history [#${idx + 1}]: ${pc.bold(recalled)}`));
                        line = recalled;
                        trimmed = recalled;
                    }
                    else {
                        console.log(pc.red(`History index out of range: ${trimmed}. Type /history to view items.\n`));
                        continue;
                    }
                }
                else if (trimmed.startsWith("!")) {
                    // Direct raw shell escape (e.g. !git status, !cargo check, !ls -la)
                    const shellCmd = trimmed.slice(1).trim();
                    if (shellCmd) {
                        console.log(pc.dim(`🐚 [Direct Shell] ${shellCmd}`));
                        try {
                            const out = execSync(shellCmd, {
                                cwd: this.config.workspace,
                                shell: this.config.shell,
                                encoding: "utf-8",
                            });
                            if (out)
                                process.stdout.write(out);
                        }
                        catch (err) {
                            if (err.stdout)
                                process.stdout.write(err.stdout);
                            if (err.stderr)
                                process.stderr.write(err.stderr);
                            console.log(pc.red(`Command exited with status ${err.status}`));
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
                    }
                    else if (cmd === "help" || cmd === "?") {
                        this.printHelp();
                        continue;
                    }
                    else if (cmd === "clear" || cmd === "reset") {
                        this.agent.resetConversation();
                        console.log(pc.green("✔ Conversation context reset.\n"));
                        continue;
                    }
                    else if (cmd === "compact") {
                        const report = await this.agent.compactConversation(arg.includes("--llm"));
                        console.log(pc.green(`✔ ${report}\n`));
                        continue;
                    }
                    else if (cmd === "status") {
                        this.printStatus();
                        continue;
                    }
                    else if (cmd === "mode") {
                        if (arg === "auto" || arg === "autonomous") {
                            this.autoApprove = true;
                            console.log(pc.green("✔ Mode switched to: auto (autonomous tool execution)\n"));
                        }
                        else if (arg === "review" || arg === "ask") {
                            this.autoApprove = false;
                            console.log(pc.yellow("✔ Mode switched to: review (requires user confirmation before changes)\n"));
                        }
                        else {
                            console.log(`Current mode: ${this.autoApprove ? pc.green("auto") : pc.yellow("review")}. Use: /mode auto or /mode review\n`);
                        }
                        continue;
                    }
                    else if (cmd === "diff") {
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
                            }
                            else {
                                console.log(pc.bold(pc.white("\nGit Working Tree Diff:")));
                                for (const line of diffOut.split("\n")) {
                                    if (line.startsWith("+") && !line.startsWith("+++")) {
                                        console.log(pc.green(line));
                                    }
                                    else if (line.startsWith("-") && !line.startsWith("---")) {
                                        console.log(pc.red(line));
                                    }
                                    else if (line.startsWith("@@")) {
                                        console.log(pc.cyan(line));
                                    }
                                    else {
                                        console.log(line);
                                    }
                                }
                                console.log();
                            }
                        }
                        catch (err) {
                            console.log(pc.red(`Git diff error: ${err.message}\n`));
                        }
                        continue;
                    }
                    else if (cmd === "sessions") {
                        const list = this.sessionManager.listSessions();
                        if (list.length === 0) {
                            console.log(pc.dim("No saved sessions found in ~/.nexus/sessions/\n"));
                        }
                        else {
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
                    }
                    else if (cmd === "save") {
                        if (arg) {
                            this.currentSessionId = arg;
                        }
                        this.saveCurrentSession("Snapshot");
                        console.log(pc.green(`✔ Session saved to ~/.nexus/sessions/${this.currentSessionId}.json\n`));
                        continue;
                    }
                    else if (cmd === "resume") {
                        const sess = arg ? this.sessionManager.loadSession(arg) : this.sessionManager.getLatestSession();
                        if (!sess) {
                            console.log(pc.red(`Session not found: ${arg || "latest"}\n`));
                        }
                        else {
                            this.currentSessionId = sess.id;
                            if (sess.workspace && fs.existsSync(sess.workspace)) {
                                this.config.workspace = sess.workspace;
                                this.agent.setWorkspace(sess.workspace);
                            }
                            this.agent.setMessages(sess.messages);
                            console.log(pc.green(`✔ Resumed session ${pc.bold(sess.id)} (${sess.messages.length} messages loaded).\n`));
                        }
                        continue;
                    }
                    else if (cmd === "tokens" || cmd === "cost") {
                        const budget = this.agent.getContextBudget();
                        console.log(renderTokenGauge(budget));
                        const cumulative = this.agent.getTokenStats();
                        if (cumulative.total > 0) {
                            console.log(pc.dim(`  • Cumulative Session Usage: ${cumulative.prompt.toLocaleString()} prompt, ${cumulative.completion.toLocaleString()} completion (${cumulative.total.toLocaleString()} total tokens)\n`));
                        }
                        else {
                            console.log();
                        }
                        continue;
                    }
                    else if (cmd === "git") {
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
                        }
                        catch (err) {
                            console.log(pc.red(`Git status error: ${err.message}`));
                        }
                        console.log();
                        continue;
                    }
                    else if (cmd === "commit") {
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
                            const answer = await this.rl.question(pc.bold(pc.white(`  Accept [y], edit custom message [e], cancel [n]? [Y/e/n]: `)));
                            const trimmedAns = answer.trim().toLowerCase();
                            if (trimmedAns === "n" || trimmedAns === "no") {
                                console.log(pc.dim("Commit cancelled.\n"));
                                continue;
                            }
                            else if (trimmedAns === "e" || trimmedAns === "edit") {
                                const custom = await this.rl.question(pc.bold(pc.white("  Enter commit message: ")));
                                commitMsg = custom.trim();
                                if (!commitMsg) {
                                    console.log(pc.dim("Empty message, commit cancelled.\n"));
                                    continue;
                                }
                            }
                            else {
                                commitMsg = suggestion.message;
                            }
                        }
                        const commitRes = commitChanges(this.config.workspace, commitMsg);
                        if (commitRes.success) {
                            console.log(pc.green(`✔ Committed changes: ${pc.bold(commitRes.hash || "")} - ${commitMsg}\n`));
                        }
                        else {
                            console.log(pc.red(`Commit failed: ${commitRes.error}\n`));
                        }
                        continue;
                    }
                    else if (cmd === "init") {
                        const file = scaffoldProjectRules(this.config.workspace);
                        console.log(pc.green(`✔ Project instructions file ready at: ${file}\n`));
                        continue;
                    }
                    else if (cmd === "skills") {
                        const skills = this.agent.getSkillManager().listSkills();
                        if (skills.length === 0) {
                            console.log(pc.yellow("No skills found. Place skills in ~/.nexus/skills/<name>/SKILL.md or .nexus/skills/\n"));
                        }
                        else {
                            console.log(pc.bold(pc.white("\nInstalled Agent Skills:")));
                            for (const s of skills) {
                                console.log(`  • ${pc.bold(pc.cyan(s.name))} (${pc.dim(s.path)})`);
                                console.log(`    ${pc.gray(s.description)}`);
                            }
                            console.log(pc.dim("\nUse '/skill <name>' to view skill instructions.\n"));
                        }
                        continue;
                    }
                    else if (cmd === "skill") {
                        if (!arg) {
                            console.log("Usage: /skill <skill_name> or /skill init <skill_name>\n");
                            continue;
                        }
                        if (arg.startsWith("init ")) {
                            const skillName = arg.slice(5).trim();
                            if (!skillName) {
                                console.log(pc.yellow("Usage: /skill init <skill_name>\n"));
                            }
                            else {
                                const res = this.agent.getSkillManager().scaffoldSkill(skillName);
                                console.log(pc.green(`✔ Scaffolded new skill template at: ${pc.bold(res.skillPath)}\n`));
                            }
                            continue;
                        }
                        const skill = this.agent.getSkillManager().getSkill(arg);
                        if (!skill) {
                            console.log(pc.red(`Skill '${arg}' not found. Type /skills for available skills.\n`));
                        }
                        else {
                            console.log(pc.bold(pc.cyan(`\n=== Skill: ${skill.name} ===`)));
                            console.log(pc.dim(`Path: ${skill.path}\n`));
                            console.log(skill.content);
                            console.log(pc.bold(pc.cyan("===========================\n")));
                        }
                        continue;
                    }
                    else if (cmd === "mcp") {
                        await this.agent.initExtensibility();
                        const mcp = this.agent.getMcpManager();
                        const subArgs = arg.trim().split(/\s+/).filter(Boolean);
                        const subCmd = subArgs[0]?.toLowerCase();
                        if (subCmd === "add") {
                            console.log(pc.bold(pc.white("\n=== MCP Server Configuration Wizard ===")));
                            const name = (await this.rl.question(pc.bold(pc.white("  Server Identifier (e.g. sqlite-db, github): ")))).trim();
                            if (!name) {
                                console.log(pc.dim("Empty server name. Wizard cancelled.\n"));
                                continue;
                            }
                            const transportInput = (await this.rl.question(pc.bold(pc.white("  Transport [stdio/sse/websocket] (default: stdio): ")))).trim().toLowerCase();
                            const transport = transportInput === "sse" || transportInput === "websocket" ? transportInput : "stdio";
                            let config = { transport };
                            if (transport === "stdio") {
                                const command = (await this.rl.question(pc.bold(pc.white("  Executable command (e.g. npx -y @modelcontextprotocol/server-sqlite): ")))).trim();
                                if (!command) {
                                    console.log(pc.dim("Empty command. Wizard cancelled.\n"));
                                    continue;
                                }
                                const parts = command.split(/\s+/);
                                config.command = parts[0];
                                config.args = parts.slice(1);
                            }
                            else {
                                const url = (await this.rl.question(pc.bold(pc.white("  Endpoint URL (e.g. http://localhost:8000/sse): ")))).trim();
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
                            }
                            else {
                                console.log(pc.red(`✖ MCP connection failed: ${res.error}\n`));
                            }
                        }
                        else if (subCmd === "resources") {
                            const resources = mcp.listResources();
                            if (resources.length === 0) {
                                console.log(pc.yellow("No MCP resources exposed by connected servers.\n"));
                            }
                            else {
                                console.log(pc.bold(pc.white("\nExposed MCP Resources:")));
                                for (const r of resources) {
                                    console.log(`  • ${pc.bold(pc.cyan(r.name))} (${pc.dim(r.uri)}) [${pc.gray(r.server)}]`);
                                    if (r.description)
                                        console.log(`    ${pc.gray(r.description)}`);
                                }
                                console.log(pc.dim("\nUse '/mcp resource <uri>' to inspect content.\n"));
                            }
                        }
                        else if (subCmd === "resource") {
                            const uri = subArgs.slice(1).join(" ").trim();
                            if (!uri) {
                                console.log(pc.yellow("Usage: /mcp resource <uri>\n"));
                            }
                            else {
                                const res = await mcp.readResource(uri);
                                if (res.success) {
                                    console.log(pc.bold(pc.cyan(`\n=== MCP Resource: ${uri} ===`)));
                                    console.log(res.content || "");
                                    console.log(pc.bold(pc.cyan("================================\n")));
                                }
                                else {
                                    console.log(pc.red(`Error reading resource: ${res.error}\n`));
                                }
                            }
                        }
                        else if (subCmd === "prompts") {
                            const prompts = mcp.listPrompts();
                            if (prompts.length === 0) {
                                console.log(pc.yellow("No MCP prompt templates exposed by connected servers.\n"));
                            }
                            else {
                                console.log(pc.bold(pc.white("\nExposed MCP Prompt Templates:")));
                                for (const p of prompts) {
                                    const argsDesc = p.arguments && p.arguments.length > 0
                                        ? ` (args: ${p.arguments.map((a) => a.name).join(", ")})`
                                        : "";
                                    console.log(`  • ${pc.bold(pc.yellow(p.name))}${pc.dim(argsDesc)} [${pc.gray(p.server)}]`);
                                    if (p.description)
                                        console.log(`    ${pc.gray(p.description)}`);
                                }
                                console.log(pc.dim("\nUse '/mcp prompt <name>' to inspect prompt template.\n"));
                            }
                        }
                        else if (subCmd === "prompt") {
                            const name = subArgs[1];
                            if (!name) {
                                console.log(pc.yellow("Usage: /mcp prompt <name>\n"));
                            }
                            else {
                                const res = await mcp.getPrompt(name);
                                if (res.success) {
                                    console.log(pc.bold(pc.yellow(`\n=== MCP Prompt: ${name} ===`)));
                                    if (res.description)
                                        console.log(pc.dim(res.description) + "\n");
                                    console.log(JSON.stringify(res.messages, null, 2));
                                    console.log(pc.bold(pc.yellow("==========================\n")));
                                }
                                else {
                                    console.log(pc.red(`Error fetching prompt: ${res.error}\n`));
                                }
                            }
                        }
                        else {
                            const servers = mcp.listServers();
                            const tools = mcp.getToolDefinitions();
                            if (servers.length === 0) {
                                console.log(pc.yellow("No MCP servers configured. Use '/mcp add' to configure a server.\n"));
                            }
                            else {
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
                    }
                    else if (cmd === "plugins") {
                        await this.agent.initExtensibility();
                        const plugins = this.agent.getPluginManager().listPlugins();
                        if (plugins.length === 0) {
                            console.log(pc.yellow("No active plugins found in ~/.nexus/plugins/ or ~/.config/opencode/plugins/\n"));
                        }
                        else {
                            console.log(pc.bold(pc.white("\nLoaded Custom Plugins:")));
                            for (const p of plugins) {
                                console.log(`  • ${pc.bold(pc.cyan(p.name))}: ${pc.gray(p.description)} (custom tools: ${p.customToolCount})`);
                            }
                            console.log();
                        }
                        continue;
                    }
                    else if (cmd === "history") {
                        const query = arg.trim();
                        if (query.startsWith("run ") || /^\d+$/.test(query)) {
                            const rawNum = query.startsWith("run ") ? query.slice(4).trim() : query;
                            const idx = parseInt(rawNum, 10) - 1;
                            if (idx >= 0 && idx < this.history.length) {
                                const recalled = this.history[idx];
                                console.log(pc.cyan(`⚡ Running from history [#${idx + 1}]: ${pc.bold(recalled)}`));
                                this.checkpointManager.createCheckpoint(`Turn: ${recalled.slice(0, 30)}`);
                                await this.agent.runTurn(recalled, (tool, args) => this.confirmAction(tool, args));
                                this.saveCurrentSession(recalled);
                            }
                            else {
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
                            }
                            else {
                                console.log(pc.bold(pc.white(`\nHistory search matches for "${query}":`)));
                                for (const { item, index } of matches) {
                                    const highlighted = item.replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => pc.bold(pc.yellow(m)));
                                    console.log(`  ${pc.gray(`[${index + 1}]`)} ${highlighted}`);
                                }
                                console.log(pc.dim("\nUse '!<num>' or '/history run <num>' to re-run any item.\n"));
                            }
                        }
                        else {
                            console.log(pc.bold(pc.white("\nRecent Command History:")));
                            const startIdx = Math.max(0, this.history.length - 20);
                            for (let i = startIdx; i < this.history.length; i++) {
                                console.log(`  ${pc.gray(`[${i + 1}]`)} ${this.history[i]}`);
                            }
                            console.log(pc.dim("\nUse '/history <query>' to search or '!<num>' to re-run.\n"));
                        }
                        continue;
                    }
                    else if (cmd === "copy") {
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
                                }
                                else {
                                    const res = copyToClipboard(diffOut);
                                    if (res.success) {
                                        console.log(pc.green(`✔ Copied git diff (${diffOut.split("\n").length} lines) to clipboard.\n`));
                                    }
                                    else {
                                        console.log(pc.red(`Clipboard error: ${res.error}\n`));
                                    }
                                }
                            }
                            catch (err) {
                                console.log(pc.red(`Git diff error: ${err.message}\n`));
                            }
                        }
                        else if (subArg === "code") {
                            const lastAssistant = this.getLastAssistantMessage();
                            if (!lastAssistant) {
                                console.log(pc.yellow("No assistant response available in conversation history.\n"));
                                continue;
                            }
                            const codeBlocks = [];
                            const regex = /```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
                            let match;
                            while ((match = regex.exec(lastAssistant)) !== null) {
                                codeBlocks.push(match[1].trimEnd());
                            }
                            const contentToCopy = codeBlocks.length > 0 ? codeBlocks.join("\n\n// ────────────────────────────\n\n") : lastAssistant;
                            const res = copyToClipboard(contentToCopy);
                            if (res.success) {
                                console.log(pc.green(`✔ Copied ${codeBlocks.length > 0 ? `${codeBlocks.length} code block(s)` : "latest response"} to clipboard.\n`));
                            }
                            else {
                                console.log(pc.red(`Clipboard error: ${res.error}\n`));
                            }
                        }
                        else {
                            const lastAssistant = this.getLastAssistantMessage();
                            if (!lastAssistant) {
                                console.log(pc.yellow("No assistant response available in conversation history.\n"));
                                continue;
                            }
                            const res = copyToClipboard(lastAssistant);
                            if (res.success) {
                                console.log(pc.green(`✔ Copied last assistant response (${lastAssistant.length} chars) to clipboard.\n`));
                            }
                            else {
                                console.log(pc.red(`Clipboard error: ${res.error}\n`));
                            }
                        }
                        continue;
                    }
                    else if (cmd === "paste") {
                        const res = readFromClipboard();
                        if (!res.success || !res.text) {
                            console.log(pc.red(`Clipboard error: ${res.error || "Clipboard is empty"}\n`));
                        }
                        else {
                            const preview = res.text.length > 200 ? res.text.slice(0, 200) + "..." : res.text;
                            console.log(pc.bold(pc.white(`\nClipboard contents (${res.text.length} chars):`)));
                            console.log(pc.gray(preview));
                            const confirm = await this.rl.question(pc.bold(pc.white(`\nSend clipboard content as user prompt? [y/N]: `)));
                            if (confirm.trim().toLowerCase() === "y" || confirm.trim().toLowerCase() === "yes") {
                                this.checkpointManager.createCheckpoint(`Turn: ${res.text.slice(0, 30)}`);
                                await this.agent.runTurn(res.text, (tool, args) => this.confirmAction(tool, args));
                                this.saveCurrentSession(res.text);
                            }
                            else {
                                console.log(pc.dim("Paste cancelled.\n"));
                            }
                        }
                        continue;
                    }
                    else if (cmd === "image") {
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
                        this.checkpointManager.createCheckpoint(`Vision: ${userPrompt.slice(0, 30)}`);
                        await this.agent.runTurn(visionPayload, (tool, args) => this.confirmAction(tool, args));
                        this.saveCurrentSession(userPrompt);
                        continue;
                    }
                    else if (cmd === "theme") {
                        if (!arg) {
                            const themes = this.themeManager.listThemes();
                            console.log(pc.bold(pc.white("\nAvailable Color Themes:")));
                            for (const t of themes) {
                                const isCurrent = t === this.themeManager.getThemeName();
                                const marker = isCurrent ? pc.bold(pc.green("* ")) : "  ";
                                console.log(`${marker}${pc.cyan(t)}`);
                            }
                            console.log(pc.dim("\nUse '/theme <name>' to apply and persist a theme.\n"));
                        }
                        else {
                            const ok = this.themeManager.saveConfiguredTheme(arg.trim());
                            if (ok) {
                                console.log(pc.green(`✔ Color theme switched to: ${pc.bold(arg.trim())}\n`));
                            }
                            else {
                                console.log(pc.red(`Unknown theme '${arg}'. Options: ${this.themeManager.listThemes().join(", ")}\n`));
                            }
                        }
                        continue;
                    }
                    else if (cmd === "team") {
                        const subParts = arg.trim().split(/\s+/);
                        const subCmd = subParts[0]?.toLowerCase();
                        const task = subParts.slice(1).join(" ").trim();
                        if (!subCmd || !task) {
                            console.log(pc.yellow("Usage: /team <researcher|architect|implementer|tester|full> <objective>\n"));
                            continue;
                        }
                        const orchestrator = new TeamOrchestrator(this.config);
                        if (subCmd === "full") {
                            console.log(pc.bold(pc.cyan(`\n👥 Launching Multi-Agent Collaborative Team Workflow...`)));
                            console.log(pc.dim(`Objective: ${task}\n`));
                            this.agent.getUi().startSpinner("Orchestrating team phases (Researcher -> Architect -> Implementer -> Tester)...");
                            const result = await orchestrator.runFullWorkflow(task);
                            this.agent.getUi().stopSpinner(result.success);
                            console.log(result.finalReport);
                            console.log();
                        }
                        else if (["researcher", "architect", "implementer", "tester"].includes(subCmd)) {
                            console.log(pc.bold(pc.cyan(`\n👤 Delegating to Specialized Role: ${subCmd.toUpperCase()}...`)));
                            this.agent.getUi().startSpinner(`Executing ${subCmd} task...`);
                            const result = await orchestrator.executeRoleTask(subCmd, task);
                            this.agent.getUi().stopSpinner(result.success);
                            console.log(pc.bold(pc.white(`\nRole [${subCmd.toUpperCase()}] Summary:`)));
                            console.log(result.summary);
                            console.log(pc.dim(`Duration: ${(result.durationMs / 1000).toFixed(1)}s | Steps: ${result.steps}\n`));
                        }
                        else {
                            console.log(pc.red(`Unknown role '${subCmd}'. Available: researcher, architect, implementer, tester, full\n`));
                        }
                        continue;
                    }
                    else if (cmd === "shell") {
                        if (arg) {
                            this.config.shell = arg;
                            this.agent.setShell(arg);
                            console.log(pc.green(`✔ Shell switched to ${arg}\n`));
                        }
                        else {
                            console.log(`Active shell: ${pc.cyan(this.config.shell)}\n`);
                        }
                        continue;
                    }
                    else if (cmd === "plan") {
                        const subArgs = arg.trim().split(/\s+/).filter(Boolean);
                        const subCmd = subArgs[0]?.toLowerCase();
                        if (subCmd === "add") {
                            const phaseName = subArgs.slice(1).join(" ");
                            if (!phaseName) {
                                console.log(pc.yellow("Usage: /plan add <phase description>\n"));
                            }
                            else {
                                const plan = [...this.agent.getActivePlan(), { name: phaseName, status: "pending" }];
                                this.agent.setActivePlan(plan);
                                console.log(pc.green(`✔ Added phase to plan: ${pc.bold(phaseName)}\n`));
                                this.agent.getUi().renderPlan(plan);
                            }
                        }
                        else if (subCmd === "done" || subCmd === "complete") {
                            const idx = parseInt(subArgs[1], 10) - 1;
                            const plan = [...this.agent.getActivePlan()];
                            if (isNaN(idx) || idx < 0 || idx >= plan.length) {
                                console.log(pc.red(`Invalid phase number. Usage: /plan done <1..${plan.length}>\n`));
                            }
                            else {
                                plan[idx] = { ...plan[idx], status: "completed" };
                                this.agent.setActivePlan(plan);
                                console.log(pc.green(`✔ Phase ${idx + 1} marked as completed.\n`));
                                this.agent.getUi().renderPlan(plan);
                            }
                        }
                        else if (subCmd === "start") {
                            const idx = parseInt(subArgs[1], 10) - 1;
                            const plan = [...this.agent.getActivePlan()];
                            if (isNaN(idx) || idx < 0 || idx >= plan.length) {
                                console.log(pc.red(`Invalid phase number. Usage: /plan start <1..${plan.length}>\n`));
                            }
                            else {
                                plan[idx] = { ...plan[idx], status: "in_progress" };
                                this.agent.setActivePlan(plan);
                                console.log(pc.green(`✔ Phase ${idx + 1} marked as in progress.\n`));
                                this.agent.getUi().renderPlan(plan);
                            }
                        }
                        else if (subCmd === "clear") {
                            this.agent.setActivePlan([]);
                            console.log(pc.green("✔ Active plan cleared.\n"));
                        }
                        else {
                            const plan = this.agent.getActivePlan();
                            if (!plan || plan.length === 0) {
                                console.log(pc.yellow("No active plan currently defined. Use '/plan add <milestone>' to create phases.\n"));
                            }
                            else {
                                this.agent.getUi().renderPlan(plan);
                            }
                        }
                        continue;
                    }
                    else if (cmd === "onboard") {
                        console.log(pc.dim(`🔍 Scanning workspace at ${this.config.workspace}...`));
                        const report = scanAndOnboardWorkspace(this.config.workspace, true);
                        console.log(pc.green(`✔ Onboarding complete for ${pc.bold(report.projectName)}!`));
                        console.log(`  • Detected stack: ${pc.cyan(report.languages.join(", ") || "General")}`);
                        console.log(`  • Detected commands: build: ${report.buildCommands[0] || "none"}, test: ${report.testCommands[0] || "none"}, lint: ${report.lintCommands[0] || "none"}`);
                        console.log(`  • Generated customized ${pc.bold("AGENTS.md")} with architecture diagram.\n`);
                        continue;
                    }
                    else if (cmd === "test") {
                        const filterPattern = arg.trim() || undefined;
                        console.log(pc.dim(`🧪 Running automated test suite${filterPattern ? ` matching "${filterPattern}"` : ""}...`));
                        const res = runTestSuite(this.config.workspace, filterPattern);
                        console.log(pc.dim(`  Command: ${res.command}`));
                        if (res.success) {
                            console.log(pc.green(`✔ Test suite PASSED!\n`));
                        }
                        else {
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
                    }
                    else if (cmd === "checkpoint") {
                        const subArgs = arg.trim().split(/\s+/).filter(Boolean);
                        const subCmd = subArgs[0]?.toLowerCase();
                        if (subCmd === "diff") {
                            const cpId = subArgs[1];
                            if (!cpId) {
                                console.log("Usage: /checkpoint diff <checkpoint_id> [base_checkpoint_id]\n");
                            }
                            else {
                                const baseId = subArgs[2];
                                const res = this.checkpointManager.getDiff(cpId, baseId);
                                if (res.success) {
                                    console.log(pc.bold(pc.white(`\nCheckpoint Diff (${cpId}${baseId ? ` vs ${baseId}` : " vs current"}):`)));
                                    this.agent.getUi().renderDiff(res.diff);
                                }
                                else {
                                    console.log(pc.red(`Diff error: ${res.error}\n`));
                                }
                            }
                        }
                        else if (subCmd === "prune") {
                            const keepCount = subArgs[1] ? parseInt(subArgs[1], 10) : 20;
                            const res = this.checkpointManager.pruneCheckpoints(keepCount);
                            console.log(pc.green(`✔ ${res.message}\n`));
                        }
                        else {
                            const cpName = arg ? arg : undefined;
                            const cp = this.checkpointManager.createCheckpoint(cpName);
                            console.log(pc.green(`✔ Checkpoint saved: ${pc.bold(cp.name)} (${cp.id})\n`));
                        }
                        continue;
                    }
                    else if (cmd === "checkpoints") {
                        const cps = this.checkpointManager.listCheckpoints();
                        if (cps.length === 0) {
                            console.log(pc.yellow("No saved checkpoints.\n"));
                        }
                        else {
                            console.log(pc.bold(pc.white("\nSaved Workspace Checkpoints:")));
                            cps.forEach((cp, idx) => {
                                console.log(`  ${idx + 1}. ${pc.cyan(cp.id)} - ${pc.bold(cp.name)} ${pc.gray(`(${cp.timestamp})`)}`);
                            });
                            console.log(pc.dim("\nUse '/checkpoint diff <id>' to inspect changes, or '/undo' to roll back.\n"));
                        }
                        continue;
                    }
                    else if (cmd === "undo") {
                        const res = this.checkpointManager.rollbackLast();
                        if (res.success) {
                            console.log(pc.green(`✔ ${res.message}\n`));
                        }
                        else {
                            console.log(pc.red(`✖ ${res.message}\n`));
                        }
                        continue;
                    }
                    else if (cmd === "audit") {
                        const auditFile = path.join(os.homedir(), ".nexus", "audit.log");
                        if (!fs.existsSync(auditFile)) {
                            console.log(pc.dim("No audit records found in ~/.nexus/audit.log\n"));
                        }
                        else {
                            const limit = arg ? parseInt(arg, 10) : 15;
                            try {
                                const raw = fs.readFileSync(auditFile, "utf-8");
                                const lines = raw.trim().split("\n").filter(Boolean);
                                const records = lines.slice(-limit).map((l) => {
                                    try {
                                        return JSON.parse(l);
                                    }
                                    catch {
                                        return null;
                                    }
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
                            }
                            catch (e) {
                                console.log(pc.red(`Failed to read audit log: ${e.message}\n`));
                            }
                        }
                        continue;
                    }
                    else if (cmd === "export") {
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
                        if (format === "json") {
                            fs.writeFileSync(outPath, JSON.stringify(sess, null, 2), "utf-8");
                        }
                        else {
                            let md = `# Nexus Code Session Export\n\n- **Session ID:** \`${sess.id}\`\n- **Workspace:** \`${sess.workspace}\`\n- **Date:** ${sess.createdAt}\n- **Model:** \`${sess.model}\`\n\n---\n\n`;
                            for (const m of sess.messages) {
                                if (m.role === "system")
                                    continue;
                                md += `### ${m.role === "user" ? "👤 User" : m.role === "assistant" ? "🤖 Nexus" : "⚡ Tool (" + m.name + ")"}\n\n`;
                                md += `${m.content}\n\n---\n\n`;
                            }
                            fs.writeFileSync(outPath, md, "utf-8");
                        }
                        console.log(pc.green(`✔ Session transcript exported to: ${pc.bold(outPath)}\n`));
                        continue;
                    }
                    else if (cmd === "cd") {
                        if (arg) {
                            const newPath = path.resolve(this.config.workspace, arg);
                            this.config.workspace = newPath;
                            this.agent.setWorkspace(newPath);
                            this.checkpointManager = new CheckpointManager(newPath);
                            console.log(pc.green(`✔ Workspace changed to ${newPath}\n`));
                        }
                        else {
                            console.log(`Current workspace: ${pc.cyan(this.config.workspace)}\n`);
                        }
                        continue;
                    }
                    else if (cmd === "model") {
                        if (arg) {
                            this.config.model = arg;
                            this.agent.setModel(arg);
                            console.log(pc.green(`✔ Active model changed to ${arg}\n`));
                        }
                        else {
                            console.log(pc.dim(`Fetching available models from ${this.config.endpoint}...`));
                            try {
                                const client = new LocalLlmClient(this.config);
                                const models = await client.listModels();
                                console.log(pc.green(`Available models:`));
                                for (const m of models) {
                                    const indicator = m === this.config.model ? pc.bold(pc.green(`* ${m} (active)`)) : `  ${m}`;
                                    console.log(indicator);
                                }
                            }
                            catch (e) {
                                console.log(pc.red(`Error fetching models: ${e.message}`));
                            }
                            console.log();
                        }
                        continue;
                    }
                    else {
                        console.log(pc.red(`Unknown command: /${cmd}. Type /help for available commands.\n`));
                        continue;
                    }
                }
                // Regular user prompt: run agent turn
                try {
                    this.checkpointManager.createCheckpoint(`Turn: ${trimmed.slice(0, 30)}`);
                    await this.agent.runTurn(trimmed, (tool, args) => this.confirmAction(tool, args));
                    this.saveCurrentSession(trimmed);
                }
                catch (err) {
                    console.error(pc.red(`\nTurn error: ${err.message}\n`));
                }
            }
        };
        await promptLoop();
        this.agent.shutdown();
        this.rl.close();
    }
}
