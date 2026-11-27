import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeHarnessSlashCommand } from "../src/harness_command.js";

describe("/harness slash command", () => {
  it("returns usage on empty args", async () => {
    const res = await executeHarnessSlashCommand("", {} as any, new AbortController().signal);
    assert.equal(res.success, false);
    assert.match(res.output, /Usage: \/harness/);
  });

  it("init/run/report flow works", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-slash-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "p", expected: { artifactPath: "artifact.txt" } }] }));
    const old = process.env.NEXUS_STATE_DIR;
    process.env.NEXUS_STATE_DIR = path.join(tmp, "state");
    try {
      const init = await executeHarnessSlashCommand(`init --task-suite ${suite} --base ${base}`, {} as any, new AbortController().signal);
      assert.equal(init.success, true, init.output);
      const run = JSON.parse(init.output);
      const ran = await executeHarnessSlashCommand(`run ${run.id} --mock`, {} as any, new AbortController().signal);
      assert.equal(ran.success, true, ran.output);
      const report = await executeHarnessSlashCommand(`report ${run.id}`, {} as any, new AbortController().signal);
      assert.equal(report.success, true, report.output);
      assert.match(report.output, /does not apply/i);

      const blockedInit = await executeHarnessSlashCommand(`init --task-suite ${suite} --base ${base}`, {} as any, new AbortController().signal);
      const blockedRun = JSON.parse(blockedInit.output);
      const blocked = await executeHarnessSlashCommand(`run ${blockedRun.id}`, {} as any, new AbortController().signal);
      assert.equal(blocked.success, false);
      assert.equal(JSON.parse(blocked.output).status, "BLOCKED");
    } finally {
      if (old === undefined) delete process.env.NEXUS_STATE_DIR;
      else process.env.NEXUS_STATE_DIR = old;
    }
  });
});
