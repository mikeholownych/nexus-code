import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

function cliBin() { return path.resolve("dist/index.js"); }

function mk() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-cli-"));
  const base = path.join(tmp, "base");
  fs.mkdirSync(base); fs.writeFileSync(path.join(base, "SYSTEM.md"), "base\n"); fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
  const suite = path.join(tmp, "suite.json");
  fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "suite1", cases: [{ id: "c1", description: "d", prompt: "p", expected: { artifactPath: "artifact.txt" } }] }));
  const state = path.join(tmp, "state");
  return { tmp, base, suite, state };
}

describe("nexus harness CLI", () => {
  it("init/status/show/report/cancel work with --json", () => {
    const { base, suite, state } = mk();
    const init = spawnSync(process.execPath, [cliBin(), "harness", "init", "--task-suite", suite, "--base", base, "--state-dir", state, "--json"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr + init.stdout);
    const run = JSON.parse(init.stdout);
    assert.equal(run.status, "CREATED");

    const status = spawnSync(process.execPath, [cliBin(), "harness", "status", run.id, "--state-dir", state, "--json"], { encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    const s = JSON.parse(status.stdout);
    assert.equal(s.liveMutation, false);

    const ran = spawnSync(process.execPath, [cliBin(), "harness", "run", run.id, "--mock", "--state-dir", state, "--json"], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr + ran.stdout);
    const done = JSON.parse(ran.stdout);
    assert.equal(done.status, "COMPLETED");

    const report = spawnSync(process.execPath, [cliBin(), "harness", "report", run.id, "--state-dir", state, "--json"], { encoding: "utf8" });
    assert.equal(report.status, 0, report.stderr + report.stdout);
    const r = JSON.parse(report.stdout);
    assert.match(r.noApplyWarning, /does not apply/i);

    const show = spawnSync(process.execPath, [cliBin(), "harness", "show", run.id, "--state-dir", state, "--json"], { encoding: "utf8" });
    assert.equal(show.status, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    assert.equal(shown.liveMutation, false);
    assert.ok(shown.report);

    const cancelInit = spawnSync(process.execPath, [cliBin(), "harness", "init", "--task-suite", suite, "--base", base, "--state-dir", state, "--json"], { encoding: "utf8" });
    const run2 = JSON.parse(cancelInit.stdout);
    const cancel = spawnSync(process.execPath, [cliBin(), "harness", "cancel", run2.id, "--state-dir", state, "--json"], { encoding: "utf8" });
    assert.equal(cancel.status, 0, cancel.stderr + cancel.stdout);
    assert.equal(JSON.parse(cancel.stdout).status, "CANCELLED");
  });
});
