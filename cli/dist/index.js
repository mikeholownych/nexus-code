#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "./core/app.js";
import { InteractiveRepl } from "./repl.js";
import { LocalLlmClient } from "./client.js";
import { SessionManager } from "./session.js";
import { SkillManager } from "./skills.js";
import { McpClientManager } from "./mcp.js";
import { PluginManager } from "./plugins.js";
import { FlightPlayer } from "./flight.js";
import { WorktreeManager } from "./worktree.js";
import { HunkStager } from "./stager.js";
import { BenchmarkEvaluator } from "./evaluator.js";
import { BrowserDriver } from "./browser.js";
import { KnowledgeGraph } from "./knowledge.js";
import { buildConfig as buildConfigOrThrow, loadEnvironment } from "./config.js";
import { describeTarget, registerProviderCommands } from "./provider_cli.js";
import { UsageLedger } from "./usage.js";
import { DOCTOR_EXIT, DOCTOR_SCHEMA_VERSION, doctorExitCode, redactDiagnostic, renderDoctorJson, renderDoctorText, runDoctor, runRepairs } from "./doctor.js";
/** Configuration errors (unknown provider, missing model or base URL) end the command with a message, not a trace. */
function buildConfig(options) {
    try {
        return buildConfigOrThrow(options);
    }
    catch (err) {
        console.error(pc.red(`Configuration error: ${err?.message ?? err}`));
        process.exit(2);
    }
}
import { registerOperationCommands } from "./operation_cli.js";
import pc from "picocolors";
import * as os from "node:os";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnvironment();
/**
 * Exits once stdout and stderr have accepted everything written so far. A write to a pipe is asynchronous, so an immediate
 * `process.exit()` drops whatever the pipe has not yet taken (65,536 bytes on Linux) while still exiting with the intended code.
 */
function exitAfterFlush(code) {
    let pending = 2;
    const done = () => { if (--pending === 0)
        process.exit(code); };
    process.stdout.write("", done);
    process.stderr.write("", done);
}
import { getBuildIdentity } from "./build_identity.js";
function isExecutable(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return fs.statSync(filePath).isFile();
    }
    catch {
        return false;
    }
}
function resolveTuiBinary() {
    if (process.env.NEXUS_TUI_BIN && isExecutable(process.env.NEXUS_TUI_BIN)) {
        return process.env.NEXUS_TUI_BIN;
    }
    if (process.env.NEXUS_HOME) {
        const packaged = path.join(process.env.NEXUS_HOME, "lib", "core", "nexus-tui");
        if (isExecutable(packaged))
            return packaged;
    }
    const root = process.env.NEXUS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const releaseTui = path.join(root, "core", "target", "release", "nexus-tui");
    if (isExecutable(releaseTui))
        return releaseTui;
    const debugTui = path.join(root, "core", "target", "debug", "nexus-tui");
    if (isExecutable(debugTui))
        return debugTui;
    return undefined;
}
function resolveSidecarScript() {
    if (process.env.NEXUS_SIDECAR && fs.existsSync(process.env.NEXUS_SIDECAR)) {
        return process.env.NEXUS_SIDECAR;
    }
    if (process.env.NEXUS_HOME) {
        const packaged = path.join(process.env.NEXUS_HOME, "lib", "cli", "dist", "sidecar.js");
        if (fs.existsSync(packaged))
            return packaged;
    }
    const root = process.env.NEXUS_ROOT;
    if (root) {
        const rootSidecar = path.join(root, "cli", "dist", "sidecar.js");
        if (fs.existsSync(rootSidecar))
            return rootSidecar;
    }
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const direct = path.join(currentDir, "sidecar.js");
    if (fs.existsSync(direct))
        return direct;
    const repoRoot = path.resolve(currentDir, "..", "..");
    const checkout = path.join(repoRoot, "cli", "dist", "sidecar.js");
    if (fs.existsSync(checkout))
        return checkout;
    return undefined;
}
function spawnTui(tuiBin, sidecarScript) {
    const passthrough = process.argv.slice(2).filter((arg) => arg !== "--live" && arg !== "--repl");
    const result = spawnSync(tuiBin, ["--live", "--sidecar", sidecarScript, "--node", process.execPath, "--", ...passthrough], { stdio: "inherit" });
    if (result.error) {
        console.error(`Failed to launch nexus-tui: ${result.error.message}`);
        process.exit(1);
    }
    process.exit(result.status ?? (result.signal ? 1 : 0));
}
async function startRepl(options) {
    if (process.env.NEXUS_TEST_RECORD_REPL) {
        const log = process.env.NEXUS_TEST_RECORD_REPL;
        const parts = ["repl"];
        if (options.model)
            parts.push("-m", options.model);
        if (options.resume)
            parts.push("-r", typeof options.resume === "string" ? options.resume : "");
        fs.appendFileSync(log, parts.join(" ").trim() + "\n");
        return;
    }
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
    if (config.provider || config.plannerProvider || config.coderProvider)
        console.error(pc.dim(describeTarget(config)));
    config.surface = "repl";
    const app = new ApplicationCore(config);
    const repl = new InteractiveRepl(app, config.approvalMode, resumeId);
    await repl.start();
}
async function runDefault(options) {
    if (options.repl) {
        await startRepl(options);
        return;
    }
    const tuiBin = resolveTuiBinary();
    const sidecarScript = resolveSidecarScript();
    if (options.live) {
        if (!tuiBin) {
            console.error("nexus-tui is not built. Run 'make build' first.");
            process.exit(1);
        }
        if (!sidecarScript) {
            console.error("nexus sidecar is not built. Run 'npm run build' in cli first.");
            process.exit(1);
        }
        spawnTui(tuiBin, sidecarScript);
        return;
    }
    const isInteractiveTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (isInteractiveTty && tuiBin && sidecarScript) {
        spawnTui(tuiBin, sidecarScript);
        return;
    }
    if (isInteractiveTty && !tuiBin) {
        console.error("nexus: the live TUI is not built (run 'make build'); starting the REPL.");
    }
    await startRepl(options);
}
const program = new Command();
program
    .name("nexus")
    .description("Nexus Code - Custom Autonomous Coding Harness for Local AI (LM Studio / vLLM)")
    .version(getBuildIdentity().string)
    .option("--repl", "Start interactive coding session (REPL)")
    .option("--live", "Start live TUI")
    .option("-r, --resume [id]", "Resume previous session (defaults to latest if id omitted)")
    .option("--approve", "Require human approval before destructive actions (edits, shell commands)")
    .option("-y, --yes", "Run non-interactively without approval prompts (forces auto mode)")
    .option("--mode <mode>", "Execution mode: auto, review, or read-only (default: auto for trusted workspaces, review for untrusted)")
    .option("--read-only", "Reject all mutating tool executions and commands")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
    .option("-m, --model <name>", "Model name identifier (default: active model in vLLM)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-s, --max-steps <number>", "Steps per segment; continuation checkpoints there instead of stopping (default: 30)")
    .option("--max-total-steps <number>", "Continuation: an explicit total-step limit for one turn (default: none; progressing work continues)")
    .option("--strict-token-count", "Refuse a request the connection could not count on a worker (default: proceed on the labelled estimate)")
    .option("--max-turn-minutes <number>", "Continuation: an explicit wall-clock limit for one turn in minutes (default: none)")
    .option("--stagnation-steps <number>", "Continuation: stop after this many steps without progress (default 12)")
    .option("--no-continuation", "End a turn at --max-steps instead of continuing while it makes progress")
    .option("-t, --temperature <number>", "Model temperature (default: 0.2)")
    .option("--shell <type>", "Linux shell to use: bash, zsh, or sh (default: bash)", "bash")
    .option("--fallback <urls>", "Comma-separated fallback LLM endpoints if primary is unavailable")
    .option("--context-limit <tokens>", "Context window limit in tokens; below the provider's advertised capacity it is kept, above it the advertised capacity applies (default: advertised capacity, else 65536)")
    .option("--dry-run", "Simulate file modifications without writing changes to disk")
    .option("--sandbox [mode]", "Isolate command execution using bubblewrap (bwrap) or Docker (default: auto)")
    .option("--worktree", "Isolate execution inside an ephemeral git worktree under .nexus/worktrees/<task-id>")
    .option("--authoritative-verifier <command>", "Trusted command that must pass before any task completion; its success may authorize automatic worktree merge")
    .option("--record-flight", "Record execution into an append-only deterministic .flightlog")
    .option("--planner-model <name>", "Deep reasoning model for architecture planning (o3, R1, Sonnet)")
    .option("--planner-endpoint <url>", "Dedicated inference endpoint for planner model")
    .option("--coder-model <name>", "High-throughput model for surgical code implementation (Qwen 2.5 Coder)")
    .option("--coder-endpoint <url>", "Dedicated inference endpoint for coder model")
    .option("--provider <id>", "Cloud inference provider: openrouter, openai, anthropic, compatible (default: appliance endpoint)")
    .option("--base-url <url>", "Override the provider's base URL (operator-only; required for 'compatible')")
    .option("--planner-provider <id>", "Cloud provider for the planner model (requires --planner-model)")
    .option("--coder-provider <id>", "Cloud provider for the coder model (requires --coder-model)")
    .action(async (options, cmd) => {
    if (cmd.args && cmd.args.length > 0) {
        program.error(`error: unknown command '${cmd.args[0]}'`);
    }
    await runDefault(options);
});
program
    .command("repl")
    .description("Start interactive coding session (REPL / TUI)")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
    .option("-m, --model <name>", "Model name identifier (default: active model in vLLM)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-s, --max-steps <number>", "Steps per segment; continuation checkpoints there instead of stopping (default: 30)")
    .option("--max-total-steps <number>", "Continuation: an explicit total-step limit for one turn (default: none; progressing work continues)")
    .option("--strict-token-count", "Refuse a request the connection could not count on a worker (default: proceed on the labelled estimate)")
    .option("--max-turn-minutes <number>", "Continuation: an explicit wall-clock limit for one turn in minutes (default: none)")
    .option("--stagnation-steps <number>", "Continuation: stop after this many steps without progress (default 12)")
    .option("--no-continuation", "End a turn at --max-steps instead of continuing while it makes progress")
    .option("-t, --temperature <number>", "Model temperature (default: 0.2)")
    .option("--shell <type>", "Linux shell to use: bash, zsh, or sh (default: bash)", "bash")
    .option("--fallback <urls>", "Comma-separated fallback LLM endpoints if primary is unavailable")
    .option("--context-limit <tokens>", "Context window limit in tokens; below the provider's advertised capacity it is kept, above it the advertised capacity applies (default: advertised capacity, else 65536)")
    .option("--dry-run", "Simulate file modifications without writing changes to disk")
    .option("--read-only", "Reject all mutating tool executions and commands")
    .option("--sandbox [mode]", "Isolate command execution using bubblewrap (bwrap) or Docker (default: auto)")
    .option("--worktree", "Isolate execution inside an ephemeral git worktree under .nexus/worktrees/<task-id>")
    .option("--authoritative-verifier <command>", "Trusted command that must pass before any task completion; its success may authorize automatic worktree merge")
    .option("--record-flight", "Record execution into an append-only deterministic .flightlog")
    .option("--planner-model <name>", "Deep reasoning model for architecture planning (o3, R1, Sonnet)")
    .option("--planner-endpoint <url>", "Dedicated inference endpoint for planner model")
    .option("--coder-model <name>", "High-throughput model for surgical code implementation (Qwen 2.5 Coder)")
    .option("--coder-endpoint <url>", "Dedicated inference endpoint for coder model")
    .option("--approve", "Require human approval before destructive actions (edits, shell commands)")
    .option("-y, --yes", "Run non-interactively without approval prompts (forces auto mode)")
    .option("--mode <mode>", "Execution mode: auto, review, or read-only (default: auto for trusted workspaces, review for untrusted)")
    .option("--provider <id>", "Cloud inference provider: openrouter, openai, anthropic, compatible (default: appliance endpoint)")
    .option("--base-url <url>", "Override the provider's base URL (operator-only; required for 'compatible')")
    .option("--planner-provider <id>", "Cloud provider for the planner model (requires --planner-model)")
    .option("--coder-provider <id>", "Cloud provider for the coder model (requires --coder-model)")
    .option("-r, --resume [id]", "Resume previous session (defaults to latest if id omitted)")
    .action(async (_options, cmd) => {
    const options = cmd.optsWithGlobals();
    await startRepl(options);
});
program
    .command("run")
    .description("Run an autonomous coding task")
    .argument("<prompt...>", "The coding instructions / task prompt")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: http://localhost:1234/v1 or $LOCAL_LLM_ENDPOINT)")
    .option("-m, --model <name>", "Model name identifier (default: active model in LM Studio/vLLM)")
    .option("-w, --workspace <path>", "Workspace directory to inspect and modify (default: current directory)")
    .option("-s, --max-steps <number>", "Steps per segment; continuation checkpoints there instead of stopping", "30")
    .option("--max-total-steps <number>", "Continuation: an explicit total-step limit for one turn (default: none; progressing work continues)")
    .option("--strict-token-count", "Refuse a request the connection could not count on a worker (default: proceed on the labelled estimate)")
    .option("--max-turn-minutes <number>", "Continuation: an explicit wall-clock limit for one turn in minutes (default: none)")
    .option("--stagnation-steps <number>", "Continuation: stop after this many steps without progress (default 12)")
    .option("--no-continuation", "End a turn at --max-steps instead of continuing while it makes progress")
    .option("-t, --temperature <number>", "Model temperature", "0.2")
    .option("--shell <type>", "Linux shell to use: bash, zsh, or sh (default: bash or $LOCAL_HARNESS_SHELL)", "bash")
    .option("--fallback <urls>", "Comma-separated fallback LLM endpoints if primary is unavailable")
    .option("--context-limit <tokens>", "Context window limit in tokens; below the provider's advertised capacity it is kept, above it the advertised capacity applies (default: advertised capacity, else 65536)")
    .option("--dry-run", "Simulate file modifications without writing changes to disk")
    .option("--read-only", "Reject all mutating tool executions and commands")
    .option("-y, --yes", "Run non-interactively without approval prompts (forces auto mode)")
    .option("--approve", "Require human approval before destructive actions (forces review mode)")
    .option("--mode <mode>", "Execution mode: auto, review, or read-only (default: auto for trusted workspaces, review for untrusted)")
    .option("--sandbox [mode]", "Isolate command execution using bubblewrap (bwrap) or Docker (default: auto)")
    .option("--worktree", "Isolate execution inside an ephemeral git worktree under .nexus/worktrees/<task-id>")
    .option("--authoritative-verifier <command>", "Trusted command that must pass before any task completion; its success may authorize automatic worktree merge")
    .option("--record-flight", "Record execution into an append-only deterministic .flightlog")
    .option("--planner-model <name>", "Deep reasoning model for architecture planning (o3, R1, Sonnet)")
    .option("--planner-endpoint <url>", "Dedicated inference endpoint for planner model")
    .option("--coder-model <name>", "High-throughput model for surgical code implementation (Qwen 2.5 Coder)")
    .option("--coder-endpoint <url>", "Dedicated inference endpoint for coder model")
    .option("--tdd", "Enforce strict RED-GREEN-REFACTOR Test-Driven Development protocol")
    .option("--provider <id>", "Cloud inference provider: openrouter, openai, anthropic, compatible (default: appliance endpoint)")
    .option("--base-url <url>", "Override the provider's base URL (operator-only; required for 'compatible')")
    .option("--planner-provider <id>", "Cloud provider for the planner model (requires --planner-model)")
    .option("--coder-provider <id>", "Cloud provider for the coder model (requires --coder-model)")
    .option("-j, --json", "Output machine-readable JSON structured result (UI-002, UI-003)")
    .option("-r, --resume [id]", "Resume previous session or task state")
    .action(async (promptParts, options) => {
    const prompt = promptParts.join(" ");
    const config = buildConfig(options);
    config.surface = "headless";
    const isJson = Boolean(options.json);
    // Auto-detect loaded model if model is 'local-model'
    if (config.model === "local-model") {
        try {
            const client = new LocalLlmClient(config);
            const models = await client.listModels();
            if (models.length > 0) {
                config.model = models[0];
                if (!isJson) {
                    console.log(pc.dim(`🔍 Auto-detected active model: ${pc.bold(config.model)}`));
                }
            }
        }
        catch {
            // Fallback to default
        }
    }
    if (!isJson && (config.provider || config.plannerProvider || config.coderProvider))
        console.error(pc.dim(describeTarget(config)));
    const app = new ApplicationCore(config);
    const resumeTaskId = typeof options.resume === "string" ? options.resume : options.resume ? "latest" : undefined;
    // Operator stop authority: first SIGINT cancels the active turn; a second one terminates immediately.
    const abort = new AbortController();
    let sigints = 0;
    const onSigint = () => {
        sigints++;
        if (sigints === 1) {
            abort.abort(new Error("SIGINT"));
            if (!isJson)
                console.error(pc.yellow("\nInterrupt received: no further work will be started (Ctrl-C again to terminate immediately)."));
        }
        else {
            process.exit(130);
        }
    };
    process.on("SIGINT", onSigint);
    try {
        const result = await app.runTask(prompt, {
            json: isJson,
            resumeTaskId,
            signal: abort.signal,
        });
        const cloud = UsageLedger.global().cloudTotals();
        if (isJson) {
            console.log(JSON.stringify(cloud.requests ? { ...result, cloudUsage: cloud } : result, null, 2));
        }
        else if (cloud.requests) {
            console.error(pc.dim(UsageLedger.global().summary()));
        }
        app.shutdown();
        exitAfterFlush(result.exitCode);
    }
    catch (err) {
        if (isJson) {
            console.log(JSON.stringify({
                taskId: app.getTaskId(),
                success: false,
                status: "failed",
                prompt,
                output: "",
                plan: [],
                milestones: [],
                validationReceipts: [],
                tokenStats: { prompt: 0, completion: 0, total: 0 },
                durationMs: 0,
                error: err.message,
            }, null, 2));
        }
        else {
            console.error(pc.red(`\nTask failed: ${err.message}`));
        }
        app.shutdown();
        exitAfterFlush(1);
    }
});
program
    .command("models")
    .description("List loaded models from your local LM Studio or vLLM server")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
    .option("-k, --api-key <key>", "API key / token (default: $LOCAL_LLM_API_KEY)")
    .option("--provider <id>", "Cloud inference provider (openrouter, openai, anthropic, compatible)")
    .option("--base-url <url>", "Override the provider's base URL")
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
/** Shared by `doctor` and its compatibility alias `check`. */
async function doctorCommand(options) {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    try {
        let config;
        let configError;
        try {
            config = buildConfigOrThrow(options);
        }
        catch (error) {
            configError = error;
        }
        const timeoutMs = options.timeout ? Number(options.timeout) : undefined;
        const base = { context: "cli", config, configError, flags: options, deep: Boolean(options.deep), signal: controller.signal, timeoutMs };
        let report = await runDoctor(base);
        if (options.fix) {
            const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY && !options.json);
            report = await runRepairs(report, {
                ...base,
                readOnly: Boolean(options.readOnly || config?.readOnly),
                confirm: async (proposals) => {
                    if (options.yes)
                        return true;
                    if (!interactive) {
                        process.stderr.write(`doctor --fix: ${proposals.length} repair(s) proposed; none applied without confirmation. Re-run with --yes to apply:\n${proposals.map((p) => `  - ${p.description}`).join("\n")}\n`);
                        return false;
                    }
                    process.stderr.write(`Proposed repairs:\n${proposals.map((p) => `  - ${p.description}`).join("\n")}\nApply them? [y/N] `);
                    const answer = await new Promise((resolve) => {
                        process.stdin.resume();
                        process.stdin.once("data", (d) => {
                            process.stdin.pause();
                            resolve(String(d).trim().toLowerCase());
                        });
                    });
                    return answer === "y" || answer === "yes";
                },
            });
        }
        console.log(options.json ? renderDoctorJson(report) : renderDoctorText(report));
        exitAfterFlush(doctorExitCode(report));
    }
    catch (err) {
        // The doctor itself failed (not a finding): exit 3 with a redacted message, JSON when asked for.
        const message = redactDiagnostic(err?.message ?? String(err));
        if (options.json)
            console.log(JSON.stringify({ schemaVersion: DOCTOR_SCHEMA_VERSION, tool: "nexus doctor", error: message }, null, 2));
        else
            console.error(`nexus doctor could not run: ${message}`);
        exitAfterFlush(DOCTOR_EXIT.error);
    }
    finally {
        process.removeListener("SIGINT", onInterrupt);
    }
}
function doctorOptions(command) {
    return command
        .option("-e, --endpoint <url>", "Endpoint to diagnose (default: as a session would resolve it)")
        .option("-m, --model <name>", "Model to check for")
        .option("-k, --api-key <key>", "Credential to test (never printed)")
        .option("--provider <id>", "Cloud inference provider (openrouter, openai, anthropic, compatible, ...)")
        .option("--base-url <url>", "Override the provider's base URL")
        .option("-w, --workspace <path>", "Workspace directory")
        .option("--shell <type>", "Shell to check")
        .option("--json", "Emit only the versioned JSON report (schemaVersion 2)")
        .option("--deep", "Also run deeper checks: one minimal inference request (costs model work), an engine tool call, state write probes, all session records")
        .option("--fix", "Propose the supported repairs and apply them after confirmation")
        .option("--yes", "With --fix: apply the supported repairs without asking (unattended)")
        .option("--read-only", "Refuse every repair (diagnosis only)")
        .option("--timeout <ms>", "Per-check time limit in milliseconds (default 4000)")
        .addHelpText("after", `
Exit codes: 0 healthy · 1 warnings only · 2 at least one failure · 3 the doctor itself could not run.
Statuses: pass, warn (works, but degraded or at risk), fail (prevents normal operation), skip (not applicable or not run).
Supported repairs (--fix): create missing ~/.nexus state directories (0700); restrict group/world-writable state
directories to 0700; restrict a group/world-readable credential store to 0600. Previous modes are recorded under
~/.nexus/doctor-backups. Nothing else is ever changed: no configuration reset, session deletion, credential rotation,
dependency installation, TLS change or service restart.`)
        .action(doctorCommand);
}
doctorOptions(program.command("doctor").description("Diagnose configuration, endpoint, credentials, engine, shell, state and extensions without starting an agent"));
doctorOptions(program.command("check").description("Compatibility alias for `doctor` (the former health check)"));
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
    const { untrustedWorkspaceExtensions } = await import("./workspace_trust.js");
    for (const file of untrustedWorkspaceExtensions(ws).filter((f) => /(^|[\\/])\.?mcp\.json$/.test(f))) {
        console.log(pc.yellow(`Not loaded (workspace not trusted; run \`nexus trust\`): ${file}`));
    }
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
    const { untrustedWorkspaceExtensions } = await import("./workspace_trust.js");
    for (const file of untrustedWorkspaceExtensions(ws).filter((f) => !/(^|[\\/])\.?mcp\.json$/.test(f))) {
        console.log(pc.yellow(`Not loaded (workspace not trusted; run \`nexus trust\`): ${file}`));
    }
    await pm.loadPlugins();
    const plugins = pm.listPlugins();
    if (plugins.length === 0) {
        console.log(pc.yellow("\nNo active plugins found in ~/.nexus/plugins/ or ~/.config/nexus/plugins/\n"));
        return;
    }
    console.log(pc.bold(pc.cyan("\n=== Loaded Custom Plugins ===\n")));
    for (const p of plugins) {
        console.log(`• ${pc.bold(pc.green(p.name))}: ${p.description} (custom tools: ${p.customToolCount})\n`);
    }
});
program
    .command("trust [path]")
    .description("Trust a workspace so its own .mcp.json servers and plugins are loaded (they run code from the workspace)")
    .option("--remove", "Stop trusting the workspace")
    .option("--list", "List trusted workspaces")
    .action(async (target, options) => {
    const { listTrustedWorkspaces, setWorkspaceTrusted } = await import("./workspace_trust.js");
    if (options.list) {
        const list = listTrustedWorkspaces();
        console.log(list.length ? list.join("\n") : "No trusted workspaces.");
        return;
    }
    const ws = path.resolve(target ?? process.cwd());
    if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) {
        console.error(pc.red(`Not a directory: ${ws}`));
        process.exitCode = 1;
        return;
    }
    const real = setWorkspaceTrusted(ws, !options.remove);
    console.log(options.remove ? `No longer trusted: ${real}` : `Trusted: ${real}\nIts .mcp.json servers and plugins will be loaded (they run code from this workspace). Undo with \`nexus trust --remove\`.`);
});
program
    .command("checkpoints")
    .description("List saved workspace snapshots and rollback checkpoints")
    .option("-w, --workspace <path>", "Workspace directory")
    .action(async (options) => {
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
    .action((options) => {
    const auditFile = path.join(os.homedir(), ".nexus", "audit.log");
    if (!fs.existsSync(auditFile)) {
        console.log(pc.yellow("\nNo audit records found in ~/.nexus/audit.log\n"));
        return;
    }
    const raw = fs.readFileSync(auditFile, "utf-8");
    let records = raw.trim().split("\n").filter(Boolean).map((l) => {
        try {
            return JSON.parse(l);
        }
        catch {
            return null;
        }
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
    .action(async (options) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const { McpServer } = await import("./mcp.js");
    const server = new McpServer(ws, options.shell);
    await server.startStdio();
});
program
    .command("flights")
    .description("List recorded deterministic flight logs")
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .action((options) => {
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
    .action(async (flightId, options) => {
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
    }
    catch (err) {
        console.error(pc.red(`Replay error: ${err.message}`));
    }
});
program
    .command("worktrees")
    .description("List active speculative git worktrees")
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .action((options) => {
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
program
    .command("stage")
    .description("Inspect and manage granular git diff hunks")
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option("--reset", "Unstage all staged changes")
    .action((options) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const stager = new HunkStager(ws);
    if (options.reset) {
        stager.unstage();
        console.log(pc.green("✔ Unstaged all changes.\n"));
        return;
    }
    const summary = stager.getStatusSummary();
    if (summary.files.length === 0) {
        console.log(pc.green("✔ Working tree clean (no unstaged diff hunks).\n"));
        return;
    }
    console.log(pc.bold(pc.cyan(`\n=== Granular Hunk Stager (${summary.files.length} modified files, ${summary.unstagedHunkCount} hunks) ===\n`)));
    for (const f of summary.files) {
        console.log(pc.bold(pc.white(`📄 ${f.newPath} (${f.hunks.length} hunks)`)));
        f.hunks.forEach((h, idx) => {
            console.log(`  [Hunk ${idx + 1}] ${pc.dim(h.header)}`);
            for (const l of h.lines.slice(0, 5)) {
                if (l.startsWith("+"))
                    console.log(`    ${pc.green(l)}`);
                else if (l.startsWith("-"))
                    console.log(`    ${pc.red(l)}`);
                else
                    console.log(`    ${pc.dim(l)}`);
            }
            if (h.lines.length > 5)
                console.log(pc.dim(`    ... [${h.lines.length - 5} more lines]`));
        });
        console.log();
    }
});
program
    .command("eval <dataset>")
    .description("Evaluate SWE-bench / benchmark dataset against Nexus Code harness")
    .option("-e, --endpoint <url>", "Local LLM endpoint (default: $LOCAL_LLM_ENDPOINT)")
    .option("-m, --model <name>", "Model name identifier (default: active model in LM Studio/vLLM)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-s, --max-steps <number>", "Maximum steps per task instance", "30")
    .option("-t, --temperature <number>", "Model temperature", "0.2")
    .option("--output <path>", "Output file path for Markdown scorecard", "eval-scorecard.md")
    .option("--limit <number>", "Limit number of benchmark instances to evaluate")
    .action(async (datasetPath, options) => {
    const config = buildConfig(options);
    console.log(pc.bold(pc.cyan(`\n📊 Loading evaluation dataset: ${datasetPath}`)));
    let instances = BenchmarkEvaluator.loadDataset(datasetPath);
    if (options.limit) {
        const limit = parseInt(options.limit, 10);
        instances = instances.slice(0, limit);
    }
    console.log(pc.dim(`Loaded ${instances.length} benchmark task instance(s).`));
    const evaluator = new BenchmarkEvaluator(config.workspace);
    const summary = await evaluator.runBenchmark(instances, config);
    const scorecard = BenchmarkEvaluator.renderScorecard(summary);
    console.log("\n" + scorecard);
    const outputPath = path.resolve(options.output || "eval-scorecard.md");
    fs.writeFileSync(outputPath, scorecard, "utf-8");
    console.log(pc.green(`✔ Scorecard saved to: ${outputPath}\n`));
});
program
    .command("knowledge [action] [key] [val...]")
    .description("Inspect or manage persistent project knowledge graph")
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option("-c, --category <type>", "Category: idiom, architecture, dependency, troubleshooting, rule", "rule")
    .action((action, key, valParts, options) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const kg = new KnowledgeGraph(ws);
    const act = (action || "list").toLowerCase();
    if (act === "set" && key) {
        const val = (valParts || []).join(" ");
        const entry = kg.set(key, val, options.category);
        console.log(pc.green(`✔ Saved knowledge entry: [${entry.category}] ${entry.key}`));
    }
    else if (act === "get" && key) {
        const entry = kg.get(key);
        if (entry) {
            console.log(`\n• [${pc.cyan(entry.category)}] ${pc.bold(entry.key)}: ${pc.white(entry.value)} (confidence: ${entry.confidence})\n`);
        }
        else {
            console.log(pc.yellow(`Key '${key}' not found in knowledge graph.\n`));
        }
    }
    else if (act === "delete" && key) {
        const deleted = kg.delete(key);
        console.log(deleted ? pc.green(`✔ Deleted entry: ${key}\n`) : pc.yellow(`Entry not found: ${key}\n`));
    }
    else {
        const list = kg.list();
        if (list.length === 0) {
            console.log(pc.yellow("\nNo persistent knowledge entries found in .nexus/knowledge.json\n"));
            return;
        }
        console.log(pc.bold(pc.cyan(`\n=== Persistent Project Knowledge Graph (${list.length} entries) ===\n`)));
        for (const e of list) {
            console.log(`• [${pc.cyan(e.category)}] ${pc.bold(e.key)}: ${pc.white(e.value)}`);
        }
        console.log();
    }
});
program
    .command("browse <url>")
    .description("Verify local or remote web frontend using headless browser driver")
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option("--screenshot", "Capture page screenshot")
    .action(async (url, options) => {
    const ws = options.workspace ? path.resolve(options.workspace) : process.cwd();
    const driver = new BrowserDriver(ws);
    console.log(pc.bold(pc.cyan(`\n🌐 Navigating headless browser to: ${url}`)));
    const res = await driver.navigate(url);
    console.log(`Title: ${pc.bold(res.title)} | Status: ${res.status === 200 ? pc.green(res.status) : pc.yellow(res.status)}`);
    console.log(`Snippet:\n${pc.dim(res.contentSnippet.slice(0, 300))}...\n`);
    if (options.screenshot) {
        const shot = await driver.screenshot();
        console.log(pc.green(`✔ Screenshot saved: ${shot.path}\n`));
    }
    await driver.close();
});
registerOperationCommands(program);
registerProviderCommands(program);
program.parse(process.argv);
export { ApplicationCore } from "./core/app.js";
