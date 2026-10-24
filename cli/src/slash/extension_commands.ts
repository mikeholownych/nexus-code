import * as path from "node:path";
import { encodeImageFile, formatVisionContent } from "../image.js";
import type { McpClientManager } from "../mcp.js";
import type { OperationEvent } from "../core/operation.js";
import { AgentRole, TEAM_ROLES, TeamOrchestrator } from "../team.js";
import { SlashContext, SlashHandler, SlashOutcome, reply } from "./catalog.js";
import { recall } from "./session_commands.js";

const IMAGE_PROMPT = "Please analyze this image, describe its contents, and provide relevant technical solutions.";
const ROLES: string[] = TEAM_ROLES;
const TEAM_USAGE = `Usage: /team <${[...TEAM_ROLES, "full"].join("|")}> [--independent-review] <objective>`;
/** Longer waits leave the team WAITING durably (resumable) instead of holding the prompt. */
const TEAM_INTERACTIVE_WAIT_MS = 60_000;

function planLines(phases: Array<{ name: string; status: string }>): string[] {
  return phases.map((p, index) => `${index + 1}. ${p.status === "completed" ? "[x]" : p.status === "in_progress" ? "[~]" : "[ ]"} ${p.name}`);
}

function plan({ host, args }: SlashContext): SlashOutcome {
  const agent = host.app.getAgent();
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const phases = [...agent.getActivePlan()];
  const show = (lead: string) => reply("plan", [lead, ...planLines(agent.getActivePlan())].filter(Boolean).join("\n"));
  switch (sub?.toLowerCase()) {
    case "add": {
      const name = rest.join(" ");
      if (!name) return reply("plan", "Usage: /plan add <phase description>", false);
      agent.setActivePlan([...phases, { name, status: "pending" }]);
      return show(`Added: ${name}`);
    }
    case "start":
    case "done":
    case "complete": {
      const index = Number.parseInt(rest[0] ?? "", 10) - 1;
      if (!(index >= 0 && index < phases.length)) return reply("plan", `Phase number must be 1..${phases.length}.`, false);
      const started = sub.toLowerCase() === "start";
      phases[index] = { ...phases[index], status: started ? "in_progress" : "completed" };
      agent.setActivePlan(phases);
      return show(`Phase ${index + 1} ${started ? "in progress" : "completed"}.`);
    }
    case "clear":
      agent.setActivePlan([]);
      return reply("plan", "Plan cleared.");
    default:
      return phases.length ? show("") : reply("plan", "No active plan. Add a phase with /plan add <description>.");
  }
}

function knowledge({ host, args }: SlashContext): SlashOutcome {
  const graph = host.app.getAgent().getKnowledgeGraph();
  const [sub, key, ...value] = args.trim().split(/\s+/).filter(Boolean);
  const action = sub?.toLowerCase();
  if (action === "set" && key) {
    const entry = graph.set(key, value.join(" "), "rule");
    return reply("knowledge", `Saved [${entry.category}] ${entry.key}`);
  }
  if (action === "delete" && key) return graph.delete(key) ? reply("knowledge", `Deleted ${key}`) : reply("knowledge", `Not found: ${key}`, false);
  const entries = graph.list();
  return entries.length
    ? reply("knowledge", entries.map((e) => `• [${e.category}] ${e.key}: ${e.value}`).join("\n"))
    : reply("knowledge", "No knowledge entries. Add one with /knowledge set <key> <rule>.");
}

function skills({ host }: SlashContext): SlashOutcome {
  const manager = host.app.getAgent().getSkillManager();
  const list = manager.listSkills();
  const untrustedList = manager.listUntrustedSkills();
  if (!list.length && !untrustedList.length) {
    return reply("skills", "No skills found. Add one under ~/.nexus/skills/<name>/SKILL.md or .nexus/skills/, or run /skill init <name>.");
  }
  const lines: string[] = [];
  for (const s of list) {
    lines.push(`• ${s.name} (${s.path})`);
    lines.push(`    ${s.description}`);
  }
  for (const s of untrustedList) {
    lines.push(`• ${s.name} (${s.path}) [untrusted (not loaded)]`);
    lines.push(`    ${s.description} — run 'nexus trust .' to enable workspace skills`);
  }
  lines.push("");
  lines.push("Show one with /skill <name>.");
  return reply("skills", lines.join("\n"));
}

function skill({ host, args }: SlashContext): SlashOutcome {
  const manager = host.app.getAgent().getSkillManager();
  const text = args.trim();
  if (!text) return reply("skill", "Usage: /skill <name> or /skill init <name>", false);
  if (text === "init" || text.startsWith("init ")) {
    const name = text.slice(4).trim();
    if (!name) return reply("skill", "Usage: /skill init <name>", false);
    return reply("skill", `Scaffolded ${name} at ${manager.scaffoldSkill(name).skillPath}`);
  }
  const found = manager.getSkill(text);
  if (found) {
    return reply("skill", `${found.name} · ${found.path}\n\n${found.content}`);
  }
  const untrusted = manager.getUntrustedSkill(text);
  if (untrusted) {
    return reply("skill", `Skill ${text} is in an untrusted workspace [untrusted (not loaded)]. Run 'nexus trust .' to trust this workspace.`, false);
  }
  return reply("skill", `Skill ${text} not found. /skills lists the available ones.`, false);
}

async function mcpAdd(manager: McpClientManager, words: string[]): Promise<SlashOutcome> {
  const usage = "Usage: /mcp add <name> stdio <command...>  or  /mcp add <name> sse|websocket <url>";
  const [name, transport, ...rest] = words;
  if (!name || !transport || !rest.length) return reply("mcp", usage, false);
  const kind = transport.toLowerCase();
  let config: Record<string, unknown>;
  if (kind === "stdio") config = { transport: "stdio", command: rest[0], args: rest.slice(1) };
  else if (kind === "sse" || kind === "websocket") config = { transport: kind, url: rest[0] };
  else return reply("mcp", usage, false);
  const result = await manager.addServer(name, config as any, true);
  return result.success
    ? reply(
        "mcp",
        result.persisted === false
          ? `Connected to ${name}: ${result.toolCount} tools, ${result.resourceCount} resources, ${result.promptCount} prompts. Configuration was NOT saved: ${result.persistError}`
          : `Connected to ${name}: ${result.toolCount} tools, ${result.resourceCount} resources, ${result.promptCount} prompts. Saved to ~/.config/nexus/mcp.json.`
      )
    : reply("mcp", `Connection failed: ${result.error}`, false);
}

async function mcp({ host, args }: SlashContext): Promise<SlashOutcome> {
  const agent = host.app.getAgent();
  await agent.initExtensibility();
  const manager = agent.getMcpManager();
  const words = args.trim().split(/\s+/).filter(Boolean);
  switch (words[0]?.toLowerCase()) {
    case "add":
      return mcpAdd(manager, words.slice(1));
    case "resources": {
      const resources = manager.listResources();
      if (!resources.length) return reply("mcp", "Connected servers expose no resources.");
      const rows = resources.map((r) => `• ${r.name} (${r.uri}) [${r.server}]${r.description ? `\n    ${r.description}` : ""}`);
      return reply("mcp", [...rows, "", "Read one with /mcp resource <uri>."].join("\n"));
    }
    case "resource": {
      const uri = words.slice(1).join(" ");
      if (!uri) return reply("mcp", "Usage: /mcp resource <uri>", false);
      const result = await manager.readResource(uri);
      return result.success ? reply("mcp", result.content || "(empty)") : reply("mcp", `Could not read ${uri}: ${result.error}`, false);
    }
    case "prompts": {
      const prompts = manager.listPrompts();
      if (!prompts.length) return reply("mcp", "Connected servers expose no prompt templates.");
      const rows = prompts.map((p) => {
        const params = p.arguments?.length ? ` (args: ${p.arguments.map((a: any) => a.name).join(", ")})` : "";
        return `• ${p.name}${params} [${p.server}]${p.description ? `\n    ${p.description}` : ""}`;
      });
      return reply("mcp", [...rows, "", "Show one with /mcp prompt <name>."].join("\n"));
    }
    case "prompt": {
      const name = words[1];
      if (!name) return reply("mcp", "Usage: /mcp prompt <name>", false);
      const result = await manager.getPrompt(name);
      return result.success
        ? reply("mcp", [result.description ?? "", JSON.stringify(result.messages, null, 2)].filter(Boolean).join("\n\n"))
        : reply("mcp", `Could not fetch ${name}: ${result.error}`, false);
    }
    default: {
      const servers = manager.listServers();
      if (!servers.length) return reply("mcp", "No MCP servers configured. Add one with /mcp add <name> stdio <command...>.");
      const lines = servers.flatMap((s) => [
        `• ${s.name} [${s.connected ? "connected" : "disconnected"} · ${s.transport}] ${s.command ?? ""}`.trimEnd(),
        `    tools ${s.toolCount} · resources ${s.resourceCount} · prompts ${s.promptCount}`,
      ]);
      const tools = manager.getToolDefinitions();
      if (tools.length) lines.push("", "Tools:", ...tools.map((t) => `  ${t.function.name}: ${t.function.description}`));
      return reply("mcp", lines.join("\n"));
    }
  }
}

async function plugins({ host }: SlashContext): Promise<SlashOutcome> {
  const agent = host.app.getAgent();
  await agent.initExtensibility();
  const list = agent.getPluginManager().listPlugins();
  if (!list.length) return reply("plugins", "No plugins loaded from ~/.nexus/plugins/ or ~/.config/nexus/plugins/.");
  return reply("plugins", list.map((p) => `• ${p.name}: ${p.description} (custom tools: ${p.customToolCount})`).join("\n"));
}

async function browse({ host, args }: SlashContext): Promise<SlashOutcome> {
  const url = args.trim();
  if (!url) return reply("browse", "Usage: /browse <url>", false);
  const page = await host.app.getAgent().getBrowserDriver().navigate(url);
  return reply("browse", `${page.title} · HTTP ${page.status}\n\n${page.contentSnippet.slice(0, 300)}…`, page.status === 200);
}

/** The first word and the remainder untouched, so a multiline prompt or objective keeps its line breaks. */
function firstWord(args: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(args.trim());
  return match ? [match[1], match[2]] : ["", ""];
}

function image({ host, args }: SlashContext): SlashOutcome {
  const [file, rest] = firstWord(args);
  if (!file) return reply("image", "Usage: /image <path> [prompt]", false);
  const prompt = rest || IMAGE_PROMPT;
  const encoded = encodeImageFile(file, host.app.getConfig().workspace);
  if (!encoded.success) return reply("image", `Could not load the image: ${encoded.error}`, false);
  return {
    kind: "turn",
    command: "image",
    prompt: formatVisionContent(prompt, encoded.dataUri),
    label: `${prompt} [image ${path.basename(encoded.filePath)}]`,
    checkpoint: `Vision: ${prompt.slice(0, 30)}`,
  };
}

async function tdd({ host, args, signal }: SlashContext): Promise<SlashOutcome> {
  const issue = args.trim();
  if (!issue) return reply("tdd", "Usage: /tdd <issue description>", false);
  const agent = host.app.getAgent();
  const result = await agent.getSynthesizer().runAutonomousTdd(agent, issue, undefined, { signal, onConfirm: host.confirm(signal) });
  return result.success
    ? reply("tdd", "TDD cycle completed: RED → GREEN → REFACTOR verified.")
    : reply("tdd", `TDD cycle ended at ${result.finalPhase}: ${result.summary}`, false);
}

async function team({ host, args, signal }: SlashContext): Promise<SlashOutcome> {
  const [role, rest] = firstWord(args);
  const independentReview = /^--independent-review\b/.test(rest);
  const objective = rest.replace(/^--independent-review\b\s*/, "").trim();
  if (!role || !objective) return reply("team", TEAM_USAGE, false);
  const name = role.toLowerCase();
  if (name !== "full" && !ROLES.includes(name)) return reply("team", `Unknown role ${role}. Roles: ${[...ROLES, "full"].join(", ")}`, false);
  const events: OperationEvent[] = [];
  const orchestrator = new TeamOrchestrator(host.app.getConfig(), {
    signal,
    independentReview,
    maxInProcessWaitMs: TEAM_INTERACTIVE_WAIT_MS,
    onEvent: (e) => events.push(e),
  });
  const result = await orchestrator.run(name === "full" ? "full" : (name as AgentRole), objective);
  const log = events.map((e) => `◆ ${e.message}`);
  return reply("team", [...log, "", result.report].join("\n").trim(), result.success);
}

async function recover({ host, args }: SlashContext): Promise<SlashOutcome> {
  const result = await host.app.executeSlashCommand("recover", args);
  return reply("recover", result.output, result.success);
}

async function bang({ host, args }: SlashContext): Promise<SlashOutcome> {
  const line = args.trim();
  if (!line) return reply("!", "Usage: !<shell command> or !<history number>", false);
  if (/^\d+$/.test(line)) return recall(host.history(), line, "!");
  const receipt = await host.app.executeOperatorCommand(line);
  const parts = [receipt.output ?? "", receipt.error ?? ""].map((text) => text.trimEnd()).filter(Boolean);
  if (!receipt.success && receipt.status === "DENIED") parts.push("Execution denied by the authority admission gate.");
  return reply("!", parts.join("\n") || (receipt.success ? "(no output)" : "Command failed."), receipt.success);
}

export const EXTENSION_HANDLERS: Record<string, SlashHandler> = {
  plan,
  knowledge,
  skills,
  skill,
  mcp,
  plugins,
  browse,
  image,
  tdd,
  team,
  recover,
  "!": bang,
};
