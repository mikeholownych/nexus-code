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
import { HarnessConfig } from "./types.js";
import { FlightPlayer } from "./flight.js";
import { WorktreeManager } from "./worktree.js";
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
  .version("1.1.0");

function buildConfig(options: any): HarnessConfig {
  const endpoint = options.endpoint || process.env.LOCAL_LLM_ENDPOINT || "http://localhost:1234/v1";
  const model = options.model || process.env.LOCAL_LLM_MODEL || "local-model";
  const apiKey = options.apiKey || process.env.LOCAL_LLM_API_KEY || readLatestAuthToken() || "local";
  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const maxSteps = options.maxSteps ? parseInt(options.maxSteps, 10) : 30;
  const temperature = options.temperature ? parseFloat(options.temperature) : 0.2;
  const shell = options.shell || process.env.LOCAL_HARNESS_SHELL || "bash";
  const dryRun = Boolean(options.dryRun);
  const readOnly = Boolean(options.readOnly);
  const sandbox = options.sandbox ? (typeof options.sandbox === "string" ? options.sandbox : true) : undefined;
  const fallbackEndpoints = options.fallback ? options.fallback.split(",").map((s: string) => s.trim()) : undefined;
  const contextLimit = options.contextLimit ? parseInt(options.contextLimit, 10) : undefined;
  const worktree = Boolean(options.worktree);
  const recordFlight = Boolean(options.recordFlight || options.flight);
  return {
    endpoint,
    model,
    apiKey,
    workspace,
    maxSteps,
    temperature,
    shell,
    dryRun,
    readOnly,
    sandbox,
    fallbackEndpoints,
    contextLimit,
    worktree,
    recordFlight,
  };
}

program
  .command("repl")
  .description("Start interactive coding session (REPL / TUI)")
  .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
  .option("-m, --model <name>", "Model name identifier (default: active model in vLLM)")
  .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
  .option("-s, --max-steps <number>", "Maximum steps per turn (default: 30)")
  .option("-t, --temperature <number>", "Model temperature (default: 0.2)")
  .option("--shell <type>", "Linux shell to use: bash, zsh, or sh (default: bash)", "bash")
  .option("--fallback <urls>", "Comma-separated fallback LLM endpoints if primary is unavailable")
  .option("--context-limit <tokens>", "Model context window limit in tokens (default: 65536)")
  .option("--dry-run", "Simulate file modifications without writing changes to disk")
  .option("--read-only", "Reject all mutating tool executions and commands")
  .option("--sandbox [mode]", "Isolate command execution using bubblewrap (bwrap) or Docker (default: auto)")
  .option("--worktree", "Isolate execution inside an ephemeral git worktree under .nexus/worktrees/<task-id>")
  .option("--record-flight", "Record execution into an append-only deterministic .flightlog")
  .option("--approve", "Require human approval before destructive actions (edits, shell commands)")
  .option("-r, --resume [id]", "Resume previous session (defaults to latest if id omitted)")
  .action(async (options: any) => {
    const config = buildConfig(options);
    if (config.model === "local-model") {
      try {
        const client = new LocalLlmClient(config);
        const models = await client.listModels();
        if (models.length > 0) {
          config.model = models[0];
        }
      } catch {
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
  .option("--fallback <urls>", "Comma-separated fallback LLM endpoints if primary is unavailable")
  .option("--context-limit <tokens>", "Model context window limit in tokens (default: 65536)")
  .option("--dry-run", "Simulate file modifications without writing changes to disk")
  .option("--read-only", "Reject all mutating tool executions and commands")
  .option("--sandbox [mode]", "Isolate command execution using bubblewrap (bwrap) or Docker (default: auto)")
  .option("--worktree", "Isolate execution inside an ephemeral git worktree under .nexus/worktrees/<task-id>")
  .option("--record-flight", "Record execution into an append-only deterministic .flightlog")
  .action(async (promptParts: string[], options: any) => {
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
      } catch {
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
    } catch (err: any) {
      console.error(pc.red(`\nAgent failed: ${err.message}`));
      agent.shutdown();
      process.exit(1);
    } finally {
      agent.shutdown();
      process.exit(0);
    }
  });

program
  .command("models")
  .description("List loaded models from your local LM Studio or vLLM server")
  .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
  .option("-k, --api-key <key>", "API key / token (default: $LOCAL_LLM_API_KEY)")
  .action(async (options: any) => {
    const config = buildConfig(options);
    const client = new LocalLlmClient(config);
    console.log(pc.cyan(`\nQuerying models from ${config.endpoint}...`));
    try {
      const models = await client.listModels();
      if (models.length === 0) {
        console.log(pc.yellow("No models returned by local server."));
      } else {
        console.log(pc.green(`\nAvailable Models (${models.length}):`));
        for (const m of models) {
          console.log(`  • ${pc.bold(m)}`);
        }
      }
    } catch (err: any) {
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
  .action(async (options: any) => {
    const config = buildConfig(options);
    console.log(pc.bold(pc.cyan("\n=== Nexus Code Harness Health Check ===\n")));

    // 1. Check Local Server
    process.stdout.write("1. Local LLM Server: ");
    try {
      const client = new LocalLlmClient(config);
      const models = await client.listModels();
      console.log(pc.green(`CONNECTED (${config.endpoint})`));
      console.log(pc.dim(`   Loaded models: ${models.join(", ") || "None loaded"}`));
    } catch (err: any) {
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
    } else {
      console.log(pc.yellow("NOT COMPILED (Will run via `cargo run` automatically)"));
    }

    // 3. Check Linux Shell
    process.stdout.write(`3. Linux Shell (${config.shell}): `);
    try {
      const out = execSync(`${config.shell} -c "uname -a"`, { encoding: "utf-8" }).trim();
      console.log(pc.green(`READY`));
      console.log(pc.dim(`   System: ${out}`));
    } catch (err: any) {
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
  .action((options: any) => {
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
  .action(async (options: any) => {
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
  .action(async (options: any) => {
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

program
  .command("checkpoints")
  .description("List saved workspace snapshots and rollback checkpoints")
  .option("-w, --workspace <path>", "Workspace directory")
  .action(async (options: any) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const { CheckpointManager } = await import("./checkpoint.js");
    const cm = new CheckpointManager(ws);
    const cps = cm.listCheckpoints();
    if (cps.length === 0) {
      console.log(pc.yellow("\nNo saved checkpoints for this workspace.\n"));
      return;
    }
    console.log(pc.bold(pc.cyan("\n=== Saved Workspace Checkpoints ===\n")));
    cps.forEach((cp, idx) => {
      console.log(`${idx + 1}. ${pc.bold(pc.green(cp.name))} ${pc.gray(`(${cp.id})`)} - ${pc.dim(cp.timestamp)}`);
    });
    console.log();
  });

program
  .command("audit")
  .description("Inspect tool execution audit log and execution metrics")
  .option("-n, --limit <number>", "Number of recent records to display", "25")
  .option("-t, --tool <name>", "Filter by tool name")
  .option("--errors", "Show only failed executions")
  .action((options: any) => {
    const auditFile = path.join(os.homedir(), ".nexus", "audit.log");
    if (!fs.existsSync(auditFile)) {
      console.log(pc.yellow("\nNo audit records found in ~/.nexus/audit.log\n"));
      return;
    }
    const raw = fs.readFileSync(auditFile, "utf-8");
    let records = raw.trim().split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    if (options.tool) {
      records = records.filter((r) => r.tool === options.tool);
    }
    if (options.errors) {
      records = records.filter((r) => !r.success);
    }

    const limit = parseInt(options.limit, 10) || 25;
    const slice = records.slice(-limit);

    if (slice.length === 0) {
      console.log(pc.yellow("\nNo matching audit records found.\n"));
      return;
    }

    console.log(pc.bold(pc.cyan(`\n=== Nexus Code Tool Execution Audit Log (${slice.length} entries) ===\n`)));
    for (const r of slice) {
      const status = r.success ? pc.green("PASS") : pc.red("FAIL");
      const time = pc.gray(r.timestamp?.slice(0, 19).replace("T", " ") || "");
      const dur = pc.yellow(`${r.duration_ms || 0}ms`.padStart(6));
      const tool = pc.bold(pc.cyan((r.tool || "").padEnd(16)));
      console.log(`${time} | ${status} | ${tool} | ${dur}`);
      if (r.error) {
        console.log(`  ${pc.red("└─ Error:")} ${r.error}`);
      }
    }
    console.log();
  });

program
  .command("serve-mcp")
  .description("Run Nexus Code as a Model Context Protocol (MCP) server over stdio")
  .option("-w, --workspace <path>", "Workspace directory", process.cwd())
  .option("--shell <type>", "Linux shell to use", "bash")
  .action(async (options: any) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const { McpServer } = await import("./mcp.js");
    const server = new McpServer(ws, options.shell);
    await server.startStdio();
  });

program
  .command("flights")
  .description("List recorded deterministic flight logs")
  .option("-w, --workspace <path>", "Workspace directory", process.cwd())
  .action((options: any) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const manifests = FlightPlayer.listFlights(ws);
    if (manifests.length === 0) {
      console.log(pc.yellow("\nNo flight logs found in .nexus/flights/\n"));
      return;
    }
    console.log(pc.bold(pc.cyan(`\n=== Nexus Code Deterministic Flight Logs (${manifests.length}) ===\n`)));
    for (const m of manifests) {
      const status = m.status === "completed" ? pc.green("COMPLETED") : pc.yellow(m.status.toUpperCase());
      console.log(`• ${pc.bold(m.flightId)} [${status}] - ${pc.dim(m.recordedAt)}`);
      console.log(`  Model: ${pc.cyan(m.model)} | Branch: ${pc.dim(m.initialBranch || "unknown")}`);
      if (m.taskPrompt) {
        console.log(`  Prompt: ${pc.white(m.taskPrompt.slice(0, 80))}`);
      }
      console.log();
    }
    console.log(pc.dim("Replay any flight log with: harness replay <flight-id>\n"));
  });

program
  .command("replay <flight>")
  .description("Replay a deterministic flight log step by step")
  .option("-w, --workspace <path>", "Workspace directory", process.cwd())
  .option("--delay <ms>", "Delay between events in milliseconds", "100")
  .action(async (flightId: string, options: any) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const delay = parseInt(options.delay, 10) || 0;
    try {
      const { manifest, events } = FlightPlayer.loadFlight(ws, flightId);
      console.log(pc.bold(pc.cyan(`\n🛫 Replaying Flight: ${manifest.flightId}`)));
      console.log(`Model: ${pc.bold(manifest.model)} | Workspace: ${pc.dim(manifest.workspace)}`);
      console.log(`Recorded: ${pc.dim(manifest.recordedAt)} | Events: ${events.length}\n`);

      await FlightPlayer.replay(events, (ev) => {
        const stepPrefix = ev.step !== undefined ? `[Step ${ev.step}] ` : "";
        switch (ev.type) {
          case "turn_start":
            console.log(pc.bold(pc.magenta(`\n▶ ${stepPrefix}Turn Started: ${ev.payload.prompt?.slice(0, 100)}`)));
            break;
          case "thought":
            console.log(pc.italic(pc.gray(`💭 Thought: ${ev.payload.thought?.slice(0, 160)}...`)));
            break;
          case "tool_call":
            console.log(pc.cyan(`⚡ ${stepPrefix}Tool Call: ${pc.bold(ev.payload.toolName)}(${JSON.stringify(ev.payload.arguments || {}).slice(0, 80)})`));
            break;
          case "tool_result": {
            const status = ev.payload.success ? pc.green("✔") : pc.red("✘");
            console.log(`  ${status} Result (${ev.payload.durationMs || 0}ms): ${ev.payload.outputSnippet?.slice(0, 100) || "ok"}`);
            break;
          }
          case "file_diff":
            console.log(pc.yellow(`📝 File Diff: ${ev.payload.path} (${ev.payload.diffSnippet?.slice(0, 80)}...)`));
            break;
          case "session_end":
            console.log(pc.bold(pc.green(`\n🏁 Flight Completed: ${ev.payload.summary} (${ev.payload.durationMs}ms)`)));
            break;
        }
      }, delay);
      console.log();
    } catch (err: any) {
      console.error(pc.red(`Replay error: ${err.message}`));
    }
  });

program
  .command("worktrees")
  .description("List active speculative git worktrees")
  .option("-w, --workspace <path>", "Workspace directory", process.cwd())
  .action((options: any) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const mgr = new WorktreeManager(ws);
    const wts = mgr.listWorktrees();
    if (wts.length === 0) {
      console.log(pc.yellow("\nNo active speculative worktrees in .nexus/worktrees/\n"));
      return;
    }
    console.log(pc.bold(pc.cyan(`\n=== Speculative Git Worktrees (${wts.length}) ===\n`)));
    for (const wt of wts) {
      console.log(`• Task: ${pc.bold(wt.taskId)} (branch: ${pc.cyan(wt.branch)})`);
      console.log(`  Path: ${pc.dim(wt.path)} | Head: ${pc.gray(wt.headSha.slice(0, 8))}\n`);
    }
  });

if (process.argv.length <= 2) {
  process.argv.push("repl");
}

program.parse(process.argv);
