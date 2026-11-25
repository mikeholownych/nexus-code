/**
 * HK-1: post-tool hooks observe. They run after a call that passed the pre-tool stage and was attempted, are given
 * the arguments and a bounded, redacted result, and nothing they answer or do to themselves (deny, crash, hang)
 * changes the receipt or what the model is told.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutonomousAgent } from "../src/agent.js";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { makeRepo } from "./helpers/fixtures.js";
import { dispatch, flightEvents, hookAgent, hookScript, loggingHook, runsOf, stable, writeOperatorHooks, type HookAgentOptions } from "./helpers/hooks_fixture.js";

let home = "", previousHome: string | undefined, repo = "", stateDir = "", scripts = "", log = "";
let agents: AutonomousAgent[] = [];

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-post-home-"));
  process.env.HOME = home;
  repo = makeRepo({ "a.txt": "hello\n" });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-post-state-"));
  scripts = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-post-hooks-"));
  log = path.join(scripts, "runs.jsonl");
});
afterEach(() => {
  for (const agent of agents) agent.shutdown();
  agents = [];
  for (const dir of [home, repo, stateDir, scripts]) fs.rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

function agentFor(options: Omit<HookAgentOptions, "repo" | "stateDir"> = {}): AutonomousAgent {
  const agent = hookAgent({ repo, stateDir, mode: "auto", fullAccess: true, ...options });
  agents.push(agent);
  return agent;
}
const hooks = (document: { pre?: unknown[]; post?: unknown[] }) => writeOperatorHooks({ version: 1, hooks: { ...(document.pre ? { "pre-tool": document.pre } : {}), ...(document.post ? { "post-tool": document.post } : {}) } });
const BLOCK = `printf '%s' '{"decision":"block","reason":"too late","continue":false,"hookSpecificOutput":{"permissionDecision":"deny","updatedInput":{"path":"other.txt"}},"systemMessage":"rewrite the result"}'`;

test("a post-tool hook that answers block changes nothing: the receipt and the result are those of a run without hooks", async () => {
  const control = await dispatch(agentFor(), "write_file", { path: "one.txt", content: "one\n" });
  assert.equal(control.status, "COMPLETED", JSON.stringify(control).slice(0, 400));

  hooks({ post: [{ name: "late-veto", tools: ["*"], command: [loggingHook(scripts, "block.sh", log, BLOCK)] }] });
  fs.rmSync(path.join(repo, "one.txt"));
  const agent = agentFor({ recordFlight: true });
  const hooked = await dispatch(agent, "write_file", { path: "one.txt", content: "one\n" });
  assert.deepEqual(stable(hooked), stable(control), "status, output, error and every other member are unchanged");
  assert.equal(JSON.stringify(hooked.output), JSON.stringify(control.output), "what the model is given is byte-identical");
  assert.equal(fs.readFileSync(path.join(repo, "one.txt"), "utf8"), "one\n", "the write happened and stays");

  // The run is recorded, as an observation.
  assert.deepEqual(hooked.hooks.map((run: any) => [run.name, run.event, run.source, run.decision, run.reason]), [["late-veto", "post-tool", "operator", "deny", "too late"]]);
  assert.deepEqual(hooked.hooks[0].ignored, ["systemMessage", "hookSpecificOutput.updatedInput"]);
  const recorded = flightEvents(agent).filter((event) => event.type === "hook_run");
  assert.deepEqual(recorded.map((event) => [event.payload.name, event.payload.event, event.payload.callId]), [["late-veto", "post-tool", hooked.invocationId]]);

  const [payload] = runsOf(log);
  assert.deepEqual(payload, {
    session_id: (agent as any).currentTaskId,
    cwd: repo,
    hook_event_name: "PostToolUse",
    nexus_event: "post-tool",
    permission_mode: "auto",
    tool_name: "write_file",
    tool_input: { path: "one.txt", content: "one\n" },
    tool_response: { success: true, output: hooked.output.slice(0, 32 * 1024), error: null },
  });
});

test("a post-tool hook that fails or hangs does not change the outcome either", async () => {
  const control = await dispatch(agentFor(), "read_file", { path: "a.txt" });
  hooks({ post: [
    { name: "crash", tools: ["*"], command: "exit 1" },
    { name: "hang", tools: ["*"], command: "sleep 120", timeout_secs: 1 },
    { name: "missing", tools: ["*"], command: [path.join(scripts, "not-there")] },
  ] });
  const hooked = await dispatch(agentFor(), "read_file", { path: "a.txt" });
  assert.deepEqual(stable(hooked), stable(control));
  assert.equal(hooked.status, "COMPLETED");
  // A failing post-tool hook does not stop the ones after it: nothing is being decided.
  assert.deepEqual(hooked.hooks.map((run: any) => [run.name, run.decision]), [["crash", "error"], ["hang", "error"], ["missing", "error"]]);
});

test("post-tool runs for attempted calls, successful or failed, and not for denied ones", async () => {
  const deny = hookScript(scripts, "deny.sh", `cat > /dev/null\nexit 2`);
  hooks({
    pre: [{ name: "no-commands", tools: ["run_command"], command: [deny] }],
    post: [{ name: "audit", tools: ["*"], command: [loggingHook(scripts, "audit.sh", log, "exit 0")] }],
  });

  // Attempted and successful.
  const ok = await dispatch(agentFor(), "read_file", { path: "a.txt" });
  assert.equal(ok.status, "COMPLETED");
  // Attempted and failed: the hook sees the failure.
  const failed = await dispatch(agentFor(), "read_file", { path: "does-not-exist.txt" });
  assert.equal(failed.success, false);
  assert.notEqual(failed.status, "DENIED");
  // Denied by a pre-tool hook.
  const hookDenied = await dispatch(agentFor(), "run_command", { command: "echo hi" });
  assert.equal(hookDenied.denialReason, "HOOK_DENIED");
  // Denied by a gate before the hook stage (headless approval in review mode).
  const gateDenied = await dispatch(agentFor({ mode: "review", fullAccess: false }), "write_file", { path: "x.txt", content: "x" });
  assert.equal(gateDenied.denialReason, "DECISION_REQUIRED_NO_OPERATOR");
  // Denied by the authority stage after the hook stage (read-only mode).
  const readOnlyDenied = await dispatch(agentFor({ readOnly: true }), "write_file", { path: "x.txt", content: "x" });
  assert.equal(readOnlyDenied.status, "DENIED");

  const runs = runsOf(log);
  assert.deepEqual(runs.map((run) => [run.tool_name, run.tool_input.path, run.tool_response.success]), [["read_file", "a.txt", true], ["read_file", "does-not-exist.txt", false]]);
  assert.equal(typeof runs[1].tool_response.error, "string");
  for (const denied of [hookDenied, gateDenied, readOnlyDenied]) assert.ok(!(denied.hooks ?? []).some((run: any) => run.event === "post-tool"));
});

test("a post-tool hook is given a bounded result with classified values removed", async () => {
  const secret = "nexus-gateway-key-0123456789abcdef";
  const previous = process.env.NEXUS_API_KEY;
  process.env.NEXUS_API_KEY = secret;
  try {
    fs.writeFileSync(path.join(repo, "leak.txt"), `token=${secret}\n${"filler line\n".repeat(8000)}`);
    hooks({ post: [{ name: "audit", tools: ["read_file"], command: [loggingHook(scripts, "audit.sh", log, "exit 0")] }] });
    const receipt = await dispatch(agentFor(), "read_file", { path: "leak.txt" });
    assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt).slice(0, 300));
    assert.ok(receipt.output.includes(secret), "the fixture: the tool's own result does contain the value");
    const raw = fs.readFileSync(log, "utf8");
    assert.ok(!raw.includes(secret), "the value is not in what the hook was given");
    const [payload] = runsOf(log);
    assert.ok(payload.tool_response.output.length > 0 && payload.tool_response.output.length <= 33 * 1024, `bounded: ${payload.tool_response.output.length}`);
    assert.ok(receipt.output.length > 40 * 1024, "the fixture: the full result is larger than the bound");
  } finally {
    if (previous === undefined) delete process.env.NEXUS_API_KEY; else process.env.NEXUS_API_KEY = previous;
  }
});

test("a secret reference in the arguments reaches the tool resolved and the hooks unresolved", async () => {
  // A value the boundary classifies (here: the gateway key of the environment), as every value it tokenizes is.
  const secret = "nexus-gateway-key-fedcba9876543210";
  const previous = process.env.NEXUS_API_KEY;
  process.env.NEXUS_API_KEY = secret;
  try {
    const agent = agentFor();
    const taskId = (agent as any).currentTaskId as string;
    const reference = InformationFlowBoundary.getGlobalInstance().generateToken(secret, taskId, "session", "HOST_LOCAL", "HOST_LOCAL");
    hooks({
      pre: [{ name: "pre", tools: ["run_command"], command: [loggingHook(scripts, "pre.sh", log, "exit 0")] }],
      post: [{ name: "post", tools: ["run_command"], command: [loggingHook(scripts, "post.sh", log, "exit 0")] }],
    });
    const receipt = await dispatch(agent, "run_command", { command: `printf '%s' '${reference}' > resolved.txt` });
    assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt).slice(0, 400));
    assert.equal(fs.readFileSync(path.join(repo, "resolved.txt"), "utf8"), secret, "the fixture: the tool itself got the value");
    const raw = fs.readFileSync(log, "utf8");
    const runs = runsOf(log);
    assert.deepEqual(runs.map((run) => run.nexus_event), ["pre-tool", "post-tool"]);
    assert.ok(!raw.includes(secret), "neither hook was given the value");
    for (const run of runs) assert.ok(run.tool_input.command.includes(reference), `${run.nexus_event}: the arguments carry the reference the model wrote`);
  } finally {
    if (previous === undefined) delete process.env.NEXUS_API_KEY; else process.env.NEXUS_API_KEY = previous;
  }
});
