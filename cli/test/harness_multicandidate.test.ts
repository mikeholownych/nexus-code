import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";

function mk() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-multi-"));
  const base = path.join(tmp, "base");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "SYSTEM.md"), "base\n");
  fs.writeFileSync(path.join(base, "artifact.txt"), "base\n");
  const candGood = path.join(tmp, "cand-good");
  fs.mkdirSync(candGood, { recursive: true });
  fs.writeFileSync(path.join(candGood, "SYSTEM.md"), "base\n");
  fs.writeFileSync(path.join(candGood, "artifact.txt"), "ok\n");
  const candBad = path.join(tmp, "cand-bad");
  fs.mkdirSync(candBad, { recursive: true });
  fs.writeFileSync(path.join(candBad, "SYSTEM.md"), "base\n");
  fs.writeFileSync(path.join(candBad, "artifact.txt"), "nope\n");
  const suite = path.join(tmp, "suite.json");
  fs.writeFileSync(suite, JSON.stringify({
    schemaVersion: 1,
    id: "suite-multi",
    cases: [{ id: "c1", description: "artifact ok", prompt: "p", expected: { verifierCommand: "grep -q '^ok$' artifact.txt" } }],
  }));
  return { tmp, base, suite, candGood, candBad };
}

describe("harness multi-candidate", () => {
  it("compares multiple candidates and selects deterministic winner", async () => {
    const { tmp, base, suite, candGood, candBad } = mk();
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store });
    const done = await orch.run(run.id, { store, mock: true, candidatePaths: [candBad, candGood] });
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.candidateIds.length, 2);
    assert.ok(done.promotionReportId);
    const report = store.loadReport(done.id);
    assert.ok(report);
    assert.equal(report!.recommendedCandidateId, done.candidateIds[1]);
    assert.ok(report!.changes.length >= 2);
    assert.ok(report!.scorecard.some((s) => s.candidateId === done.candidateIds[1] && s.verdict === "better"));
    const cands = done.candidateIds.map((id) => store.loadCandidate(id));
    assert.ok(cands.every((c) => c.diffRef.includes("diff.txt")));
  });
});
