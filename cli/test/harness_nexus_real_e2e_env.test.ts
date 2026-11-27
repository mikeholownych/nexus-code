import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";

const model = process.env.NEXUS_HIR_E2E_MODEL;
const endpoint = process.env.NEXUS_HIR_E2E_ENDPOINT;
const apiKey = process.env.NEXUS_HIR_E2E_API_KEY;

describe("harness nexus real-model e2e (env-gated)", () => {
  it("runs nexus-agent probe/propose path with deterministic oracle when env is configured", { skip: !(model && endpoint) ? "set NEXUS_HIR_E2E_MODEL and NEXUS_HIR_E2E_ENDPOINT to run" : false }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-real-e2e-"));
    const base = path.join(tmp, "base"); fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s-real", cases: [{ id: "c1", description: "artifact exists", prompt: "Ensure artifact.txt contains ok", expected: { artifactPath: "artifact.txt" } }] }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store, maxRounds: 1, maxCandidatesPerRound: 1, maxProbes: 2 });
    const done = await orch.run(run.id, {
      store,
      nexusAgent: true,
      nexusPropose: false,
      nexusAgentConfig: { model: model!, endpoint: endpoint!, apiKey, maxSteps: 4, sandbox: "auto", network: false },
    });
    assert.ok(["COMPLETED", "BLOCKED", "FAILED"].includes(done.status));
    assert.notEqual(done.status, "FAILED"); // should be COMPLETED or BLOCKED by policy/sandbox, not crash
  });
});
