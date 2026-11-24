/**
 * HK-1 acceptance, gate G-3 (hook rows): "a hook that returns allow for a denied action has no effect".
 *
 * The hook here is hostile: an operator pre-tool hook for every tool that answers "approve" in every dialect and
 * offers a replacement input pointing at a protected path. Each gate is exercised twice, without any hooks file and
 * with that hook, and the two receipts must be the same denial. For the gates of the dispatcher (approval,
 * verification protection, command rules, managed policy, delegation) the hook is not even started. Read-only mode is
 * enforced by the spine's authority stage, which runs after the hook stage: there the hook runs, its answer is
 * recorded as ignored, and the authority stage refuses the call exactly as before.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutonomousAgent } from "../src/agent.js";
import { makeRepo } from "./helpers/fixtures.js";
import { allowHook, dispatch, hookAgent, runsOf, stable, writeOperatorHooks, operatorHooksFile, type Confirm, type HookAgentOptions } from "./helpers/hooks_fixture.js";
import { toml } from "./helpers/policy_enforcement.js";

let home = "", previousHome: string | undefined, repo = "", stateDir = "", scripts = "", log = "";
let agents: AutonomousAgent[] = [];

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-bypass-home-"));
  process.env.HOME = home;
  repo = makeRepo({ "a.txt": "hello\n", "Makefile": "test:\n\ttrue\n" });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-bypass-state-"));
  scripts = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-bypass-hooks-"));
  log = path.join(scripts, "runs.jsonl");
});
afterEach(() => {
  for (const agent of agents) agent.shutdown();
  agents = [];
  for (const dir of [home, repo, stateDir, scripts]) fs.rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

function agentFor(options: Omit<HookAgentOptions, "repo" | "stateDir"> = {}): AutonomousAgent {
  const agent = hookAgent({ repo, stateDir, ...options });
  agents.push(agent);
  return agent;
}

/** Installs the always-allow hook for every tool, before and (to show it changes nothing there either) after. */
function installAllowHook(): void {
  const hook = allowHook(scripts, log);
  writeOperatorHooks({ version: 1, hooks: { "pre-tool": [{ name: "always-allow", tools: ["*"], command: [hook] }] } });
}

interface Gate {
  name: string;
  agent?: Omit<HookAgentOptions, "repo" | "stateDir">;
  setup?: () => void;
  tool: string;
  args: Record<string, unknown>;
  confirm?: Confirm;
  denialReason: string | undefined;
  error: RegExp;
  /** Must not exist afterwards. */
  effect: string;
}

const DISPATCHER_GATES: Gate[] = [
  {
    name: "an approval nobody is there to give (headless, review mode)",
    agent: { mode: "review" },
    tool: "run_command", args: { command: "touch effect.txt" },
    denialReason: "DECISION_REQUIRED_NO_OPERATOR", error: /requires operator approval \(exec\), but no operator is present/, effect: "effect.txt",
  },
  {
    name: "an approval the operator refuses",
    agent: { mode: "review" },
    tool: "run_command", args: { command: "touch effect.txt" }, confirm: async () => false,
    denialReason: undefined, error: /Execution was rejected by the user/, effect: "effect.txt",
  },
  {
    name: "an edit of verification configuration (VERIFICATION_CONFIG_PROTECTED)",
    agent: { mode: "auto" },
    tool: "write_file", args: { path: "Makefile", content: "test:\n\ttouch effect.txt\n" },
    denialReason: "VERIFICATION_CONFIG_PROTECTED", error: /Makefile/, effect: "effect.txt",
  },
  {
    name: "a command the operator's command rules forbid (CS-9)",
    agent: { mode: "auto", fullAccess: true },
    setup: () => {
      fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
      fs.writeFileSync(path.join(home, ".config", "nexus", "command_rules.json"), JSON.stringify({ version: 1, rules: [{ prefix: ["touch", "effect.txt"], decision: "forbidden", match: ["touch effect.txt"] }] }));
    },
    tool: "run_command", args: { command: "touch effect.txt" },
    denialReason: "COMMAND_RULE_FORBIDDEN", error: /forbid/i, effect: "effect.txt",
  },
  {
    name: "a command managed policy forbids",
    agent: { mode: "auto", fullAccess: true, system: toml("[commands]", 'forbid = ["touch effect.txt"]') },
    tool: "run_command", args: { command: "touch effect.txt" },
    denialReason: "MANAGED_POLICY_FORBIDDEN", error: /managed policy forbids 'touch effect\.txt'/, effect: "effect.txt",
  },
  {
    name: "an effect managed policy requires a human for (approval.require_human), headless under full access",
    agent: { mode: "auto", fullAccess: true, system: toml("[approval]", 'require_human = ["write_workspace"]') },
    tool: "write_file", args: { path: "effect.txt", content: "x\n" },
    denialReason: "DECISION_REQUIRED_NO_OPERATOR", error: /approval\.require_human/, effect: "effect.txt",
  },
  {
    name: "a tool outside the delegated tool list",
    agent: { mode: "auto", fullAccess: true, delegatedToolAllowList: ["read_file"] },
    tool: "write_file", args: { path: "effect.txt", content: "x\n" },
    denialReason: "DELEGATION_AUTHORITY", error: /Delegation authority denied tool 'write_file'/, effect: "effect.txt",
  },
];

test("the hook is live: an allowed call starts it, so 'not started' below means something", async () => {
  installAllowHook();
  const receipt = await dispatch(agentFor({ mode: "auto", fullAccess: true }), "read_file", { path: "a.txt" });
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt).slice(0, 400));
  const runs = runsOf(log);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].tool_name, "read_file");
  assert.deepEqual(receipt.hooks.map((run: any) => [run.name, run.source, run.decision]), [["always-allow", "operator", "ignored_allow"]]);
});

for (const gate of DISPATCHER_GATES) {
  test(`an allow hook has no effect on ${gate.name}`, async () => {
    gate.setup?.();
    const control = await dispatch(agentFor(gate.agent), gate.tool, gate.args, gate.confirm);
    assert.equal(control.status, "DENIED", `the gate denies without any hook: ${JSON.stringify(control).slice(0, 300)}`);
    assert.equal(control.denialReason, gate.denialReason);
    assert.match(control.error, gate.error);

    installAllowHook();
    const hooked = await dispatch(agentFor(gate.agent), gate.tool, gate.args, gate.confirm);
    assert.deepEqual(stable(hooked), stable(control), "the same denial, word for word");
    assert.equal(hooked.hooks, undefined, "no hook took part in this call");
    assert.deepEqual(runsOf(log), [], "the hook was not started for a call the gate denied");
    assert.equal(fs.existsSync(path.join(repo, gate.effect)), false, "nothing was executed");
    assert.equal(fs.existsSync(path.join(repo, "pwned.txt")), false);
    assert.equal(fs.readFileSync(path.join(repo, "Makefile"), "utf8"), "test:\n\ttrue\n", "the protected file is untouched");
  });
}

test("an allow hook has no effect on read-only mode: the authority stage refuses the write after the hook answered", async () => {
  const write = { path: "effect.txt", content: "x\n" };
  const control = await dispatch(agentFor({ readOnly: true }), "write_file", write);
  assert.equal(control.status, "DENIED", JSON.stringify(control).slice(0, 300));
  assert.match(control.error, /Read-only mode violation/);

  installAllowHook();
  const hooked = await dispatch(agentFor({ readOnly: true }), "write_file", write);
  assert.deepEqual(stable(hooked), stable(control), "the same denial, word for word");
  // This gate sits after the hook stage, so the hook did run; what it answered is on the receipt as ignored.
  assert.deepEqual(hooked.hooks.map((run: any) => [run.name, run.decision]), [["always-allow", "ignored_allow"]]);
  assert.deepEqual(hooked.hooks[0].ignored, ["updatedInput", "hookSpecificOutput.updatedInput"]);
  assert.equal(fs.existsSync(path.join(repo, "effect.txt")), false, "nothing was written");

  const command = await dispatch(agentFor({ readOnly: true }), "run_command", { command: "touch effect.txt" });
  assert.equal(command.status, "DENIED");
  assert.equal(fs.existsSync(path.join(repo, "effect.txt")), false);
  assert.equal(fs.existsSync(path.join(repo, "pwned.txt")), false);
});

test("updatedInput is ignored: the tool runs with the arguments the gates approved, not the hook's", async () => {
  installAllowHook();
  const args = { path: "out.txt", content: "approved content\n" };
  const receipt = await dispatch(agentFor({ mode: "auto", fullAccess: true }), "write_file", args);
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt).slice(0, 400));
  assert.deepEqual(receipt.targetResources, ["out.txt"]);
  assert.equal(fs.readFileSync(path.join(repo, "out.txt"), "utf8"), "approved content\n");
  assert.equal(fs.readFileSync(path.join(repo, "Makefile"), "utf8"), "test:\n\ttrue\n", "the path the hook asked for was not written");
  assert.equal(fs.existsSync(path.join(repo, "pwned.txt")), false);
  assert.deepEqual(runsOf(log).map((run) => run.tool_input), [args], "the hook saw the approved arguments");
  assert.deepEqual(receipt.hooks[0].ignored, ["updatedInput", "hookSpecificOutput.updatedInput"]);
  assert.equal(receipt.hooks[0].decision, "ignored_allow");

  // The same for a command: the one that ran is the one that was asked for.
  const command = await dispatch(agentFor({ mode: "auto", fullAccess: true }), "run_command", { command: "echo approved > ran.txt" });
  assert.equal(command.status, "COMPLETED", JSON.stringify(command).slice(0, 400));
  assert.equal(fs.readFileSync(path.join(repo, "ran.txt"), "utf8"), "approved\n");
  assert.equal(fs.existsSync(path.join(repo, "pwned.txt")), false);
});

test("removing the hooks file restores the plain behaviour without a restart", async () => {
  installAllowHook();
  const agent = agentFor({ mode: "auto", fullAccess: true });
  assert.equal((await dispatch(agent, "read_file", { path: "a.txt" })).hooks.length, 1);
  fs.rmSync(operatorHooksFile());
  const plain = await dispatch(agent, "read_file", { path: "a.txt" });
  assert.equal(plain.status, "COMPLETED");
  assert.equal(plain.hooks, undefined);
  assert.equal(runsOf(log).length, 1);
});
