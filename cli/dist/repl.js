import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import pc from "picocolors";
import { AutonomousAgent } from "./agent.js";
import { LocalLlmClient } from "./client.js";
import { getGitInfo, scaffoldProjectRules } from "./git.js";
import { SessionManager } from "./session.js";
import { CheckpointManager } from "./checkpoint.js";
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
        console.log(`  ${pc.bold(pc.yellow("/skill <name>"))}        View specialized skill instructions`);
        console.log(`  ${pc.bold(pc.yellow("/mcp"))}                List connected MCP servers and external tools`);
        console.log(`  ${pc.bold(pc.yellow("/plugins"))}            List loaded custom plugins and lifecycle hooks`);
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
        console.log(`  ${pc.bold(pc.yellow("/history"))}            Show recent prompt history`);
        console.log(`  ${pc.bold(pc.yellow("!<command>"))}           Run raw shell command directly (e.g. !git status)`);
        console.log(`  ${pc.bold(pc.yellow("/exit"))} or ${pc.bold(pc.yellow("/quit"))}       Exit session\n`);
    }
    async confirmAction(toolName, args) {
        if (this.autoApprove)
            return true;
        if (!this.rl)
            return true;
        console.log(pc.bold(pc.yellow(`\n⚠️  Action Approval Required:`)));
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
        const answer = await this.rl.question(pc.bold(pc.white(`  Approve [y]es, [n]o, [a]lways allow session? [Y/n/a]: `)));
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === "a" || trimmed === "always") {
            this.autoApprove = true;
            console.log(pc.green("  Switched to auto-approve for remainder of session."));
            return true;
        }
        return trimmed === "" || trimmed === "y" || trimmed === "yes";
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
                    "/diff", "/git", "/sessions", "/save", "/resume", "/skills",
                    "/skill", "/mcp", "/plugins", "/plan", "/checkpoint",
                    "/checkpoints", "/undo", "/audit", "/export", "/tokens", "/init",
                    "/model", "/shell", "/cd", "/history", "/exit", "/quit"
                ];
                const trimmed = line.trim();
                const hits = completions.filter((c) => c.startsWith(trimmed));
                return [hits.length ? hits : completions, line];
            },
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
                const trimmed = fullInput.trim();
                if (!trimmed)
                    continue;
                // Direct raw shell escape (e.g. !git status, !cargo check, !ls -la)
                if (trimmed.startsWith("!")) {
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
                        const report = this.agent.compactConversation();
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
                        console.log(pc.bold(pc.white("\nContext & Token Statistics:")));
                        console.log(`  • Messages in active context: ${this.agent.getHistoryCount()}`);
                        console.log(`  • Estimated turns completed: ${Math.floor(this.agent.getHistoryCount() / 2)}`);
                        console.log(`  • Model: ${pc.green(this.config.model)}`);
                        console.log(`  • Session ID: ${pc.dim(this.currentSessionId)}\n`);
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
                            console.log("Usage: /skill <skill_name>\n");
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
                        const servers = mcp.listServers();
                        const tools = mcp.getToolDefinitions();
                        if (servers.length === 0) {
                            console.log(pc.yellow("No MCP servers configured. Add servers in ~/.config/nexus/mcp.json or .mcp.json\n"));
                        }
                        else {
                            console.log(pc.bold(pc.white("\nConfigured MCP Servers:")));
                            for (const s of servers) {
                                const status = s.connected ? pc.green("CONNECTED") : pc.red("DISCONNECTED");
                                console.log(`  • ${pc.bold(pc.cyan(s.name))} [${status}] (${pc.dim(s.command)})`);
                                console.log(`    Tools exposed: ${s.toolCount}`);
                            }
                            if (tools.length > 0) {
                                console.log(pc.bold(pc.white("\nAvailable MCP Tools:")));
                                for (const t of tools) {
                                    console.log(`  ⚡ ${pc.yellow(t.function.name)}: ${pc.gray(t.function.description)}`);
                                }
                            }
                            console.log();
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
                        console.log(pc.bold(pc.white("\nRecent Command History:")));
                        const recent = this.history.slice(-15);
                        for (let i = 0; i < recent.length; i++) {
                            console.log(`  ${pc.gray(i + 1)} ${recent[i]}`);
                        }
                        console.log();
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
                        const plan = this.agent.getActivePlan();
                        if (!plan || plan.length === 0) {
                            console.log(pc.yellow("No active plan currently defined. The agent will formulate a plan when given a multi-step objective.\n"));
                        }
                        else {
                            this.agent.getUi().renderPlan(plan);
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
