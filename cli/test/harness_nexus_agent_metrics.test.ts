import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NexusAgentProbeAdapter } from "../src/core/harness/nexus_agent_probe_adapter.js";

describe("nexus agent probe metrics", () => {
  it("captures turn metrics and sandbox/network observations", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-metrics-"));
    const cand = path.join(tmp, "cand");
    fs.mkdirSync(cand, { recursive: true });
    fs.writeFileSync(path.join(cand, "artifact.txt"), "ok\n");
    const adapter = new NexusAgentProbeAdapter({
      createAgent: () => ({
        run: async () => ({
          execution: "COMPLETED", outcome: "NOT_REQUIRED", acceptance: "NOT_REQUESTED", modelStop: "FINAL_TEXT", finalOutputComplete: true,
          verification: null, interruption: null, inferenceFailure: null, steps: { used: 3, max: 8, limitReached: false },
          continuation: { toolInvocations: 2 }, usage: { totalTokens: 123 }, unverifiedChangesPending: false, finishedAt: new Date().toISOString(),
        } as any),
        shutdown: () => {},
      }),
    });
    const result = await adapter.run({
      runId: "hrun_1", candidateId: "hcand_1", candidatePath: cand, timeoutMs: 5000,
      case: { id: "c1", description: "d", prompt: "p", expected: { artifactPath: "artifact.txt" } },
    });
    assert.equal(result.metrics.tokens, 123);
    assert.ok(result.observations.some((o) => o.includes("turn_steps=3")));
    assert.ok(result.observations.some((o) => o.includes("sandbox=")));
    assert.ok(result.observations.some((o) => o.includes("network=")));
  });
});
