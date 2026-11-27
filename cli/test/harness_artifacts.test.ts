import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";

describe("harness probe artifacts", () => {
  it("persists probe stdout/stderr artifacts when store is provided", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-art-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({
      schemaVersion: 1, id: "s-art",
      cases: [{ id: "c1", description: "d", prompt: "p", expected: { verifierCommand: "echo hello && echo err 1>&2; grep -q ok artifact.txt" } }],
    }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store });
    const done = await orch.run(run.id, { store, mock: true });
    assert.equal(done.status, "COMPLETED");
    assert.ok(done.probeIds.length >= 2);
    const probe = store.loadProbe(done.probeIds[0]);
    assert.ok(probe.artifacts.stdoutRef || probe.artifacts.stderrRef || probe.observations.length > 0);
    if (probe.artifacts.stdoutRef) assert.ok(fs.existsSync(probe.artifacts.stdoutRef));
  });
});
