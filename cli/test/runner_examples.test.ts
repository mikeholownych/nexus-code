/** BG-1 G-6: the documented detached-runner example executes through the real CLI against a scripted gateway. */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliEntry } from "./helpers/audit_fixture.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";
import { readReceipt, runnerAlive } from "../src/core/job_runner.js";
import { runnerWorld } from "./helpers/runner_fixture.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

test("examples/runner: a detached read-only job completes with an unattended receipt", { timeout: 180_000 }, async () => {
  const world = runnerWorld();
  const repo = makeRepo({ "README.md": "This example runs a detached Nexus job.\n" });
  const gateway = await startGateway((n) => n === 1
    ? { kind: "tools", calls: [{ name: "read_file", args: { path: "README.md" } }] }
    : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "The first line describes a detached Nexus job." } }] });
  const shim = path.join(world.root, "nexus");
  fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${cliEntry().map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
  const child = spawn("bash", [path.join(ROOT, "examples", "runner", "run.sh")], {
    cwd: repo,
    env: { ...world.env, NEXUS_BIN: shim, NEXUS_RUNNER_ENDPOINT: gateway.url, NEXUS_RUNNER_MODEL: "m" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, `${stdout}\n${stderr}`.slice(-3000));
    const id = /^Job (job-[0-9a-f]{12}): COMPLETE/m.exec(stdout)?.[1];
    assert.ok(id, stdout);
    const receipt = readReceipt(world.paths, id!);
    assert.equal(receipt?.unattended, true);
    assert.equal(receipt?.outcome, "COMPLETE");
    assert.equal(gateway.requests.length, 2);
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "This example runs a detached Nexus job.\n");
    assert.equal(runnerAlive(world.paths), false, "the script stops the runner it started");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await world.cleanup();
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
