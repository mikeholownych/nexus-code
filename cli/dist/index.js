#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { AutonomousAgent } from "./agent.js";
import { InteractiveRepl } from "./repl.js";
import { LocalLlmClient, readLatestAuthToken } from "./client.js";
import { SessionManager } from "./session.js";
import { SkillManager } from "./skills.js";
import { McpClientManager } from "./mcp.js";
import { PluginManager } from "./plugins.js";
import pc from "picocolors";
import * as os from "node:os";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 1. Installation directory defaults
loadDotenv({ path: path.resolve(__dirname, "../.env") });
// 2. Global user config (~/.config/nexus/config.env)
const globalConfig = path.join(os.homedir(), ".config/nexus/config.env");
if (fs.existsSync(globalConfig)) {
    loadDotenv({ path: globalConfig, override: true });
}
// 3. Current working directory overrides
loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: true });
const program = new Command();
program
    .name("harness")
    .description("Nexus Code - Custom Autonomous Coding Harness for Local AI (LM Studio / vLLM)")
    .version("1.0.0");
function buildConfig(options) {
    const endpoint = options.endpoint || process.env.LOCAL_LLM_ENDPOINT || "http://localhost:1234/v1";
    const model = options.model || process.env.LOCAL_LLM_MODEL || "local-model";
    const apiKey = options.apiKey || process.env.LOCAL_LLM_API_KEY || readLatestAuthToken() || "local";
    const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const maxSteps = options.maxSteps ? parseInt(options.maxSteps, 10) : 30;
    const temperature = options.temperature ? parseFloat(options.temperature) : 0.2;
    const shell = options.shell || process.env.LOCAL_HARNESS_SHELL || "bash";
    return {
        endpoint,
        model,
        apiKey,
        workspace,
        maxSteps,
        temperature,
        shell,
    };
}
program
    .command("repl", { isDefault: true })
    .description("Start interactive coding session (REPL / TUI)")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
    .option("-m, --model <name>", "Model name identifier (default: active model in vLLM)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-s, --max-steps <number>", "Maximum steps per turn (default: 30)")
    .option("-t, --temperature <number>", "Model temperature (default: 0.2)")
    .option("--shell <type>", "Linux shell to use: bash, zsh, or sh (default: bash)", "bash")
    .option("--approve", "Require human approval before destructive actions (edits, shell commands)")
    .option("-r, --resume [id]", "Resume previous session (defaults to latest if id omitted)")
    .action(async (options) => {
    const config = buildConfig(options);
    if (config.model === "local-model") {
        try {
            const client = new LocalLlmClient(config);
            const models = await client.listModels();
            if (models.length > 0) {
                config.model = models[0];
            }
        }
        catch {
            // Fallback
        }
    }
    const resumeId = typeof options.resume === "string" ? options.resume : options.resume ? "latest" : undefined;
    const repl = new InteractiveRepl(config, !options.approve, resumeId);
    await repl.start();
});
program
    .command("run")
    .description("Run an autonomous coding task")
    .argument("<prompt...>", "The coding instructions / task prompt")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: http://localhost:1234/v1 or $LOCAL_LLM_ENDPOINT)")
    .option("-m, --model <name>", "Model name identifier (default: active model in LM Studio/vLLM)")
    .option("-w, --workspace <path>", "Workspace directory to inspect and modify (default: current directory)")
    .option("-s, --max-steps <number>", "Maximum autonomous agent steps", "30")
    .option("-t, --temperature <number>", "Model temperature", "0.2")
    .option("--shell <type>", "Linux shell to use: bash, zsh, or sh (default: bash or $LOCAL_HARNESS_SHELL)", "bash")
    .action(async (promptParts, options) => {
    const prompt = promptParts.join(" ");
    const config = buildConfig(options);
    // Auto-detect loaded model if model is 'local-model'
    if (config.model === "local-model") {
        try {
            const client = new LocalLlmClient(config);
            const models = await client.listModels();
            if (models.length > 0) {
                config.model = models[0];
                console.log(pc.dim(`🔍 Auto-detected active model: ${pc.bold(config.model)}`));
            }
        }
        catch {
            // Fallback to default
        }
    }
    const agent = new AutonomousAgent(config);
    try {
        await agent.run(prompt);
        const sm = new SessionManager();
        sm.saveSession({
            id: sm.generateSessionId(),
            title: prompt.slice(0, 60),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            workspace: config.workspace,
            model: config.model,
            messages: agent.getMessages(),
            tokenStats: agent.getTokenStats(),
        });
    }
    catch (err) {
        console.error(pc.red(`\nAgent failed: ${err.message}`));
        agent.shutdown();
        process.exit(1);
    }
    finally {
        agent.shutdown();
        process.exit(0);
    }
});
program
    .command("models")
    .description("List loaded models from your local LM Studio or vLLM server")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
    .option("-k, --api-key <key>", "API key / token (default: $LOCAL_LLM_API_KEY)")
    .action(async (options) => {
    const config = buildConfig(options);
    const client = new LocalLlmClient(config);
    console.log(pc.cyan(`\nQuerying models from ${config.endpoint}...`));
    try {
        const models = await client.listModels();
        if (models.length === 0) {
            console.log(pc.yellow("No models returned by local server."));
        }
        else {
            console.log(pc.green(`\nAvailable Models (${models.length}):`));
            for (const m of models) {
                console.log(`  • ${pc.bold(m)}`);
            }
        }
    }
    catch (err) {
        console.error(pc.red(`Error: ${err.message}`));
    }
    console.log();
});
program
    .command("check")
    .description("Verify local LLM connectivity, Rust engine, and Linux shell environment")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
    .option("-k, --api-key <key>", "API key / token (default: $LOCAL_LLM_API_KEY)")
    .option("--shell <type>", "Linux shell to test")
    .action(async (options) => {
    const config = buildConfig(options);
    console.log(pc.bold(pc.cyan("\n=== Nexus Code Harness Health Check ===\n")));
    // 1. Check Local Server
    process.stdout.write("1. Local LLM Server: ");
    try {
        const client = new LocalLlmClient(config);
        const models = await client.listModels();
        console.log(pc.green(`CONNECTED (${config.endpoint})`));
        console.log(pc.dim(`   Loaded models: ${models.join(", ") || "None loaded"}`));
    }
    catch (err) {
        console.log(pc.yellow(`UNREACHABLE (${err.message})`));
        console.log(pc.dim("   Make sure LM Studio (Local Server ON) or vLLM is running."));
    }
    // 2. Check Rust Core
    process.stdout.write("2. Rust Core Engine: ");
    const candidateRelease = path.resolve(__dirname, "../../core/target/release/harness-core");
    const candidateDebug = path.resolve(__dirname, "../../core/target/debug/harness-core");
    const candidateReleaseExe = path.resolve(__dirname, "../../core/target/release/harness-core.exe");
    const candidateDebugExe = path.resolve(__dirname, "../../core/target/debug/harness-core.exe");
    const resolvedBin = [candidateRelease, candidateDebug, candidateReleaseExe, candidateDebugExe].find(fs.existsSync);
    if (resolvedBin) {
        console.log(pc.green(`READY (${resolvedBin})`));
    }
    else {
        console.log(pc.yellow("NOT COMPILED (Will run via `cargo run` automatically)"));
    }
    // 3. Check Linux Shell
    process.stdout.write(`3. Linux Shell (${config.shell}): `);
    try {
        const out = execSync(`${config.shell} -c "uname -a"`, { encoding: "utf-8" }).trim();
        console.log(pc.green(`READY`));
        console.log(pc.dim(`   System: ${out}`));
    }
    catch (err) {
        console.log(pc.red(`FAILED (${err.message})`));
        console.log(pc.dim(`   Ensure ${config.shell} is installed and in PATH.`));
    }
    console.log(pc.bold(pc.cyan("\n========================================\n")));
});
program
    .command("sessions")
    .description("List past interactive sessions and saved transcripts")
    .action(() => {
    const sm = new SessionManager();
    const list = sm.listSessions();
    if (list.length === 0) {
        console.log(pc.yellow("\nNo saved sessions found in ~/.nexus/sessions/\n"));
        return;
    }
    console.log(pc.bold(pc.cyan("\n=== Saved Nexus Sessions ===\n")));
    for (const s of list) {
        console.log(`• ${pc.bold(pc.green(s.id))} (${pc.gray(s.updatedAt.slice(0, 19))})`);
        console.log(`  Title: ${pc.white(s.title)}`);
        console.log(`  Workspace: ${pc.dim(s.workspace)} | Messages: ${s.messageCount}\n`);
    }
    console.log(pc.dim("Resume any session with: harness repl --resume <session_id>\n"));
});
program
    .command("skills")
    .description("List installed agent skills and their descriptions")
    .option("-w, --workspace <path>", "Workspace directory")
    .action((options) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const sm = new SkillManager(ws);
    const skills = sm.listSkills();
    if (skills.length === 0) {
        console.log(pc.yellow("\nNo skills found. Place skills in ~/.nexus/skills/<name>/SKILL.md or .nexus/skills/\n"));
        return;
    }
    console.log(pc.bold(pc.cyan("\n=== Installed Agent Skills ===\n")));
    for (const s of skills) {
        console.log(`• ${pc.bold(pc.green(s.name))} (${pc.dim(s.path)})`);
        console.log(`  ${s.description}\n`);
    }
});
program
    .command("mcp")
    .description("Check connected MCP servers and inspect exposed tools")
    .option("-w, --workspace <path>", "Workspace directory")
    .action(async (options) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const mcp = new McpClientManager(ws);
    console.log(pc.dim("\nConnecting to configured MCP servers..."));
    await mcp.loadAndConnect();
    const servers = mcp.listServers();
    const tools = mcp.getToolDefinitions();
    if (servers.length === 0) {
        console.log(pc.yellow("No MCP servers configured in ~/.config/nexus/mcp.json or .mcp.json\n"));
        return;
    }
    console.log(pc.bold(pc.cyan("\n=== Configured MCP Servers ===\n")));
    for (const s of servers) {
        const status = s.connected ? pc.green("CONNECTED") : pc.red("DISCONNECTED");
        console.log(`• ${pc.bold(s.name)} [${status}]`);
        console.log(`  Command: ${pc.dim(s.command)}`);
        console.log(`  Tools: ${s.toolCount}\n`);
    }
    if (tools.length > 0) {
        console.log(pc.bold(pc.cyan("=== Discovered MCP Tools ===\n")));
        for (const t of tools) {
            console.log(`⚡ ${pc.yellow(t.function.name)}: ${t.function.description}`);
        }
        console.log();
    }
    mcp.shutdownAll();
});
program
    .command("plugins")
    .description("List loaded custom plugins and lifecycle hooks")
    .option("-w, --workspace <path>", "Workspace directory")
    .action(async (options) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const pm = new PluginManager(ws);
    await pm.loadPlugins();
    const plugins = pm.listPlugins();
    if (plugins.length === 0) {
        console.log(pc.yellow("\nNo active plugins found in ~/.nexus/plugins/ or ~/.config/opencode/plugins/\n"));
        return;
    }
    console.log(pc.bold(pc.cyan("\n=== Loaded Custom Plugins ===\n")));
    for (const p of plugins) {
        console.log(`• ${pc.bold(pc.green(p.name))}: ${p.description} (custom tools: ${p.customToolCount})\n`);
    }
});
program.parse(process.argv);
