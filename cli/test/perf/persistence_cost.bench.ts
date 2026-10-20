/**
 * Persistence cost measurement harness (ACC-CONT-08 / SPEC-04 §3.7 / AGT-15).
 * Measures per-step persistence overhead across 200 steps with 2 KB outputs.
 * Threshold: p95 < 100 ms on SSD.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DurableStateManager, DurableTaskState } from "../../src/core/state.js";
import { ChatMessage } from "../../src/types.js";
import { WorkspacePath } from "../../src/core/workspace_path.js";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

test("ACC-CONT-08: 200-step persistence overhead measurement (threshold p95 < 100 ms)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-perf-persistence-"));
  try {
    const stateManager = new DurableStateManager({ baseDir: tmpDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(tmpDir)] });
    const taskId = "task-bench-200-steps";
    const workspace = tmpDir;

    const initialMessages: ChatMessage[] = [
      { role: "system", content: "You are an autonomous AI coding assistant." },
      { role: "user", content: "Implement the feature and verify it with 200 operations." },
    ];

    const initialState: DurableTaskState = {
      schemaVersion: 1,
      taskId,
      sessionId: "session-bench",
      workspacePath: workspace,
      prompt: "Benchmark task",
      status: "in_progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      planPhases: [],
      messages: [...initialMessages],
      milestones: [],
      unverifiedChangesPending: false,
    };

    stateManager.saveTaskState(initialState);

    // 2 KB dummy tool output
    const outputChunk2KB = "A".repeat(2048);
    const stepDurationsMs: number[] = [];

    const messages = [...initialMessages];

    for (let step = 1; step <= 200; step++) {
      const callId = `call_${step.toString().padStart(4, "0")}`;
      const invocationId = `inv_${step}_${Date.now()}`;

      // Measure the persistence overhead of this step
      const stepStart = performance.now();

      // 1. Tool call announced in assistant message
      messages.push({
        role: "assistant",
        content: `Step ${step}: inspecting workspace.`,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: `file_${step}.txt` }),
            },
          },
        ],
      });

      // 2. Pre-execution operation start recorded durably
      stateManager.recordOperationStart(taskId, {
        invocationId,
        seq: step,
        toolName: "read_file",
        targetResources: [`file_${step}.txt`],
        argsSummary: `path: file_${step}.txt`,
      });

      // 3. Post-execution operation end recorded durably
      stateManager.recordOperationEnd(
        taskId,
        invocationId,
        { success: true },
        step
      );

      // 4. Tool result (2 KB) appended to conversation and progress persisted durably
      messages.push({
        role: "tool",
        tool_call_id: callId,
        name: "read_file",
        content: outputChunk2KB,
      });

      stateManager.recordProgress(taskId, {
        messages,
        unverifiedChangesPending: false,
      });

      const stepEnd = performance.now();
      stepDurationsMs.push(stepEnd - stepStart);
    }

    const sorted = [...stepDurationsMs].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const mean = sum / sorted.length;
    const p50 = percentile(sorted, 50);
    const p90 = percentile(sorted, 90);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);

    console.log("\n=======================================================");
    console.log(" ACC-CONT-08 Persistence Overhead Benchmark (200 steps) ");
    console.log("=======================================================");
    console.log(` Steps:     ${sorted.length}`);
    console.log(` Output/step: 2 KB`);
    console.log(` Min:       ${min.toFixed(2)} ms`);
    console.log(` Mean:      ${mean.toFixed(2)} ms`);
    console.log(` p50:       ${p50.toFixed(2)} ms`);
    console.log(` p90:       ${p90.toFixed(2)} ms`);
    console.log(` p95:       ${p95.toFixed(2)} ms`);
    console.log(` p99:       ${p99.toFixed(2)} ms`);
    console.log(` Max:       ${max.toFixed(2)} ms`);
    console.log(` Threshold: p95 < 100.00 ms (SSD)`);
    const exceeded = p95 >= 100;
    console.log(` Status:    ${exceeded ? "EXCEEDED (latency threshold exceeded on host storage per SPEC-04 §3.7 / SPEC-08)" : "PASSED (within budget)"}`);
    console.log("=======================================================\n");

    assert.equal(sorted.length, 200, "All 200 steps must be recorded");
    assert.ok(p95 > 0, "p95 overhead must be positive");
    assert.ok(!exceeded, `[ACC-CONT-08] p95 overhead (${p95.toFixed(2)} ms) exceeds the unchanged 100 ms SSD threshold after the split-record implementation.`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
