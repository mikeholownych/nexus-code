/**
 * Convergence scheduling: an operation is a set of work units with dependencies, driven toward its objective.
 *
 * A resource becoming unavailable is not the work becoming unavailable. When a resource condition changes the
 * scheduler reroutes to a qualified alternate if one is eligible, otherwise parks the affected unit and continues
 * other eligible work; the operation waits only when no productive work remains, and blocks only when no safe
 * autonomous transition exists, in which case it asks for one concrete decision.
 *
 * The scheduler is pure decision logic over durable state; the OperationRunner owns time, execution and
 * persistence. Provider recovery stays beneath it: the recovery controller decides how one inference step survives
 * a failure; the scheduler decides what to work on next.
 *
 * Lifecycle (the one model for durable autonomous work; `nexus operation` and `/team` both use it):
 *
 *   unit COMPLETE              its turn completed with an established result: turnSucceeded(TurnResult), the same
 *                              predicate as `nexus run` exit 0 (VERIFIED, or NOT_REQUIRED). UNVERIFIED work is not
 *                              complete. A function returning is not completion.
 *   unit PARKED                a qualified resource will be eligible again at a known time; nothing is held.
 *   unit WAITING_ON_DEPENDENCY a dependency is not COMPLETE (a BLOCKED dependency keeps it here: it never runs on
 *                              unfinished inputs).
 *   unit BLOCKED               no safe autonomous transition: terminal execution failure, unknown execution with
 *                              its replay budget spent, an interrupted tool, or no qualified resource. Carries one
 *                              structured decision; only an applied operator decision moves it on.
 *   operation RUNNING          (active) some unit is runnable or running.
 *   operation WAITING          nothing can run now and some required work is parked on a known time.
 *   operation BLOCKED          nothing can run or wait; required work needs a decision.
 *   operation COMPLETE         every required unit is COMPLETE (advisory units are reported, never awaited).
 *   operation CANCELLED        the operator stopped it; units and their history are preserved.
 *
 * There is no separate FAILED state: a failed unit is BLOCKED on a decision (retry, revise, reassign, stop), and
 * environmental conditions are never failures (they park or reroute).
 *
 * Boundary: an interactive turn (REPL, TUI sidecar, `nexus run`) stays a direct runTurn — one turn, whose
 * TurnResult is the outcome, with provider recovery and context admission inside it. Work that has dependencies,
 * must outlive a resource becoming unavailable, may wait, or must resume after a restart is an operation.
 * spawn_subagent is in-turn delegation: its result is a tool result of the parent's (durable) turn.
 */
import type { AgentRole } from "./roles.js";
import type { ResourceConditionRecord, ResourceDescriptor, ResourceRegistry, WorkRequirements } from "./resources.js";
import type { InferenceFailure } from "./turn.js";
import { REVISION_MARKER } from "./scheduler.js";
export { ConvergenceScheduler, DecisionRejected, isRequired } from "./scheduler.js";

export type WorkUnitStatus = "RUNNABLE" | "RUNNING" | "PARKED" | "WAITING_ON_DEPENDENCY" | "COMPLETE" | "BLOCKED";
export type OperationStatus = "RUNNING" | "WAITING" | "BLOCKED" | "COMPLETE" | "CANCELLED";

/** The task a unit was given before any operator revision (its conversation began with this). */
export function unitBaseTask(prompt: string): string {
  const at = prompt.indexOf(REVISION_MARKER);
  return at < 0 ? prompt : prompt.slice(0, at);
}

/** What applying a decision option does. Every option Nexus offers is one of these; nothing else is accepted. */
export type DecisionAction =
  /**
   * Run the unit again from its history; where execution was unknown this authorizes the replay. `restart` starts it
   * over from its authorized task when its history cannot be recovered (its verification obligation is kept).
   */
  | { kind: "retry"; clearResources?: string[]; restart?: boolean }
  /** Restart the wait bound and keep waiting for the parked resources. */
  | { kind: "keep_waiting" }
  /** Run the unit on this resource, accepting the listed unmet requirements (never the trust boundary). */
  | { kind: "assign"; resourceId: string; overriding: string[] }
  /** Append the operator's note to the unit's task and run it again. */
  | { kind: "revise" }
  /** Drop an advisory unit (required units cannot be dropped: the objective would be unmet). */
  | { kind: "drop" }
  | { kind: "cancel_operation" }
  | { kind: "accept_no_change" };

export interface DecisionOption {
  id: string;
  label: string;
  action: DecisionAction;
}

export type BlockCause =
  | "EXECUTION_FAILED"
  | "MERGE_CONFLICT"
  | "INTEGRATION_FAILED"
  | "CONTEXT_BUDGET"
  | "EXECUTION_UNKNOWN"
  | "INTERRUPTED"
  | "NO_QUALIFIED_RESOURCE"
  | "RESOURCE_NEEDS_OPERATOR"
  | "WAIT_BOUND"
  | "RUN_BUDGET"
  | "NOT_CONVERGING";

/** The smallest decision that unblocks progress, with the concrete options Nexus can act on. */
export interface EscalationDecision {
  id: string;
  unitId: string;
  cause: BlockCause;
  question: string;
  options: DecisionOption[];
}

export interface AppliedDecision {
  decisionId: string;
  optionId: string;
  label: string;
  action: DecisionAction;
  note?: string;
  at: string;
}

export interface WorkUnit {
  id: string;
  title: string;
  role?: AgentRole;
  prompt: string;
  dependsOn: string[];
  requires: WorkRequirements;
  /** False for advisory work: reported, run when possible, never awaited for completion. */
  required?: boolean;
  /** X-Task-Class routing hint for this unit (used when the resource has none of its own). */
  taskClass?: string;
  status: WorkUnitStatus;
  /** Resource the unit last ran on (its conversation continues from there). */
  assignment?: { resourceId: string; model: string; since: string };
  /** Operator-authorized assignment that replaces requirement matching for this unit. */
  override?: { resourceId: string; overriding: string[]; decisionId: string };
  /** Durable task state holding the unit's conversation, for resumption without live model context. */
  agentTaskId?: string;
  parked?: { since: string; reason: string; resourceIds: string[]; wakeAt?: string };
  blocked?: { since: string; reason: string; decision: EscalationDecision };
  /** A decision applied since the unit last ran, told to the unit when it resumes. */
  pendingDecision?: { label: string; note?: string; restart?: boolean };
  decisions?: AppliedDecision[];
  dropped?: boolean;
  result?: { summary: string; completedAt: string; resourceId: string; outcome: string; overriding?: string[] };
  reroutes: Array<{ at: string; from: string; to: string; reason: string }>;
  runs: number;
  /** `runs` when the operator last authorized more attempts (the run budget counts from here). */
  runsBase?: number;
  /** Executions started whose inference outcome was never received (process ended mid-run). */
  unknownResumes: number;
  modelsUsed: string[];
  /**
   * Operator cap on this unit's prompt context, in tokens. The resource's advertised capacity still applies; a unit
   * whose start prompt cannot fit this budget is blocked before any inference.
   */
  contextBudget?: number;
  /** What the unit's start prompt was estimated to need, and the budget it was checked against. */
  context?: { estimatedPromptTokens: number; budgetTokens: number; contextLimit: number; at: string };
}

export type OperationEventType =
  | "RESOURCE_INELIGIBLE"
  | "RESOURCE_ELIGIBLE"
  | "WORK_STARTED"
  | "WORK_COMPLETED"
  | "WORK_REROUTED"
  | "WORK_PARKED"
  | "WORK_RESUMED"
  | "WORK_BLOCKED"
  | "CONTINUING_INDEPENDENT_WORK"
  | "OPERATION_WAITING"
  | "OPERATION_RESUMED"
  | "OPERATION_BLOCKED"
  | "OPERATION_COMPLETED"
  | "OPERATION_CANCELLED"
  | "DECISION_APPLIED";

export interface OperationEvent {
  type: OperationEventType;
  at: string;
  /** What it means, for the operator. */
  message: string;
  unitId?: string;
  resourceId?: string;
  detail?: Record<string, unknown>;
}

export interface OperationPolicy {
  /** How long the operation may wait with nothing runnable before asking for a decision. */
  maxWaitMs: number;
  /** Executions restarted after their outcome was lost; matches the UNKNOWN inference replay bound. */
  unknownResumeBudget: number;
  /** Runs of one unit before the scheduler stops retrying it. */
  maxRunsPerUnit: number;
  /** Floor between WAITING wake-ups. */
  minWaitMs: number;
}

export const DEFAULT_OPERATION_POLICY: OperationPolicy = {
  maxWaitMs: 12 * 60 * 60_000,
  unknownResumeBudget: 2,
  maxRunsPerUnit: 25,
  minWaitMs: 1_000,
};

/** One unit's worktree/branch in an isolated operation. */
export interface OperationGitUnit {
  branch: string;
  worktree: string;
  /** Integration tip the branch was created from. */
  baseCommit: string;
  /** Integration tip after the unit was merged (absent until it is). */
  integratedCommit?: string;
}

/** Opt-in Git isolation for an operation (`spec.git.isolate`). */
export interface OperationGitState {
  isolate: true;
  repoRoot: string;
  baseRef: string;
  baseCommit: string;
  integrationBranch: string;
  integrationWorktree: string;
  baseDir: string;
  units: Record<string, OperationGitUnit>;
}

/** A durable snapshot of a unit's conversation, restorable by the operator. */
export interface ContextCheckpoint {
  unitId: string;
  name: string;
  at: string;
  taskId: string;
  messages: number;
  bytes: number;
}

/** What was integrated, and the evidence the merge was accepted with. */
export interface IntegrationReceipt {
  unitId: string;
  branch: string;
  commit: string;
  integratedCommit: string;
  mergedAt: string;
  files: string[];
  outcome: string;
  summary: string;
  verification: "PASSED" | "PASSED_POSTHOC" | "NOT_RUN" | "ALREADY_INTEGRATED" | "ALREADY_MERGED" | "NO_CHANGES";
}

export interface DurableOperationState {
  schemaVersion: 1;
  id: string;
  objective: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  units: WorkUnit[];
  resources: ResourceDescriptor[];
  conditions: ResourceConditionRecord[];
  wait?: { since: string; wakeAt: string; reason: string; parkedUnits: string[] };
  blocked?: { since: string; decisions: EscalationDecision[] };
  events: OperationEvent[];
  policy: OperationPolicy;
  decisions?: AppliedDecision[];
  /** Present only for an isolated operation; absent keeps the original in-place behaviour. */
  git?: OperationGitState;
  /** Accepted unit integrations, oldest first. */
  integrations?: IntegrationReceipt[];
  /** Operator-created conversation snapshots, oldest first. */
  contextCheckpoints?: ContextCheckpoint[];
}

/** An option before it is numbered into a decision. */
export interface OptionSpec {
  label: string;
  action: DecisionAction;
}

export interface BlockSpec {
  cause: BlockCause;
  reason: string;
  question: string;
  options: OptionSpec[];
  /** Also offer assigning the unit to each other resource it may use (the scheduler knows which). */
  offerReassign?: boolean;
}

export type UnitRunResult =
  | {
      kind: "completed";
      summary: string;
      outcome: string;
      /** The verifier that produced the unit's outcome, for the integration check on the merged tree. */
      verification?: { command: string; status: string; hasExecutedTests: boolean };
    }
  /** The resource could not take the work and nothing executed (or the condition is recorded at resource scope). */
  | { kind: "resource_unavailable"; failure: InferenceFailure; condition: ResourceConditionRecord }
  /** Inference may have executed and its bounded replays are spent: never resubmitted elsewhere automatically. */
  | { kind: "execution_unknown"; failure: InferenceFailure }
  | ({ kind: "failed" } & BlockSpec)
  | { kind: "cancelled" };

export type Decision =
  | { kind: "run"; unit: WorkUnit; resource: ResourceDescriptor; reroutedFrom?: { resourceId: string; reason: string } }
  | { kind: "wait"; wakeAt: number; reason: string; parked: string[] }
  | { kind: "complete" }
  | { kind: "blocked"; decisions: EscalationDecision[] };

/** An operator decision Nexus will not apply (stale, not offered, or outside the unit's authority). */
export interface WorkUnitSpec {
  id: string;
  title?: string;
  role?: AgentRole;
  prompt: string;
  dependsOn?: string[];
  requires?: WorkRequirements;
  required?: boolean;
  taskClass?: string;
  /** Operator cap on this unit's prompt context, in tokens. */
  contextBudget?: number;
}

export function newOperation(
  id: string,
  objective: string,
  units: WorkUnitSpec[],
  resources: ResourceDescriptor[],
  now: number,
  policy: Partial<OperationPolicy> = {},
): DurableOperationState {
  const ids = new Set<string>();
  for (const u of units) {
    if (!u.id || ids.has(u.id)) throw new Error(`Work unit ids must be unique and non-empty (got '${u.id}')`);
    ids.add(u.id);
  }
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    for (const d of u.dependsOn ?? []) {
      if (!ids.has(d)) throw new Error(`Work unit '${u.id}' depends on unknown unit '${d}'`);
      if (u.required !== false && byId.get(d)!.required === false) {
        throw new Error(`Required work unit '${u.id}' depends on advisory unit '${d}'; mark '${d}' required or drop the dependency`);
      }
    }
    for (const d of u.requires?.independentOf ?? []) if (!ids.has(d)) throw new Error(`Work unit '${u.id}' is independent of unknown unit '${d}'`);
  }
  if (!units.some((u) => u.required !== false)) throw new Error("An operation needs at least one required work unit");
  assertAcyclic(units);
  const at = new Date(now).toISOString();
  return {
    schemaVersion: 1,
    id,
    objective,
    status: "RUNNING",
    createdAt: at,
    updatedAt: at,
    units: units.map((u) => ({
      id: u.id,
      title: u.title ?? u.id,
      ...(u.role ? { role: u.role } : {}),
      prompt: u.prompt,
      dependsOn: u.dependsOn ?? [],
      requires: u.requires ?? {},
      ...(u.required === false ? { required: false } : {}),
      ...(u.taskClass ? { taskClass: u.taskClass } : {}),
      ...(u.contextBudget !== undefined ? { contextBudget: u.contextBudget } : {}),
      status: "WAITING_ON_DEPENDENCY",
      reroutes: [],
      runs: 0,
      unknownResumes: 0,
      modelsUsed: [],
    })),
    resources: resources.map((r) => ({ ...r })),
    conditions: [],
    events: [],
    policy: { ...DEFAULT_OPERATION_POLICY, ...policy },
  };
}

function assertAcyclic(units: WorkUnitSpec[]): void {
  const deps = new Map(units.map((u) => [u.id, u.dependsOn ?? []]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`Work unit dependency cycle: ${[...path, id].join(" -> ")}`);
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const u of units) visit(u.id, []);
}
