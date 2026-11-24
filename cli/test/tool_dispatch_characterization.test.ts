import "./helpers/leak_guard.js";
/**
 * MT-2 slice 1: how a tool call is routed and decided, pinned before the tool registry refactor and the split of
 * `dispatchToolCallImpl`.
 *
 * Everything goes through the agent's real `dispatchToolCall` and the real execution spine. Only the ends are replaced:
 * each handler source by a stub that records that it ran (nothing is executed, written or fetched), and each
 * collaborator by a pass-through that records its call (see `instrument` in helpers/tool_characterization.ts). The
 * policy is injected, never the machine's own.
 *
 * `fixtures/tool_bindings_v1.json` holds:
 *   - `registered`: which tools are registered for which agent;
 *   - `bindings`: per tool, the capability facts and which handler source the spine resolves;
 *   - `sweep`: every registered tool, called with schema-valid arguments, in every approval posture: who was asked,
 *     which gate answered, the receipt, and the order of every side effect (the trace);
 *   - `cases`: the calls that are not "a valid call of a registered tool" (unknown tool, malformed arguments,
 *     allow-lists, command rules, managed policy, verification paths, read-only fallback, dry run).
 *
 * Regenerate (only for an intended change, and review the diff): see helpers/tool_characterization.ts.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AutonomousAgent } from "../src/agent.js";
import { changesWorkspace } from "../src/core/capabilities.js";
import { createLedger } from "../src/core/objective.js";
import { TOOL_GROUPS } from "../src/core/tool_groups.js";
import {
  MCP_TOOL, PLUGIN_TOOL, RECORDING, addExtensions, dispatch, golden, goldenSections, instrument, makeAgent, makeWorld, routeProbe, sampleArgs, startFakeMcp,
  type AgentSpec, type Operator, type Outcome, type World,
} from "./helpers/tool_characterization.js";
import { toml } from "./helpers/policy_enforcement.js";

const FILE = "tool_bindings_v1.json";
const ALL_GROUPS = Object.keys(TOOL_GROUPS);

/** Dispatch prints operator-facing warnings with console.log; they are not the subject here. */
const realLog = console.log;

describe("tool routing and dispatch decisions (MT-2 characterization)", () => {
  let world: World;
  let mcp: Awaited<ReturnType<typeof startFakeMcp>>;

  before(async () => {
    console.log = () => {};
    world = makeWorld({ "sample.txt": "sample\n" });
    mcp = await startFakeMcp();
  });
  after(async () => {
    console.log = realLog;
    await mcp.close();
    world.close();
  });

  /**
   * An agent with everything that can add a tool turned on: output masking, a skill, an objective with a requirement,
   * every tool group, one MCP tool and one plugin tool.
   */
  async function fullAgent(spec: AgentSpec = {}): Promise<AutonomousAgent> {
    const skillDir = path.join(world.home, ".nexus", "skills", "mt2-demo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: mt2-demo\ndescription: A skill that exists so activate_skill is offered\n---\nDo nothing.\n");
    const agent = makeAgent(world, { ...spec, mask: true });
    await addExtensions(agent, mcp.url);
    const a = agent as any;
    a.enabledToolGroups = new Set(ALL_GROUPS);
    const ledger = createLedger("characterize dispatch", "2026-01-01T00:00:00.000Z");
    ledger.requirements = [{ id: "R1", text: "a requirement", status: "open" } as any];
    a.objective = ledger;
    return agent;
  }
  const registeredNames = (agent: AutonomousAgent): string[] => agent.getCapabilityRegistry().listCapabilities().map((c) => c.modelToolName);

  test("which tools are registered for which agent", async () => {
    const plain = makeAgent(world);
    const full = await fullAgent();
    const sub = makeAgent(world, { depth: 1 });
    const implementer = makeAgent(world, { depth: 1, role: "implementer" });
    const reviewer = makeAgent(world, { depth: 1, role: "reviewer" });
    golden(FILE, "registered", {
      "main/default": registeredNames(plain).join(","),
      "main/everything": registeredNames(full).join(","),
      "subagent/default": registeredNames(sub).join(","),
      "subagent/role=implementer": registeredNames(implementer).join(","),
      "subagent/role=reviewer": registeredNames(reviewer).join(","),
    });
  });

  test("per tool: capability facts and the handler source the spine resolves", async () => {
    const agent = await fullAgent();
    const table = Object.fromEntries(agent.getCapabilityRegistry().listCapabilities().map((c) => [c.modelToolName, {
      capabilityId: c.id,
      category: c.category,
      backend: c.backend,
      effect: c.effect,
      mutating: c.mutating,
      changesWorkspace: changesWorkspace(c),
      source: routeProbe(agent, c.modelToolName),
    }]));
    golden(FILE, "bindings", table);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The sweep: every registered tool in every approval posture.

  const POSTURES: Record<string, { spec: AgentSpec; operator: Operator }> = {
    "review/no-operator": { spec: { mode: "review" }, operator: "none" },
    "review/operator-approves": { spec: { mode: "review" }, operator: "approves" },
    "review/operator-declines": { spec: { mode: "review" }, operator: "declines" },
    "review,full-access/no-operator": { spec: { mode: "review", fullAccess: true }, operator: "none" },
    "auto/no-operator": { spec: { mode: "auto" }, operator: "none" },
    "auto/operator-approves": { spec: { mode: "auto" }, operator: "approves" },
    "auto,full-access/no-operator": { spec: { mode: "auto", fullAccess: true }, operator: "none" },
    "read-only/no-operator": { spec: { mode: "read-only" }, operator: "none" },
    "read-only/operator-approves": { spec: { mode: "read-only" }, operator: "approves" },
    "read-only,full-access/no-operator": { spec: { mode: "read-only", fullAccess: true }, operator: "none" },
  };

  const BASE_RECEIPT_KEYS = ["actor", "candidateMutated", "capabilityId", "durationMs", "executionDomain", "invocationId", "output", "simulated", "status", "success", "targetResources", "taskId", "timestamp", "toolName"];

  /** What a row records: the outcome with the tool's own name written as `<tool>`, so tools that behave alike share a row. */
  function row(outcome: Outcome, tool: string): Record<string, unknown> {
    const keys = outcome.receiptKeys.split(",");
    for (const key of BASE_RECEIPT_KEYS) assert.ok(keys.includes(key), `${tool}: every receipt has '${key}'`);
    const generic = (text: string | null): string | null => text === null ? null
      : text.split(`'${outcome.capabilityId}'`).join("'<capability>'").split(tool.replace(/_/g, "-")).join("<tool>").split(tool).join("<tool>");
    return {
      asked: outcome.asked.join(","),
      status: outcome.status,
      denialReason: outcome.denialReason,
      error: generic(outcome.error),
      output: generic(outcome.output),
      shouldExit: outcome.shouldExit,
      executionDomain: outcome.executionDomain,
      simulated: outcome.simulated,
      extraReceiptKeys: keys.filter((key) => !BASE_RECEIPT_KEYS.includes(key)).join(","),
      trace: outcome.trace,
    };
  }

  const sweep = new Map<string, Map<string, Outcome>>();
  async function sweepOf(posture: string): Promise<Map<string, Outcome>> {
    if (sweep.has(posture)) return sweep.get(posture)!;
    const { spec, operator } = POSTURES[posture];
    const agent = await fullAgent(spec);
    const probe = instrument(agent, world);
    const outcomes = new Map<string, Outcome>();
    for (const capability of agent.getCapabilityRegistry().listCapabilities()) {
      // One agent serves a posture; what an earlier approval would carry over to the next tool is cleared, so every
      // row is that tool's own first call (approval_policy.test.ts covers "egress asks once per origin").
      agent.clearApprovedEgressOrigins();
      agent.clearApprovedVerifiers();
      const outcome = await dispatch(agent, world, probe, capability.modelToolName, sampleArgs(capability.toolDefinition), operator);
      // A receipt for a registered tool always names that tool's capability.
      assert.equal(outcome.capabilityId, capability.id, `${posture} ${capability.modelToolName}`);
      outcomes.set(capability.modelToolName, outcome);
    }
    agent.shutdown();
    sweep.set(posture, outcomes);
    return outcomes;
  }

  for (const posture of Object.keys(POSTURES)) {
    test(`sweep: every registered tool, ${posture}`, async () => {
      const groups: Array<Record<string, unknown>> = [];
      for (const [tool, outcome] of await sweepOf(posture)) {
        const recorded = row(outcome, tool);
        const key = JSON.stringify(recorded);
        const existing = groups.find((group) => JSON.stringify({ ...group, tools: undefined }) === key);
        if (existing) existing.tools = `${existing.tools},${tool}`;
        else groups.push({ tools: tool, ...recorded });
      }
      golden(FILE, `sweep ${posture}`, groups);
    });
  }

  test("side-effect order of an approved write and an approved command (the order the split must keep)", async () => {
    const approved = await sweepOf("review/operator-approves");
    const common = (run: string, tail: string): string => [
      "flight.toolCall", "ui.printToolCall", "observer.toolStart",
      "confirm",
      "plugin.notifyToolCall", "journal.start", "baseline.capture",
      "spine.contextAdmission", "spine.authorityAdmission", "spine.resourceConfinement", "spine.egressQuarantine", "spine.processLifecycle:start",
      run,
      "spine.processLifecycle:exit", "spine.candidateMutation", "spine.evidenceEmission",
      "journal.end", "plugin.notifyToolResult", "audit.log", "flight.toolResult:ok", ...(tail ? [tail] : []), "ui.printToolResult", "observer.toolEnd:ok",
    ].join(" > ");
    assert.equal(approved.get("write_file")!.trace, common("run:bridge", "flight.fileDiff"));
    assert.equal(approved.get("run_command")!.trace, common("run:bridge", ""));
    // A read asks nobody, captures no baseline and reports no mutation; the rest of the order is the same.
    assert.equal(approved.get("read_file")!.trace, common("run:bridge", "").replace("confirm > ", "").replace("baseline.capture > ", "").replace("spine.candidateMutation > ", ""));
  });

  test("every offered tool has a route and every route belongs to an offered tool", async () => {
    // Offered: the union over the postures that change the list (a main agent with everything on, with and without
    // every group, since enable_tools is withdrawn once all groups are on).
    const agent = await fullAgent({ mode: "auto", fullAccess: true });
    const offered = new Set(agent.getEffectiveTools().map((tool) => tool.function.name));
    (agent as any).enabledToolGroups = new Set();
    for (const tool of agent.getEffectiveTools()) offered.add(tool.function.name);
    const registered = new Set(registeredNames(agent));
    agent.shutdown();

    assert.deepEqual([...offered].filter((name) => !registered.has(name)), [], "offered to the model but not registered (the spine would answer FAIL-001)");
    assert.deepEqual([...registered].filter((name) => !offered.has(name)), [], "registered but never offered in any configuration");

    // A route is more than a registry row: called with valid arguments where nothing asks, each offered tool reaches
    // exactly one handler source, and it is the source the bindings table names.
    const ran = await sweepOf("auto,full-access/no-operator");
    const expected: Record<string, string> = { "spine-handler": "run:spine-handler", "registry-handler": "run:bridge", "pipeline-bridge": "run:bridge", mcp: "run:mcp", plugin: "run:plugin" };
    const probeAgent = await fullAgent();
    for (const name of offered) {
      const outcome = ran.get(name);
      assert.ok(outcome, `${name} was not swept`);
      const runs = outcome.trace.split(" > ").filter((event) => event.startsWith("run:"));
      assert.deepEqual(runs, [expected[routeProbe(probeAgent, name)]], `${name}: ${outcome.status} ${outcome.error ?? ""}`);
      assert.equal(outcome.status, "COMPLETED", name);
    }
    probeAgent.shutdown();
    assert.ok(offered.has(MCP_TOOL) && offered.has(PLUGIN_TOOL), "the extension tools are part of the check");
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The calls that are not "a valid call of a registered tool".

  interface Case {
    spec?: AgentSpec;
    /** Files put in the workspace for this case only. */
    files?: Record<string, string>;
    /** Operator command rules written to the (throwaway) home before the agent starts. */
    rules?: unknown;
    prepare?: (agent: AutonomousAgent) => void;
    tool: string;
    args: unknown;
    operator?: Operator;
    actor?: "agent" | "subagent";
  }

  const RULES = {
    version: 1,
    rules: [
      { prefix: ["git", "status"], decision: "allow", justification: "read-only git", match: ["git status"] },
      { prefix: ["git", "push"], decision: "prompt", justification: "pushes need a human", match: ["git push origin main"] },
      { prefix: ["rm", "-rf"], decision: "forbidden", justification: "never recursive-delete", match: ["rm -rf build"] },
    ],
  };
  const REQUIRE_HUMAN = toml("[approval]", 'require_human = ["exec"]');
  const MANAGED_COMMANDS = toml("[commands]", 'forbid = ["touch forbidden.txt"]', 'prompt = ["touch asked.txt"]');
  const MANAGED_EGRESS = toml("[egress]", 'allowed_domains = ["example.com"]');
  const TRUNCATED = "{\"path\":\"sample.txt\",\"content\":\"cut off";

  const CASES: Record<string, Case> = {
    // An unknown tool is treated as running code (exec): it is put to the operator first and refused by the spine after.
    "unknown tool: review, no operator": { spec: { mode: "review" }, tool: "no_such_tool", args: {} },
    "unknown tool: review, operator approves": { spec: { mode: "review" }, tool: "no_such_tool", args: {}, operator: "approves" },
    "unknown tool: auto, no operator": { spec: { mode: "auto" }, tool: "no_such_tool", args: {} },
    "unknown tool: read-only, no operator": { spec: { mode: "read-only" }, tool: "no_such_tool", args: {} },
    "unknown tool with an MCP-style name: auto, no operator": { spec: { mode: "auto" }, tool: "mcp__gone__tool", args: {} },

    "arguments are not JSON: read tool": { spec: { mode: "auto" }, tool: "read_file", args: "{not json" },
    "arguments are not JSON: task_completed": { spec: { mode: "auto" }, tool: "task_completed", args: "not json at all" },
    "arguments are truncated JSON: write tool": { spec: { mode: "auto", fullAccess: true }, tool: "write_file", args: TRUNCATED },
    "arguments are truncated JSON: read tool": { spec: { mode: "auto" }, tool: "read_file", args: "{\"path\":\"sample.txt" },
    "arguments are truncated JSON: MCP tool": { spec: { mode: "auto", fullAccess: true }, tool: MCP_TOOL, args: "{\"text\":\"cut off" },
    "arguments are a JSON array": { spec: { mode: "auto" }, tool: "read_file", args: "[\"sample.txt\"]" },
    "arguments are a JSON string": { spec: { mode: "auto" }, tool: "read_file", args: "\"sample.txt\"" },
    "arguments are JSON null": { spec: { mode: "auto" }, tool: "read_file", args: "null" },
    "a required argument is missing: read tool": { spec: { mode: "auto" }, tool: "read_file", args: {} },
    "a required argument is missing: write tool, review, operator approves": { spec: { mode: "review" }, tool: "write_file", args: { path: "sample.txt" }, operator: "approves" },
    "an argument has the wrong type": { spec: { mode: "auto" }, tool: "read_file", args: { path: 5 } },
    "an argument the schema does not name": { spec: { mode: "auto" }, tool: "read_file", args: { path: "sample.txt", surprise: true } },

    "delegated allow-list: a tool outside it": { spec: { mode: "auto", fullAccess: true, delegated: ["read_file"] }, tool: "write_file", args: { path: "sample.txt", content: "x" } },
    "delegated allow-list: an unknown tool": { spec: { mode: "auto", fullAccess: true, delegated: ["read_file"] }, tool: "no_such_tool", args: {} },
    "role deny-list: implementer, browser": { spec: { mode: "auto", fullAccess: true, role: "implementer", depth: 1 }, tool: "browser_navigate", args: { url: "https://example.invalid/" } },
    "role allow-list: reviewer, a read tool outside it": { spec: { role: "reviewer", depth: 1 }, tool: "list_dir", args: { path: "." } },
    "role allow-list: reviewer, a write tool (left to the read-only check)": { spec: { role: "reviewer", depth: 1 }, tool: "write_file", args: { path: "sample.txt", content: "x" }, actor: "subagent" },
    "subagent actor: a read": { spec: { depth: 1 }, tool: "read_file", args: { path: "sample.txt" }, actor: "subagent" },

    "delete_file: the workspace root": { spec: { mode: "auto", fullAccess: true }, tool: "delete_file", args: { path: "." } },
    "delete_file: inside .git": { spec: { mode: "auto", fullAccess: true }, tool: "delete_file", args: { path: ".git/config" } },
    "checkpoint read-only fallback: a write": { spec: { mode: "auto", fullAccess: true }, prepare: (agent) => agent.setCheckpointReadOnlyFallback(true), tool: "write_file", args: { path: "sample.txt", content: "x" } },
    "checkpoint read-only fallback: a command": { spec: { mode: "auto", fullAccess: true }, prepare: (agent) => agent.setCheckpointReadOnlyFallback(true), tool: "run_command", args: { command: "echo hi" } },
    "checkpoint read-only fallback: a read": { spec: { mode: "auto", fullAccess: true }, prepare: (agent) => agent.setCheckpointReadOnlyFallback(true), tool: "read_file", args: { path: "sample.txt" } },
    "dry run: a write": { spec: { mode: "auto", fullAccess: true, config: { dryRun: true } }, tool: "write_file", args: { path: "sample.txt", content: "x" } },
    "dry run: a command": { spec: { mode: "auto", fullAccess: true, config: { dryRun: true } }, tool: "run_command", args: { command: "echo hi" } },
    "dry run: a read": { spec: { mode: "auto", fullAccess: true, config: { dryRun: true } }, tool: "read_file", args: { path: "sample.txt" } },

    "command rule allow: review, no operator": { spec: { mode: "review" }, rules: RULES, tool: "run_command", args: { command: "git status" } },
    "command rule allow: review, operator would decline": { spec: { mode: "review" }, rules: RULES, tool: "run_command", args: { command: "git status" }, operator: "declines" },
    "command rule prompt: auto, no operator": { spec: { mode: "auto" }, rules: RULES, tool: "run_command", args: { command: "git push origin main" } },
    "command rule prompt: auto, operator approves": { spec: { mode: "auto" }, rules: RULES, tool: "run_command", args: { command: "git push origin main" }, operator: "approves" },
    "command rule prompt: auto, full access, no operator": { spec: { mode: "auto", fullAccess: true }, rules: RULES, tool: "run_command", args: { command: "git push origin main" } },
    "command rule forbidden: auto, full access, operator approves": { spec: { mode: "auto", fullAccess: true }, rules: RULES, tool: "run_command", args: { command: "rm -rf build" }, operator: "approves" },
    "command rules file that does not load: review, no operator": { spec: { mode: "review" }, rules: "{ not json", tool: "run_command", args: { command: "git status" } },

    "managed require_human(exec): auto, no operator": { spec: { mode: "auto", system: REQUIRE_HUMAN }, tool: "run_command", args: { command: "echo hi" } },
    "managed require_human(exec): auto, operator approves": { spec: { mode: "auto", system: REQUIRE_HUMAN }, tool: "run_command", args: { command: "echo hi" }, operator: "approves" },
    "managed require_human(exec): auto, full access, no operator": { spec: { mode: "auto", fullAccess: true, system: REQUIRE_HUMAN }, tool: "run_command", args: { command: "echo hi" } },
    "managed require_human(exec): a command-rule allow does not remove it": { spec: { mode: "auto", system: REQUIRE_HUMAN }, rules: RULES, tool: "run_command", args: { command: "git status" } },
    "managed require_human(exec): a read is not asked": { spec: { mode: "auto", system: REQUIRE_HUMAN }, tool: "read_file", args: { path: "sample.txt" } },
    "managed commands.forbid: auto, full access, operator approves": { spec: { mode: "auto", fullAccess: true, system: MANAGED_COMMANDS }, tool: "run_command", args: { command: "touch forbidden.txt" }, operator: "approves" },
    "managed commands.prompt: auto, full access, no operator": { spec: { mode: "auto", fullAccess: true, system: MANAGED_COMMANDS }, tool: "run_command", args: { command: "touch asked.txt" } },
    "managed commands.prompt: auto, full access, operator approves": { spec: { mode: "auto", fullAccess: true, system: MANAGED_COMMANDS }, tool: "run_command", args: { command: "touch asked.txt" }, operator: "approves" },
    "managed egress allowlist: a host outside it": { spec: { mode: "auto", fullAccess: true, system: MANAGED_EGRESS }, tool: "fetch_web", args: { url: "https://other.invalid/x" }, operator: "approves" },
    "managed egress allowlist: not a URL": { spec: { mode: "auto", fullAccess: true, system: MANAGED_EGRESS }, tool: "fetch_web", args: { url: "not a url" }, operator: "approves" },

    "verification path: write the project policy file, review, no operator": { spec: { mode: "review" }, tool: "write_file", args: { path: ".nexus-security.json", content: "{}" } },
    "verification path: write the project policy file, auto, no operator": { spec: { mode: "auto" }, tool: "write_file", args: { path: ".nexus-security.json", content: "{}" } },
    "verification path: write the project policy file, auto, operator approves": { spec: { mode: "auto" }, tool: "write_file", args: { path: ".nexus-security.json", content: "{}" }, operator: "approves" },
    "verification path: write the project policy file, auto, operator declines": { spec: { mode: "auto" }, tool: "write_file", args: { path: ".nexus-security.json", content: "{}" }, operator: "declines" },
    "verification path: write the project policy file, auto, full access, no operator": { spec: { mode: "auto", fullAccess: true }, tool: "write_file", args: { path: ".nexus-security.json", content: "{}" } },
    // With a verifier to discover, capturing the pre-change baseline asks the operator a second time and runs the
    // verifier through the bridge, before the write itself reaches the spine.
    "a workspace with a test script: write, review, operator approves": { spec: { mode: "review" }, files: { "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n" }, tool: "write_file", args: { path: "sample.txt", content: "x" }, operator: "approves" },
    "a workspace with a test script: edit package.json, auto, no operator": { spec: { mode: "auto" }, files: { "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n" }, tool: "edit_file", args: { path: "package.json", old_content: "node --test", new_content: "true" } },
  };

  const caseOutcomes = new Map<string, Outcome>();
  test("cases: unknown tools, malformed arguments, allow-lists, command rules, managed policy, verification paths", async () => {
    const rulesFile = path.join(world.home, ".config", "nexus", "command_rules.json");
    const table: Record<string, unknown> = {};
    for (const [name, c] of Object.entries(CASES)) {
      fs.rmSync(rulesFile, { force: true });
      if (c.rules !== undefined) {
        fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
        fs.writeFileSync(rulesFile, typeof c.rules === "string" ? c.rules : JSON.stringify(c.rules));
      }
      for (const [file, content] of Object.entries(c.files ?? {})) fs.writeFileSync(path.join(world.repo, file), content);
      const agent = await fullAgent(c.spec);
      c.prepare?.(agent);
      const probe = instrument(agent, world);
      const outcome = await dispatch(agent, world, probe, c.tool, c.args, c.operator ?? "none", c.actor ?? "agent");
      agent.shutdown();
      for (const file of Object.keys(c.files ?? {})) fs.rmSync(path.join(world.repo, file), { force: true });
      caseOutcomes.set(name, outcome);
      const { receiptKeys, asked, ...rest } = outcome;
      table[name] = { call: `${c.tool} ${typeof c.args === "string" ? c.args : JSON.stringify(c.args)}`, asked: asked.join(","), ...rest, extraReceiptKeys: receiptKeys.split(",").filter((key) => !BASE_RECEIPT_KEYS.includes(key)).join(",") };
    }
    fs.rmSync(rulesFile, { force: true });
    golden(FILE, "cases", table);
  });

  test("gate order: what is decided before the operator is asked, and what only after", () => {
    const of = (name: string): Outcome => {
      const outcome = caseOutcomes.get(name);
      assert.ok(outcome, `case '${name}' did not run`);
      return outcome;
    };
    const events = (name: string): string[] => of(name).trace.split(" > ");
    // Refused before any prompt, whatever the operator would have said.
    for (const name of [
      "command rule forbidden: auto, full access, operator approves",
      "managed commands.forbid: auto, full access, operator approves",
      "managed egress allowlist: a host outside it",
    ]) {
      assert.equal(of(name).status, "DENIED", name);
      assert.deepEqual(of(name).asked, [], name);
      assert.ok(!events(name).some((event) => event.startsWith("run:") || event.startsWith("spine.")), `${name}: the spine is never reached`);
    }
    // Argument validation and registration are spine stages: they come after the operator's approval.
    assert.deepEqual(of("a required argument is missing: write tool, review, operator approves").asked, ["asked"]);
    assert.match(of("a required argument is missing: write tool, review, operator approves").error ?? "", /^FAIL-002/);
    assert.deepEqual(of("unknown tool: review, operator approves").asked, ["asked"]);
    assert.match(of("unknown tool: review, operator approves").error ?? "", /^FAIL-001/);
    // Structural repair of a write's arguments is refused before anything is recorded at all.
    assert.equal(of("arguments are truncated JSON: write tool").trace, "");
    assert.equal(of("arguments are truncated JSON: write tool").status, "DENIED");
    // A managed requirement for a human reaches the operator as a question a front end may not answer by itself.
    assert.deepEqual(of("managed require_human(exec): auto, operator approves").asked, ["operator-must-decide"]);
    // An approval comes before the plugin notification, the journal entry and the baseline capture.
    const approved = events("command rule prompt: auto, operator approves");
    assert.ok(approved.indexOf("confirm") >= 0 && approved.indexOf("confirm") < approved.indexOf("plugin.notifyToolCall"));
    assert.ok(approved.indexOf("plugin.notifyToolCall") < approved.indexOf("journal.start"));
    assert.ok(approved.indexOf("journal.start") < approved.indexOf("baseline.capture"));
    assert.ok(approved.indexOf("baseline.capture") < approved.indexOf("spine.contextAdmission"));
  });

  test("the fixture holds exactly the sections this file checks", { skip: RECORDING }, () => {
    assert.deepEqual(goldenSections(FILE), ["registered", "bindings", ...Object.keys(POSTURES).map((posture) => `sweep ${posture}`), "cases"]);
  });
});
