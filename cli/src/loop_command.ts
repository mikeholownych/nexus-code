import { LoopOrchestrator, type LoopResult, type LoopRunnerOptions } from "./loop.js";
import { parseBatchWords } from "./batch.js";
import type { OperationEvent } from "./core/operation.js";
import type { DurableLoopCondition } from "./core/state_schema.js";
import type { HarnessConfig } from "./types.js";

export interface LoopCommandResult { success: boolean; output: string }
const USAGE = [
  "Usage: /loop [--until <condition>] [--max-iterations <n>] [--max-duration <duration>] <objective>",
  "       /loop status [id] | list | pause [id] | resume [id] | stop [id]",
  "       /loop reconcile <id> --confirm-no-effect",
  "Conditions: test=<command> | artifact=<relative-path>::<command> | criteria=<text>",
  "Durations: integer seconds (30s), minutes (5m), or hours (1h). Options go before the objective.",
].join("\n");

export function parseLoopDuration(value: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h)$/u.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const factor = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const result = amount * factor;
  return Number.isSafeInteger(result) ? result : undefined;
}

export function parseLoopCondition(value: string): DurableLoopCondition | undefined {
  if (value.startsWith("test=") && value.slice(5).trim()) return { kind: "verification", command: value.slice(5).trim() };
  if (value.startsWith("criteria=") && value.slice(9).trim()) return { kind: "criteria", text: value.slice(9).trim() };
  if (value.startsWith("artifact=")) {
    const [path, ...command] = value.slice(9).split("::");
    if (path?.trim() && command.join("::").trim()) return { kind: "artifact", path: path.trim(), command: command.join("::").trim() };
  }
  return undefined;
}

function render(result: LoopResult): string {
  const state = result.state;
  const rows = [`Loop ${state.id}: ${state.status}`, `Objective: ${state.originalObjective}`, `Iterations: ${state.iterations.length}/${state.maxIterations}`, `Deadline: ${state.deadlineAt}`];
  if (state.condition) rows.push(`Condition: ${JSON.stringify(state.condition)}`);
  if (state.reason) rows.push(`Status: ${state.reason}`);
  for (const iteration of state.iterations) {
    rows.push(`  #${iteration.number} ${iteration.status}; progress=${iteration.progress}; verifier=${iteration.verifier?.status ?? "missing"}; review=${iteration.reviewer?.verdict ?? "missing"}`);
  }
  rows.push(`Usage: ${state.actualUsage.agentRuns} agent runs, ${state.actualUsage.inferenceRequests} inference requests, ${state.actualUsage.reportedTokens} reported tokens, ${state.actualUsage.estimatedTokens} estimated tokens.`);
  if (["PAUSED", "BLOCKED"].includes(state.status)) rows.push(`Continue with: /loop resume ${state.id}`);
  if (state.evidenceRefs.length) rows.push(`Evidence operations: ${state.evidenceRefs.join(", ")}`);
  return rows.join("\n");
}

export async function executeLoopCommand(
  args: string,
  config: HarnessConfig,
  signal?: AbortSignal,
  onEvent?: (event: OperationEvent) => void,
  requestApproval?: (tool: string, values: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>,
  runtime: Pick<LoopRunnerOptions, "store" | "executor" | "resources" | "now"> = {},
): Promise<LoopCommandResult> {
  const words = parseBatchWords(args);
  if (!words.length) return { success: false, output: USAGE };
  const action = words[0].toLowerCase();
  const orchestrator = new LoopOrchestrator(config, { ...runtime, signal, onEvent, maxInProcessWaitMs: 60_000 });
  if (action === "reconcile") {
    if (words.length !== 3 || words[2] !== "--confirm-no-effect") return { success: false, output: "Usage: /loop reconcile <id> --confirm-no-effect\nThis records your explicit confirmation that the unresolved child had no effect." };
    if (!requestApproval || !(await requestApproval("loop_reconcile_no_effect", { loopId: words[1], decision: "OPERATOR_CONFIRMED_NO_EFFECT" }, signal ?? new AbortController().signal))) {
      return { success: false, output: "Reconciliation was not approved; the loop remains UNKNOWN_EFFECT." };
    }
    const result = await orchestrator.reconcileNoEffect(words[1]);
    return { success: true, output: `${render(result)}\nThe child effect was explicitly reconciled as absent by the operator. Resume with /loop resume ${result.id}.` };
  }
  if (["status", "pause", "resume", "stop"].includes(action)) {
    if (words.length > 2) return { success: false, output: `Usage: /loop ${action} [id]` };
    if (action === "status") {
      const state = orchestrator.load(words[1] ?? orchestrator.resolveTarget().id);
      return { success: true, output: render({ id: state.id, status: state.status, state }) };
    }
    const changed = action === "pause" ? await orchestrator.pause(words[1]) : action === "resume" ? await orchestrator.resume(words[1]) : await orchestrator.stop(words[1]);
    return { success: ["PAUSED", "COMPLETE", "CANCELLED"].includes(changed.status), output: render(changed) };
  }
  if (action === "list") {
    if (words.length !== 1) return { success: false, output: "Usage: /loop list" };
    const loops = orchestrator.list();
    return { success: true, output: loops.length ? loops.map((loop) => `${loop.id}  ${loop.status}  ${loop.state.iterations.length}/${loop.state.maxIterations}  ${loop.state.originalObjective}`).join("\n") : "No loops in this workspace." };
  }
  let condition: DurableLoopCondition | undefined;
  let maxIterations: number | undefined;
  let maxDurationMs: number | undefined;
  let index = 0;
  while (index < words.length && words[index].startsWith("--")) {
    const flag = words[index++];
    const value = words[index++];
    if (value === undefined) return { success: false, output: `Missing value for ${flag}.\n${USAGE}` };
    if (flag === "--until") {
      condition = parseLoopCondition(value);
      if (!condition) return { success: false, output: `Invalid condition '${value}'.\n${USAGE}` };
    } else if (flag === "--max-iterations") {
      if (!/^\d+$/u.test(value)) return { success: false, output: `Invalid iteration limit '${value}'.\n${USAGE}` };
      maxIterations = Number(value);
    } else if (flag === "--max-duration") {
      maxDurationMs = parseLoopDuration(value);
      if (maxDurationMs === undefined) return { success: false, output: `Invalid duration '${value}'.\n${USAGE}` };
    } else return { success: false, output: `Unknown option '${flag}'.\n${USAGE}` };
  }
  if (maxIterations !== undefined && (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 100)) {
    return { success: false, output: "Iteration limit must be between 1 and 100." };
  }
  if (maxDurationMs !== undefined && (maxDurationMs < 1_000 || maxDurationMs > 24 * 60 * 60 * 1_000)) {
    return { success: false, output: "Duration must be between 1 second and 24 hours." };
  }
  const objective = words.slice(index).join(" ").trim();
  if (!objective) return { success: false, output: USAGE };
  const result = await orchestrator.start(objective, { condition, maxIterations, maxDurationMs });
  return { success: result.status === "COMPLETE", output: render(result) };
}
