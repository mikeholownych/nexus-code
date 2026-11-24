/**
 * MT-2 slice 1: what the two tool characterization test files share. A throwaway home and repository, an agent whose
 * policy is injected (never the machine's own policy files), a loopback MCP server and a plugin with one tool each,
 * and the golden-file reader/writer.
 *
 * Golden files are checked byte for byte. They are rewritten only by a run with `NEXUS_TOOLS_RECORD=1`:
 *
 *   cd cli && NEXUS_TOOLS_RECORD=1 HOME=$(mktemp -d) node --import tsx --test \
 *     test/tool_surface_characterization.test.ts test/tool_dispatch_characterization.test.ts
 *
 * (Recording replaces sections in place; after renaming or removing a section, delete the file and record again.)
 * A diff in a golden file is a change in what the model is offered or in how a call is decided, and needs review.
 *
 * `routeProbe` and `instrument` are the only places that reach into how handlers are stored today (the spine's handler
 * map, the registry's handler, the dispatch-built default handler, the bridge). When a tool registry replaces those
 * (MT-2 slice 2) these two functions are what gets adapted; the golden files must not change.
 */
// The agents built here are the importing test file's to shut down; the guard names any that are not.
import "./leak_guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../../src/agent.js";
import { ApprovalPolicy } from "../../src/core/approval_policy.js";
import { DurableStateManager } from "../../src/core/state.js";
import { SecurityManager } from "../../src/security.js";
import type { ToolDefinition } from "../../src/types.js";
import { makeRepo } from "./fixtures.js";
import { policyWorld } from "./policy_enforcement.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const RECORDING = process.env.NEXUS_TOOLS_RECORD === "1";

const render = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * One named section of a golden file. Recording replaces that section and keeps the others; checking compares the
 * section's serialized bytes, so key order and every character count.
 */
export function golden(file: string, section: string, actual: unknown): void {
  const full = path.join(FIXTURES, file);
  if (RECORDING) {
    const current = fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, "utf8")) : {};
    current[section] = JSON.parse(JSON.stringify(actual));
    fs.writeFileSync(full, render(current));
    return;
  }
  const recorded = JSON.parse(fs.readFileSync(full, "utf8"));
  assert.ok(Object.hasOwn(recorded, section), `${file} has no section '${section}'; record it with NEXUS_TOOLS_RECORD=1 and review the diff`);
  assert.equal(render(actual), render(recorded[section]), `${file} section '${section}' differs from today's behaviour; if the change is intended, record with NEXUS_TOOLS_RECORD=1 and review the diff`);
}

/** The sections a golden file holds, and that the file is in the canonical serialization (so a hand edit shows). */
export function goldenSections(file: string): string[] {
  const text = fs.readFileSync(path.join(FIXTURES, file), "utf8");
  const parsed = JSON.parse(text);
  assert.equal(text, render(parsed), `${file} is not in the recorded serialization`);
  return Object.keys(parsed);
}

export interface World {
  home: string;
  repo: string;
  stateDir: string;
  agents: AutonomousAgent[];
  close(): void;
}

/** A throwaway home (so nothing reads or writes the operator's own), a small git repository and a state directory. */
export function makeWorld(files: Record<string, string> = {}): World {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mt2-home-"));
  process.env.HOME = home;
  const repo = makeRepo({ "a.txt": "hello\n", ...files });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mt2-state-"));
  const agents: AutonomousAgent[] = [];
  return {
    home,
    repo,
    stateDir,
    agents,
    close() {
      for (const agent of agents) agent.shutdown();
      for (const dir of [home, repo, stateDir]) fs.rmSync(dir, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  };
}

export interface AgentSpec {
  mode?: "review" | "auto" | "read-only";
  fullAccess?: boolean;
  depth?: number;
  role?: string;
  delegated?: readonly string[];
  /** Tool-output masking (`NEXUS_TOOL_OUTPUT_MASK_TOKENS`, read when the agent is built), which adds `read_tool_output`. */
  mask?: boolean;
  /** The system policy text (TOML); none when omitted. */
  system?: string;
  config?: Record<string, unknown>;
}

/** An agent over the world's repository whose security manager and approval gate see only the injected policy. */
export function makeAgent(world: World, spec: AgentSpec = {}): AutonomousAgent {
  const options = spec.role !== undefined || spec.delegated !== undefined || spec.depth
    ? { ...(spec.depth ? { durable: false } : {}), ...(spec.role !== undefined ? { role: spec.role } : {}), ...(spec.delegated ? { delegatedToolAllowList: spec.delegated } : {}) }
    : undefined;
  const previousMask = process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS;
  if (spec.mask) process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS = "2000";
  else delete process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS;
  let agent: AutonomousAgent;
  try {
    agent = new AutonomousAgent(
      { endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: world.repo, shell: "bash", fullAccess: spec.fullAccess, ...spec.config } as any,
      spec.depth ?? 0,
      options as any,
    );
  } finally {
    if (previousMask === undefined) delete process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS;
    else process.env.NEXUS_TOOL_OUTPUT_MASK_TOKENS = previousMask;
  }
  world.agents.push(agent);
  const a = agent as any;
  a.stateManager = new DurableStateManager({ baseDir: world.stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
  const policy = policyWorld(spec.system === undefined ? {} : { system: spec.system });
  a.bridge.securityManager = new SecurityManager(world.repo, { policyFor: (workspace) => policy.load(workspace), notify: () => {} });
  agent.setApprovalPolicy(new ApprovalPolicy(() => policy.host.managed().effective));
  a.ui = new Proxy({}, { get: () => () => {} });
  agent.setObserver({ onNotice: () => {} } as any);
  if (spec.mode) agent.setApprovalMode(spec.mode);
  return agent;
}

export const MCP_TOOL = "mcp__demo__echo";
export const PLUGIN_TOOL = "custom__stamp";

/** A loopback MCP server (streamable HTTP) with one tool, `echo`. */
export async function startFakeMcp(): Promise<{ url: string; calls: string[]; close(): Promise<void> }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      calls.push(body.method);
      const result =
        body.method === "tools/list" ? { tools: [{ name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string", description: "What to echo." } }, required: ["text"] } }] }
        : body.method === "tools/call" ? { content: [{ type: "text", text: `echo:${body.params?.arguments?.text}` }] }
        : {};
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const PLUGIN_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: PLUGIN_TOOL,
    description: "Stamp a label (test plugin tool).",
    parameters: { type: "object", properties: { label: { type: "string", description: "The label." } }, required: ["label"] },
  },
} as ToolDefinition;

/**
 * Adds the fake MCP server's tool and one plugin tool to an agent through the public extension points, then syncs the
 * capability registry the way a turn start does. Returns what the MCP manager answered (a posture may refuse it).
 */
export async function addExtensions(agent: AutonomousAgent, mcpUrl: string): Promise<{ success: boolean; error?: string }> {
  await agent.initExtensibility();
  const added = await agent.getMcpManager().addServer("demo", { url: mcpUrl, transport: "http" } as any, true);
  (agent as any).pluginManager.registerPlugin({
    name: "mt2-characterization",
    customTools: [{ definition: PLUGIN_TOOL_DEFINITION, handler: async (args: any) => ({ success: true, output: `stamp:${args.label}` }) }],
  });
  await agent.initExtensibility();
  return added;
}

/** Arguments that satisfy a tool's schema: every required property, by type. Deterministic, and never a real target. */
export function sampleArgs(definition: ToolDefinition): Record<string, unknown> {
  const { name, parameters } = definition.function as any;
  const args: Record<string, unknown> = {};
  for (const key of parameters?.required ?? []) {
    const schema = parameters.properties?.[key] ?? {};
    const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
    if (Array.isArray(schema.enum)) args[key] = schema.enum[0];
    else if (key === "url") args[key] = `https://${name.replace(/_/g, "-")}.invalid/page`;
    else if (key === "command") args[key] = "echo sample";
    else if (key === "path" || key === "file_path") args[key] = "sample.txt";
    else if (type === "integer" || type === "number") args[key] = 1;
    else if (type === "boolean") args[key] = false;
    else if (type === "array") args[key] = [];
    else if (type === "object") args[key] = {};
    else args[key] = "sample";
  }
  return args;
}

export type RouteSource = "spine-handler" | "registry-handler" | "mcp" | "plugin" | "pipeline-bridge";

/**
 * Which of today's handler sources `ExecutionSpine.execute` resolves for a registered tool, in its order: the spine's
 * own handler map, then the registry's handler (the same object as `capability.handler`), then the default handler
 * dispatch builds (MCP, plugin tool, else the plugin pipeline around the bridge).
 */
export function routeProbe(agent: AutonomousAgent, name: string): RouteSource {
  const a = agent as any;
  if (agent.getSpine().getHandler(name)) return "spine-handler";
  if (agent.getCapabilityRegistry().getHandler(name)) return "registry-handler";
  if (a.mcpManager.isMcpTool(name)) return "mcp";
  if (a.pluginManager.isCustomTool(name)) return "plugin";
  return "pipeline-bridge";
}

export interface Instrumented {
  /** The events since the last `take`, in order. */
  take(): string[];
}

const STUB_OUTPUT = "<stub>";

/**
 * Makes every effect of a dispatched call observable and harmless: each handler source is replaced by a stub that
 * records that it ran (so no command, file write, browser or network call happens), and every collaborator dispatch
 * talks to (spine hooks, plugin notifications and pipeline, journal, flight recorder, observer, audit log, UI) records
 * its call and then does what it did before.
 */
export function instrument(agent: AutonomousAgent, world: World): Instrumented & { trace(event: string): void } {
  const a = agent as any;
  let events: string[] = [];
  const auditFile = path.join(world.home, ".nexus", "audit.log");
  const auditSize = (): number => { try { return fs.statSync(auditFile).size; } catch { return 0; } };
  let seenAudit = auditSize();
  const trace = (event: string): void => {
    const size = auditSize();
    if (size !== seenAudit) { seenAudit = size; events.push("audit.log"); }
    events.push(event);
  };

  // Handler sources.
  const spine = agent.getSpine();
  for (const capability of agent.getCapabilityRegistry().listCapabilities()) {
    const name = capability.modelToolName;
    if (spine.getHandler(name)) spine.registerHandler(name, async () => { trace("run:spine-handler"); return { success: true, output: STUB_OUTPUT }; });
  }
  a.bridge.executeTool = async () => { trace("run:bridge"); return { success: true, output: STUB_OUTPUT }; };
  a.mcpManager.executeMcpTool = async () => { trace("run:mcp"); return { success: true, output: STUB_OUTPUT }; };
  a.pluginManager.executeCustomTool = async () => { trace("run:plugin"); return { success: true, output: STUB_OUTPUT }; };

  // The spine's gates, in the order the spine calls them.
  const hooks = spine.getHooks() as Record<string, (...args: any[]) => Promise<any>>;
  for (const [hookName, hook] of Object.entries(hooks)) {
    spine.setHook(hookName as any, (async (...args: any[]) => {
      const result = await hook(...args);
      const verdict = result && typeof result === "object"
        ? (result.admitted === false || result.confined === false || result.allowed === false ? "(refused)" : "")
        : "";
      trace(`spine.${hookName}${hookName === "processLifecycle" ? `:${args[0]?.stage}` : ""}${verdict}`);
      return result;
    }) as any);
  }

  // What dispatch itself calls.
  const wrap = (target: any, method: string, label: (...args: any[]) => string): void => {
    const original = target[method].bind(target);
    target[method] = (...args: any[]) => { trace(label(...args)); return original(...args); };
  };
  wrap(a.pluginManager, "notifyToolCall", () => "plugin.notifyToolCall");
  wrap(a.pluginManager, "notifyToolResult", () => "plugin.notifyToolResult");
  wrap(a.pluginManager, "executeToolPipeline", () => "plugin.pipeline");
  wrap(a.stateManager, "recordOperationStart", () => "journal.start");
  wrap(a.stateManager, "recordOperationEnd", () => "journal.end");
  wrap(a, "captureChangeBaseline", () => "baseline.capture");
  a.flightRecorder = new Proxy({}, {
    get: (_target, method: string) => (...args: any[]) => {
      if (method === "recordToolResult") trace(`flight.toolResult:${args[3] ? "ok" : "failed"}${typeof args[6] === "string" && /^[A-Za-z_ ]+$/.test(args[6]) ? `:${args[6]}` : ""}`);
      else trace(`flight.${method.replace(/^record/, "").replace(/^./, (c) => c.toLowerCase())}`);
    },
  });
  a.ui = new Proxy({}, { get: (_target, method: string) => () => { if (method === "printToolCall" || method === "printToolResult") trace(`ui.${method}`); } });
  agent.setObserver({
    onNotice: () => {},
    onToolStart: () => trace("observer.toolStart"),
    onToolEnd: (event: any) => trace(`observer.toolEnd:${event.success ? "ok" : "failed"}${event.denied ? ":denied" : ""}`),
    onFileChange: () => trace("observer.fileChange"),
  } as any);

  return {
    trace,
    take() {
      trace("end");
      const taken = events.slice(0, -1);
      events = [];
      return taken;
    },
  };
}

let callSeq = 0;

export interface Outcome {
  /** How often the operator was asked, and whether each question had to be answered by the operator in person. */
  asked: string[];
  status: string;
  success: boolean;
  capabilityId: string;
  denialReason: string | null;
  error: string | null;
  output: string;
  shouldExit: boolean;
  executionDomain: string;
  simulated: boolean;
  /** The receipt's keys, sorted: the shape a consumer sees. */
  receiptKeys: string;
  trace: string;
}

export type Operator = "none" | "approves" | "declines";

/** Dispatches one call through the agent's real dispatch and returns what a characterization row records. */
export async function dispatch(
  agent: AutonomousAgent,
  world: World,
  probe: Instrumented & { trace(event: string): void },
  name: string,
  rawArguments: unknown,
  operator: Operator = "none",
  actor: "agent" | "subagent" = "agent",
): Promise<Outcome> {
  const asked: string[] = [];
  const onConfirm = operator === "none" ? undefined : async (_tool: string, _args: unknown, _signal: unknown, options?: { requireOperatorDecision?: boolean }) => {
    asked.push(options?.requireOperatorDecision ? "operator-must-decide" : "asked");
    probe.trace("confirm");
    return operator === "approves";
  };
  const call = { id: `mt2-${++callSeq}`, type: "function", function: { name, arguments: typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments) } };
  probe.take();
  let result: { receipt: any; shouldExit: boolean };
  try {
    result = await (agent as any).dispatchToolCall(call, 1, actor, onConfirm);
  } catch (error) {
    // Dispatch is expected to answer with a receipt; a call that makes it throw is recorded as that.
    const thrown = error as Error;
    return { asked, status: "THREW", success: false, capabilityId: "", denialReason: null, error: `${thrown.name}: ${thrown.message}`, output: "", shouldExit: false, executionDomain: "", simulated: false, receiptKeys: "", trace: probe.take().join(" > ") };
  }
  const { receipt, shouldExit } = result;
  const scrub = (text: string): string => text.split(world.repo).join("<workspace>").split(world.home).join("<home>").replace(/needs_input [0-9a-f]{8,}/g, "needs_input <id>");
  return {
    asked,
    status: receipt.status,
    success: receipt.success,
    capabilityId: receipt.capabilityId,
    denialReason: receipt.denialReason ?? null,
    error: receipt.error ? scrub(String(receipt.error)) : null,
    output: scrub(String(receipt.output ?? "")),
    shouldExit,
    executionDomain: receipt.executionDomain,
    simulated: receipt.simulated,
    receiptKeys: Object.keys(receipt).filter((key) => receipt[key] !== undefined).sort().join(","),
    trace: probe.take().join(" > "),
  };
}
