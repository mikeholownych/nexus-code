import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";
import { NexusAgentProbeAdapter } from "../src/core/harness/nexus_agent_probe_adapter.js";
import { NexusModelProposalAdapter } from "../src/core/harness/nexus_model_proposal_adapter.js";

describe("harness nexus agent/proposal e2e (deterministic injected)", () => {
  it("runs propose->probe->reflect->report flow without live mutation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-nexus-e2e-"));
    const base = path.join(tmp, "base"); fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "artifact.txt"), "old\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "fix artifact", expected: { verifierCommand: "grep -q '^ok$' artifact.txt" } }] }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store, maxRounds: 2, maxCandidatesPerRound: 1, maxProbes: 6 });

    const proposalAdapter = new NexusModelProposalAdapter({
      createAgent: (_cfg, workspace) => ({
        run: async () => {
          fs.writeFileSync(path.join(workspace, "artifact.txt"), "ok\n");
          return { execution: "COMPLETED", outcome: "NOT_REQUIRED", acceptance: "NOT_REQUESTED", modelStop: "FINAL_TEXT", finalOutputComplete: true, verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 6, limitReached: false }, unverifiedChangesPending: false, finishedAt: new Date().toISOString(), detail: "```json\n{\"rationale\":\"fix\",\"targetWeaknesses\":[\"c1\"],\"edits\":[{\"path\":\"artifact.txt\",\"content\":\"ok\\n\"}]}\n```" } as any;
        },
        shutdown: () => {},
      }),
    });

    const probeAdapter = new NexusAgentProbeAdapter({
      createAgent: (_cfg, workspace) => ({
        run: async () => {
          // agent has already made/found change in isolated candidate workspace; ensure deterministic oracle passes
          if (!fs.existsSync(path.join(workspace, "artifact.txt"))) fs.writeFileSync(path.join(workspace, "artifact.txt"), "ok\n");
          return { execution: "COMPLETED", outcome: "NOT_REQUIRED", acceptance: "NOT_REQUESTED", modelStop: "FINAL_TEXT", finalOutputComplete: true, verification: null, interruption: null, inferenceFailure: null, steps: { used: 2, max: 8, limitReached: false }, continuation: { toolInvocations: 1 }, usage: { totalTokens: 10 }, unverifiedChangesPending: false, finishedAt: new Date().toISOString() } as any;
        },
        shutdown: () => {},
      }),
    });

    const done = await orch.run(run.id, { store, adapter: probeAdapter, proposalAdapter, nexusAgent: true, nexusPropose: true });
    assert.equal(done.status, "COMPLETED");
    assert.ok(done.promotionReportId);
    const report = store.loadReport(run.id);
    assert.ok(report);
    assert.ok(store.readEvents(run.id).some((e) => e.type === "hir.proposals"));
    assert.ok(store.readEvents(run.id).some((e) => e.type === "hir.reflection"));
    // no live mutation: base file unchanged
    assert.equal(fs.readFileSync(path.join(base, "artifact.txt"), "utf8"), "old\n");
  });
});
