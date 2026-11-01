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
import { teamUnits } from "../src/team.js";

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
