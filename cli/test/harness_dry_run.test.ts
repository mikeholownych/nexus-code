import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";

describe("harness dry run", () => {
  it("validates and completes without executing probes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-dry-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "p", expected: { artifactPath: "artifact.txt" } }] }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store });
    const done = await orch.run(run.id, { store, mock: true, dryRun: true });
    assert.equal(done.status, "COMPLETED");
    assert.match(done.reason || "", /Dry run/);
    assert.equal(done.actualUsage.probes, 0);
    assert.equal(store.loadReport(done.id), undefined);
  });
});
