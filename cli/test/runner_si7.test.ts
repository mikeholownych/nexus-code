/**
 * BG-1 acceptance, part 2 (SI-7 against the runner): "kill the worker; the run resumes". A worktree-write job runs a
 * command the operator allowed (CS-9 rule) that appends to a counter and then blocks. The worker is killed with
 * SIGKILL mid-call; the runner starts a new attempt by itself. Contract, as in fault_kill_mid_tool_call.test.ts:
 *   - the resumed attempt reports the call as interrupted, runs nothing again and asks before any further inference;
 *   - the job ends BLOCKED (INTERRUPTED) with one crash resume counted, and its receipt names the decision;
 *   - after the operator decides and the job is resumed, exactly one more inference happens and nothing is VERIFIED.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadJobOperation, readReceipt, submitRequest } from "../src/core/job_runner.js";
import { sameProcess, signalProcess } from "../src/core/process_identity.js";
import { isSandboxAvailable } from "../src/sandbox.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { runnerWorld, startedJobId, until } from "./helpers/runner_fixture.js";

function find(dir: string, name: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile() && entry.name === name).map((entry) => path.join(entry.parentPath, entry.name));
}

test("kill the worker mid-tool-call: the runner resumes the job, nothing is replayed, and it never ends verified", { timeout: 290_000, skip: isSandboxAvailable("auto") ? false : "worktree-write needs a sandbox engine" }, async () => {
  const world = runnerWorld();
  // The command is one the operator allowed by rule; nothing else may run in an unattended job.
  const repo = makeRepo({ "counter.sh": "echo ran >> counter.txt\nexec sleep 300\n" });
  fs.mkdirSync(path.join(world.home, ".config", "nexus"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(world.home, ".config", "nexus", "command_rules.json"), JSON.stringify({ version: 1, rules: [{ prefix: ["sh", "counter.sh"], decision: "allow", match: ["sh counter.sh"] }] }), { mode: 0o600 });
  const gw = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "run_command", args: { command: "sh counter.sh" } }] }
      : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "continued after inspection" } }] },
  );
  const counts = () => find(path.join(repo, ".nexus", "worktrees"), "counter.txt").reduce((n, file) => n + fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 0);
  const operation = (job: Parameters<typeof loadJobOperation>[0]) => {
    process.env.NEXUS_STATE_DIR = world.stateDir;
    try { return loadJobOperation(job)!; } finally { delete process.env.NEXUS_STATE_DIR; }
  };
  try {
    await world.startRunner();
    const started = await world.run(["job", "start", "--prompt", "Run the counter command.", "--allow-worktree-write", "-w", repo, "-e", gw.url, "-m", "m"]);
    assert.equal(started.code, 0, started.stderr);
    const id = startedJobId(started.stdout);
    await until(() => counts() === 1, 150_000, () => `the allowed command to be running\n${JSON.stringify(world.job(id))}\n${fs.existsSync(world.paths.stderr(id)) ? fs.readFileSync(world.paths.stderr(id), "utf8") : ""}`);
    assert.equal(gw.requests.length, 1);

    const first = world.job(id)!;
    assert.equal(first.state, "RUNNING");
    const worker = first.attempts[0];
    world.remember(worker.pid);
    assert.ok(world.survivors().length >= 2, "the worker and the command below it are running");
    assert.equal(signalProcess(worker, "SIGKILL"), true, "the worker is killed by pid after its start time was checked");
    await until(() => !sameProcess(worker), 30_000, () => "the worker to be gone");

    // The runner notices, counts one crash and starts a new attempt, which recovers instead of re-running.
    const blocked = await world.waitJob(id, ["BLOCKED", "COMPLETE", "FAILED", "CANCELLED", "TIMED_OUT"], 200_000);
    assert.equal(blocked.state, "BLOCKED", JSON.stringify(readReceipt(world.paths, id)));
    assert.equal(blocked.autoResumes, 1);
    assert.equal(blocked.attempts.length, 2);
    // The command the dead worker left running was stopped too: nothing of an attempt outlives it.
    await until(() => world.survivors().length === 0, 30_000, () => `the first attempt's processes to be gone: ${JSON.stringify(world.survivors())}`);
    assert.deepEqual(blocked.attempts[0].end, { code: null, signal: "SIGKILL", reason: "crashed" });
    assert.equal(counts(), 1, "recovery must not re-run the non-idempotent command");
    assert.equal(gw.requests.length, 1, "no inference before the operator decides");
    const receipt = readReceipt(world.paths, id)!;
    assert.equal(receipt.outcome, "BLOCKED");
    assert.equal(receipt.reason, "INTERRUPTED");
    assert.equal(receipt.unattended, true);
    assert.equal(receipt.attempts, 2);
    assert.equal(receipt.units[0].status, "BLOCKED");
    assert.equal(receipt.units[0].blocked?.cause, "INTERRUPTED");
    assert.match(receipt.units[0].blocked!.question, /may have partially run/);
    assert.equal(receipt.pending_decisions.length, 1);
    assert.match(receipt.pending_decisions[0].decide, new RegExp(`^nexus operation decide ${blocked.operationId} .* --no-resume -w `));

    // The operator inspects, decides, and resumes the job.
    const decision = operation(blocked).units[0].blocked!.decision;
    const option = decision.options.find((o) => o.label === "continue after inspection")!;
    const decided = await world.run(["operation", "decide", blocked.operationId, decision.id, option.id, "--no-resume", "-w", repo, "-e", gw.url, "-m", "m"]);
    assert.equal(decided.code, 0, decided.stderr);
    submitRequest(world.paths, { kind: "resume", jobId: id });
    await world.waitJob(id, ["QUEUED", "STARTING", "RUNNING"], 60_000);
    assert.equal(world.job(id)!.outcome, undefined);
    const ended = await world.waitJob(id, ["BLOCKED", "COMPLETE", "FAILED", "CANCELLED", "TIMED_OUT"], 200_000);
    assert.equal(counts(), 1, "continuing must not re-run the non-idempotent command");
    assert.equal(gw.requests.length, 2, "exactly one resumed inference");
    assert.match(JSON.stringify((gw.requests[1] as any).messages), /may have partially run/);
    assert.equal(ended.attempts.length, 3);
    assert.equal(ended.autoResumes, 1, "an operator resume is not a crash");
    const after = operation(ended);
    assert.notEqual(after.units[0].result?.outcome, "VERIFIED");
    assert.equal(ended.state, "BLOCKED", JSON.stringify(readReceipt(world.paths, id)));
    assert.notEqual(after.status, "COMPLETE");
    const final = readReceipt(world.paths, id)!;
    assert.equal(final.outcome, "BLOCKED");
    assert.ok(final.units.every((unit) => unit.outcome !== "VERIFIED"));
    assert.ok(fs.existsSync(path.join(world.paths.jobDir(id), "receipt.blocked-2.json")), "the first BLOCKED receipt is kept");
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
