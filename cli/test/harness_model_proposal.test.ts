import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NexusModelProposalAdapter } from "../src/core/harness/nexus_model_proposal_adapter.js";
import type { ProposalContext } from "../src/core/harness/proposal_adapter.js";

describe("nexus model proposal adapter", () => {
  it("applies JSON edits from injected agent and returns candidate path", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-prop-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "SYSTEM.md"), "base\n");
    const adapter = new NexusModelProposalAdapter({
      createAgent: (_cfg, workspace) => ({
        run: async () => {
          // simulate agent editing workspace too; adapter should still accept JSON edits
          fs.writeFileSync(path.join(workspace, "notes.txt"), "agent\n");
          return { execution: "COMPLETED", outcome: "NOT_REQUIRED", acceptance: "NOT_REQUESTED", modelStop: "FINAL_TEXT", finalOutputComplete: true, verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 6, limitReached: false }, unverifiedChangesPending: false, finishedAt: new Date().toISOString(), detail: "```json\n{\"rationale\":\"improve\",\"targetWeaknesses\":[\"w1\"],\"edits\":[{\"path\":\"SYSTEM.md\",\"content\":\"improved\\n\"}]}\n```" } as any;
        },
        shutdown: () => {},
      }),
    });
    const ctx: ProposalContext = {
      run: { id: "hrun_1", budgets: { maxRounds: 2, maxCandidatesPerRound: 1, maxProbes: 4, maxWallClockMs: 60000, maxProbeWallClockMs: 30000, maxConcurrentProbes: 1 } } as any,
      suite: { schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "p" }] } as any,
      baseTree: base,
      round: 2,
      priorCandidates: [],
      priorProbes: [],
      priorScorecards: [],
    };
    const out = await adapter.propose(ctx);
    assert.equal(out.length, 1);
    assert.equal(out[0].source, "agent");
    assert.match(out[0].rationale, /improve/);
    assert.ok(fs.existsSync(path.join(out[0].candidatePath, "SYSTEM.md")));
    assert.equal(fs.readFileSync(path.join(out[0].candidatePath, "SYSTEM.md"), "utf8"), "improved\n");
  });
});
