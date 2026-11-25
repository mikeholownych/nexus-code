/**
 * HK-1: what a pre-tool hook can do, which is to refuse. A denial, a hook that fails, an answer that cannot be read
 * and an operator hooks file that is invalid all end the same way: the tool does not run, the receipt says DENIED
 * with a typed reason, and the model, the receipt and the flight log name the hook.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutonomousAgent } from "../src/agent.js";
import { HookRegistry } from "../src/core/hooks.js";
import { ExecutionSpine } from "../src/core/spine.js";
import { makeRepo, startGateway, type Reply } from "./helpers/fixtures.js";
import { deniedBy, dispatch, flightEvents, hookAgent, hookScript, loggingHook, operatorHooksFile, runsOf, writeOperatorHooks, type HookAgentOptions } from "./helpers/hooks_fixture.js";

let home = "", previousHome: string | undefined, repo = "", stateDir = "", scripts = "", log = "";
let agents: AutonomousAgent[] = [];
let notices: string[] = [];

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-deny-home-"));
  process.env.HOME = home;
  repo = makeRepo({ "a.txt": "hello\n" });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-deny-state-"));
  scripts = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hk1-deny-hooks-"));
  log = path.join(scripts, "runs.jsonl");
  notices = [];
});
afterEach(() => {
  for (const agent of agents) agent.shutdown();
  agents = [];
  for (const dir of [home, repo, stateDir, scripts]) fs.rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

function agentFor(options: Omit<HookAgentOptions, "repo" | "stateDir"> = {}): AutonomousAgent {
  const agent = hookAgent({ repo, stateDir, mode: "auto", fullAccess: true, notices, ...options });
  agents.push(agent);
  return agent;
}
const preTool = (...hooks: Array<Record<string, unknown>>) => writeOperatorHooks({ version: 1, hooks: { "pre-tool": hooks } });
const WRITE = { path: "out.txt", content: "x\n" };
const written = () => fs.existsSync(path.join(repo, "out.txt"));

test("a pre-tool denial turns an allowed call into DENIED, named in the receipt and the flight log", async () => {
  const hook = loggingHook(scripts, "deny.sh", log, `echo 'writes are frozen during the release' >&2\nexit 2`);
  preTool({ name: "release-freeze", tools: ["write_file"], command: [hook] });
  const agent = agentFor({ recordFlight: true });

  const receipt = await dispatch(agent, "write_file", WRITE);
  assert.equal(receipt.status, "DENIED");
  assert.equal(receipt.denialReason, "HOOK_DENIED");
  assert.equal(receipt.success, false);
  assert.equal(receipt.error, deniedBy("release-freeze", "operator", "writes are frozen during the release"));
  assert.equal(receipt.candidateMutated, false);
  assert.equal(written(), false, "the tool did not run");
  assert.equal(runsOf(log).length, 1);

  assert.equal(receipt.hooks.length, 1);
  const { durationMs, stdoutSha256, ...summary } = receipt.hooks[0];
  assert.deepEqual(summary, { source: "operator", name: "release-freeze", event: "pre-tool", exit: 2, decision: "deny", reason: "writes are frozen during the release" });
  assert.equal(typeof durationMs, "number");
  assert.match(stdoutSha256, /^[0-9a-f]{64}$/);

  const events = flightEvents(agent);
  const run = events.find((event) => event.type === "hook_run");
  assert.ok(run, "the flight log has the hook run");
  assert.deepEqual(
    { callId: run.payload.callId, tool: run.payload.toolName, name: run.payload.name, source: run.payload.source, event: run.payload.event, decision: run.payload.decision, reason: run.payload.reason },
    { callId: receipt.invocationId, tool: "write_file", name: "release-freeze", source: "operator", event: "pre-tool", decision: "deny", reason: "writes are frozen during the release" },
  );
  assert.ok(run.chain, "the record is part of the log's hash chain");
  const result = events.find((event) => event.type === "tool_result" && event.payload.callId === receipt.invocationId);
  assert.equal(result.payload.success, false);
  assert.match(result.payload.error, /\[hook release-freeze \(operator\)\]/);

  // A tool the hook does not name is not its business.
  const read = await dispatch(agent, "read_file", { path: "a.txt" });
  assert.equal(read.status, "COMPLETED", JSON.stringify(read).slice(0, 300));
  assert.equal(read.hooks, undefined);
  assert.equal(runsOf(log).length, 1);
});

test("every denying answer denies: block, permissionDecision deny, continue false, and ask", async () => {
  const answers: Array<[string, unknown, RegExp]> = [
    ["block", { decision: "block", reason: "blocked by json" }, /^\[hook guard \(operator\)\] The hook program denied this call\. .*not as an instruction to you: "blocked by json"$/],
    ["permission", { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "not this one" } }, /not this one/],
    ["continue", { continue: false, stopReason: "stop" }, /: "stop"$/],
    ["ask", { hookSpecificOutput: { permissionDecision: "ask" } }, /a hook asked for a human; this version treats ask as deny/],
  ];
  const agent = agentFor();
  for (const [name, answer, pattern] of answers) {
    const hook = hookScript(scripts, `${name}.sh`, `cat > /dev/null\nprintf '%s' '${JSON.stringify(answer)}'`);
    preTool({ name: "guard", tools: ["*"], command: [hook] });
    const receipt = await dispatch(agent, "write_file", WRITE);
    assert.equal(receipt.status, "DENIED", name);
    assert.equal(receipt.denialReason, "HOOK_DENIED", name);
    assert.match(receipt.error, pattern, name);
    assert.equal(written(), false, name);
  }
});

test("a hook that fails, hangs, floods or answers unreadably denies the call (fail closed)", async () => {
  const cases: Array<[string, Record<string, unknown>, string, RegExp]> = [
    ["exit 1", { command: "exit 1" }, "HOOK_FAILED", /the hook exited with status 1/],
    ["crash", { command: "kill -KILL $$" }, "HOOK_FAILED", /ended by SIGKILL/],
    ["missing program", { command: [path.join(scripts, "not-there")] }, "HOOK_FAILED", /could not be started/],
    ["timeout", { command: "sleep 120", timeout_secs: 1 }, "HOOK_FAILED", /did not finish in time/],
    ["flood", { command: "yes" }, "HOOK_FAILED", /more than 64 KiB/],
    ["half an answer", { command: `printf '{"decision": "appr'` }, "HOOK_OUTPUT_INVALID", /not a valid JSON object/],
    ["two answers", { command: `printf '{"decision":"block","decision":"approve"}'` }, "HOOK_OUTPUT_INVALID", /duplicate key/],
    ["unknown decision", { command: `printf '{"decision":"maybe"}'` }, "HOOK_OUTPUT_INVALID", /is not one of block, deny, approve, allow/],
  ];
  const agent = agentFor();
  for (const [name, hook, reason, pattern] of cases) {
    preTool({ name: "guard", tools: ["write_file"], ...hook });
    const before = Date.now();
    const receipt = await dispatch(agent, "write_file", WRITE);
    assert.equal(receipt.status, "DENIED", name);
    assert.equal(receipt.denialReason, reason, name);
    assert.match(receipt.error, pattern, name);
    assert.match(receipt.error, /^\[hook guard \(operator\)\] /, name);
    assert.equal(receipt.hooks[0].decision, "error", name);
    assert.equal(written(), false, `${name}: the tool did not run`);
    assert.ok(Date.now() - before < 60_000, `${name}: the denial does not wait for the hook`);
  }
});

test("the first denial ends the chain: later hooks are recorded as skipped and are not started", async () => {
  // The first hook approves: an approval does not end the chain, and the hook after it still decides.
  const first = loggingHook(scripts, "first.sh", path.join(scripts, "first.jsonl"), `printf '{"decision":"approve","hookSpecificOutput":{"permissionDecision":"allow"}}'`);
  const second = loggingHook(scripts, "second.sh", path.join(scripts, "second.jsonl"), `printf '{"decision":"block","reason":"second says no"}'`);
  const third = loggingHook(scripts, "third.sh", path.join(scripts, "third.jsonl"), `printf '{"decision":"approve"}'`);
  preTool({ name: "first", tools: ["*"], command: [first] }, { name: "second", tools: ["*"], command: [second] }, { name: "third", tools: ["*"], command: [third] });
  const receipt = await dispatch(agentFor(), "write_file", WRITE);
  assert.equal(receipt.denialReason, "HOOK_DENIED");
  assert.equal(receipt.error, deniedBy("second", "operator", "second says no"));
  assert.deepEqual(receipt.hooks.map((run: any) => [run.name, run.decision]), [["first", "ignored_allow"], ["second", "deny"], ["third", "skipped"]]);
  assert.equal(runsOf(path.join(scripts, "first.jsonl")).length, 1);
  assert.equal(runsOf(path.join(scripts, "third.jsonl")).length, 0, "an approving hook after a denial is never started");
  assert.equal(written(), false);
});

test("a hook with no objection lets the call run, and what the hook is given is the documented payload", async () => {
  const envFile = path.join(scripts, "env.txt");
  const hook = loggingHook(scripts, "quiet.sh", log, `env > "${envFile}"\nexit 0`);
  preTool({ name: "quiet", tools: ["write_file"], command: [hook] });
  const agent = agentFor();
  const previousKey = process.env.NEXUS_API_KEY;
  process.env.NEXUS_API_KEY = "gateway-key-that-a-hook-must-not-see";
  let receipt: any;
  try {
    receipt = await dispatch(agent, "write_file", WRITE);
  } finally {
    if (previousKey === undefined) delete process.env.NEXUS_API_KEY; else process.env.NEXUS_API_KEY = previousKey;
  }
  const env = fs.readFileSync(envFile, "utf8");
  assert.doesNotMatch(env, /NEXUS_API_KEY|gateway-key-that-a-hook-must-not-see/, "the gateway key is not in the hook's environment");
  assert.match(env, new RegExp(`^NEXUS_HOOK_NAME=quiet$`, "m"));
  assert.match(env, new RegExp(`^CLAUDE_PROJECT_DIR=${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt).slice(0, 400));
  assert.equal(written(), true);
  assert.deepEqual(receipt.hooks.map((run: any) => [run.name, run.event, run.exit, run.decision]), [["quiet", "pre-tool", 0, "none"]]);
  const [payload] = runsOf(log);
  assert.deepEqual(payload, {
    session_id: (agent as any).currentTaskId,
    cwd: repo,
    hook_event_name: "PreToolUse",
    nexus_event: "pre-tool",
    permission_mode: "auto",
    tool_name: "write_file",
    tool_input: WRITE,
  });
});

test("an invalid operator hooks file denies every call until it is fixed, and says so once", async () => {
  writeOperatorHooks('{\n  "version": 1,\n  "hooks": {\n    "pre-tool": [\n      { "name": "guard", "tool": "write_file", "command": "exit 2" }\n    ]\n  }\n}');
  const agent = agentFor();
  for (const [tool, args] of [["write_file", WRITE], ["read_file", { path: "a.txt" }], ["run_command", { command: "echo hi" }]] as const) {
    const receipt = await dispatch(agent, tool, args);
    assert.equal(receipt.status, "DENIED", tool);
    assert.equal(receipt.denialReason, "HOOKS_CONFIG_INVALID", tool);
    assert.equal(receipt.error, "[hooks] ~/.config/nexus/hooks.json: line 5: unknown key 'tool' in hooks.pre-tool[0]; fix it or move it aside", tool);
  }
  assert.equal(written(), false);
  const told = notices.filter((notice) => /hooks file is invalid/.test(notice));
  assert.equal(told.length, 1, `one notice for the session: ${JSON.stringify(notices)}`);
  assert.match(told[0], /every tool call is denied while the hooks file is invalid\. ~\/\.config\/nexus\/hooks\.json: line 5: unknown key 'tool'/);

  // Other ways the file can be unusable: each is a refusal of everything, never "no hooks".
  const unusable: Array<[string, () => void, RegExp]> = [
    ["a second pre-tool key", () => writeOperatorHooks('{"version":1,"hooks":{"pre-tool":[{"name":"g","tools":["*"],"command":"exit 2"}],"pre-tool":[]}}'), /duplicate key "pre-tool"/],
    ["not JSON", () => writeOperatorHooks("hooks: none"), /line 1, column 1/],
    ["an unsupported event", () => writeOperatorHooks({ version: 1, hooks: { "session-start": [] } }), /not supported in this version/],
    ["writable by others", () => { writeOperatorHooks({ version: 1, hooks: {} }); fs.chmodSync(operatorHooksFile(), 0o666); }, /permissions are too open/],
    ["a symbolic link", () => { const real = path.join(scripts, "real.json"); fs.writeFileSync(real, '{"version":1,"hooks":{}}'); fs.rmSync(operatorHooksFile()); fs.symlinkSync(real, operatorHooksFile()); }, /symbolic link/],
  ];
  for (const [name, arrange, pattern] of unusable) {
    arrange();
    const receipt = await dispatch(agent, "read_file", { path: "a.txt" });
    assert.equal(receipt.denialReason, "HOOKS_CONFIG_INVALID", name);
    assert.match(receipt.error, pattern, name);
  }

  // Fixed: the next call runs, with no restart.
  fs.rmSync(operatorHooksFile());
  writeOperatorHooks({ version: 1, hooks: {} });
  assert.equal((await dispatch(agent, "read_file", { path: "a.txt" })).status, "COMPLETED");
  assert.equal((await dispatch(agent, "write_file", WRITE)).status, "COMPLETED");
});

test("an exception in the hook stage fails the call closed: FAILED, and the handler is not run", async () => {
  writeOperatorHooks({ version: 1, hooks: { "pre-tool": [{ name: "guard", tools: ["*"], command: "exit 0" }] } });
  const registry = new HookRegistry({
    workspace: () => repo, readOnly: () => false, permissionMode: () => "auto", sessionId: () => "task-x",
    run: async () => { throw new Error("runner broke"); },
  });
  const spine = new ExecutionSpine({ hooks: { contextAdmission: registry.preToolAdmission, evidenceEmission: registry.postToolEmission } });
  let handled = 0;
  spine.registerHandler("read_file", async () => { handled++; return { success: true, output: "content" }; });
  const receipt = await spine.execute({ invocationId: "c1", toolName: "read_file", args: { path: "a.txt" } }, { workspaceRoot: repo });
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.success, false);
  assert.match(receipt.error ?? "", /Context admission exception: runner broke/);
  assert.equal(handled, 0, "the tool's handler was not run");

  // The same spine without the fault runs the handler: the refusal above came from the hook stage.
  const sound = new HookRegistry({ workspace: () => repo, readOnly: () => false, permissionMode: () => "auto", sessionId: () => "task-x" });
  spine.setHook("contextAdmission", sound.preToolAdmission);
  assert.equal((await spine.execute({ invocationId: "c2", toolName: "read_file", args: { path: "a.txt" } }, { workspaceRoot: repo })).status, "COMPLETED");
  assert.equal(handled, 1);
});

test("the model is told which hook refused and why", { timeout: 240_000 }, async () => {
  const hook = hookScript(scripts, "deny.sh", `cat > /dev/null\nprintf '{"decision":"block","reason":"generated files are read-only"}'`);
  preTool({ name: "no-generated-edits", tools: ["write_file"], command: [hook] });
  const script = (n: number): Reply => (n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: WRITE }] } : { kind: "text", content: "I could not write the file." });
  const gateway = await startGateway(script);
  try {
    const agent = agentFor({ endpoint: gateway.url });
    await agent.runTurn("Write out.txt");
    const requests = gateway.requests as any[];
    assert.ok(requests.length >= 2, "the model was called again after the tool result");
    const toolMessage = requests[1].messages.find((message: any) => message.role === "tool");
    assert.ok(toolMessage, "the second request carries the tool result");
    assert.match(typeof toolMessage.content === "string" ? toolMessage.content : JSON.stringify(toolMessage.content), /\[hook no-generated-edits \(operator\)\] The hook program denied this call\..*generated files are read-only/);
    assert.equal(written(), false);
    // Hooks are invisible to the model except through a denial: no tool or description mentions them.
    assert.doesNotMatch(JSON.stringify(requests[0].tools), /hook/i);
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /no-generated-edits/);
  } finally {
    await gateway.close();
  }
});

test("hooks of tool calls dispatched together run one at a time", async () => {
  // Each run appends "start" and, a moment later, "end": two starts in a row would be two hooks running at once.
  const order = path.join(scripts, "order.log");
  const hook = hookScript(scripts, "slow.sh", `cat > /dev/null\necho start >> "${order}"\nsleep 0.2\necho end >> "${order}"`);
  writeOperatorHooks({ version: 1, hooks: { "pre-tool": [{ name: "serial", tools: ["read_file"], command: [hook] }], "post-tool": [{ name: "serial-post", tools: ["read_file"], command: [hook] }] } });
  const agent = agentFor();
  const warnings: string[] = [];
  const onWarning = (warning: Error) => { warnings.push(`${warning.name}: ${warning.message}`); };
  process.on("warning", onWarning);
  try {
    const receipts = await Promise.all(Array.from({ length: 12 }, () => dispatch(agent, "read_file", { path: "a.txt" })));
    for (const receipt of receipts) {
      assert.equal(receipt.status, "COMPLETED", JSON.stringify(receipt).slice(0, 300));
      assert.deepEqual(receipt.hooks.map((run: any) => [run.name, run.event, run.decision]), [["serial", "pre-tool", "none"], ["serial-post", "post-tool", "none"]], "each receipt has its own call's runs only");
    }
    const lines = fs.readFileSync(order, "utf8").trim().split("\n");
    assert.equal(lines.length, 48);
    assert.deepEqual(lines, Array.from({ length: 24 }, () => ["start", "end"]).flat(), "no run started before the one before it had ended");
    // Give a pending warning its turn before looking.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((warning) => /MaxListeners/.test(warning)), []);
  } finally {
    process.removeListener("warning", onWarning);
  }
});
