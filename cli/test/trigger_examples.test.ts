/** BG-3: the documented example runs through the real CLI and runner against a scripted gateway, for a file change and for a signed webhook. */
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
import { listJobs } from "../src/core/runner_store.js";
import { runnerWorld } from "./helpers/runner_fixture.js";
import { approveInRepo } from "./helpers/trigger_fixture.js";
import { trustRepo } from "./helpers/schedule_fixture.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXAMPLE = path.join(ROOT, "examples", "triggers");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function runExample(mode: "file" | "webhook") {
  const world = runnerWorld();
  const repo = fs.realpathSync(makeRepo({ "README.md": "This example is run by a trigger.\n" }));
  const gateway = await startGateway((n) => n === 1
    ? { kind: "tools", calls: [{ name: "read_file", args: { path: "README.md" } }] }
    : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "The first line says it is run by a trigger." } }] });
  const shim = path.join(world.root, "nexus");
  fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${cliEntry().map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
  let stdout = "";
  let stderr = "";
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await trustRepo(world, repo);
    // What a person does in a terminal: read the file, then `nexus triggers approve` and type yes. The test records the same approvals directly.
    approveInRepo(world, repo, { copyFrom: path.join(EXAMPLE, "triggers.json") });
    child = spawn("bash", [path.join(EXAMPLE, "run.sh"), mode], {
      cwd: repo,
      env: { ...world.env, NEXUS_BIN: shim, LOCAL_LLM_ENDPOINT: gateway.url, LOCAL_LLM_MODEL: "m", NEXUS_EXAMPLE_HOOK_SECRET: "0123456789abcdef0123" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("close", resolve); });
    assert.equal(code, 0, `${stdout}\n${stderr}`.slice(-3000));
    const id = /^started (job-[0-9a-f]{12})$/m.exec(stdout)?.[1];
    assert.ok(id, stdout);
    const receipt = readReceipt(world.paths, id!);
    assert.equal(receipt?.outcome, "COMPLETE");
    assert.equal(receipt?.unattended, true);
    assert.equal(receipt?.approval_mode, "read-only");
    assert.equal(receipt?.schedule_id, null);
    assert.equal(receipt?.trigger_id, mode === "file" ? "example-readme" : "example-hook");
    assert.equal(receipt?.trigger_event?.kind, mode === "file" ? "file-change" : "webhook");
    assert.match(receipt?.trigger_event?.id ?? "", mode === "file" ? /^fc-/ : /^wh-/);
    assert.equal(listJobs(world.paths).jobs.length, 1, "one event, one job");
    assert.match(stdout, /fired: 1/);
    assert.equal(gateway.requests.length, 2);
    assert.match(JSON.stringify(gateway.requests[0]), /UNTRUSTED EVENT DATA BEGIN/);
    if (mode === "file") assert.match(JSON.stringify(gateway.requests[0]), /README\.md/);
    else assert.match(stdout, /^202 /m);
    assert.equal(runnerAlive(world.paths), false, "the script stops the runner it started");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await world.cleanup();
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test("examples/triggers: a README change fires the approved file-change trigger and the receipt names the trigger and event", { timeout: 240_000 }, () => runExample("file"));
test("examples/triggers: a signed webhook delivery to the loopback listener fires the approved webhook trigger", { timeout: 240_000 }, () => runExample("webhook"));
