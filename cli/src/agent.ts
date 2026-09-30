import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { ChatMessage, HarnessConfig, ToolCall, ToolDefinition } from "./types.js";
import { LocalLlmClient } from "./client.js";
import { HARNESS_TOOLS, RustCoreBridge } from "./tools.js";
import { parseModelResponse } from "./parser.js";
import { TerminalUI, redactSecrets } from "./ui.js";
import { getGitInfo, getProjectRules } from "./git.js";
import { SkillManager } from "./skills.js";
import { McpClientManager } from "./mcp.js";
import { PluginManager } from "./plugins.js";
import pc from "picocolors";

export type ConfirmHandler = (toolName: string, args: Record<string, any>) => Promise<boolean>;

function triggerNotification(title: string, message: string) {
  try {
    process.stdout.write("\x07");
    exec(`notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`, () => {});
  } catch {
    // Ignore notification errors
  }
}

function logAudit(entry: {
  workspace: string;
  tool: string;
  args: any;
  success: boolean;
  durationMs: number;
  error?: string;
}) {
  try {
    const auditDir = path.join(os.homedir(), ".nexus");
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
    const auditPath = path.join(auditDir, "audit.log");
    const sanitizedArgs = JSON.parse(redactSecrets(JSON.stringify(entry.args)));
    const record = {
      timestamp: new Date().toISOString(),
      workspace: entry.workspace,
      tool: entry.tool,
      args: sanitizedArgs,
      success: entry.success,
      duration_ms: entry.durationMs,
      error: entry.error ? redactSecrets(entry.error) : undefined,
    };
    fs.appendFileSync(auditPath, JSON.stringify(record) + "\n");
  } catch {
    // Ignore audit log write errors
  }
}

export class AutonomousAgent {
  private client: LocalLlmClient;
  private bridge: RustCoreBridge;
  private config: HarnessConfig;
  private ui: TerminalUI;
  private messages: ChatMessage[] = [];
  private depth: number;
  private skillManager: SkillManager;
  private mcpManager: McpClientManager;
  private pluginManager: PluginManager;
  private extensibilityInitialized: boolean = false;
  private activePlan: Array<{ name: string; status: string; detail?: string }> = [];

  constructor(config: HarnessConfig, depth: number = 0) {
    this.config = config;
    this.depth = depth;
    this.client = new LocalLlmClient(config);
    this.bridge = new RustCoreBridge(config.workspace, config.shell, config.coreBinaryPath);
    this.ui = new TerminalUI();
    this.skillManager = new SkillManager(config.workspace);
    this.mcpManager = new McpClientManager(config.workspace);
    this.pluginManager = new PluginManager(config.workspace);
    this.resetConversation();
  }

  public async initExtensibility(): Promise<void> {
    if (this.extensibilityInitialized) return;
    try {
      await this.pluginManager.loadPlugins();
      await this.mcpManager.loadAndConnect();
      this.extensibilityInitialized = true;
    } catch {
      // Ignore background extensibility init errors
    }
  }

  public getSkillManager(): SkillManager {
    return this.skillManager;
  }

  public getMcpManager(): McpClientManager {
    return this.mcpManager;
  }

  public getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  public shutdown(): void {
    this.mcpManager.shutdownAll();
  }

  public getEffectiveTools(): ToolDefinition[] {
    return [
      ...HARNESS_TOOLS,
      ...this.mcpManager.getToolDefinitions(),
      ...this.pluginManager.getCustomToolDefinitions(),
    ];
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  public setMessages(msgs: ChatMessage[]): void {
    this.messages = [...msgs];
  }

  public resetConversation(): void {
    this.messages = [
      {
        role: "system",
        content: this.buildSystemPrompt(),
      },
    ];
  }

  public getHistoryCount(): number {
    return this.messages.length;
  }

  public getUi(): TerminalUI {
    return this.ui;
  }

  public getConfig(): HarnessConfig {
    return this.config;
  }

  public setWorkspace(newWorkspace: string): void {
    this.config.workspace = newWorkspace;
    this.bridge = new RustCoreBridge(this.config.workspace, this.config.shell, this.config.coreBinaryPath);
    this.skillManager.setWorkspace(newWorkspace);
    this.mcpManager = new McpClientManager(newWorkspace);
    this.pluginManager = new PluginManager(newWorkspace);
    this.extensibilityInitialized = false;
    this.resetConversation();
  }

  public setShell(newShell: string): void {
    this.config.shell = newShell;
    this.bridge = new RustCoreBridge(this.config.workspace, this.config.shell, this.config.coreBinaryPath);
    this.resetConversation();
  }

  public setModel(newModel: string): void {
    this.config.model = newModel;
    this.client = new LocalLlmClient(this.config);
  }

  private totalTokens = { prompt: 0, completion: 0, total: 0 };

  public getTokenStats() {
    return this.totalTokens;
  }

  public getActivePlan(): Array<{ name: string; status: string; detail?: string }> {
    return this.activePlan;
  }

  public setActivePlan(phases: Array<{ name: string; status: string; detail?: string }>): void {
    this.activePlan = phases;
  }

  public compactConversation(): string {
    if (this.messages.length <= 4) {
      return "Conversation is already compact.";
    }
    const system = this.messages[0];
    const recent = this.messages.slice(-4);
    const prunedCount = this.messages.length - 5;
    const summaryMessage: ChatMessage = {
      role: "system",
      content: `[Context Note: ${prunedCount} earlier conversation messages were compacted to preserve context budget.]`,
    };
    this.messages = [system, summaryMessage, ...recent];
    return `Compacted context: pruned ${prunedCount} messages, ${this.messages.length} active messages in memory.`;
  }

  private buildSystemPrompt(): string {
    const gitInfo = getGitInfo(this.config.workspace);
    const gitSection = gitInfo.isRepo
      ? `### Git Repository:\n- Branch: ${gitInfo.branch}\n- Uncommitted changes: ${gitInfo.dirtyCount} files\n`
      : "";

    const projectRules = getProjectRules(this.config.workspace);
    const rulesSection = projectRules ? `\n${projectRules}\n` : "";
    const skillsSection = this.skillManager ? `\n${this.skillManager.getPromptSection()}` : "";
    let planSection = "";
    if (this.activePlan && this.activePlan.length > 0) {
      planSection = `\n### Active Execution Plan:\n` +
        this.activePlan.map((p, i) => `${i + 1}. [${p.status}] ${p.name}${p.detail ? ` (${p.detail})` : ""}`).join("\n") + "\n";
    }

    return `You are Nexus Code, an autonomous AI software engineering agent running in a Linux shell environment.
You solve coding problems, build features, fix bugs, and refactor codebases by iteratively exploring, reading, editing, and verifying files.

### Shell Environment:
- Active Shell: ${this.config.shell} (standard GNU/Linux shell environment)
- Workspace directory: ${this.config.workspace}
${gitSection}${rulesSection}${skillsSection}${planSection}
### Operating Rules:
1. EXPLORE FIRST: Before editing files, always explore the workspace using \`file_tree\`, \`list_dir\`, \`find_files\`, \`search_code\`, or \`read_file\`. Never guess file names or function signatures.
2. HIGH-EFFICIENCY BATCHING: Prefer \`batch_read\` to read multiple files concurrently in a single turn, and \`file_info\` to inspect metadata without loading whole files.
3. PRECISE EDITS & PATCHES: When modifying existing files, use \`edit_file\` with unique snippets or \`patch_file\` with unified diffs.
4. STRUCTURED PLANNING: For multi-step tasks, use \`update_plan\` to establish and advance through explicit milestone phases.
5. VERIFICATION: After making code changes, use \`run_command\` with bash/zsh commands to run tests, builds, or linting (e.g. \`cargo check\`, \`cargo test\`, \`npm test\`, \`pytest\`).
6. SELF-CORRECTION: If a command or tool returns an error, analyze the error message, identify the root cause, and fix it.
7. AUTONOMOUS COMPLETION: Keep executing tools until the entire task is thoroughly resolved. When everything is verified and done, invoke \`task_completed\` with a detailed summary.

Always explain your reasoning before or alongside your tool calls.`;
  }

  async runTurn(taskPrompt: string, onConfirm?: ConfirmHandler): Promise<void> {
    await this.initExtensibility();
    await this.pluginManager.notifyTurnStart(taskPrompt, this.config.workspace);

    this.messages.push({
      role: "user",
      content: taskPrompt,
    });

    let currentStep = 1;
    let isFinished = false;

    while (currentStep <= this.config.maxSteps && !isFinished) {
      this.ui.stepHeader(currentStep, this.config.maxSteps);
      this.ui.startSpinner("Thinking and analyzing next step...");

      let assistantMessage: ChatMessage;
      let streamedTokens = false;
      try {
        assistantMessage = await this.client.chatCompletionStream(
          this.messages,
          this.getEffectiveTools(),
          (token: string) => {
            if (!streamedTokens) {
              this.ui.stopSpinner(true);
              process.stdout.write(pc.bold(pc.magenta("\n💭 Assistant: ")));
              streamedTokens = true;
            }
            process.stdout.write(token);
          }
        );
        if (streamedTokens) {
          process.stdout.write("\n\n");
        } else {
          this.ui.stopSpinner(true);
        }
      } catch (err: any) {
        this.ui.stopSpinner(false, `Inference error: ${err.message}`);
        console.error(`\nFatal error communicating with LLM server: ${err.message}`);
        return;
      }

      // Parse the response using hybrid parser
      const parsed = parseModelResponse(assistantMessage);

      // Print any thought or explanation text only if not already streamed
      if (parsed.thoughtText && !streamedTokens) {
        this.ui.printThought(parsed.thoughtText);
      }

      // Record assistant's response in history
      this.messages.push({
        role: "assistant",
        content: assistantMessage.content || "",
        ...(parsed.toolCalls.length > 0 ? { tool_calls: parsed.toolCalls } : {}),
      });

      // If no tool calls were requested, the model thinks it's done or answered conversationally
      if (parsed.toolCalls.length === 0) {
        console.log("ℹ Model finished without further tool calls.");
        this.ui.taskCompleted(parsed.thoughtText || "Completed without additional tool invocations.");
        isFinished = true;
        break;
      }

      // Execute each tool call
      for (const call of parsed.toolCalls) {
        const toolName = call.function.name;
        let args: Record<string, any> = {};

        try {
          args = typeof call.function.arguments === "string"
            ? JSON.parse(call.function.arguments)
            : call.function.arguments;
        } catch {
          args = { raw: call.function.arguments };
        }

        this.ui.printToolCall(toolName, args);

        if (toolName === "task_completed") {
          this.ui.taskCompleted(args.summary || "Task completed.", args.notes);
          isFinished = true;
          break;
        }

        if (toolName === "spawn_subagent") {
          if (this.depth >= 2) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: "Error: Subagent depth limit reached. Solve the task directly without spawning additional subagents.",
            });
            continue;
          }

          const subPrompt = args.prompt || "Investigate the task";
          const subMaxSteps = args.max_steps ? Math.min(args.max_steps, 15) : 8;

          this.ui.startSpinner(`Spawning isolated subagent: "${subPrompt.slice(0, 45)}..."`);
          const subagent = new AutonomousAgent(
            { ...this.config, maxSteps: subMaxSteps },
            this.depth + 1
          );

          try {
            const subResult = await subagent.runSubagent(subPrompt);
            this.ui.stopSpinner(true);
            console.log(pc.cyan(`\n🤖 [Subagent Report Received]\n`));

            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: subResult,
            });
          } catch (subErr: any) {
            this.ui.stopSpinner(false);
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `Subagent failed with error: ${subErr.message}`,
            });
          }
          continue;
        }

        if (toolName === "activate_skill") {
          const skillName = args.name;
          const skill = this.skillManager.getSkill(skillName);
          if (!skill) {
            const avail = this.skillManager.listSkills().map((s) => s.name).join(", ");
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `Error: Skill '${skillName}' not found. Available skills: ${avail || "none"}`,
            });
          } else {
            console.log(pc.green(`✔ Activated skill: ${pc.bold(skill.name)}`));
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `[Activated Skill: ${skill.name}]\n\n${skill.content}`,
            });
          }
          continue;
        }

        if (toolName === "update_plan") {
          const phases = Array.isArray(args.phases) ? args.phases : [];
          this.activePlan = phases;
          this.ui.renderPlan(this.activePlan);
          logAudit({
            workspace: this.config.workspace,
            tool: toolName,
            args,
            success: true,
            durationMs: 0,
          });
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({
              status: "plan_updated",
              total_phases: this.activePlan.length,
              completed: this.activePlan.filter((p) => p.status === "completed").length,
              in_progress: this.activePlan.filter((p) => p.status === "in_progress").length,
            }),
          });
          continue;
        }

        if (this.mcpManager.isMcpTool(toolName)) {
          const t0 = Date.now();
          this.ui.startSpinner(`Executing MCP tool ${toolName}...`);
          const result = await this.mcpManager.executeMcpTool(toolName, args);
          this.ui.stopSpinner(result.success);
          logAudit({
            workspace: this.config.workspace,
            tool: toolName,
            args,
            success: result.success,
            durationMs: Date.now() - t0,
            error: result.error,
          });
          this.ui.printToolResult(toolName, result.success, result.output, result.error);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: result.success ? result.output : `MCP Tool Error: ${result.error}`,
          });
          continue;
        }

        if (this.pluginManager.isCustomTool(toolName)) {
          const t0 = Date.now();
          this.ui.startSpinner(`Executing plugin tool ${toolName}...`);
          const result = await this.pluginManager.executeCustomTool(toolName, args);
          this.ui.stopSpinner(result.success);
          logAudit({
            workspace: this.config.workspace,
            tool: toolName,
            args,
            success: result.success,
            durationMs: Date.now() - t0,
            error: result.error,
          });
          this.ui.printToolResult(toolName, result.success, result.output, result.error);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: result.success ? result.output : `Plugin Tool Error: ${result.error}`,
          });
          continue;
        }

        // Optional Human-in-the-loop confirmation
        if (onConfirm && (toolName === "edit_file" || toolName === "write_file" || toolName === "patch_file" || toolName === "run_command")) {
          const approved = await onConfirm(toolName, args);
          if (!approved) {
            console.log(`⚠️ Tool execution cancelled by user.`);
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `Error: Execution was rejected by the user. Ask the user for clarification or proceed with an alternative approach.`,
            });
            continue;
          }
        }

        const t0 = Date.now();
        this.ui.startSpinner(`Executing ${toolName}...`);
        const result = await this.bridge.executeTool(toolName, args);
        this.ui.stopSpinner(result.success);

        logAudit({
          workspace: this.config.workspace,
          tool: toolName,
          args,
          success: result.success,
          durationMs: Date.now() - t0,
          error: result.error,
        });

        this.ui.printToolResult(toolName, result.success, result.output, result.error);

        // Append tool result to context
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: result.success
            ? result.output
            : `Error executing ${toolName}: ${result.error || "Unknown error"}`,
        });
      }

      currentStep++;
    }

    triggerNotification("Nexus Code", "Turn completed.");

    if (!isFinished && currentStep > this.config.maxSteps) {
      console.log(
        `\n⚠️ Reached maximum step limit (${this.config.maxSteps}). Halting loop to prevent runaway execution.`
      );
    }
  }

  async run(taskPrompt: string): Promise<void> {
    this.ui.banner();
    console.log(`🎯 Task: ${taskPrompt}\n`);
    console.log(`📁 Workspace: ${this.config.workspace}`);
    console.log(`🐚 Shell: ${this.config.shell}`);
    console.log(`🤖 Model: ${this.config.model} (${this.config.endpoint})\n`);

    this.resetConversation();
    await this.runTurn(taskPrompt);
  }

  public async runSubagent(prompt: string): Promise<string> {
    this.resetConversation();
    this.messages.push({
      role: "user",
      content: `[Subagent Objective]: ${prompt}\n\nPlease inspect, execute tools as needed, and produce a concise, comprehensive report answering the objective. Call task_completed when done.`,
    });

    let currentStep = 1;
    let finalSummary = "";

    while (currentStep <= this.config.maxSteps) {
      let assistantMessage: ChatMessage;
      try {
        assistantMessage = await this.client.chatCompletion(this.messages, HARNESS_TOOLS);
      } catch (err: any) {
        return `Subagent failed during LLM inference: ${err.message}`;
      }

      const parsed = parseModelResponse(assistantMessage);
      this.messages.push({
        role: "assistant",
        content: assistantMessage.content || "",
        ...(parsed.toolCalls.length > 0 ? { tool_calls: parsed.toolCalls } : {}),
      });

      if (parsed.toolCalls.length === 0) {
        finalSummary = parsed.thoughtText || assistantMessage.content || "Subagent finished without remarks.";
        break;
      }

      for (const call of parsed.toolCalls) {
        const toolName = call.function.name;
        let args: Record<string, any> = {};
        try {
          args = typeof call.function.arguments === "string"
            ? JSON.parse(call.function.arguments)
            : call.function.arguments;
        } catch {
          args = { raw: call.function.arguments };
        }

        if (toolName === "task_completed") {
          finalSummary = args.summary || "Subagent finished objective.";
          return finalSummary;
        }

        if (toolName === "spawn_subagent") {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: "Error: Subagents cannot recursively spawn further subagents.",
          });
          continue;
        }

        const result = await this.bridge.executeTool(toolName, args);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: result.success
            ? result.output
            : `Error executing ${toolName}: ${result.error || "Unknown error"}`,
        });
      }

      currentStep++;
    }

    return finalSummary || "Subagent completed assigned steps.";
  }
}

