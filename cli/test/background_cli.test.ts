/** BG-1: the operator commands for the detached runner never alter the live user's service or state in tests. */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runnerWorld } from "./helpers/runner_fixture.js";
import { DEFAULT_JOB_BUDGETS, newJobIds, newJobRecord, writeJob } from "../src/core/runner_store.js";

test("runner status and job list report the empty isolated state", async () => {
  const world = runnerWorld();
  try {
    const status = await world.run(["runner", "status", "--json"]);
    assert.equal(status.code, 1);
    assert.deepEqual(JSON.parse(status.stdout), { alive: false });
    const jobs = await world.run(["job", "list", "--json"]);
    assert.equal(jobs.code, 0, jobs.stderr);
    assert.deepEqual(JSON.parse(jobs.stdout), { jobs: [], invalid: [] });
  } finally {
    await world.cleanup();
  }
});

test("install-unit prints a correctly escaped unit, writes it privately, and refuses to overwrite", async () => {
  const world = runnerWorld();
  try {
    const bin = path.join(world.home, "bin");
    fs.mkdirSync(bin, { mode: 0o700 });
    const launcher = path.join(bin, "nexus % client");
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const expected = [
      "[Unit]",
      "Description=Nexus Code detached job runner",
      "[Service]",
      "Type=simple",
      `ExecStart=\"${launcher.replace(/%/g, "%%")}\" runner serve`,
      "Restart=on-failure",
      "RestartSec=5",
      "UMask=0077",
      "NoNewPrivileges=yes",
      "TimeoutStopSec=60",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    const printed = await world.run(["runner", "install-unit", "--exec", launcher, "--print"]);
    assert.equal(printed.code, 0, printed.stderr);
    assert.equal(printed.stdout, expected);
    assert.equal(fs.existsSync(path.join(world.home, ".config", "systemd", "user", "nexus-runner.service")), false);

    const written = await world.run(["runner", "install-unit", "--exec", launcher]);
    assert.equal(written.code, 0, written.stderr);
    const unit = path.join(world.home, ".config", "systemd", "user", "nexus-runner.service");
    assert.equal(fs.readFileSync(unit, "utf8"), expected);
    assert.equal(fs.statSync(unit).mode & 0o777, 0o600);
    const overwrite = await world.run(["runner", "install-unit", "--exec", launcher]);
    assert.equal(overwrite.code, 2);
    assert.match(overwrite.stderr, /Refusing to overwrite/);
    assert.equal(fs.readFileSync(unit, "utf8"), expected);
  } finally {
    await world.cleanup();
  }
});

test("job logs refuse a symlinked event file", async () => {
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
    fs.symlinkSync(path.join(world.root, "missing"), world.paths.events(record.id));
    const result = await world.run(["job", "logs", record.id]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /cannot be read/);
  } finally {
    await world.cleanup();
  }
});

test("install-unit refuses a symlinked systemd directory", async () => {
  const world = runnerWorld();
  try {
    const bin = path.join(world.home, "bin");
    fs.mkdirSync(bin, { mode: 0o700 });
    const launcher = path.join(bin, "nexus");
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const config = path.join(world.home, ".config");
    fs.mkdirSync(config, { mode: 0o700 });
    const outside = path.join(world.root, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(config, "systemd"));
    const result = await world.run(["runner", "install-unit", "--exec", launcher]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unsafe directory/);
    assert.equal(fs.existsSync(path.join(outside, "user", "nexus-runner.service")), false);
  } finally {
    await world.cleanup();
  }
});
