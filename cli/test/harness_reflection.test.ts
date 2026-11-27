import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";
import type { ProposalAdapter } from "../src/core/harness/proposal_adapter.js";

describe("harness reflection/proposal hook", () => {
  it("records reflection evidence and uses proposal adapter on round 2", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-reflect-"));
    const base = path.join(tmp, "base"); fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
    const cand2 = path.join(tmp, "cand2"); fs.mkdirSync(cand2, { recursive: true });
    fs.writeFileSync(path.join(cand2, "artifact.txt"), "ok\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "p", expected: { artifactPath: "artifact.txt" } }] }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store, maxRounds: 2, maxCandidatesPerRound: 1, maxProbes: 8 });
    const proposalAdapter: ProposalAdapter = {
      propose: async ({ round }) => round === 2 ? [{ candidatePath: cand2, rationale: "try improved candidate", targetWeaknesses: ["none"], source: "agent" }] : [],
    };
    const done = await orch.run(run.id, { store, mock: true, proposalAdapter });
    assert.equal(done.status, "COMPLETED");
    assert.ok(done.rounds.length >= 2);
    const events = store.readEvents(run.id);
    assert.ok(events.some((e) => e.type === "hir.reflection"));
    assert.ok(events.some((e) => e.type === "hir.proposals"));
  });
});
