/**
 * BG-3 / G-4 for triggered runs: "no allow-always, a fresh worktree, the unattended flag in receipts, and a
 * kill-and-resume pass", through a real runner and real workers. A trigger starts a job like any other, so the job's
 * rules hold; these tests show it, and show that a kill never makes a second job for the same event.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readReceipt } from "../src/core/job_runner.js";
import { listJobs, type JobRecord } from "../src/core/runner_store.js";
import { sameProcess, signalProcess } from "../src/core/process_identity.js";
import { readTriggerState, triggerStatePaths } from "../src/core/trigger_state.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { runnerWorld, stalledGateway, until, type RunnerWorld } from "./helpers/runner_fixture.js";
import { trustRepo } from "./helpers/schedule_fixture.js";
import { approveInRepo, fileSpec, hookPath, post, signed, webhookSpec } from "./helpers/trigger_fixture.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const triggerJobs = (world: RunnerWorld, id: string): JobRecord[] => listJobs(world.paths).jobs.filter((job) => job.origin.kind === "trigger" && job.origin.triggerId === id);
const state = (world: RunnerWorld) => readTriggerState(triggerStatePaths(world.paths));
const armed = (world: RunnerWorld, id: string) => until(() => state(world)?.triggers.find((t) => t.id === id && t.armed), 90_000, () => `trigger ${id} to be armed\n${JSON.stringify(state(world))}`);
const SECRET = "0123456789abcdef0123456789";

test("kill and resume a triggered run: the worker is resumed, the runner's restart adopts it, and the event is never fired twice", { timeout: 290_000 }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "src/a.ts": "a\n" }));
  const gw = await stalledGateway();
  const env = { LOCAL_LLM_ENDPOINT: gw.url, LOCAL_LLM_MODEL: "m" };
  try {
    await trustRepo(world, repo);
    approveInRepo(world, repo, [fileSpec("watch-src", ["src/**/*.ts"])]);
    const headAtApproval = git(repo, "rev-parse", "HEAD");
    let runner = await world.startRunner([], env);
    await armed(world, "watch-src");
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "changed\n");
    const job = await until(() => triggerJobs(world, "watch-src")[0], 120_000, () => `a triggered job\n${JSON.stringify(state(world))}`);
    await until(() => gw.requests.length >= 1 && world.job(job.id)?.state === "RUNNING", 150_000, () => `the job to be mid-inference\n${JSON.stringify(world.job(job.id))}`);
    assert.equal(job.origin.kind === "trigger" && job.origin.eventKind, "file-change");
    assert.equal(job.baseCommit, headAtApproval);
    assert.equal(job.policy, "read-only");
    assert.equal(job.unattended, true);
    const eventId = job.origin.kind === "trigger" ? job.origin.eventId : "";

    // More changes while it runs are dropped and counted (the loop guard), not queued.
    fs.writeFileSync(path.join(repo, "src", "b.ts"), "b\n");
    await until(() => state(world)?.triggers.find((t) => t.id === "watch-src")?.dropped.overlap, 60_000, () => `the overlap drop\n${JSON.stringify(state(world))}`);
    assert.equal(triggerJobs(world, "watch-src").length, 1);

    // The worker is killed with SIGKILL: the runner resumes the same job.
    const first = world.job(job.id)!.attempts[0];
    world.remember(first.pid);
    assert.equal(signalProcess(first, "SIGKILL"), true);
    const resumed = await until(() => {
      const record = world.job(job.id);
      return record && record.attempts.length >= 2 && !record.attempts[1].end && record.state !== "BLOCKED" ? record : undefined;
    }, 150_000, () => `a second attempt\n${JSON.stringify(world.job(job.id))}`);
    assert.equal(resumed.autoResumes, 1);
    assert.deepEqual(resumed.attempts[0].end, { code: null, signal: "SIGKILL", reason: "crashed" });
    assert.equal(sameProcess(first), false);
    assert.equal(triggerJobs(world, "watch-src").length, 1, "no duplicate job for the same event");

    // Then the runner itself dies: a new one adopts the worker, re-arms the trigger and fires nothing.
    await until(() => world.job(job.id)?.state === "RUNNING" && gw.requests.length >= 2, 150_000, () => "the resumed attempt to be mid-inference");
    const second = world.job(job.id)!.attempts[1];
    world.remember(second.pid);
    runner.proc.kill("SIGKILL");
    await runner.exited;
    assert.equal(sameProcess(second), true, "the worker outlives its runner");
    runner = await world.startRunner([], env);
    await armed(world, "watch-src");
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    assert.equal(triggerJobs(world, "watch-src").length, 1, "the restart fired nothing");
    assert.equal(world.job(job.id)!.attempts.length, 2);
    assert.equal(world.job(job.id)!.autoResumes, 1);
    const status = (await world.run(["triggers", "status", "watch-src", "-w", repo])).stdout;
    assert.match(status, new RegExp(`fired: 1; last .* job ${job.id} event ${eventId}`));

    const stopped = await world.run(["job", "stop", job.id]);
    assert.equal(stopped.code, 0, stopped.stderr);
    const ended = await world.waitJob(job.id, ["CANCELLED", "COMPLETE", "BLOCKED", "FAILED", "TIMED_OUT"], 120_000);
    assert.equal(ended.state, "CANCELLED");
    const receipt = readReceipt(world.paths, job.id)!;
    assert.equal(receipt.trigger_id, "watch-src");
    assert.deepEqual(receipt.trigger_event, { id: eventId, kind: "file-change", approved_sha256: job.origin.kind === "trigger" ? job.origin.approvedSha256 : "" });
    assert.equal(receipt.unattended, true);
    assert.equal(receipt.approval_mode, "read-only");
    assert.equal(receipt.attempts, 2);
    assert.equal(git(repo, "rev-parse", "HEAD"), headAtApproval);
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a triggered run is unattended in every way: no allow-always, read-only, a fresh worktree, and the checkout is untouched", { timeout: 290_000 }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "src/a.ts": "a\n" }));
  const command = { name: "run_command", args: { command: "touch ran.txt" } };
  const gw = await startGateway((n) => n === 1
    ? { kind: "tools", calls: [{ name: "write_file", args: { path: "made.txt", content: "x\n" } }, command, command] }
    : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "tried" } }] });
  try {
    await trustRepo(world, repo);
    approveInRepo(world, repo, [fileSpec("watch-src", ["src/**/*.ts"])]);
    await world.startRunner([], { LOCAL_LLM_ENDPOINT: gw.url, LOCAL_LLM_MODEL: "m" });
    await armed(world, "watch-src");
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "changed\n");
    const job = await until(() => triggerJobs(world, "watch-src")[0], 120_000, () => "a triggered job");
    const ended = await world.waitJob(job.id, ["BLOCKED", "COMPLETE", "FAILED", "CANCELLED", "TIMED_OUT"], 240_000);
    const results = ((gw.requests[1] as any).messages as any[]).filter((m) => m.role === "tool").map((m) => String(m.content));
    assert.equal(results.length, 3);
    assert.doesNotMatch(results[0], /^(Wrote|Written)/i, "a read-only job could not write: no write was approved");
    for (const result of results) assert.doesNotMatch(result, /Wrote|written successfully/i);
    for (const result of results.slice(1)) assert.match(result, /requires operator approval \(exec\), but no operator is present|read-only|not permitted|denied/i, "the same command twice: denied twice, nothing was remembered");
    assert.equal(fs.existsSync(path.join(repo, "made.txt")), false);
    assert.equal(fs.existsSync(path.join(repo, "ran.txt")), false);
    assert.deepEqual(git(repo, "status", "--porcelain").split("\n").map((l) => l.trim()).filter(Boolean), ["M src/a.ts"], "only the operator's own edit shows: nothing the job did, and no worktree files in the checkout");
    assert.match(ended.operationId, /^bg-[0-9a-f]{12}$/);
    const receipt = readReceipt(world.paths, job.id)!;
    assert.equal(receipt.unattended, true);
    assert.equal(receipt.policy, "read-only");
    assert.equal(receipt.approval_mode, "read-only");
    assert.equal(receipt.trigger_id, "watch-src");
    assert.equal(fs.existsSync(path.join(world.home, ".config", "nexus", "command_rules.json")), false, "nothing was written to the operator's command rules");
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a webhook through the real runner: bad and replayed deliveries start nothing, the good one starts one job, and the worker does not inherit the secret", { timeout: 290_000 }, async () => {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "README.md": "hello\n" }));
  const gw = await stalledGateway();
  try {
    await trustRepo(world, repo);
    approveInRepo(world, repo, [webhookSpec("hook", "NEXUS_TRIGGER_TEST_HOOK")]);
    await world.startRunner(["--webhook-port", "0"], { LOCAL_LLM_ENDPOINT: gw.url, LOCAL_LLM_MODEL: "m", NEXUS_TRIGGER_TEST_HOOK: SECRET });
    await armed(world, "hook");
    const listener = await until(() => state(world)?.listener, 30_000, () => "the listener");
    assert.equal(listener.host, "127.0.0.1");
    const url = hookPath(repo, "hook");
    const body = '{"x":1}';
    assert.equal(((await post(listener.port, url, body, signed("wrong-wrong-wrong-wrong-wrong", url, body))) as any).status, 401);
    assert.equal(((await post(listener.port, url, body, { ...signed(SECRET, url, body), "x-nexus-signature": "v1=" + "0".repeat(64) })) as any).status, 401);
    assert.equal(triggerJobs(world, "hook").length, 0);
    const good = signed(SECRET, url, body, { delivery: "delivery-0001" });
    assert.equal(((await post(listener.port, url, body, good)) as any).status, 202);
    assert.equal(((await post(listener.port, url, body, good)) as any).status, 401, "the same signed request again is a replay");
    const job = await until(() => triggerJobs(world, "hook")[0], 60_000, () => "the job");
    assert.equal(triggerJobs(world, "hook").length, 1);
    await until(() => world.job(job.id)?.attempts[0], 150_000, () => "a worker");
    const environ = fs.readFileSync(`/proc/${world.job(job.id)!.attempts[0]!.pid}/environ`, "latin1");
    assert.match(environ, /LOCAL_LLM_ENDPOINT=/, "the worker has the operator's environment");
    assert.equal(environ.includes("NEXUS_TRIGGER_TEST_HOOK"), false, "and not the webhook secret");
    assert.equal(environ.includes(SECRET), false);
    const stopped = await world.run(["job", "stop", job.id]);
    assert.equal(stopped.code, 0, stopped.stderr);
    await world.waitJob(job.id, ["CANCELLED", "COMPLETE", "BLOCKED", "FAILED", "TIMED_OUT"], 120_000);
    const receipt = readReceipt(world.paths, job.id)!;
    assert.equal(receipt.trigger_event?.kind, "webhook");
    assert.equal((await world.run(["triggers", "status", "hook", "-w", repo])).stdout.includes(SECRET), false, "status never prints the secret");
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a runner with no approved triggers opens no listener and writes no trigger state, even with --webhook-port", { timeout: 120_000 }, async () => {
  const world = runnerWorld();
  try {
    const runner = await world.startRunner(["--webhook-port", "0"]);
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    assert.equal(fs.existsSync(triggerStatePaths(world.paths).dir), false);
    // /proc/<pid>/net/tcp lists the whole network namespace: keep the listening sockets whose inode this process holds.
    const held = new Set(fs.readdirSync(`/proc/${runner.proc.pid}/fd`).map((fd) => { try { return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${runner.proc.pid}/fd/${fd}`))?.[1]; } catch { return undefined; } }).filter(Boolean));
    const listening = fs.readFileSync(`/proc/${runner.proc.pid}/net/tcp`, "utf8").split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((cols) => cols[3] === "0A" && held.has(cols[9]!));
    assert.deepEqual(listening, [], "no listening TCP socket");
  } finally { await world.cleanup(); }
});
