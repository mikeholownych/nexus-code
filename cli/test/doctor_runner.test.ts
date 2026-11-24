/** BG-1: doctor reports runner liveness, version, unit safety and stranded jobs from an isolated HOME. */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runnerWorld } from "./helpers/runner_fixture.js";
import { DEFAULT_JOB_BUDGETS, newJobIds, newJobRecord, writeJob } from "../src/core/runner_store.js";

const findings = (stdout: string): Map<string, any> => {
  const report = JSON.parse(stdout);
  return new Map(report.findings.map((item: any) => [item.id, item]));
};

test("doctor marks the optional runner absent and reports no stranded jobs", async () => {
  const world = runnerWorld();
  try {
    const result = await world.run(["doctor", "--json", "--timeout", "1000"]);
    const checks = findings(result.stdout);
    assert.equal(checks.get("runner.alive")?.status, "skip");
    assert.equal(checks.get("runner.version")?.status, "skip");
    assert.equal(checks.get("runner.unit")?.status, "skip");
    assert.equal(checks.get("runner.stuck")?.status, "pass");
  } finally {
    await world.cleanup();
  }
});

test("doctor identifies a non-terminal job with no live runner or worker", async () => {
  const world = runnerWorld();
  try {
    const ids = newJobIds();
    const record = newJobRecord({
      ...ids,
      workspace: world.root,
      baseCommit: "a".repeat(40),
      specSha256: "b".repeat(64),
      origin: { kind: "cli" },
      unattended: true,
      policy: "read-only",
      verifier: null,
      deliverables: [],
      provider: {},
      budgets: { ...DEFAULT_JOB_BUDGETS },
    }, new Date("2026-11-24T12:00:00.000Z"));
    writeJob(world.paths, record);
    const result = await world.run(["doctor", "--json", "--timeout", "1000"]);
    const check = findings(result.stdout).get("runner.stuck");
    assert.equal(check?.status, "warn");
    assert.ok(check.evidence.some((item: string) => item.includes(record.id)), "the evidence names the stranded job");
  } finally {
    await world.cleanup();
  }
});

test("doctor rejects an unsafe systemd runner unit", async () => {
  const world = runnerWorld();
  try {
    const unit = path.join(world.home, ".config", "systemd", "user", "nexus-runner.service");
    fs.mkdirSync(path.dirname(unit), { recursive: true, mode: 0o700 });
    fs.writeFileSync(unit, "[Service]\nExecStart=/tmp/nexus\n", { mode: 0o600 });
    fs.chmodSync(unit, 0o666);
    const result = await world.run(["doctor", "--json", "--timeout", "1000"]);
    assert.notEqual(result.code, 0);
    assert.equal(findings(result.stdout).get("runner.unit")?.status, "fail");
  } finally {
    await world.cleanup();
  }
});

test("doctor recognizes a live runner and its current version", async () => {
  const world = runnerWorld();
  let runner;
  try {
    runner = await world.startRunner();
    const result = await world.run(["doctor", "--json", "--timeout", "1000"]);
    const checks = findings(result.stdout);
    assert.equal(checks.get("runner.alive")?.status, "pass");
    assert.equal(checks.get("runner.version")?.status, "pass");
    assert.equal(checks.get("runner.stuck")?.status, "pass");
  } finally {
    if (runner && runner.proc.exitCode === null) runner.proc.kill("SIGTERM");
    await world.cleanup();
  }
});
