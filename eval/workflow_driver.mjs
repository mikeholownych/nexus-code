import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowSlashRequest, makeBatchWorkflowSpec, independentAgentsObjective, validateWorkflowArm } from "./workflow_modes.mjs";

/** Drive one measured PA-4 arm through the same sidecar protocol used by the CLI. */
export function createWorkflowDriver({ arm, task, workspace }, write) {
  validateWorkflowArm(arm);
  const state = { arm, phase: "starting", slashResult: null, turns: [], toolCalls: 0, toolCounts: {}, successfulToolCounts: {}, errors: [], progressEvents: 0, armCompliance: null };
  let generatedSpecPath;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    state.phase = "done";
    if (generatedSpecPath) { try { fs.rmSync(generatedSpecPath, { force: true }); } catch (error) { state.errors.push(`generated batch spec cleanup failed: ${error.message}`); } }
    write(`${JSON.stringify({ v: 1, type: "shutdown" })}\n`);
    resolveDone(state);
  };
  const sendSlash = () => {
    try {
      if (arm === "independent_agents") {
        const text = independentAgentsObjective(task.objective);
        write(`${JSON.stringify({ v: 1, type: "prompt.submit", id: "workflow-objective", text })}\n`);
        state.phase = "turn";
        return;
      }
      let specPath;
      if (arm === "bounded_batch") {
        specPath = `.nexus-eval-batch-${randomUUID()}.json`;
        const spec = makeBatchWorkflowSpec(task, "eval-batch");
        generatedSpecPath = path.join(workspace, specPath);
        fs.writeFileSync(generatedSpecPath, JSON.stringify(spec, null, 2), { mode: 0o600 });
      }
      const request = workflowSlashRequest(arm, task, specPath);
      write(`${JSON.stringify({ v: 1, type: "slash", id: "workflow-command", command: request.command, args: request.args })}\n`);
      state.phase = "slash";
    } catch (error) {
      state.errors.push(`workflow arm could not start: ${error.message}`);
      finish();
    }
  };
  const handleLine = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { state.errors.push("unparseable sidecar event"); return; }
    if (event.v !== 1) { state.errors.push(`unsupported sidecar protocol ${event.v}`); return; }
    if (event.type === "hello" && state.phase === "starting") sendSlash();
    else if (event.type === "tool.start") {
      state.toolCalls++;
      if (typeof event.tool === "string") state.toolCounts[event.tool] = (state.toolCounts[event.tool] ?? 0) + 1;
    }
    else if (event.type === "tool.end" && event.success === true && typeof event.tool === "string") {
      state.successfulToolCounts[event.tool] = (state.successfulToolCounts[event.tool] ?? 0) + 1;
    }
    else if (event.type === "progress" || event.type === "operation.event" || event.type === "notice") state.progressEvents++;
    else if (event.type === "slash.result" && event.id === "workflow-command") {
      state.slashResult = { success: event.success === true, command: event.command, output: String(event.output ?? "").slice(0, 16_000) };
      state.armCompliance = event.success === true;
      finish();
    } else if (event.type === "turn.result") {
      state.turns.push(event.turn ?? null);
      if (arm === "independent_agents") {
        state.armCompliance = state.successfulToolCounts.spawn_subagent === 3;
        finish();
      }
    } else if (event.type === "error") {
      state.errors.push(`${event.code ?? "error"}: ${String(event.message ?? "").slice(0, 300)}`);
      if (event.id === "workflow-command" || arm === "independent_agents") finish();
    }
  };
  return { state, done, handleLine, abort: finish };
}

