/**
 * BG-1 / G-4 (no allow-always) and G-3 (client and environment): an unattended job cannot be put in auto mode and
 * cannot be granted anything.
 *   - `nexus job start` has no --yes, -y, --mode or --approve; the same flags before `job` and NEXUS_APPROVAL_MODE=auto
 *     in the client's environment are refused, not ignored.
 *   - A runner whose own environment says auto mode, trusts every workspace and opens the sandbox's network still runs
 *     the job in review mode, loads no workspace plugin, and denies a command twice in a row: nothing is remembered.
 *   - Through the real dispatch path, in process: the job's policy denies commands and egress with
 *     DECISION_REQUIRED_NO_OPERATOR and lets a worktree write through; a copy of the policy that lets commands through
 *     runs the command, so these assertions do depend on the policy (mutation guard).
 */
import "./helpers/leak_guard.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import type { PolicyContext } from "../src/core/approval_policy.js";
import type { EffectClass } from "../src/core/capabilities.js";
import { readReceipt } from "../src/core/job_runner.js";
import { mergePolicies } from "../src/core/managed_policy.js";
import { sameProcess } from "../src/core/process_identity.js";
import type { JobPolicy } from "../src/core/runner_store.js";
import { DurableStateManager } from "../src/core/state.js";
import { scrubUnattendedEnv, UnattendedApprovalPolicy } from "../src/core/unattended.js";
import { isSandboxAvailable } from "../src/sandbox.js";
import { isWorkspaceTrusted } from "../src/workspace_trust.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { runnerWorld, startedJobId } from "./helpers/runner_fixture.js";

const temp: string[] = [];
const agents: AutonomousAgent[] = [];
after(() => {
  for (const agent of agents) agent.shutdown();
  for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
});

test("job start has no way to ask for auto mode: the flags do not exist, and the ones that parse elsewhere are refused", { timeout: 200_000 }, async () => {
  const world = runnerWorld();
  const repo = makeRepo();
  const start = ["job", "start", "--prompt", "x", "-w", repo];
  try {
    const runs = await Promise.all([
      world.run([...start, "--yes"]),
      world.run([...start, "-y"]),
      world.run([...start, "--mode", "auto"]),
      world.run([...start, "--approve"]),
      world.run([...start, "--sandbox", "none"]),
      world.run(["--yes", ...start]),
      world.run(["--mode", "auto", ...start]),
      world.run(["--sandbox-network", ...start]),
      world.run(start, { NEXUS_APPROVAL_MODE: "auto" }),
    ]);
    for (const [index, flag] of ["--yes", "-y", "--mode", "--approve", "--sandbox"].entries()) {
      assert.equal(runs[index].code, 1, runs[index].stderr);
      assert.match(runs[index].stderr, new RegExp(`unknown option '${flag}'`));
    }
    for (const [index, flag] of [[5, "--yes"], [6, "--mode"], [7, "--sandbox-network"]] as const) {
      assert.equal(runs[index].code, 2, runs[index].stderr);
      assert.match(runs[index].stderr, new RegExp(`^${flag} does not apply to a background job and is refused`));
    }
    assert.equal(runs[8].code, 2, runs[8].stderr);
    assert.match(runs[8].stderr, /^NEXUS_APPROVAL_MODE=auto is set, and a background job never runs in auto mode/);
    for (const run of runs) assert.equal(run.stdout, "", "no job id was printed");
    assert.equal(fs.existsSync(world.paths.root), false, "nothing was submitted");
  } finally {
    await world.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a runner started with auto mode, workspace trust and sandbox network in its environment still runs the job in review mode and denies every command", { timeout: 290_000, skip: isSandboxAvailable("auto") ? false : "worktree-write needs a sandbox engine" }, async () => {
  const world = runnerWorld();
  const sentinel = path.join(world.root, "plugin-loaded");
  const repo = makeRepo({ "plugins/sentinel.mjs": `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(sentinel)}, "loaded");\nexport default { name: "sentinel", description: "must not load" };\n` });
  const command = { name: "run_command", args: { command: "touch ran.txt" } };
  const gw = await startGateway((n) => (n === 1 ? { kind: "tools", calls: [command, command] } : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "could not run it" } }] }));
  try {
    await world.startRunner([], { NEXUS_APPROVAL_MODE: "auto", NEXUS_TRUST_WORKSPACE: "1", NEXUS_SANDBOX_NETWORK: "1" });
    const started = await world.run(["job", "start", "--prompt", "Run touch ran.txt.", "--allow-worktree-write", "-w", repo, "-e", gw.url, "-m", "m"]);
    assert.equal(started.code, 0, started.stderr);
    const id = startedJobId(started.stdout);
    const ended = await world.waitJob(id, ["BLOCKED", "COMPLETE", "FAILED", "CANCELLED", "TIMED_OUT"], 200_000);
    const receipt = readReceipt(world.paths, id)!;
    assert.equal(ended.state, "BLOCKED", JSON.stringify(receipt));
    assert.equal(receipt.approval_mode, "review", "not auto, whatever the runner's environment says");
    assert.equal(receipt.unattended, true);
    // The operation reports the unit as having changed nothing (its command was refused), and asks what to do next.
    assert.equal(receipt.reason, "EXECUTION_FAILED", receipt.summary);
    assert.match(receipt.summary, /^BLOCKED: unit 'task' no_change: .*no changes made/);
    assert.equal(receipt.pending_decisions.length, 1);
    assert.equal(receipt.units[0].status, "BLOCKED");
    assert.notEqual(receipt.units[0].outcome, "VERIFIED");

    // Both identical calls were denied: the first denial granted nothing for the second.
    const results = ((gw.requests[1] as any).messages as any[]).filter((message) => message.role === "tool").map((message) => String(message.content));
    assert.equal(results.length, 2);
    for (const result of results) assert.match(result, /requires operator approval \(exec\), but no operator is present/);
    const denied = fs.readFileSync(world.paths.events(id), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === "TOOL_END" && event.tool === "run_command");
    assert.equal(denied.length, 2);
    assert.ok(denied.every((event) => event.success === false));
    assert.deepEqual(fs.readdirSync(path.join(repo, ".nexus", "worktrees"), { recursive: true }).filter((name) => String(name).endsWith("ran.txt")), [], "the command never ran");

    // NEXUS_TRUST_WORKSPACE=1 did not reach the worker: the repository's plugin was seen and not loaded.
    assert.equal(fs.existsSync(sentinel), false, "the workspace plugin was not imported");
    assert.equal(sameProcess(ended.attempts[0]), false, "the worker did not stay waiting for an answer");
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function agent(jobPolicy: JobPolicy, make: (jobPolicy: JobPolicy) => UnattendedApprovalPolicy): { agent: AutonomousAgent; repo: string } {
  const repo = makeRepo({ "a.txt": "hello\n" });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-unattended-gate-"));
  temp.push(repo, stateDir);
  const made = new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 4, temperature: 0, workspace: repo, shell: "bash", approvalMode: jobPolicy === "worktree-write" ? "review" : "read-only", readOnly: jobPolicy === "read-only", fullAccess: false, surface: "unattended" } as any);
  (made as any).stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [(made as any).primaryWorkspacePathIdentity] });
  made.setApprovalPolicy(make(jobPolicy));
  agents.push(made);
  return { agent: made, repo };
}
let seq = 0;
/** One tool call through the real dispatch path with no operator to ask, as in a worker. */
async function call(target: AutonomousAgent, name: string, args: Record<string, unknown>) {
  const toolCall = { id: `c${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
  return (await (target as any).dispatchToolCall(toolCall, 1, "agent", undefined)).receipt;
}
const none = mergePolicies();
const real = (jobPolicy: JobPolicy) => new UnattendedApprovalPolicy(jobPolicy, () => none);

test("dispatch under the job policy: commands and egress are denied every time, a worktree write goes through, a read-only job writes nothing", async () => {
  const write = agent("worktree-write", real);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const receipt = await call(write.agent, "run_command", { command: "touch ran.txt" });
    assert.deepEqual([receipt.status, receipt.denialReason], ["DENIED", "DECISION_REQUIRED_NO_OPERATOR"], `attempt ${attempt}`);
  }
  assert.equal(fs.existsSync(path.join(write.repo, "ran.txt")), false);
  const egress = await call(write.agent, "fetch_web", { url: "https://example.test/" });
  assert.deepEqual([egress.status, egress.denialReason], ["DENIED", "DECISION_REQUIRED_NO_OPERATOR"]);
  const written = await call(write.agent, "write_file", { path: "new.txt", content: "made by the job\n" });
  assert.equal(written.success, true, JSON.stringify(written));
  assert.equal(fs.readFileSync(path.join(write.repo, "new.txt"), "utf8"), "made by the job\n");

  const readOnly = agent("read-only", real);
  const refused = await call(readOnly.agent, "write_file", { path: "new.txt", content: "x" });
  assert.equal(refused.success, false);
  assert.equal(refused.status, "DENIED");
  assert.equal(fs.existsSync(path.join(readOnly.repo, "new.txt")), false);
  const command = await call(readOnly.agent, "run_command", { command: "touch ran.txt" });
  assert.equal(command.status, "DENIED");
  assert.equal(fs.existsSync(path.join(readOnly.repo, "ran.txt")), false);
});

test("mutation guard: with a copy of the policy that lets commands through, the same command runs, so the denials above come from the policy", async () => {
  const mutant = (jobPolicy: JobPolicy) => new (class extends UnattendedApprovalPolicy {
    override requiresDecision(effect: EffectClass, context: PolicyContext): boolean {
      return effect === "exec" ? false : super.requiresDecision(effect, context);
    }
  })(jobPolicy, () => none);
  const loose = agent("worktree-write", mutant);
  const receipt = await call(loose.agent, "run_command", { command: "touch ran.txt" });
  assert.notEqual(receipt.status, "DENIED", JSON.stringify(receipt));
  assert.equal(fs.existsSync(path.join(loose.repo, "ran.txt")), true, "the gate test would fail with this policy");
});

test("the environment scrub is what keeps NEXUS_TRUST_WORKSPACE out of a job: with it a workspace is trusted, after the scrub it is not", () => {
  const repo = makeRepo();
  temp.push(repo);
  const saved = process.env.NEXUS_TRUST_WORKSPACE;
  process.env.NEXUS_TRUST_WORKSPACE = "1";
  try {
    assert.equal(isWorkspaceTrusted(repo, false, none), true, "the variable trusts any workspace for an attended run");
    assert.deepEqual(scrubUnattendedEnv(process.env), ["NEXUS_TRUST_WORKSPACE"]);
    assert.equal(isWorkspaceTrusted(repo, false, none), false);
  } finally {
    if (saved === undefined) delete process.env.NEXUS_TRUST_WORKSPACE;
    else process.env.NEXUS_TRUST_WORKSPACE = saved;
  }
});
