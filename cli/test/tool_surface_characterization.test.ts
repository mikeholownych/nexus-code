import "./helpers/leak_guard.js";
/**
 * MT-2 slice 1: what the model is offered, pinned before the tool registry refactor.
 *
 * `AutonomousAgent.getEffectiveTools()` is the list sent with every model request (run_turn passes it to the client
 * unchanged). For each configuration below the test records the tool names in order plus the byte length and SHA-256
 * of `JSON.stringify(tools)`, and every distinct tool definition in full, in `fixtures/model_tools_v1.json`. A later
 * slice that changes one character of one description, one schema key or the order of two tools fails here.
 *
 * Also pinned: the lists derived from the baseline catalogue (`HARNESS_TOOLS`, the parser's known tool names, what
 * `nexus serve-mcp` lists, the ACP kind table), which the registry must keep identical.
 *
 * Regenerate (only for an intended change, and review the diff): see helpers/tool_characterization.ts.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AutonomousAgent } from "../src/agent.js";
import { TOOL_KINDS } from "../src/acp/mapping.js";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import { createLedger } from "../src/core/objective.js";
import { ROLE_PROFILES } from "../src/core/roles.js";
import { TOOL_GROUPS } from "../src/core/tool_groups.js";
import { McpServer } from "../src/mcp.js";
import { isKnownToolName, isWriteOrExecTool } from "../src/parser.js";
import type { ToolDefinition } from "../src/types.js";
import { MCP_TOOL, PLUGIN_TOOL, RECORDING, addExtensions, golden, goldenSections, makeAgent, makeWorld, startFakeMcp, type AgentSpec, type World } from "./helpers/tool_characterization.js";

const FILE = "model_tools_v1.json";
const ALL_GROUPS = Object.keys(TOOL_GROUPS);
const ROLES = Object.keys(ROLE_PROFILES);

interface Setup extends AgentSpec {
  groups?: readonly string[];
  /** An objective ledger: without requirements, or with one. */
  objective?: "bare" | "requirements";
  /** A skill in the (throwaway) home, so `activate_skill` has something to activate. */
  skills?: boolean;
  /** One MCP tool and one plugin tool. */
  extensions?: boolean;
}

const EVERYTHING: Setup = { groups: ALL_GROUPS, objective: "requirements", skills: true, mask: true, extensions: true };

/** The matrix. Names say what differs from a main agent started with nothing. */
const CONFIGURATIONS: Record<string, Setup> = {
  "main/default": {},
  "main/mode=auto": { mode: "auto" },
  "main/mode=auto,full-access": { mode: "auto", fullAccess: true },
  "main/mode=read-only": { mode: "read-only" },
  "main/launched-read-only": { config: { readOnly: true } },
  ...Object.fromEntries(ALL_GROUPS.map((group) => [`main/group=${group}`, { groups: [group] }])),
  "main/groups=all": { groups: ALL_GROUPS },
  "main/objective": { objective: "bare" },
  "main/objective+requirements": { objective: "requirements" },
  "main/skills": { skills: true },
  "main/mask": { mask: true },
  "main/extensions": { extensions: true },
  "main/everything": EVERYTHING,
  "main/everything,mode=read-only": { ...EVERYTHING, mode: "read-only" },
  "main/delegated=read_file,run_command,enable_tools,mcp,no_such_tool": { ...EVERYTHING, delegated: ["read_file", "run_command", "enable_tools", MCP_TOOL, "no_such_tool"] },
  "subagent/default": { depth: 1 },
  "subagent/everything": { ...EVERYTHING, depth: 1 },
  "subagent/delegated=read_file,search_code,task_completed": { ...EVERYTHING, depth: 1, delegated: ["read_file", "search_code", "task_completed"] },
  ...Object.fromEntries(ROLES.flatMap((role) => [
    [`main/role=${role},everything`, { ...EVERYTHING, role }],
    [`subagent/role=${role},everything`, { ...EVERYTHING, role, depth: 1 }],
  ])),
};

const digest = (tools: readonly unknown[]): { bytes: number; sha256: string } => {
  const text = JSON.stringify(tools);
  return { bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
};
const names = (tools: readonly ToolDefinition[]): string => tools.map((tool) => tool.function.name).join(",");

describe("the model-facing tool list (MT-2 characterization)", () => {
  let world: World;
  let mcp: Awaited<ReturnType<typeof startFakeMcp>>;
  const offered = new Map<string, ToolDefinition[]>();

  async function build(setup: Setup): Promise<AutonomousAgent> {
    const skillDir = path.join(world.home, ".nexus", "skills", "mt2-demo");
    fs.rmSync(skillDir, { recursive: true, force: true });
    if (setup.skills) {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: mt2-demo\ndescription: A skill that exists so activate_skill is offered\n---\nDo nothing.\n");
    }
    const agent = makeAgent(world, setup);
    const a = agent as any;
    if (setup.extensions) await addExtensions(agent, mcp.url);
    if (setup.groups) a.enabledToolGroups = new Set(setup.groups);
    if (setup.objective) {
      const ledger = createLedger("characterize the tool list", "2026-01-01T00:00:00.000Z");
      // createLedger derives requirements from the text; the two states are set explicitly here.
      ledger.requirements = setup.objective === "requirements" ? [{ id: "R1", text: "a requirement", status: "open" } as any] : [];
      a.objective = ledger;
    }
    return agent;
  }

  before(async () => {
    world = makeWorld();
    mcp = await startFakeMcp();
    for (const [name, setup] of Object.entries(CONFIGURATIONS)) {
      const agent = await build(setup);
      offered.set(name, JSON.parse(JSON.stringify(agent.getEffectiveTools())));
      // The list is a pure function of the agent's state: asking twice gives the same bytes.
      assert.equal(JSON.stringify(agent.getEffectiveTools()), JSON.stringify(offered.get(name)), name);
      agent.shutdown();
    }
  });
  after(async () => {
    await mcp.close();
    world.close();
  });

  /** Every distinct definition, by tool name, in first-offered order. One name never has two definitions. */
  function definitions(): Record<string, ToolDefinition> {
    const byName: Record<string, ToolDefinition> = {};
    for (const [config, tools] of offered) {
      for (const tool of tools) {
        const name = tool.function.name;
        if (byName[name]) assert.equal(JSON.stringify(tool), JSON.stringify(byName[name]), `${name} is offered with a different definition in ${config}`);
        else byName[name] = tool;
      }
    }
    return byName;
  }

  test("every tool definition the model can be sent, byte for byte", () => {
    golden(FILE, "definitions", definitions());
  });

  test("names, order and bytes of the list in every configuration", () => {
    const table = Object.fromEntries([...offered].map(([config, tools]) => [config, { count: tools.length, names: names(tools), ...digest(tools) }]));
    golden(FILE, "configurations", table);
  });

  test("the fixture is self-consistent: each configuration's hash is the hash of its named definitions", () => {
    const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/model_tools_v1.json", import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(recorded.configurations), Object.keys(CONFIGURATIONS), "one fixture row per configuration, in matrix order");
    for (const [config, row] of Object.entries<any>(recorded.configurations)) {
      const tools = row.names === "" ? [] : row.names.split(",").map((name: string) => {
        assert.ok(recorded.definitions[name], `${config} names ${name}, which has no recorded definition`);
        return recorded.definitions[name];
      });
      assert.deepEqual({ count: tools.length, ...digest(tools) }, { count: row.count, bytes: row.bytes, sha256: row.sha256 }, config);
    }
    const used = new Set(Object.values<any>(recorded.configurations).flatMap((row) => row.names.split(",")));
    assert.deepEqual(Object.keys(recorded.definitions).filter((name) => !used.has(name)), [], "no recorded definition is unused");
  });

  test("the matrix exercises every offer rule (so a rule that stops working cannot hide)", () => {
    const of = (config: string): string[] => offered.get(config)!.map((tool) => tool.function.name);
    const added = (config: string): string[] => of(config).filter((name) => !of("main/default").includes(name));
    const removed = (config: string): string[] => of("main/default").filter((name) => !of(config).includes(name));
    for (const group of ALL_GROUPS) assert.deepEqual(added(`main/group=${group}`).sort(), [...TOOL_GROUPS[group].tools].sort(), `group ${group}`);
    assert.deepEqual(removed("main/groups=all"), ["enable_tools"], "enable_tools is withdrawn once every group is offered");
    assert.deepEqual(added("main/objective"), ["read_objective"]);
    assert.deepEqual(added("main/objective+requirements"), ["read_objective", "update_requirements"]);
    assert.deepEqual(added("main/skills"), ["activate_skill"]);
    assert.deepEqual(added("main/mask"), ["read_tool_output"]);
    assert.deepEqual(added("main/extensions"), [MCP_TOOL, PLUGIN_TOOL]);
    // Approval mode and read-only posture do not change the list today: the gates refuse at dispatch instead.
    for (const config of ["main/mode=auto", "main/mode=auto,full-access", "main/mode=read-only", "main/launched-read-only"]) {
      assert.equal(names(offered.get(config)!), names(offered.get("main/default")!), config);
    }
    // A delegated allow-list only removes; a name in it that is no tool adds nothing.
    assert.deepEqual(of("main/delegated=read_file,run_command,enable_tools,mcp,no_such_tool"), ["read_file", "run_command", MCP_TOOL]);
    assert.deepEqual(of("subagent/delegated=read_file,search_code,task_completed"), ["read_file", "search_code", "task_completed"]);
    // A subagent without a ledger-owning role is never offered the objective tools.
    assert.deepEqual(of("main/everything").filter((name) => !of("subagent/everything").includes(name)), ["read_objective", "update_requirements"]);
    for (const role of ROLES) {
      for (const depth of ["main", "subagent"]) {
        const list = of(`${depth}/role=${role},everything`);
        assert.ok(list.length > 0 && list.every((name) => of("main/everything").includes(name)), `${depth} ${role}: a role only removes tools`);
      }
    }
  });

  test("lists derived from the baseline catalogue", async () => {
    const universe = [...new Set([...Object.keys(definitions()), "no_such_tool", "mcp__other__tool", "custom__other", "git_commit", "git_stage", "checkpoint_restore", "nexus_verify", "verifier"])];
    const server = new McpServer(world.repo);
    let served: Array<{ name: string }>;
    try {
      served = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
    } finally {
      server.shutdown();
    }
    golden(FILE, "derived", {
      harnessTools: { count: HARNESS_TOOLS.length, names: names(HARNESS_TOOLS), ...digest(HARNESS_TOOLS) },
      parserKnownToolNames: universe.filter((name) => isKnownToolName(name)).join(","),
      parserUnknownToolNames: universe.filter((name) => !isKnownToolName(name)).join(","),
      parserWriteOrExecToolNames: universe.filter((name) => isWriteOrExecTool(name)).join(","),
      serveMcpTools: { count: served.length, names: served.map((tool) => tool.name).join(","), ...digest(served) },
      acpToolKinds: TOOL_KINDS,
    });
    // HARNESS_TOOLS is the baseline catalogue the agent filters: every baseline definition it offers is the same bytes.
    const byName = definitions();
    for (const tool of HARNESS_TOOLS) assert.equal(JSON.stringify(byName[tool.function.name]), JSON.stringify(tool), tool.function.name);
  });

  test("the fixture holds exactly the sections this file checks", { skip: RECORDING }, () => {
    assert.deepEqual(goldenSections(FILE), ["definitions", "configurations", "derived"]);
  });
});
