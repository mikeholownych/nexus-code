/**
 * BG-1 acceptance, part 1: "kill the CLI; the run continues". A runner process, a client `nexus job start --wait`
 * that is killed with SIGKILL while the job is mid-inference, and the job still reaches its end against the scripted
 * gateway. The worker was never a descendant of the client, and the receipt says the run was unattended.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { jobReceiptSchemaFile, jobStatusSchemaFile } from "../scripts/gen_job_receipt_schema.mjs";
import { JOB_RECEIPT_SCHEMA_VERSION, JOB_STATUS_SCHEMA_VERSION } from "../src/core/job_receipt.js";
import { loadJobOperation, readReceipt } from "../src/core/job_runner.js";
import { descendants, sameProcess } from "../src/core/process_identity.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { validate } from "./helpers/json_schema.js";
import { runnerWorld, until } from "./helpers/runner_fixture.js";

const receiptSchema = JSON.parse(fs.readFileSync(jobReceiptSchemaFile(JOB_RECEIPT_SCHEMA_VERSION), "utf8"));
const statusSchema = JSON.parse(fs.readFileSync(jobStatusSchemaFile(JOB_STATUS_SCHEMA_VERSION), "utf8"));

test("kill the client CLI: the job continues and completes, in its own process tree, with an unattended receipt", { timeout: 280_000 }, async () => {
  const world = runnerWorld();
  const repo = makeRepo({ "README.md": "the fact is 42\n" });
  // The first reply is slow, so the client is certainly killed while the job is still working.
  const gw = await startGateway((n) =>
    n === 1
      ? { kind: "tools", calls: [{ name: "read_file", args: { path: "README.md" } }], delayMs: 4_000 }
      : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "README.md says the fact is 42" } }] },
  );
  try {
    await world.startRunner();
    const client = world.spawn(["job", "start", "--prompt", "Read README.md and report the fact it states.", "-w", repo, "-e", gw.url, "-m", "m", "--wait"]);
    const id = await until(() => /^job-[0-9a-f]{12}$/m.exec(client.stdout())?.[0], 90_000, () => `the client to print a job id\n${client.stderr()}`);
    await until(() => gw.requests.length >= 1, 120_000, () => `the job's first inference\n${JSON.stringify(world.job(id))}`);

    const running = world.job(id)!;
    assert.ok(["STARTING", "RUNNING"].includes(running.state), running.state);
    const worker = running.attempts[0];
    assert.equal(sameProcess(worker), true, "the worker is the recorded process");
    assert.equal(descendants([client.proc.pid!]).includes(worker.pid), false, "the worker is not below the client");

    client.proc.kill("SIGKILL");
    assert.equal((await client.exited).signal, "SIGKILL");
    assert.equal(sameProcess(worker), true, "killing the client did not reach the worker");
    assert.equal(world.job(id)!.outcome, undefined, "the job had not ended when the client died");

    const ended = await world.waitJob(id, ["COMPLETE", "BLOCKED", "FAILED", "CANCELLED", "TIMED_OUT"]);
    assert.equal(ended.state, "COMPLETE", JSON.stringify(readReceipt(world.paths, id)));
    assert.equal(ended.attempts.length, 1);
    assert.equal(ended.autoResumes, 0);
    assert.deepEqual(ended.attempts[0].end, { code: 0, signal: null, reason: "exited" });
    assert.equal(gw.requests.length, 2);

    const receipt = readReceipt(world.paths, id)!;
    assert.deepEqual(validate(receipt, receiptSchema, receiptSchema), []);
    assert.equal(receipt.unattended, true);
    assert.equal(receipt.outcome, "COMPLETE");
    assert.equal(receipt.approval_mode, "read-only");
    assert.equal(receipt.policy, "read-only");
    assert.equal(receipt.job_id, id);
    assert.equal(fs.statSync(world.paths.receipt(id)).mode & 0o777, 0o600);

    // The operation carries the stamp too, and `job status` works with no client left from the start.
    process.env.NEXUS_STATE_DIR = world.stateDir;
    try {
      const operation = loadJobOperation(ended)!;
      assert.deepEqual(operation.origin, { kind: "job", jobId: id, unattended: true });
      // An in-process wait of the operation can never outlive the job (the default would be twelve hours).
      assert.ok(operation.policy.maxWaitMs <= 120 * 60_000, String(operation.policy.maxWaitMs));
    } finally {
      delete process.env.NEXUS_STATE_DIR;
    }
    const status = await world.run(["job", "status", id, "--json"]);
    assert.equal(status.code, 0, status.stderr);
    const shown = JSON.parse(status.stdout);
    assert.deepEqual(validate(shown, statusSchema, statusSchema), []);
    assert.equal(shown.schema_version, JOB_STATUS_SCHEMA_VERSION);
    assert.equal(shown.job.state, "COMPLETE");
    assert.equal(shown.receipt.unattended, true);
    assert.deepEqual(shown.operation.origin, { kind: "job", jobId: id, unattended: true });
  } finally {
    await world.cleanup();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
