import { BatchOrchestrator, batchStatus, parseBatchWords, readBatchInputFile, readBatchSpecFile, renderBatchResult } from "./batch.js";
import { BatchPlanStore, parseBatchPlan, type BatchPlanDraft } from "./batch_plan.js";
import { generateBatchPlanProposal } from "./batch_plan_generation.js";
import { visibleControls } from "./file_diff.js";
import { formatDiagnosticForOutput, safeTerminal } from "./ui.js";
import type { OperationEvent } from "./core/operation.js";
import type { HarnessConfig } from "./types.js";

export interface BatchCommandResult {
  success: boolean;
  output: string;
}

const PLAN_USAGE = "Usage: /batch plan <objective> | plan show <draft-id> | plan import <file>";

const USAGE = [
  "Usage: /batch <spec-file> | run <spec-file> | validate <spec-file>",
  PLAN_USAGE,
  "       /batch status [id] | list | pause [id] | resume [id] | cancel [id] | results [id]",
].join("\n");

function loadSpec(file: string, config: HarnessConfig): unknown {
  return readBatchSpecFile(file, config.workspace);
}

function listOutput(config: HarnessConfig): string {
  const batches = new BatchOrchestrator(config).list();
  if (!batches.length) return "No batches in this workspace.";
  return batches.map((batch) => `${batch.id}  ${batchStatus(batch)}  ${batch.objective}`).join("\n");
}

async function executePlanCommand(
  words: string[],
  config: HarnessConfig,
  signal: AbortSignal | undefined,
  propose: typeof generateBatchPlanProposal,
): Promise<BatchCommandResult> {
  if (words[0] === "accept") {
    return { success: false, output: "Plan execution is unavailable until the required verification gates are enabled." };
  }
  if (["show", "import"].includes(words[0]) && words.length !== 2) return { success: false, output: PLAN_USAGE };
  try {
    const store = new BatchPlanStore(config.workspace);
    let draft: BatchPlanDraft;
    if (words[0] === "show") {
      draft = store.read(words[1]);
    } else {
      if (config.readOnly || config.approvalMode === "read-only" || config.dryRun) {
        throw new Error("This mode cannot save a plan draft.");
      }
      signal?.throwIfAborted();
      if (words[0] === "import") {
        draft = store.create(parseBatchPlan(readBatchInputFile(words[1], config.workspace), config.workspace));
      } else {
        const input = words.join(" ").trim();
        if (!input) throw new Error(PLAN_USAGE);
        const { plan, provenance } = await propose(input, config, signal);
        signal?.throwIfAborted();
        draft = store.create(plan, provenance);
      }
    }
    const normalized = JSON.stringify({ ...draft, workspace: safeTerminal(draft.workspace) }, null, 2)
      .split("\n").map(visibleControls).join("\n");
    return { success: true, output: `Proposal saved for review.\n${normalized}` };
  } catch (error) {
    return { success: false, output: formatDiagnosticForOutput(error) };
  }
}

/** Shared by the REPL and sidecar so both interfaces drive the same durable operation records. */
export async function executeBatchCommand(
  args: string,
  config: HarnessConfig,
  signal?: AbortSignal,
  onEvent?: (event: OperationEvent) => void,
  dependencies: { propose?: typeof generateBatchPlanProposal } = {},
): Promise<BatchCommandResult> {
  const words = parseBatchWords(args);
  const first = words[0]?.toLowerCase();
  if (first === "plan" && words.length > 1) {
    return executePlanCommand(words.slice(1), config, signal, dependencies.propose ?? generateBatchPlanProposal);
  }
  const operation = new BatchOrchestrator(config, {
    signal,
    onEvent,
    maxInProcessWaitMs: 60_000,
  });

  if (!words.length) return { success: false, output: USAGE };
  if (first === "list") {
    if (words.length !== 1) return { success: false, output: "Usage: /batch list" };
    return { success: true, output: listOutput(config) };
  }
  if (first === "pause") {
    if (words.length > 2) return { success: false, output: "Usage: /batch pause [id]" };
    const result = await operation.pause(words[1]);
    return { success: result.status === "PAUSED", output: renderBatchResult(result) };
  }
  if (first === "status" || first === "results") {
    if (words.length > 2) return { success: false, output: `Usage: /batch ${first} [id]` };
    const result = operation.results(words[1]);
    return { success: true, output: renderBatchResult(result) };
  }
  if (first === "cancel" || first === "resume") {
    if (words.length > 2) return { success: false, output: `Usage: /batch ${first} [id]` };
    const result = first === "cancel" ? await operation.cancel(words[1]) : await operation.resume(words[1]);
    return { success: result.status === "COMPLETE" || result.status === "CANCELLED", output: renderBatchResult(result) };
  }

  const action = first === "run" || first === "validate" ? first : "run";
  const file = action === first ? words[1] : words[0];
  const expectedWords = action === first ? 2 : 1;
  if (!file || words.length !== expectedWords) return { success: false, output: USAGE };
  const spec = loadSpec(file, config);
  if (action === "validate") {
    const batch = spec as { objective: string; units: Array<{ id: string; dependsOn?: string[] }> };
    const rows = batch.units.map((unit) => `  ${unit.id}${unit.dependsOn?.length ? ` ← ${unit.dependsOn.join(", ")}` : ""}`);
    return { success: true, output: [`Batch specification is valid: ${batch.objective}`, ...rows].join("\n") };
  }
  const result = await operation.run(spec);
  return { success: result.status === "COMPLETE", output: renderBatchResult(result) };
}
