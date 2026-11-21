/**
 * VC-8: implementer and tester are not read-only, so they have no allow-list, but they are refused the tools that reach
 * outside the task. The agent neither offers a refused tool nor runs it if the model calls it anyway, and says why.
 * Everything they need to edit, test and run stays available. Owner decision 2026-11-21 ("network and side-channel tools").
 */
import "./helpers/leak_guard.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { roleToolAllowList, roleToolDenyList } from "../src/core/roles.js";
import { TOOL_GROUPS } from "../src/core/tool_groups.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-role-deny-"));
const agents: AutonomousAgent[] = [];
after(() => { for (const a of agents) a.shutdown(); fs.rmSync(workspace, { recursive: true, force: true }); });
const track = (agent: AutonomousAgent): AutonomousAgent => { agents.push(agent); return agent; };
const agentFor = (role: string) => track(
  new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash", role, approvalMode: "auto", fullAccess: true } as any));
/** Network and browser tools are disclosed on demand (enable_tools); enable every group so "not offered" can only be the deny-list. */
const withAllGroups = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).enabledToolGroups = new Set(Object.keys(TOOL_GROUPS));
  return agent;
};
const call = (name: string, args: Record<string, unknown>) => ({ id: `call-${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const BROWSER = ["browser_navigate", "browser_screenshot", "browser_click", "browser_type", "browser_console_logs"];
const KEPT = ["read_file", "write_file", "edit_file", "patch_file", "run_command", "run_tests", "search_code", "task_completed"];

test("the deny-lists are exactly the owner's: browser and knowledge store for both, plus network and subagents for the tester", () => {
  assert.deepEqual([...roleToolDenyList("implementer")!].sort(), [...BROWSER, "manage_knowledge"].sort());
  assert.deepEqual([...roleToolDenyList("tester")!].sort(), [...BROWSER, "manage_knowledge", "fetch_web", "search_web", "spawn_subagent"].sort());
  for (const role of ["architect", "researcher", "reviewer", undefined, "constructor", "failure_debugger"]) assert.equal(roleToolDenyList(role), undefined, String(role));
  assert.equal(roleToolAllowList("implementer"), undefined, "no allow-list: the role still edits and runs commands");
  assert.equal(roleToolAllowList("tester"), undefined);
});

for (const [role, refused] of [
  ["implementer", [...BROWSER, "manage_knowledge"]],
  ["tester", [...BROWSER, "manage_knowledge", "fetch_web", "search_web", "spawn_subagent"]],
] as const) {
  test(`${role}: refused tools are not offered, and the tools the work needs are`, () => {
    const agent = withAllGroups(agentFor(role));
    const offered = new Set(agent.getEffectiveTools().map((t) => t.function.name));
    for (const name of refused) assert.equal(offered.has(name), false, `${name} must not be offered to ${role}`);
    for (const name of KEPT) assert.equal(offered.has(name), true, `${name} must stay offered to ${role}`);
  });

  test(`${role}: a refused tool called anyway is denied with a reason and never runs`, async () => {
    const agent = agentFor(role);
    for (const name of refused) {
      const { receipt } = await (agent as any).dispatchToolCall(call(name, { url: "https://example.com", action: "list", selector: "#a", text: "x" }), 1, "agent");
      assert.equal(receipt.status, "DENIED", name);
      assert.equal(receipt.success, false, name);
      assert.match(receipt.error, new RegExp(`not available to role '${role}'`), name);
      assert.match(receipt.error, /reach outside the task/, name);
    }
  });
}

test("with every group enabled, a session with no role still has the network, browser and knowledge tools (the deny-list is role-scoped)", () => {
  const agent = withAllGroups(track(new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash" } as any)));
  const offered = new Set(agent.getEffectiveTools().map((t) => t.function.name));
  for (const name of ["fetch_web", "search_web", "manage_knowledge", "browser_navigate"]) assert.equal(offered.has(name), true, `${name} for no role`);
});

test("a permitted tool still runs for the implementer (the deny-list does not widen into a block)", async () => {
  const agent = agentFor("implementer");
  fs.writeFileSync(path.join(workspace, "hello.txt"), "hi\n");
  const { receipt } = await (agent as any).dispatchToolCall(call("read_file", { path: "hello.txt" }), 1, "agent");
  assert.equal(receipt.success, true, JSON.stringify(receipt).slice(0, 300));
});
