/**
 * BG-1: the runner is killed while a job runs. Outside systemd the worker survives (it is in its own session), and a
 * new runner adopts it: it finds the worker's kernel lock held and its recorded identity alive, starts no second
 * driver, and settles the job when the worker ends. When the worker died too, the job takes the crash path.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readReceipt, runnerAlive } from "../src/core/job_runner.js";
import { sameProcess, signalProcess } from "../src/core/process_identity.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { runnerWorld, stalledGateway, startedJobId, until } from "./helpers/runner_fixture.js";

test("a new runner adopts the surviving worker of a killed runner; the job completes once, driven once", { timeout: 290_000 }, async () => {
  const world = runnerWorld();
  const repo = makeRepo({ "README.md": "base\n" });
  // Slow enough that the worker is still mid-inference when the second runner is up.
  const gw = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "read_file", args: { path: "README.md" } }], delayMs: 30_000 }
      : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "read it" } }] },
  );
  try {
    const first = await world.startRunner();
    const started = await world.run(["job", "start", "--prompt", "Read README.md.", "-w", repo, "-e", gw.url, "-m", "m"]);
    assert.equal(started.code, 0, started.stderr);
    const id = startedJobId(started.stdout);
    await until(() => gw.requests.length >= 1, 120_000, () => `the job's first inference\n${JSON.stringify(world.job(id))}`);
    const worker = world.job(id)!.attempts[0];

    first.proc.kill("SIGKILL");
    assert.equal((await first.exited).signal, "SIGKILL");
    assert.equal(runnerAlive(world.paths), false, "the kernel released the dead runner's lock");
    assert.equal(sameProcess(worker), true, "the worker outlives its runner");

    const second = await world.startRunner();
    await until(() => /adopted its running worker/.test(second.stderr()), 60_000, () => `the new runner to adopt the worker\n${second.stderr()}`);
    assert.match(second.stderr(), new RegExp(`job ${id}: adopted its running worker \\(pid ${worker.pid}\\)`));
    assert.equal(sameProcess(worker), true);
    assert.equal(world.job(id)!.attempts.length, 1, "no second driver was started");

    const ended = await world.waitJob(id, ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"]);
    assert.equal(ended.state, "COMPLETE", JSON.stringify(readReceipt(world.paths, id)));
    assert.equal(ended.attempts.length, 1);
    assert.equal(ended.autoResumes, 0);
    assert.equal(ended.attempts[0].pid, worker.pid);
    assert.equal(gw.requests.length, 2, "the model was asked once per step, by one driver");
    assert.equal(readReceipt(world.paths, id)!.attempts, 1);
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("when the worker died with the runner, the new runner finds its lock free and resumes the job as a crash", { timeout: 290_000 }, async () => {
  const world = runnerWorld();
  const repo = makeRepo({ "README.md": "base\n" });
  const gw = await stalledGateway();
  try {
    const first = await world.startRunner();
    const started = await world.run(["job", "start", "--prompt", "Read README.md.", "-w", repo, "-e", gw.url, "-m", "m"]);
    assert.equal(started.code, 0, started.stderr);
    const id = startedJobId(started.stdout);
    await until(() => gw.requests.length >= 1, 120_000, () => `the job's first inference\n${JSON.stringify(world.job(id))}`);
    const worker = world.job(id)!.attempts[0];
    world.remember(worker.pid);

    first.proc.kill("SIGKILL");
    await first.exited;
    assert.equal(signalProcess(worker, "SIGKILL"), true);
    await until(() => !sameProcess(worker), 30_000, () => "the worker to be gone");

    await world.startRunner();
    const resumed = await until(() => { const job = world.job(id)!; return job.attempts.length === 2 ? job : undefined; }, 120_000, () => `the job to be resumed\n${JSON.stringify(world.job(id))}`);
    assert.equal(resumed.attempts[0].end?.reason, "crashed");
    assert.equal(resumed.autoResumes, 1);
    assert.notEqual(resumed.attempts[1].pid, worker.pid);
    const stop = await world.run(["job", "stop", id]);
    assert.ok([0, 1].includes(stop.code ?? -1), stop.stderr);
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
