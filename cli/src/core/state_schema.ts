/** Current durable task/session format. Config and release metadata have independent schemas. */
import { validateBranchName } from "../worktrunk/paths.js";

export const CURRENT_STATE_SCHEMA_VERSION = 2;

/** Version of the worktree binding shape itself (independent of the task-state schema version). */
export const WORKTREE_BINDING_VERSION = 1;

/** Durable controller state for `/loop`; its own version is independent of the task envelope. */
export type DurableLoopCondition =
  | { kind: "verification"; command: string }
  | { kind: "artifact"; path: string; command: string }
  | { kind: "criteria"; text: string; command?: string };

export type DurableLoopStatus = "RUNNING" | "PAUSE_REQUESTED" | "STOP_REQUESTED" | "PAUSED" | "BLOCKED" | "UNKNOWN_EFFECT" | "EXHAUSTED" | "COMPLETE" | "CANCELLED";

export interface DurableLoopIteration {
  number: number;
  operationId: string;
  status: "RUNNING" | "COMPLETE" | "FAILED" | "BLOCKED" | "UNKNOWN_EFFECT";
  startedAt: string;
  completedAt?: string;
  verifier?: { command: string; status: string; hasExecutedTests: boolean; definitionBound?: false };
  reviewer?: { verdict: "ACCEPT" | "REJECT" | "MISSING"; modelIds: string[] };
  beforeFingerprint?: string;
  afterFingerprint?: string;
  progress: "CHANGED" | "UNCHANGED" | "UNKNOWN";
  summary?: string;
  actualUsage?: { agentRuns: number; reportedTokens: number; estimatedTokens: number; inferenceRequests: number };
}

export interface DurableLoopState {
  schemaVersion: 1;
  id: string;
  originalObjective: string;
  condition?: DurableLoopCondition;
  maxIterations: number;
  maxDurationMs: number;
  startedAt: string;
  deadlineAt: string;
  updatedAt: string;
  status: DurableLoopStatus;
  currentOperationId?: string;
  currentIteration?: number;
  pauseRequestedAt?: string;
  stopRequestedAt?: string;
  iterations: DurableLoopIteration[];
  noProgressStreak: number;
  repeatedFailureStreak: number;
  actualUsage: { agentRuns: number; reportedTokens: number; estimatedTokens: number; inferenceRequests: number };
  evidenceRefs: string[];
  reconciliations: Array<{ operationId: string; decision: "OPERATOR_CONFIRMED_NO_EFFECT"; at: string }>;
  reason?: string;
}

const LOOP_STATUSES = new Set<DurableLoopStatus>(["RUNNING", "PAUSE_REQUESTED", "STOP_REQUESTED", "PAUSED", "BLOCKED", "UNKNOWN_EFFECT", "EXHAUSTED", "COMPLETE", "CANCELLED"]);

/** Structural guard for loop state before any lifecycle code reads or rewrites it. */
export function durableLoopStateProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Loop state is not an object";
  const state = value as Partial<DurableLoopState>;
  if (state.schemaVersion !== 1) return `Loop state has unsupported schema version ${String(state.schemaVersion)}`;
  if (typeof state.id !== "string" || !/^loop-[0-9a-f-]{36}$/i.test(state.id)) return "Loop state has an invalid id";
  if (typeof state.originalObjective !== "string" || !state.originalObjective.trim() || state.originalObjective.length > 24_000) return "Loop state has an invalid original objective";
  if (!Number.isSafeInteger(state.maxIterations) || (state.maxIterations as number) < 1 || (state.maxIterations as number) > 100) return "Loop state maxIterations is outside 1..100";
  if (!Number.isSafeInteger(state.maxDurationMs) || (state.maxDurationMs as number) < 1_000 || (state.maxDurationMs as number) > 86_400_000) return "Loop state maxDurationMs is outside 1000..86400000";
  if (!LOOP_STATUSES.has(state.status as DurableLoopStatus)) return `Loop state has invalid status ${String(state.status)}`;
  for (const [field, value] of [["startedAt", state.startedAt], ["deadlineAt", state.deadlineAt], ["updatedAt", state.updatedAt]] as const) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return `Loop state ${field} is invalid`;
  }
  if ((state.currentOperationId === undefined) !== (state.currentIteration === undefined)) return "Loop current operation identity is incomplete";
  if (state.currentOperationId !== undefined && (typeof state.currentOperationId !== "string" || !/^loop-[0-9a-f-]{36}-i\d{3}$/i.test(state.currentOperationId) || !Number.isSafeInteger(state.currentIteration) || (state.currentIteration as number) < 1 || (state.currentIteration as number) > (state.maxIterations as number))) return "Loop current operation identity is invalid";
  if (!Array.isArray(state.iterations) || state.iterations.length > (state.maxIterations as number)) return "Loop state iterations are invalid";
  if (!Number.isSafeInteger(state.noProgressStreak) || (state.noProgressStreak as number) < 0 || !Number.isSafeInteger(state.repeatedFailureStreak) || (state.repeatedFailureStreak as number) < 0) return "Loop state progress counters are invalid";
  if (!state.actualUsage || Object.values(state.actualUsage).some((count) => !Number.isSafeInteger(count) || count < 0)) return "Loop state usage counters are invalid";
  if (!Array.isArray(state.evidenceRefs) || state.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length > 200)) return "Loop state evidence references are invalid";
  if (!Array.isArray(state.reconciliations) || state.reconciliations.some((entry) => !entry || typeof entry.operationId !== "string" || !/^loop-[0-9a-f-]{36}-i\d{3}$/i.test(entry.operationId) || !entry.operationId.startsWith(`${state.id}-i`) || entry.decision !== "OPERATOR_CONFIRMED_NO_EFFECT" || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at)))) return "Loop reconciliation records are invalid";
  if (state.condition) {
    const condition = state.condition;
    if (!condition || typeof condition !== "object" || !["verification", "artifact", "criteria"].includes(condition.kind)) return "Loop state condition is invalid";
    if (condition.kind === "verification" && (typeof condition.command !== "string" || !condition.command.trim() || condition.command.length > 4096)) return "Loop verification command is invalid";
    if (condition.kind === "artifact" && (typeof condition.path !== "string" || !condition.path.trim() || condition.path.length > 1024 || typeof condition.command !== "string" || !condition.command.trim() || condition.command.length > 4096)) return "Loop artifact condition is invalid";
    if (condition.kind === "criteria" && (typeof condition.text !== "string" || !condition.text.trim() || condition.text.length > 4000 || (condition.command !== undefined && (typeof condition.command !== "string" || !condition.command.trim() || condition.command.length > 4096)))) return "Loop acceptance criteria are invalid";
  }
  for (let index = 0; index < state.iterations.length; index++) {
    const iteration = state.iterations[index];
    if (!iteration || iteration.number !== index + 1 || iteration.operationId !== `${state.id}-i${String(index + 1).padStart(3, "0")}` || !["RUNNING", "COMPLETE", "FAILED", "BLOCKED", "UNKNOWN_EFFECT"].includes(iteration.status)) return `Loop iteration ${index + 1} is invalid`;
    if (!["CHANGED", "UNCHANGED", "UNKNOWN"].includes(iteration.progress)) return `Loop iteration ${index + 1} progress is invalid`;
    if (typeof iteration.startedAt !== "string" || !Number.isFinite(Date.parse(iteration.startedAt)) || (iteration.completedAt !== undefined && (typeof iteration.completedAt !== "string" || !Number.isFinite(Date.parse(iteration.completedAt))))) return `Loop iteration ${index + 1} timestamps are invalid`;
    if (iteration.actualUsage && Object.values(iteration.actualUsage).some((count) => !Number.isSafeInteger(count) || count < 0)) return `Loop iteration ${index + 1} usage counters are invalid`;
    if (iteration.reviewer && (!Array.isArray(iteration.reviewer.modelIds) || iteration.reviewer.modelIds.some((model) => typeof model !== "string"))) return `Loop iteration ${index + 1} reviewer receipt is invalid`;
  }
  return undefined;
}

export type WorktreeBindingKind = "task" | "named";

/** The binding fields the normaliser reads and fills; the durable type in state.ts extends this shape. */
export interface WorktreeBindingShape {
  branch?: unknown;
  kind?: WorktreeBindingKind;
  bindingVersion?: number;
}

export type WorktreeBindingProblem =
  | { problem: "corrupt"; reason: string }
  | { problem: "unsupported"; version: number };

/**
 * The one set of rules for a worktree binding, applied on every save and every load so the two cannot drift.
 * Migrates in place: a record with neither `kind` nor `bindingVersion` (written before the fields existed) is a task
 * binding at the current version. A version without a kind, an unknown kind, a malformed version or a named binding
 * whose branch is unusable is corruption; a newer version is unsupported (fail closed rather than read with today's
 * rules). Returns undefined when the binding is valid.
 */
export function normalizeWorktreeBinding(binding: WorktreeBindingShape): WorktreeBindingProblem | undefined {
  if (binding.kind === undefined) {
    if (binding.bindingVersion !== undefined) return { problem: "corrupt", reason: "Worktree binding has a version but no kind" };
    binding.kind = "task";
    binding.bindingVersion = WORKTREE_BINDING_VERSION;
    return undefined;
  }
  if (binding.kind !== "task" && binding.kind !== "named") return { problem: "corrupt", reason: "Worktree binding has an unknown kind" };
  const version = binding.bindingVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return { problem: "corrupt", reason: "Worktree binding has no valid version" };
  if ((version as number) > WORKTREE_BINDING_VERSION) return { problem: "unsupported", version: version as number };
  if (binding.kind === "named" && (typeof binding.branch !== "string" || validateBranchName(binding.branch) !== undefined)) {
    return { problem: "corrupt", reason: "Named worktree binding has an invalid branch" };
  }
  return undefined;
}
