import "./helpers/leak_guard.js";
/**
 * MT-2 slice 2: the tool registry. A tool is one registered spec+handler pair; registration fails closed; the registry
 * has no way to grant anything; the model-visible list keeps today's order and filters. The routing and the lists of the
 * shipped catalogue are pinned by tool_surface_characterization and tool_dispatch_characterization.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as toolRegistryModule from "../src/core/tool_registry.js";
import { ToolRegistry, baselineTools, createToolRegistry, type OfferContext, type RegisteredTool } from "../src/core/tool_registry.js";
import { HARNESS_TOOLS, type CanonicalCapability } from "../src/core/capabilities.js";
import { extensionCapability } from "../src/core/extension_capabilities.js";
import { TOOL_GROUPS, toolGroupOf } from "../src/core/tool_groups.js";
import { ExecutionSpine } from "../src/core/spine.js";
import { isKnownToolName } from "../src/parser.js";
import type { ToolDefinition } from "../src/types.js";

function definition(name: string): ToolDefinition {
  return { type: "function", function: { name, description: `test tool ${name}`, parameters: { type: "object", properties: {}, additionalProperties: false } } } as ToolDefinition;
}

function spec(name: string, over: Partial<CanonicalCapability> = {}): CanonicalCapability {
  return {
    id: `test_${name}`, modelToolName: name, category: "test", mutating: false, effect: "read_workspace",
    sideEffectContract: "test only", backend: "ts_native", toolDefinition: definition(name), ...over,
  };
}

const ok = async () => ({ success: true, output: "ran" });
const native = (name: string, over: Partial<RegisteredTool> = {}): RegisteredTool => ({ spec: spec(name), binding: { kind: "native", handler: ok }, offer: "always", ...over });
const ctx = (over: Partial<OfferContext> = {}): OfferContext => ({
  enabledGroups: new Set(), hasSkills: false, offerObjective: false, offerRequirements: false, maskOutput: false, extensions: [], ...over,
});
const names = (tools: ToolDefinition[]): string[] => tools.map((t) => t.function.name);
const context = { workspaceRoot: "/workspace", dryRun: false, readOnly: false };

describe("registration fails closed", () => {
  test("a duplicate name is refused, and nothing changes", () => {
    const registry = new ToolRegistry();
    registry.register(native("alpha"));
    assert.throws(() => registry.register(native("alpha")), /Duplicate tool registration/);
    assert.equal(registry.capabilities().listCapabilities().length, 1);
  });

  test("a spec that carries its own handler next to a binding is refused", () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register({ spec: spec("alpha", { handler: ok }), binding: { kind: "native", handler: ok }, offer: "always" }), /one source/);
    assert.equal(registry.resolve("alpha"), undefined);
  });

  test("a non-extension spec without a binding is refused", () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register({ spec: spec("alpha"), offer: "always" } as unknown as RegisteredTool), /no binding/);
    assert.throws(() => registry.register({ spec: spec("alpha"), binding: { kind: "other" }, offer: "always" } as unknown as RegisteredTool), /no binding/);
  });

  test("an extension cannot register read_workspace, internal or any effect that never asks", () => {
    const registry = new ToolRegistry();
    for (const effect of ["read_workspace", "internal", "delegate", "context_inject", "write_workspace"] as const) {
      const extension = { ...extensionCapability(definition("mcp__x__y"), { kind: "plugin" }), effect };
      assert.throws(() => registry.register({ spec: extension, binding: { kind: "extension" }, offer: "always" }), /only exec or egress/, effect);
    }
    for (const effect of ["exec", "egress"] as const) {
      registry.register({ spec: { ...extensionCapability(definition(`custom__${effect}`), { kind: "plugin" }), effect }, binding: { kind: "extension" }, offer: "always" });
    }
    assert.deepEqual(registry.capabilities().listCapabilities().map((c) => c.effect), ["exec", "egress"]);
  });

  test("an extension binding cannot carry a quiet spec, and a quiet binding cannot carry an extension spec", () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register({ spec: spec("alpha"), binding: { kind: "extension" }, offer: "always" }), /extension category, backend and binding together/);
    assert.throws(() => registry.register({ spec: extensionCapability(definition("custom__a"), { kind: "plugin" }), binding: { kind: "native", handler: ok }, offer: "always" }), /together/);
  });

  test("the shipped catalogue registers without an error and every tool has a binding", () => {
    const registry = createToolRegistry();
    for (const cap of registry.capabilities().listCapabilities()) assert.ok(registry.resolve(cap.modelToolName)?.binding, cap.modelToolName);
  });
});

describe("the registry grants nothing", () => {
  test("it has no member that changes an effect, skips the operator or sets a handler by name", () => {
    const members = [...Object.getOwnPropertyNames(ToolRegistry.prototype).filter((name) => name !== "constructor"), ...Object.keys(toolRegistryModule)].sort();
    assert.deepEqual(members, ["ToolRegistry", "baselineDefinitions", "baselineTools", "capabilities", "createToolRegistry", "isBridgeBound", "modelTools", "register", "resolve", "serveMcpDefinitions", "unregisterExtensions"].sort());
    for (const member of members) assert.doesNotMatch(member, /effect|approv|requiresDecision|grant|allow|skip|trust|setHandler|setEffect|override/i, member);
  });

  test("the only removal is of extension tools", () => {
    const registry = new ToolRegistry();
    registry.register(native("alpha"));
    registry.register({ spec: extensionCapability(definition("custom__beta"), { kind: "plugin" }), binding: { kind: "extension" }, offer: "always" });
    registry.unregisterExtensions();
    assert.deepEqual(registry.capabilities().listCapabilities().map((c) => c.modelToolName), ["alpha"]);
    assert.equal(registry.resolve("custom__beta"), undefined);
  });

  test("a registered effect is the effect dispatch reads", () => {
    const registry = new ToolRegistry();
    registry.register(native("alpha", { spec: spec("alpha", { effect: "write_workspace", mutating: true }) }));
    assert.equal(registry.capabilities().getByToolName("alpha")?.effect, "write_workspace");
  });
});

describe("the model-visible list", () => {
  test("keeps the order and the filters of the agent's list", () => {
    const registry = new ToolRegistry();
    // Registered in a different order from the offered one on purpose: the offer rule fixes the order.
    registry.register(native("mask_tool", { offer: "mask" }));
    registry.register(native("always_tool"));
    registry.register(native("requirements_tool", { offer: "requirements" }));
    registry.register(native("objective_tool", { offer: "objective" }));
    registry.register(native("enable_tool", { offer: "until-all-groups" }));
    registry.register(native("skills_tool", { offer: "skills" }));
    registry.register(native("group_tool", { offer: "group" }));
    const everything = ctx({ enabledGroups: new Set(), hasSkills: true, offerObjective: true, offerRequirements: true, maskOutput: true, extensions: [definition("mcp__s__t"), definition("custom__p")] });
    assert.deepEqual(names(registry.modelTools(everything)), ["skills_tool", "group_tool", "enable_tool", "objective_tool", "requirements_tool", "always_tool", "mask_tool", "mcp__s__t", "custom__p"]);
    assert.deepEqual(names(registry.modelTools(ctx())), ["group_tool", "enable_tool", "always_tool"]);
    assert.deepEqual(names(registry.modelTools({ ...everything, admits: (name) => name !== "always_tool" && name !== "custom__p" })), ["skills_tool", "group_tool", "enable_tool", "objective_tool", "requirements_tool", "mask_tool", "mcp__s__t"]);
  });

  test("the shipped catalogue offers exactly HARNESS_TOOLS when every group and skills are on", () => {
    const registry = createToolRegistry();
    const offered = registry.modelTools(ctx({ enabledGroups: new Set(Object.keys(TOOL_GROUPS)), hasSkills: true }));
    assert.deepEqual(names(offered), names(HARNESS_TOOLS));
    assert.deepEqual(names(registry.baselineDefinitions()), names(HARNESS_TOOLS));
    assert.ok(HARNESS_TOOLS.every((tool, i) => offered[i] === tool));
    assert.deepEqual(names(registry.modelTools(ctx())), names(HARNESS_TOOLS.filter((t) => !toolGroupOf(t.function.name) && t.function.name !== "activate_skill")));
  });
});

describe("adding a tool is one registered spec and handler pair", () => {
  test("it is model-visible, dispatched, and in every derived list, with no other edit", async () => {
    const registry = new ToolRegistry();
    const before = createToolRegistry();
    registry.register(native("zeta_probe", {
      spec: spec("zeta_probe"),
      binding: { kind: "native", handler: async (args) => ({ success: true, output: `zeta:${args.value}` }) },
      offer: "group",
      baseline: true,
    }));
    assert.deepEqual(names(registry.modelTools(ctx())), ["zeta_probe"]);
    assert.deepEqual(names(registry.baselineDefinitions()), ["zeta_probe"]);
    assert.deepEqual(names(registry.serveMcpDefinitions()), ["zeta_probe"]);
    assert.ok(registry.capabilities().getByToolName("zeta_probe"));

    const spine = new ExecutionSpine({ tools: registry });
    const receipt = await spine.execute({ toolName: "zeta_probe", args: { value: 7 }, taskId: "t" }, context);
    assert.equal(receipt.status, "COMPLETED");
    assert.equal(receipt.output, "zeta:7");

    // The shipped catalogue is untouched, and the shipped derived lists do not know the test tool.
    assert.equal(before.resolve("zeta_probe"), undefined);
    assert.equal(baselineTools.resolve("zeta_probe"), undefined);
    assert.equal(isKnownToolName("zeta_probe"), false);
  });

  test("an agent-bound tool is not served over MCP", () => {
    const registry = new ToolRegistry();
    registry.register(native("loop_tool", { baseline: true, agentBound: true }));
    registry.register(native("plain_tool", { baseline: true }));
    assert.deepEqual(names(registry.serveMcpDefinitions()), ["plain_tool"]);
  });

  test("a tool the registry does not hold is refused by the spine, as before", async () => {
    const spine = new ExecutionSpine({ tools: new ToolRegistry() });
    const receipt = await spine.execute({ toolName: "ghost", args: {}, taskId: "t" }, context);
    assert.equal(receipt.success, false);
    assert.notEqual(receipt.status, "COMPLETED");
  });
});

describe("each binding resolves to its own route", () => {
  test("native runs its handler, bridge runs through the bridge, extension runs through the default handler", async () => {
    const registry = new ToolRegistry();
    registry.register(native("n_tool", { binding: { kind: "native", handler: async () => ({ success: true, output: "native" }) } }));
    registry.register({ spec: spec("b_tool", { backend: "rust_rpc" }), binding: { kind: "bridge" }, offer: "always" });
    registry.register({ spec: extensionCapability(definition("custom__e"), { kind: "plugin" }), binding: { kind: "extension" }, offer: "always" });
    const spine = new ExecutionSpine({ tools: registry });
    const routed = {
      ...context,
      bridge: { executeTool: async () => ({ success: true, output: "bridge" }) } as any,
      defaultHandler: async () => ({ success: true, output: "default" }),
    };
    const run = async (toolName: string, extra = {}) => (await spine.execute({ toolName, args: {}, taskId: "t" }, { ...routed, ...extra })).output;
    assert.equal(await run("n_tool"), "native");
    assert.equal(await run("custom__e"), "default");
    // With no default handler, the bridge-bound tool still reaches the bridge, and the extension tool does not.
    assert.equal(await run("b_tool", { defaultHandler: undefined }), "bridge");
  });

  test("a handler registered on the spine still takes precedence over the binding", async () => {
    const registry = new ToolRegistry();
    registry.register(native("n_tool", { binding: { kind: "native", handler: async () => ({ success: true, output: "bound" }) } }));
    const spine = new ExecutionSpine({ tools: registry });
    spine.registerHandler("n_tool", async () => ({ success: true, output: "spine" }));
    assert.equal((await spine.execute({ toolName: "n_tool", args: {}, taskId: "t" }, context)).output, "spine");
  });
});
