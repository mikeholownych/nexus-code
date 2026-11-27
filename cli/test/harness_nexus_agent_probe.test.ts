import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NexusAgentProbeAdapter } from "../src/core/harness/nexus_agent_probe_adapter.js";
import { HarnessStore } from "../src/core/harness/store.js";

describe("nexus agent probe adapter", () => {
  it("runs injected agent, captures trajectory, and grades deterministic verifier", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-nexus-probe-"));
    const cand = path.join(tmp, "cand");
    fs.mkdirSync(cand, { recursive: true });
    fs.writeFileSync(path.join(cand, "artifact.txt"), "before\n");
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });

    const adapter = new NexusAgentProbeAdapter({
      createAgent: (_cfg, workspace) => ({
        run: async () => {
          fs.writeFileSync(path.join(workspace, "artifact.txt"), "ok\n");
          return { execution: "COMPLETED", outcome: "NOT_REQUIRED", acceptance: "NOT_REQUESTED", modelStop: "FINAL_TEXT", finalOutputComplete: true, verification: null, interruption: null, inferenceFailure: null, steps: { used: 1, max: 8, limitReached: false }, unverifiedChangesPending: false, finishedAt: new Date().toISOString() } as any;
        },
        shutdown: () => {},
      }),
    });

    const result = await adapter.run({
      runId: "hrun_1",
      candidateId: "hcand_1",
      candidatePath: cand,
      timeoutMs: 5000,
      store,
      case: { id: "c1", description: "d", prompt: "fix it", expected: { verifierCommand: "grep -q '^ok$' artifact.txt" } },
    });

    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.metrics.verifierPass, true);
    assert.ok(result.artifacts.trajectoryRef);
    assert.ok(fs.existsSync(result.artifacts.trajectoryRef!));
    const traj = fs.readFileSync(result.artifacts.trajectoryRef!, "utf8");
    assert.match(traj, /"execution":"COMPLETED"/);
  });
});
