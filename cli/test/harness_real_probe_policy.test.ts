import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";
import { RealProbeAdapter } from "../src/core/harness/real_probe_adapter.js";

describe("harness real probe sandbox policy", () => {
  it("blocks real probe when OS sandbox unavailable unless explicitly overridden", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-real-policy-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "p", expected: { verifierCommand: "test -f artifact.txt" } }] }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store });

    // Force unsandboxable command path by stubbing wrapSandboxedCommand behavior through adapter option is not available;
    // instead run adapter directly with a fake candidate case where bwrap/docker are absent by using an impossible PATH? Not reliable.
    // This test asserts the adapter blocks when run in an environment where sandbox is unavailable by invoking with empty PATH.
    const oldPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const done = await orch.run(run.id, { store, real: true });
      assert.equal(done.status, "COMPLETED");
      const report = store.loadReport(done.id);
      assert.ok(report);
      // probes should be recorded as BLOCKED/FAILED depending on policy; check probe result
      const probeDir = path.join(store.rootDir, "probes");
      const probeFiles = fs.readdirSync(probeDir).filter(f => f.endsWith(".json") || fs.statSync(path.join(probeDir,f)).isDirectory());
      assert.ok(probeFiles.length >= 1);
      const first = probeFiles.find(f => fs.existsSync(path.join(probeDir,f,"result.json")));
      const probe = JSON.parse(fs.readFileSync(path.join(probeDir, first!, "result.json"), "utf8"));
      assert.equal(probe.status, "BLOCKED");
      assert.ok(probe.observations.some((o: string) => o.includes("OS sandbox required")));
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
