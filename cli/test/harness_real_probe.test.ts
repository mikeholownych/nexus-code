import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";

describe("harness real probe adapter", () => {
  it("runs deterministic verifiers in isolated workspace and does not mutate source", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-real-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    fs.writeFileSync(path.join(base, "SYSTEM.md"), "base\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({
      schemaVersion: 1,
      id: "suite-real",
      cases: [{ id: "c1", description: "artifact exists", prompt: "check", expected: { artifactPath: "artifact.txt" } }],
    }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store });
    const { isSandboxAvailable } = await import("../src/sandbox.js");
    const done = await orch.run(run.id, { store, real: true, allowUnsandboxedRealProbe: !isSandboxAvailable("auto") });
    assert.equal(done.status, "COMPLETED");
    assert.equal(fs.readFileSync(path.join(base, "SYSTEM.md"), "utf8"), "base\n");
    const report = store.loadReport(done.id);
    assert.ok(report);
    assert.match(report!.noApplyWarning, /does not apply/i);
  });
});
