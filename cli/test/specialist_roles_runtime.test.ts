/**
 * Specialist roles are runtime roles: a work unit or agent can run as one, and the agent both advertises only the
 * contract's permitted tools and refuses any other call, read-only or not.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AutonomousAgent } from "../src/agent.js";
import { ROLE_PROFILES, SPECIALIST_CONTRACTS, isReadOnlyRole, roleToolAllowList } from "../src/core/roles.js";
import { validateOperationSpec } from "../src/operation_cli.js";
import { teamUnits, TeamOrchestrator } from "../src/team.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-specialist-runtime-"));
const agentFor = (role: any) =>
  new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash", role } as any);
const call = (name: string, args: Record<string, unknown>) => ({ id: `call-${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

test("every specialist contract is a role profile, read-only exactly as its contract says", () => {
  for (const contract of Object.values(SPECIALIST_CONTRACTS)) {
    const profile = ROLE_PROFILES[contract.role];
    assert.ok(profile, contract.role);
    assert.deepEqual(profile.recommendedTools, [...contract.permittedTools]);
    for (const tool of contract.permittedTools) assert.match(profile.systemPromptAddendum, new RegExp(tool));
    assert.equal(isReadOnlyRole(contract.role), contract.readOnly, contract.role);
    assert.deepEqual([...roleToolAllowList(contract.role)!].sort(), [...new Set([...contract.permittedTools, "task_completed"])].sort());
  }
  assert.equal(roleToolAllowList("implementer"), undefined);
  assert.equal(roleToolAllowList("constructor"), undefined);
});

test("failure_debugger is offered its permitted tools only and is refused write_file at dispatch", async () => {
  const agent = agentFor("failure_debugger");
  assert.notEqual(agent.config.readOnly, true);
  const offered = agent.getEffectiveTools().map((t) => t.function.name);
  assert.ok(offered.includes("run_tests") && offered.includes("run_command"));
  assert.ok(!offered.includes("write_file") && !offered.includes("edit_file"));
  for (const name of offered) assert.ok(roleToolAllowList("failure_debugger")!.has(name), name);

  const { receipt } = await (agent as any).dispatchToolCall(call("write_file", { path: "planted.txt", content: "x" }), 1, "agent");
  assert.equal(receipt.status, "DENIED");
  assert.match(receipt.error, /not permitted for role 'failure_debugger'/);
  assert.equal(fs.existsSync(path.join(workspace, "planted.txt")), false);
});

test("a read-only specialist keeps the read-only refusal for writes and the role refusal for other tools", async () => {
  const agent = agentFor("security_reviewer");
  assert.equal(agent.config.readOnly, true);
  const write = await (agent as any).dispatchToolCall(call("write_file", { path: "planted.txt", content: "x" }), 1, "agent");
  assert.equal(write.receipt.status, "DENIED");
  assert.match(write.receipt.error, /Read-only mode violation/i);
  const egress = await (agent as any).dispatchToolCall(call("fetch_web", { url: "https://example.com" }), 1, "agent");
  assert.equal(egress.receipt.status, "DENIED");
  assert.match(egress.receipt.error, /not permitted for role 'security_reviewer'/);
});

test("operation specs and team targets accept specialist roles", () => {
  assert.doesNotThrow(() => validateOperationSpec({ objective: "o", units: [{ id: "dbg", prompt: "why does it fail", role: "failure_debugger" }] }));
  assert.throws(() => validateOperationSpec({ objective: "o", units: [{ id: "x", prompt: "p", role: "root" }] }), /unknown role 'root'/);
  const [unit] = teamUnits("call_site_analyzer", "trace callers of foo");
  assert.equal(unit.id, "call_site_analyzer");
  assert.equal(unit.role, "call_site_analyzer");
});

// ---------------------------------------------------------------- configured verifier and read-only specialists

import { fakeClock, startGateway } from "./helpers/provider_fixture.js";

test("an operator-configured verifier gates only roles that can write; read-only report roles are exempt", () => {
  for (const role of ["researcher", "architect", "reviewer", ...Object.values(SPECIALIST_CONTRACTS).filter((c) => c.readOnly).map((c) => c.role)]) {
    const agent = new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash", role, authoritativeVerifierCommand: "true" } as any);
    assert.equal((agent as any).configuredVerifierGatesCompletion(), false, role);
  }
  for (const role of ["implementer", "tester", "failure_debugger"]) {
    const agent = new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash", role, authoritativeVerifierCommand: "true" } as any);
    assert.equal((agent as any).configuredVerifierGatesCompletion(), true, role);
  }
});

test("a read-only specialist completes with a report even when an authoritative verifier is configured", async () => {
  const gw = await startGateway(() => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary: "callers: a.ts:3, b.ts:9" } }] }));
  try {
    for (const role of ["call_site_analyzer", "semantic_explorer", "security_reviewer", "acceptance_reviewer"]) {
      const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 3, temperature: 0, workspace, shell: "bash", role, authoritativeVerifierCommand: "true" } as any, 1);
      (agent as any).recoveryClock = fakeClock();
      const turn = await agent.runTurn("trace callers of foo");
      assert.equal(turn.execution, "COMPLETED", role);
      assert.notEqual(turn.outcome, "UNVERIFIED", `${role}: ${turn.reason}`);
    }
  } finally {
    await gw.close();
  }
});

// ---------------------------------------------------------------- /team accepts specialist targets

import { EXTENSION_HANDLERS } from "../src/slash/extension_commands.js";

test("/team plans and runs a specialist role as a single-role target, through the real planner and executor", async () => {
  const gw = await startGateway(() => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary: "callers: a.ts:3" } }] }));
  try {
    const config = { endpoint: gw.url, model: "m", maxSteps: 3, temperature: 0, workspace, shell: "bash" } as any;
    const host = { app: { getConfig: () => config } } as any;
    const out = (await EXTENSION_HANDLERS.team({ host, args: "call_site_analyzer trace callers of foo", signal: new AbortController().signal } as any)) as { success: boolean; output: string };
    assert.doesNotMatch(out.output, /Unknown role/);
    assert.equal(out.success, true, out.output);
    assert.match(out.output, /\[CALL_SITE_ANALYZER\] COMPLETE/);
    const usage = (await EXTENSION_HANDLERS.team({ host, args: "", signal: new AbortController().signal } as any)) as { output: string };
    for (const role of ["researcher", "reviewer", "semantic_explorer", "call_site_analyzer", "failure_debugger", "security_reviewer", "acceptance_reviewer", "full"]) assert.match(usage.output, new RegExp(role));
    const bad = (await EXTENSION_HANDLERS.team({ host, args: "root do things", signal: new AbortController().signal } as any)) as { output: string };
    assert.match(bad.output, /Unknown role root/);
  } finally {
    await gw.close();
  }
});

test("TeamOrchestrator.plan builds a one-unit operation for each specialist target with that role's requirements", () => {
  for (const role of Object.keys(SPECIALIST_CONTRACTS)) {
    const op = new TeamOrchestrator({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 3, temperature: 0, workspace, shell: "bash" } as any).plan(role as any, "do the thing");
    assert.deepEqual(op.units.map((u) => [u.id, u.role]), [[role, role]]);
    assert.deepEqual(op.units[0].requires.capabilities, ["tools"]);
  }
});

// ---------------------------------------------------------------- recovered read-only agents

import { DurableStateManager } from "../src/core/state.js";

test("a recovered read-only specialist completes with its report; roles that can write keep the unverified-change obligation", async () => {
  const gw = await startGateway(() => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary: "callers: a.ts:3" } }] }));
  try {
    const outcomes: Record<string, string> = {};
    for (const role of ["semantic_explorer", "call_site_analyzer", "security_reviewer", "failure_debugger", "implementer"]) {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-spec-recover-"));
      const make = () => {
        const a = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 3, temperature: 0, workspace, shell: "bash", role } as any, 1, undefined, { durable: true, role } as any) as any;
        a.recoveryClock = fakeClock();
        a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
        return a;
      };
      const first = make();
      const taskId = first.getTaskId();
      first.checkpointDurableState("checkpoint");
      first.shutdown();
      const second = make();
      await second.recoverFromTaskState(taskId);
      const turn = await second.runTurn("report", undefined, { resume: true });
      outcomes[role] = `${turn.outcome}`;
      second.shutdown();
    }
    for (const role of ["semantic_explorer", "call_site_analyzer", "security_reviewer"]) assert.notEqual(outcomes[role], "UNVERIFIED", role);
    for (const role of ["failure_debugger", "implementer"]) assert.equal(outcomes[role], "UNVERIFIED", `${role} keeps the obligation`);
  } finally {
    await gw.close();
  }
});
