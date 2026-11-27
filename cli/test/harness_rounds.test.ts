import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";

describe("harness rounds", () => {
  it("records multiple rounds when maxRounds > 1 and no deterministic improvement found", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-rounds-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "SYSTEM.md"), "base\n");
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({
      schemaVersion: 1,
      id: "suite-rounds",
      cases: [{ id: "c1", description: "artifact ok", prompt: "p", expected: { artifactPath: "artifact.txt" } }],
    }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store, maxRounds: 2, maxCandidatesPerRound: 1, maxProbes: 8 });
    const done = await orch.run(run.id, { store, mock: true });
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.rounds.length, 2);
    assert.ok(done.candidateIds.length >= 2);
    assert.equal(done.rounds[0].status, "COMPLETED");
    assert.equal(done.rounds[1].status, "COMPLETED");
  });
});
