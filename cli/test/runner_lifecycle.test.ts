/**
 * BG-1: the runner's life and its inbox. As real processes: one runner per state directory (the second exits 3 and
 * names the first), a client refuses when no runner serves, a runner stopped with SIGTERM cancels its job cleanly and
 * the next runner continues it, and `nexus job stop` ends a job as CANCELLED. As a library with stand-in workers:
 * what the runner refuses from its inbox and why, the queue and concurrency bounds, and how a worker's result becomes
 * the job's outcome.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadJobOperation, readReceipt, readRunnerInfo, requestRefusal, runnerAlive, specDigest, submitRequest } from "../src/core/job_runner.js";
import { newOperation } from "../src/core/operation.js";
import { sameProcess } from "../src/core/process_identity.js";
import { ensureRunnerTree, MAX_QUEUED_JOBS, parseJobSpecFile, RUNNER_FILE_VERSION, writePrivateJson } from "../src/core/runner_store.js";
import { makeRepo } from "./helpers/fixtures.js";
import { bench, runnerWorld, stalledGateway, startedJobId, until, type StandIn } from "./helpers/runner_fixture.js";

const mode = (file: string) => fs.lstatSync(file).mode & 0o777;

test("one runner per state directory; a client refuses without one; SIGTERM cancels cleanly, the next runner resumes, and job stop cancels", { timeout: 290_000 }, async () => {
  const world = runnerWorld();
  const repo = makeRepo({ "README.md": "base\n" });
  // No chat request is ever answered: the job is always mid-inference when it is stopped.
  const gw = await stalledGateway();
  const start = ["job", "start", "--prompt", "Read README.md.", "-w", repo, "-e", gw.url, "-m", "m"];
  try {
    const refused = await world.run(start);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /no runner is running; start it with `systemctl --user start nexus-runner` or run `nexus runner serve`/);
    assert.equal(fs.existsSync(world.paths.root), false, "a refused client leaves no state behind");

    const first = await world.startRunner();
    for (const dir of [world.paths.root, world.paths.inbox, world.paths.rejected, world.paths.jobs]) assert.equal(mode(dir), 0o700, dir);
    assert.equal(mode(world.paths.runnerJson), 0o600);
    assert.equal(mode(world.paths.guard), 0o600);
    const info = readRunnerInfo(world.paths)!;
    assert.equal(info.pid, first.proc.pid);
    assert.equal(sameProcess(info), true);

    const second = await world.run(["runner", "serve"]);
    assert.equal(second.code, 3, second.stderr);
    assert.match(second.stderr, new RegExp(`A runner is already serving this state directory \\(pid ${first.proc.pid}\\)`));
    assert.equal(runnerAlive(world.paths), true, "the first runner still holds the lock");

    const started = await world.run(start);
    assert.equal(started.code, 0, started.stderr);
    const id = startedJobId(started.stdout);
    await until(() => gw.requests.length >= 1, 120_000, () => `the job's first inference\n${JSON.stringify(world.job(id))}`);
    const worker = world.job(id)!.attempts[0];
    for (const file of [world.paths.job(id), world.paths.spec(id), world.paths.workerGuard(id), world.paths.workerJson(id), world.paths.events(id), world.paths.stderr(id)]) assert.equal(mode(file), 0o600, file);
    assert.equal(mode(world.paths.jobDir(id)), 0o700);

    // systemd stop: SIGTERM to the runner. It stops its worker, records why, and exits 0.
    first.proc.kill("SIGTERM");
    assert.deepEqual(await first.exited, { code: 0, signal: null });
    assert.equal(sameProcess(worker), false, "the worker ended with the runner");
    assert.equal(runnerAlive(world.paths), false);
    const stopped = world.job(id)!;
    assert.equal(stopped.outcome, undefined, "the job is not over");
    assert.deepEqual(stopped.attempts[0].end, { code: 130, signal: null, reason: "runner_stop" });
    process.env.NEXUS_STATE_DIR = world.stateDir;
    try { assert.equal(loadJobOperation(stopped)!.status, "CANCELLED", "the operation was cancelled, not abandoned"); } finally { delete process.env.NEXUS_STATE_DIR; }

    // A new runner continues the job without counting a crash.
    await world.startRunner();
    const resumed = await until(() => { const job = world.job(id)!; return job.attempts.length === 2 ? job : undefined; }, 120_000, () => `the job to be resumed\n${JSON.stringify(world.job(id))}`);
    assert.equal(resumed.autoResumes, 0);
    // The operation layer decides what a resumed unit does. A unit that had changed nothing lost its clean worktree
    // when the operation was cancelled, and asks before it starts over; otherwise it continues. Either way the job
    // was continued by the runner, not failed, and a blocked one names the decision.
    const seenBefore = gw.requests.length;
    await until(() => gw.requests.length > seenBefore || world.job(id)!.outcome !== undefined, 150_000, () => `a resumed inference or an outcome\n${JSON.stringify(world.job(id))}`);
    const continued = world.job(id)!;
    assert.ok(["STARTING", "RUNNING", "BLOCKED"].includes(continued.state), continued.state);
    if (continued.state === "BLOCKED") assert.equal(readReceipt(world.paths, id)!.pending_decisions.length, 1);

    // `nexus job stop` on a job that is mid-inference.
    const seen = gw.requests.length;
    const other = await world.run(start);
    assert.equal(other.code, 0, other.stderr);
    const otherId = startedJobId(other.stdout);
    await until(() => gw.requests.length > seen, 150_000, () => `the second job's inference\n${JSON.stringify(world.job(otherId))}`);
    const stop = await world.run(["job", "stop", otherId]);
    assert.equal(stop.code, 0, stop.stderr + stop.stdout);
    const cancelled = world.job(otherId)!;
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(cancelled.attempts[0].end?.reason, "stopped");
    assert.equal(sameProcess(cancelled.attempts[0]), false);
    const receipt = readReceipt(world.paths, otherId)!;
    assert.deepEqual({ outcome: receipt.outcome, reason: receipt.reason, unattended: receipt.unattended, attempts: receipt.attempts }, { outcome: "CANCELLED", reason: "STOPPED", unattended: true, attempts: 1 });
    assert.equal((await world.run(["job", "status", "job-000000000000"])).code, 1);
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the inbox: a request the runner cannot trust is moved aside with the reason and never becomes a job", async () => {
  const repo = makeRepo();
  const b = bench(repo);
  try {
    const runner = b.runner();
    runner.start();
    const request = (name: string, body: unknown, fileMode = 0o600) => {
      const file = path.join(b.paths.inbox, `${name}.json`);
      fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body), { mode: fileMode });
      fs.chmodSync(file, fileMode);
      return name;
    };
    const document = (id: string, change: (r: any) => void = () => {}) => {
      const { job, spec } = b.submission();
      const r: any = { format: "nexus-runner-request", version: RUNNER_FILE_VERSION, id, at: new Date().toISOString(), kind: "start", job, spec };
      change(r);
      return r;
    };
    const cases: Array<[string, RegExp]> = [];
    const add = (id: string, why: RegExp, body: unknown, fileMode?: number) => { cases.push([request(id, body, fileMode), why]); };
    add("req-0000000000000001", /has unsafe permissions \(644\); expected 600/, document("req-0000000000000001"), 0o644);
    add("req-0000000000000002", /request\.job: unknown key 'approval'/, document("req-0000000000000002", (r) => { r.job.approval = "auto"; }));
    add("req-0000000000000003", /request\.job\.policy must be one of read-only, worktree-write/, document("req-0000000000000003", (r) => { r.job.policy = "full-access"; }));
    add("req-0000000000000004", /request\.job\.unattended must be true/, document("req-0000000000000004", (r) => { r.job.unattended = false; }));
    add("req-0000000000000005", /a job always runs in a fresh worktree; 'git\.isolate: false' is refused/, document("req-0000000000000005", (r) => { r.spec.git = { isolate: false }; }));
    add("req-0000000000000010", /the spec is not in its job form/, document("req-0000000000000010", (r) => { delete r.spec.git; r.job.specSha256 = specDigest(r.spec); }));
    add("req-0000000000000006", /the spec does not match its recorded digest/, document("req-0000000000000006", (r) => { r.spec.objective = "something else"; }));
    add("req-0000000000000007", /the request id does not match its file name/, document("req-0000000000000008"));
    add("req-0000000000000009", /duplicate key "kind"/, `{"kind":"stop",${JSON.stringify(document("req-0000000000000009")).slice(1)}`);
    add("req-000000000000000a", /request: unknown key 'alwaysApprove'/, document("req-000000000000000a", (r) => { r.alwaysApprove = true; }));
    add("req-000000000000000b", /unknown spec key 'sandbox'/, document("req-000000000000000b", (r) => { r.spec.sandbox = "none"; r.job.specSha256 = specDigest(r.spec); }));
    add("req-000000000000000c", /there is no job job-000000000000/, { format: "nexus-runner-request", version: RUNNER_FILE_VERSION, id: "req-000000000000000c", at: new Date().toISOString(), kind: "stop", jobId: "job-000000000000" });
    add("req-000000000000000d", /unsupported version 2/, document("req-000000000000000d", (r) => { r.version = 2; }));
    // A link into the inbox is refused whatever it points at.
    const target = path.join(b.root, "elsewhere.json");
    fs.writeFileSync(target, JSON.stringify(document("req-000000000000000e")), { mode: 0o600 });
    fs.symlinkSync(target, path.join(b.paths.inbox, "req-000000000000000e.json"));
    cases.push(["req-000000000000000e", /must not be a symbolic link/]);
    // Not a request name: left alone, as a client's temporary file is.
    fs.writeFileSync(path.join(b.paths.inbox, "req-0000000000000001.json.1234.tmp"), "{", { mode: 0o600 });

    runner.tick();
    for (const [id, why] of cases) {
      assert.match(requestRefusal(b.paths, id) ?? "(accepted)", why, id);
      assert.equal(fs.existsSync(path.join(b.paths.inbox, `${id}.json`)), false, `${id} left the inbox`);
      assert.equal(mode(path.join(b.paths.rejected, `${id}.json.why`)), 0o600);
    }
    assert.deepEqual(fs.readdirSync(b.paths.jobs), [], "no refused request became a job");
    assert.equal(b.workers.length, 0);
    assert.deepEqual(fs.readdirSync(b.paths.inbox).sort(), ["rejected", "req-0000000000000001.json.1234.tmp"]);

    // The same document, untouched, is accepted.
    const good = document("req-00000000000000ff");
    request("req-00000000000000ff", good);
    runner.tick();
    assert.equal(requestRefusal(b.paths, "req-00000000000000ff"), undefined);
    assert.equal(b.job(good.job.id).state, "STARTING");
    assert.equal(JSON.parse(fs.readFileSync(b.paths.spec(good.job.id), "utf8")).specSha256, good.job.specSha256);
    // Replaying the exact submission after the record committed is idempotent and never starts another worker.
    const workerCount = b.workers.length;
    request("req-00000000000000fe", { ...good, id: "req-00000000000000fe" });
    runner.tick();
    assert.equal(requestRefusal(b.paths, "req-00000000000000fe"), undefined);
    assert.equal(b.workers.length, workerCount);

    // Simulate a crash after spec.json was atomically written but before job.json. The inbox request survives too.
    const partial = b.submission();
    fs.mkdirSync(b.paths.jobDir(partial.job.id), { mode: 0o700 });
    writePrivateJson(b.paths.spec(partial.job.id), parseJobSpecFile({
      format: "nexus-job-spec", version: RUNNER_FILE_VERSION, jobId: partial.job.id, specSha256: partial.job.specSha256, spec: partial.spec,
    }));
    const partialRequest = submitRequest(b.paths, { kind: "start", job: partial.job, spec: partial.spec });
    runner.tick();
    assert.equal(requestRefusal(b.paths, partialRequest), undefined);
    assert.equal(b.job(partial.job.id).state, "QUEUED");
    assert.match(b.log.join("\n"), /recovered its interrupted submission/);

    const partialWrite = b.submission();
    fs.mkdirSync(b.paths.jobDir(partialWrite.job.id), { mode: 0o700 });
    const tempSpec = path.join(b.paths.jobDir(partialWrite.job.id), "spec.json.12345678-1234-1234-1234-123456789abc.tmp");
    fs.writeFileSync(tempSpec, "{\"incomplete\":", { mode: 0o600 });
    const partialWriteRequest = submitRequest(b.paths, { kind: "start", job: partialWrite.job, spec: partialWrite.spec });
    runner.tick();
    assert.equal(requestRefusal(b.paths, partialWriteRequest), undefined);
    assert.equal(b.job(partialWrite.job.id).state, "QUEUED");
    assert.equal(fs.existsSync(tempSpec), false, "only the interrupted atomic temporary file is removed");
  } finally {
    await b.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("bounds and outcomes: jobs run up to --max-jobs, the queue holds 32, a queued job can be stopped, and a worker's result is the job's outcome", async () => {
  const repo = makeRepo();
  const b = bench(repo);
  try {
    assert.throws(() => b.runner({ maxJobs: 5 }), /--max-jobs must be an integer from 1 to 4/);
    assert.throws(() => b.runner({ maxJobs: 0 }), /--max-jobs/);
    const results: Record<string, ReturnType<StandIn>["result"]> = {};
    const noEvidence = new Set<string>();
    const runner = b.runner({
      maxJobs: 2,
      standIn: (job) => (results[job.id] ? { command: ["true"], result: results[job.id] } : { command: ["sleep", "300"] }),
      loadOperation: (job) => {
        if (noEvidence.has(job.id) || results[job.id]?.operationStatus !== "COMPLETE") return undefined;
        const operation = newOperation(job.operationId, "fixture", [{ id: "task", title: "task", role: "researcher", prompt: "look" }], [], Date.now());
        operation.status = "COMPLETE";
        operation.units[0].status = "COMPLETE";
        operation.units[0].result = { summary: "verified in fixture", completedAt: new Date().toISOString(), resourceId: "fixture", outcome: "VERIFIED" };
        return operation;
      },
    });
    runner.start();
    ensureRunnerTree(b.paths.root);

    const ids = Array.from({ length: MAX_QUEUED_JOBS + 3 }, () => b.submit());
    runner.tick();
    const states = () => ids.map((id) => { try { return b.job(id).state; } catch { return "REFUSED"; } });
    assert.equal(states().filter((s) => s === "STARTING").length, 2, "two run at once");
    assert.equal(states().filter((s) => s === "QUEUED").length, MAX_QUEUED_JOBS - 2);
    assert.equal(states().filter((s) => s === "REFUSED").length, 3, "the queue holds 32");
    assert.equal(b.workers.length, 2);
    assert.match(fs.readdirSync(b.paths.rejected).filter((n) => n.endsWith(".why")).map((n) => fs.readFileSync(path.join(b.paths.rejected, n), "utf8")).join(""), /the queue is full \(32 jobs\)/);

    // A queued job is stopped without ever having a worker.
    const queued = ids.find((id) => states()[ids.indexOf(id)] === "QUEUED")!;
    submitRequest(b.paths, { kind: "stop", jobId: queued });
    runner.tick();
    assert.equal(b.job(queued).state, "CANCELLED");
    assert.equal(b.job(queued).attempts.length, 0);
    assert.equal(readReceipt(b.paths, queued)!.outcome, "CANCELLED");

    // A running one is stopped by signal, and the slot it frees goes to the next queued job.
    const running = b.workers[0].jobId;
    submitRequest(b.paths, { kind: "stop", jobId: running });
    await b.drive(runner, () => b.job(running).state === "CANCELLED");
    assert.deepEqual(b.job(running).attempts[0].end, { code: null, signal: "SIGTERM", reason: "stopped" });
    await b.drive(runner, () => b.workers.length === 3);

    // What a worker reports becomes the job's outcome.
    const outcome = async (result: NonNullable<ReturnType<StandIn>["result"]>, missing = false) => {
      const { job, spec } = b.submission();
      results[job.id] = result;
      if (missing) noEvidence.add(job.id);
      // Room for it: the stand-ins of the earlier jobs are stopped first.
      for (const other of b.workers.filter((w) => w.child.exitCode === null && w.child.signalCode === null)) submitRequest(b.paths, { kind: "stop", jobId: other.jobId });
      for (const other of ids) if (states()[ids.indexOf(other)] === "QUEUED") submitRequest(b.paths, { kind: "stop", jobId: other });
      submitRequest(b.paths, { kind: "start", job, spec });
      await b.drive(runner, () => { try { return b.job(job.id).outcome !== undefined; } catch { return false; } });
      return { job: b.job(job.id), receipt: readReceipt(b.paths, job.id)! };
    };
    const complete = await outcome({ operationStatus: "COMPLETE", exit: 0 });
    assert.deepEqual([complete.job.state, complete.receipt.outcome, complete.job.attempts[0].end?.reason], ["COMPLETE", "COMPLETE", "exited"]);
    const unproven = await outcome({ operationStatus: "COMPLETE", exit: 0 }, true);
    assert.deepEqual([unproven.job.state, unproven.receipt.reason], ["FAILED", "COMPLETION_EVIDENCE_MISSING"]);
    const blocked = await outcome({ operationStatus: "BLOCKED", exit: 2 });
    assert.deepEqual([blocked.job.state, blocked.receipt.outcome], ["BLOCKED", "BLOCKED"]);
    const noSandbox = await outcome({ operationStatus: null, exit: 2, error: { reason: "SANDBOX_UNAVAILABLE", message: "no sandbox engine" } });
    assert.deepEqual([noSandbox.job.state, noSandbox.receipt.reason, noSandbox.receipt.summary], ["BLOCKED", "SANDBOX_UNAVAILABLE", "BLOCKED: no sandbox engine; nothing was merged."]);
    const clamp = await outcome({ operationStatus: null, exit: 1, error: { reason: "UNATTENDED_CLAMP", message: "Refusing to start an unattended run: full access is on." } });
    assert.deepEqual([clamp.job.state, clamp.receipt.reason], ["FAILED", "UNATTENDED_CLAMP"]);
    const paused = await outcome({ operationStatus: "PAUSED", exit: 2 });
    assert.deepEqual([paused.job.state, paused.receipt.reason], ["FAILED", "OPERATION_PAUSED"]);

    // Only a BLOCKED job can be resumed, and resuming requeues it without its old outcome.
    const no = submitRequest(b.paths, { kind: "resume", jobId: complete.job.id });
    const yes = submitRequest(b.paths, { kind: "resume", jobId: blocked.job.id });
    results[blocked.job.id] = { operationStatus: "COMPLETE", exit: 0 };
    await b.drive(runner, () => b.job(blocked.job.id).state === "COMPLETE");
    assert.match(requestRefusal(b.paths, no)!, /is COMPLETE; only a BLOCKED job can be resumed/);
    assert.equal(requestRefusal(b.paths, yes), undefined);
    assert.equal(b.job(blocked.job.id).attempts.length, 2);
    assert.equal(b.job(blocked.job.id).autoResumes, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(b.paths.jobDir(blocked.job.id), "receipt.blocked-1.json"), "utf8")).outcome, "BLOCKED");
    assert.equal(b.job(complete.job.id).state, "COMPLETE");
  } finally {
    await b.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
