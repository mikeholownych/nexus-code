/**
 * The tool registry (MT-2): a tool is one registered pair of a spec (what the model sees and what the tool may affect)
 * and a binding (how a call of it runs). The model-visible list, the dispatch route and the lists derived from the
 * baseline catalogue (the parser's known names, `nexus serve-mcp`) all read this one registry, so adding a tool is one
 * `register` and nothing else.
 *
 * It fails closed and grants nothing. `register` refuses a duplicate name, a spec that already carries its own handler
 * next to a binding, a non-extension spec without a binding, and an extension whose effect is not `exec` or `egress`
 * (an extension can never register itself as `read_workspace` or `internal`, which never ask). There is no member that
 * changes an effect, marks a tool approval-free or overrides the operator decision: whether a call is asked, denied or
 * run is decided in dispatch from the registered effect, exactly as before. See docs/TOOL_REGISTRY.md.
 */
import type { ToolDefinition } from "../types.js";
import {
  BASELINE_CAPABILITIES,
  CapabilityRegistry,
  type CanonicalCapability,
  type CapabilityHandler,
} from "./capabilities.js";
import { isExtensionCapability } from "./extension_capabilities.js";
import { TOOL_GROUPS, toolGroupOf } from "./tool_groups.js";

/** How a call of a tool runs. */
export type ToolBinding =
  /** In-process. `handler` may be omitted when the owner attaches it later (`ExecutionSpine.registerHandler`). */
  | { kind: "native"; handler?: CapabilityHandler }
  /** The Rust core through `RustCoreBridge.executeTool`. */
  | { kind: "bridge" }
  /** An MCP server or a plugin, through the plugin pipeline. */
  | { kind: "extension" };

/**
 * When the model is offered the tool. `group`: its tool group is enabled (or it has none); `skills`: a skill exists;
 * `until-all-groups`: some group is still hidden; `objective` / `requirements`: the agent owns an objective ledger
 * (with requirements); `always`; `mask`: output masking is on.
 */
export type OfferRule = "always" | "group" | "skills" | "objective" | "requirements" | "mask" | "until-all-groups";

export interface RegisteredTool {
  spec: CanonicalCapability;
  binding: ToolBinding;
  offer: OfferRule;
  /** Part of the shipped catalogue (the derived lists are built from these). */
  baseline?: boolean;
  /** Needs the model loop around it, so `nexus serve-mcp` does not list it. */
  agentBound?: boolean;
}

/** What decides which tools one agent is offered (the agent computes it; the registry holds no agent state). */
export interface OfferContext {
  enabledGroups: ReadonlySet<string>;
  hasSkills: boolean;
  offerObjective: boolean;
  offerRequirements: boolean;
  maskOutput: boolean;
  /** Connected MCP tool definitions then plugin tool definitions: discovered live, offered after the registered tools. */
  extensions: readonly ToolDefinition[];
  /** Role allow and deny lists and a delegated allow-list, as one predicate over a tool name. */
  admits?: (name: string) => boolean;
}

/** Offer order: rules rank in the order the model has always seen the tools; within a rank, registration order. */
const OFFER_RANK: Record<OfferRule, number> = {
  group: 0,
  skills: 0,
  "until-all-groups": 1,
  objective: 2,
  requirements: 3,
  always: 4,
  mask: 5,
};

function offered(rule: OfferRule, name: string, ctx: OfferContext): boolean {
  switch (rule) {
    case "always": return true;
    case "group": { const group = toolGroupOf(name); return !group || ctx.enabledGroups.has(group); }
    case "skills": return ctx.hasSkills;
    case "until-all-groups": return !Object.keys(TOOL_GROUPS).every((group) => ctx.enabledGroups.has(group));
    case "objective": return ctx.offerObjective;
    case "requirements": return ctx.offerRequirements;
    case "mask": return ctx.maskOutput;
  }
}

const EXTENSION_EFFECTS: readonly string[] = ["exec", "egress"];

export class ToolRegistry {
  private readonly capabilityRegistry = new CapabilityRegistry();
  private readonly tools = new Map<string, RegisteredTool>();

  /** Registers a tool. Throws (nothing is registered) when it would open a gap; see the module comment. */
  public register(tool: RegisteredTool): void {
    const { spec, binding } = tool;
    const name = spec?.modelToolName;
    if (!name) throw new Error("Invalid tool: spec.modelToolName is required.");
    if (this.tools.has(name)) throw new Error(`Duplicate tool registration: '${name}' is already registered.`);
    if (!binding || !["native", "bridge", "extension"].includes(binding.kind)) {
      throw new Error(`Tool '${name}' has no binding: every tool is registered with how a call of it runs.`);
    }
    if (spec.handler) {
      throw new Error(`Tool '${name}' carries a handler on its spec and a binding: a tool has one source for how it runs.`);
    }
    const extension = binding.kind === "extension" || isExtensionCapability(spec) || spec.backend === "extension";
    if (extension) {
      if (binding.kind !== "extension" || !isExtensionCapability(spec) || spec.backend !== "extension") {
        throw new Error(`Tool '${name}': an extension tool has the extension category, backend and binding together.`);
      }
      if (!EXTENSION_EFFECTS.includes(spec.effect)) {
        throw new Error(`Extension tool '${name}' cannot have effect '${spec.effect}': only exec or egress, which review mode asks about.`);
      }
    }
    this.capabilityRegistry.register(spec);
    this.tools.set(name, tool);
  }

  public resolve(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Removes every extension tool (an MCP reconnect or a posture change may have removed some). Nothing else. */
  public unregisterExtensions(): void {
    for (const [name, tool] of [...this.tools]) {
      if (tool.binding.kind !== "extension") continue;
      this.tools.delete(name);
      this.capabilityRegistry.unregister(name);
    }
  }

  /** The tools one agent offers the model: the order and filters `AutonomousAgent.effectiveTools` has always used. */
  public modelTools(ctx: OfferContext): ToolDefinition[] {
    const own = [...this.tools.values()]
      .filter((tool) => tool.binding.kind !== "extension" && offered(tool.offer, tool.spec.modelToolName, ctx))
      .map((tool, index) => ({ tool, index }))
      .sort((a, b) => OFFER_RANK[a.tool.offer] - OFFER_RANK[b.tool.offer] || a.index - b.index)
      .map(({ tool }) => tool.spec.toolDefinition);
    const all = [...own, ...ctx.extensions];
    return ctx.admits ? all.filter((tool) => ctx.admits!(tool.function.name)) : all;
  }

  /** Adapter for callers of `getByToolName`, `listCapabilities` and the spine: the same specs, same order. */
  public capabilities(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  /** The baseline catalogue's model definitions, in registration order (`HARNESS_TOOLS`). */
  public baselineDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].filter((tool) => tool.baseline).map((tool) => tool.spec.toolDefinition);
  }

  /** What `nexus serve-mcp` lists: the baseline tools that do not need the model loop. */
  public serveMcpDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].filter((tool) => tool.baseline && !tool.agentBound).map((tool) => tool.spec.toolDefinition);
  }
}

/** Baseline tools that run in the Rust core (the `rust_rpc` backend, plus the TypeScript-backed ones that call it). */
const BRIDGED_TS_TOOLS: ReadonlySet<string> = new Set(["fetch_web", "search_web", "lsp_hover", "lsp_definition", "lsp_diagnostics", "run_tests"]);

export function isBridgeBound(cap: Pick<CanonicalCapability, "backend" | "modelToolName">): boolean {
  return cap.backend === "rust_rpc" || BRIDGED_TS_TOOLS.has(cap.modelToolName);
}

const AGENT_BOUND: ReadonlySet<string> = new Set(["spawn_subagent", "activate_skill"]);

/** A registry holding the shipped catalogue. Each agent has its own, because its handlers and extensions are its own. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const cap of BASELINE_CAPABILITIES) {
    registry.register({
      spec: { ...cap },
      binding: isBridgeBound(cap) ? { kind: "bridge" } : { kind: "native" },
      offer: cap.modelToolName === "activate_skill" ? "skills" : "group",
      baseline: true,
      agentBound: AGENT_BOUND.has(cap.modelToolName),
    });
  }
  return registry;
}

/** The shipped catalogue, for the lists derived from it. Not an agent's registry: nothing is registered into it later. */
export const baselineTools: ToolRegistry = createToolRegistry();
