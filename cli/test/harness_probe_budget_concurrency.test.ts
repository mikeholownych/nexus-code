import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";
import type { ProbeAdapter, ProbeInput } from "../src/core/harness/probe_adapter.js";
import type { HarnessImprovementRun, ProbeResult } from "../src/core/harness/types.js";

interface Fixture {
  root: string;
  base: string;
  store: HarnessStore;
  run: HarnessImprovementRun;
}

async function fixture(maxProbes: number, initialUsage = 0): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hir-probe-budget-"));
  const base = path.join(root, "base");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "SYSTEM.md"), "base\n");
  fs.writeFileSync(path.join(base, "artifact.txt"), "ok\n");
  const suitePath = path.join(root, "suite.json");
  fs.writeFileSync(suitePath, JSON.stringify({
    schemaVersion: 1,
    id: "suite",
    cases: [1, 2, 3, 4].map((n) => ({ id: `case${n}`, description: `case ${n}`, prompt: "probe" })),
  }));
  const store = new HarnessStore({ rootDir: path.join(root, "state") });
  const orchestrator = new HarnessOrchestrator(store);
  const run = await orchestrator.init({ taskSuitePath: suitePath, basePath: base, store, maxProbes });
  run.budgets.maxConcurrentProbes = 4;
  run.actualUsage.probes = initialUsage;
  store.saveRun(run);
  return { root, base, store, run };
}

class CountingAdapter implements ProbeAdapter {
  readonly calls: ProbeInput[] = [];
  readonly persistedProbeCounts: number[] = [];
  active = 0;
  peak = 0;

  async run(input: ProbeInput): Promise<ProbeResult> {
    this.calls.push(input);
    this.persistedProbeCounts.push(input.store?.loadRun(input.runId).actualUsage.probes ?? -1);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.active--;
    const at = new Date().toISOString();
    return {
      schemaVersion: 1,
      id: `probe-${this.calls.length}-${input.candidateId}-${input.case.id}`,
      runId: input.runId,
      candidateId: input.candidateId,
      caseId: input.case.id,
      status: "SUCCEEDED",
      startedAt: at,
      endedAt: at,
      metrics: { wallClockMs: 20, tokens: 0, toolErrors: 0, verifierPass: null },
      artifacts: {},
      observations: [],
    };
  }
}

describe("HIR concurrent probe budget reservations", () => {
  it("does not dispatch more probes than a nearly exhausted run budget", async () => {
    const f = await fixture(2);
    const adapter = new CountingAdapter();
    const result = await new HarnessOrchestrator(f.store).run(f.run.id, { store: f.store, adapter, candidatePath: f.base });

    assert.equal(adapter.calls.length, 2);
    assert.equal(adapter.peak, 2);
    assert.equal(result.actualUsage.probes, 2);
    assert.equal(result.status, "BLOCKED");
  });

  it("never dispatches more baseline and candidate probes than the run-wide budget", async () => {
    const f = await fixture(6);
    const adapter = new CountingAdapter();
    const result = await new HarnessOrchestrator(f.store).run(f.run.id, { store: f.store, adapter, candidatePath: f.base });

    assert.ok(adapter.peak > 1, "configured bounded concurrency should be exercised");
    assert.ok(adapter.peak <= 4, `peak ${adapter.peak} exceeded configured concurrency 4`);
    assert.ok(adapter.calls.length <= 6, `dispatched ${adapter.calls.length} probes with maxProbes=6`);
    assert.ok(result.actualUsage.probes <= 6, `recorded ${result.actualUsage.probes} probes with maxProbes=6`);
    assert.ok(adapter.persistedProbeCounts.every((count) => count >= 1 && count <= 6), "each adapter call must observe its durable reservation");
    assert.equal(f.store.loadRun(f.run.id).actualUsage.probes, result.actualUsage.probes);
    assert.equal(result.status, "BLOCKED");
  });

  it("resumes near exhaustion using only the remaining probe allowance", async () => {
    const f = await fixture(6, 5);
    const adapter = new CountingAdapter();
    const result = await new HarnessOrchestrator(f.store).run(f.run.id, { store: f.store, adapter, candidatePath: f.base });

    assert.equal(adapter.calls.length, 1);
    assert.equal(result.actualUsage.probes, 6);
    assert.equal(f.store.loadRun(f.run.id).actualUsage.probes, 6);
    assert.equal(result.status, "BLOCKED");
  });


  it("accepts the configured concurrency ceiling and rejects larger values", async () => {
    const f = await fixture(4);
    const invalid = f.store.loadRun(f.run.id);
    invalid.budgets.maxConcurrentProbes = 5;
    assert.throws(() => f.store.saveRun(invalid), /invalid budgets\.maxConcurrentProbes/);
  });

  it("does not dispatch when persisting a probe reservation fails", async () => {
    const f = await fixture(4);
    const adapter = new CountingAdapter();
    const saveRun = f.store.saveRun.bind(f.store);
    f.store.saveRun = (run) => {
      if (run.actualUsage.probes > 0) throw new Error("injected reservation persistence failure");
      saveRun(run);
    };

    await assert.rejects(
      new HarnessOrchestrator(f.store).run(f.run.id, { store: f.store, adapter, candidatePath: f.base }),
      /injected reservation persistence failure/,
    );
    assert.equal(adapter.calls.length, 0);
  });
});
