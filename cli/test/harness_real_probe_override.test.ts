import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";

describe("harness real probe unsafe override", () => {
  it("allows unsandboxed real probe only with explicit override", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-real-override-"));
    const base = path.join(tmp, "base"); fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "p", expected: { verifierCommand: "test -f artifact.txt" } }] }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store });
    const oldPath = process.env.PATH;
    const oldAllow = process.env.NEXUS_ALLOW_UNSANDBOXED_HIR_PROBE;
    process.env.PATH = "/nonexistent";
    process.env.NEXUS_ALLOW_UNSANDBOXED_HIR_PROBE = "1";
    try {
      const done = await orch.run(run.id, { store, real: true, allowUnsandboxedRealProbe: true });
      assert.equal(done.status, "COMPLETED");
    } finally {
      process.env.PATH = oldPath;
      if (oldAllow === undefined) delete process.env.NEXUS_ALLOW_UNSANDBOXED_HIR_PROBE; else process.env.NEXUS_ALLOW_UNSANDBOXED_HIR_PROBE = oldAllow;
    }
  });
});
