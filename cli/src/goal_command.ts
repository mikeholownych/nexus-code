import { GoalOrchestrator, goalEvidenceRows, goalRequirementRows, type GoalResult } from "./goal.js";
import { parseBatchWords } from "./batch.js";
import type { OperationEvent } from "./core/operation.js";
import type { HarnessConfig } from "./types.js";

export interface GoalCommandResult {
  success: boolean;
  output: string;
}

const USAGE = [
  "Usage: /goal <objective>",
  "       /goal status [id] | list | show <id>",
  "       /goal pause [id] | resume [id] | cancel [id]",
  "       /goal requirements [id] | evidence [id]",
  "       /goal requirements accept <goal-id> <requirement-id>",
  "       /goal requirements descope <goal-id> <requirement-id> <reason>",
].join("\n");

function renderGoal(result: GoalResult, detailed = false): string {
  const operation = result.operation;
  const rows = [`Goal ${result.id}: ${result.status}`, `Objective: ${operation.objective}`];
  if (result.reason) rows.push(`Outstanding: ${result.reason}`);
  if (operation.pauseReason && !result.reason?.includes(operation.pauseReason)) rows.push(`Paused: ${operation.pauseReason}`);
  if (result.usage) rows.push(`Usage: ${result.usage.agentRuns} agent runs, ${result.usage.reportedTokens} reported tokens, ${result.usage.estimatedTokens} estimated tokens, ${result.usage.inferenceRequests} inference requests`);
  rows.push("", "Work units:");
  for (const unit of operation.units) {
    rows.push(`  ${unit.id}: ${unit.status}${unit.dependsOn.length ? ` (after ${unit.dependsOn.join(", ")})` : ""}${unit.required === false ? " (advisory)" : ""}`);
    if (unit.result?.summary) rows.push(`    ${unit.result.summary}`);
    if (unit.blocked?.reason) rows.push(`    blocked: ${unit.blocked.reason}`);
  }
  if (detailed) rows.push("", "Requirements:", ...goalRequirementRows(result).map((line) => `  ${line}`));
  if (!detailed && result.status !== "COMPLETE" && result.status !== "CANCELLED") rows.push("", `Resume with: /goal resume ${result.id}`);
  return rows.join("\n");
}

function listGoals(orchestrator: GoalOrchestrator): GoalCommandResult {
  const goals = orchestrator.list();
  return {
    success: true,
    output: goals.length ? goals.map((goal) => `${goal.id}  ${goal.status}  ${goal.operation.objective}${goal.reason ? ` — ${goal.reason}` : ""}`).join("\n") : "No goals in this workspace.",
  };
}

/** Shared by REPL and sidecar so every terminal entry point drives the same durable goal records. */
export async function executeGoalCommand(
  args: string,
  config: HarnessConfig,
  signal?: AbortSignal,
  onEvent?: (event: OperationEvent) => void,
): Promise<GoalCommandResult> {
  const first = /^\s*(\S+)/u.exec(args)?.[1]?.toLowerCase();
  const commandWords = new Set(["status", "list", "show", "pause", "resume", "cancel", "requirements", "evidence"]);
  const words = first && commandWords.has(first) ? parseBatchWords(args) : [];
  const orchestrator = new GoalOrchestrator(config, { signal, onEvent, maxInProcessWaitMs: 60_000 });
  if (!args.trim()) return { success: false, output: USAGE };
  if (first === "list") {
    if (words.length !== 1) return { success: false, output: "Usage: /goal list" };
    return listGoals(orchestrator);
  }
  if (first === "status" || first === "show" || first === "evidence") {
    if ((first === "show" && words.length !== 2) || words.length > 2) return { success: false, output: `Usage: /goal ${first}${first === "show" ? " <id>" : " [id]"}` };
    const result = orchestrator.results(words[1]);
    if (first === "evidence") return { success: true, output: goalEvidenceRows(result.operation).join("\n") || "No goal evidence recorded." };
    return { success: result.status === "COMPLETE", output: renderGoal(result, first === "show") };
  }
  if (first === "requirements") {
    const action = words[1]?.toLowerCase();
    if (action === "accept") {
      if (words.length !== 4) return { success: false, output: "Usage: /goal requirements accept <goal-id> <requirement-id>" };
      const ledger = orchestrator.updateDescoping("accept", words[3], undefined, words[2]);
      const requirement = ledger.requirements.find((item) => item.id === words[3]);
      return { success: true, output: `Operator acceptance recorded for ${words[3]}${requirement ? `: ${requirement.text}` : ""}.` };
    }
    if (action === "descope") {
      if (words.length < 5) return { success: false, output: "Usage: /goal requirements descope <goal-id> <requirement-id> <reason>" };
      const ledger = orchestrator.updateDescoping("descope", words[3], words.slice(4).join(" "), words[2]);
      return { success: true, output: `Requirement ${words[3]} marked descoped with the operator's reason. Run /goal requirements accept ${words[2]} ${words[3]} to approve the scope reduction.\n${ledger.requirements.find((item) => item.id === words[3])?.text ?? ""}` };
    }
    if (words.length > 2) return { success: false, output: "Usage: /goal requirements [id]" };
    const result = orchestrator.results(words[1]);
    return { success: true, output: [`Requirements for ${result.id}:`, ...goalRequirementRows(result)].join("\n") };
  }
  if (first === "pause" || first === "resume" || first === "cancel") {
    if (words.length > 2) return { success: false, output: `Usage: /goal ${first} [id]` };
    const result = first === "pause" ? await orchestrator.pause(words[1]) : first === "resume" ? await orchestrator.resume(words[1]) : await orchestrator.cancel(words[1]);
    return { success: result.status === "COMPLETE" || result.status === "CANCELLED" || result.status === "PAUSED", output: renderGoal(result) };
  }
  if (first?.startsWith("--")) return { success: false, output: `Unknown /goal option '${first}'.\n${USAGE}` };
  const result = await orchestrator.start(args.trim());
  return { success: result.status === "COMPLETE", output: renderGoal(result) };
}
