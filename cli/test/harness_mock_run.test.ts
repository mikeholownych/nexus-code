import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";

function mkFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-run-"));
  const base = path.join(tmp, "base");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "SYSTEM.md"), "base system\n");
  fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
  const suitePath = path.join(tmp, "suite.json");
  fs.writeFileSync(suitePath, JSON.stringify({
    schemaVersion: 1,
    id: "suite1",
    cases: [{ id: "c1", description: "artifact exists", prompt: "check", expected: { artifactPath: "artifact.txt" } }],
  }));
  return { tmp, base, suitePath };
}

describe("harness mock run", () => {
  it("runs deterministically with mock adapter and produces report, no live mutation", async () => {
    const { tmp, base, suitePath } = mkFixture();
    const outside = path.join(tmp, "live-profile.txt");
    fs.writeFileSync(outside, "original");
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suitePath, basePath: base, store });
    const done = await orch.run(run.id, { store, mock: true });
    assert.equal(done.status, "COMPLETED");
    assert.ok(done.promotionReportId);
    const report = store.loadReport(done.id);
    assert.ok(report);
    assert.match(report!.noApplyWarning, /does not apply/i);
    assert.equal(fs.readFileSync(outside, "utf8"), "original");
  });

  it("blocks when no mock adapter and real probes not enabled", async () => {
    const { tmp, base, suitePath } = mkFixture();
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suitePath, basePath: base, store });
    const done = await orch.run(run.id, { store, mock: false });
    assert.equal(done.status, "BLOCKED");
    assert.match(done.reason || "", /--mock/i);
  });

  it("does not create a promotion report when the probe budget is exhausted", async () => {
    const { tmp, base, suitePath } = mkFixture();
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suitePath, basePath: base, store, maxProbes: 1 });

    const done = await orch.run(run.id, { store, mock: true });

    assert.equal(done.status, "BLOCKED");
    assert.match(done.reason || "", /probe budget exhausted/i);
    assert.equal(done.promotionReportId, undefined);
    assert.equal(store.loadReport(done.id), undefined);
  });
});
