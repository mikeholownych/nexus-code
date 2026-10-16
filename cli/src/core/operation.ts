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

export type WorkUnitStatus = "RUNNABLE" | "RUNNING" | "PARKED" | "WAITING_ON_DEPENDENCY" | "COMPLETE" | "BLOCKED";
export type OperationStatus = "RUNNING" | "WAITING" | "BLOCKED" | "COMPLETE" | "CANCELLED";

/** Separates a unit's task from the operator revisions appended to it. */
const REVISION_MARKER = "\n\nOperator revision: ";

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
  | { kind: "completed"; summary: string; outcome: string }
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
export class DecisionRejected extends Error {}

const MAX_EVENTS = 300;
const TERMINAL: WorkUnitStatus[] = ["COMPLETE", "BLOCKED"];

export const isRequired = (u: Pick<WorkUnit, "required">): boolean => u.required !== false;

export interface WorkUnitSpec {
  id: string;
  title?: string;
  role?: AgentRole;
  prompt: string;
  dependsOn?: string[];
  requires?: WorkRequirements;
  required?: boolean;
  taskClass?: string;
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

function clockTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + " UTC";
}

export class ConvergenceScheduler {
  constructor(
    readonly state: DurableOperationState,
    readonly registry: ResourceRegistry,
    private readonly now: () => number,
    private readonly onEvent?: (e: OperationEvent) => void,
  ) {}

  unit(id: string): WorkUnit {
    const u = this.state.units.find((x) => x.id === id);
    if (!u) throw new Error(`Unknown work unit ${id}`);
    return u;
  }

  emit(type: OperationEventType, message: string, extra: Omit<OperationEvent, "type" | "at" | "message"> = {}): void {
    const event: OperationEvent = { type, at: new Date(this.now()).toISOString(), message, ...extra };
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    try {
      this.onEvent?.(event);
    } catch {}
  }

  private excludedModels(u: WorkUnit): Set<string> {
    return new Set((u.requires.independentOf ?? []).flatMap((id) => this.unit(id).modelsUsed));
  }

  /**
   * Re-derives every non-terminal unit's status from dependencies and resource eligibility, then chooses the next
   * transition. Called after every change (completion, resource condition, wake), never acting on stale state.
   */
  decide(): Decision {
    const now = this.now();
    if (this.state.status === "CANCELLED") return { kind: "blocked", decisions: [] };
    const previous = new Map(this.state.units.map((u) => [u.id, u.status]));
    const choices = new Map<string, { resource: ResourceDescriptor; reroutedFrom?: { resourceId: string; reason: string } }>();

    for (const u of this.state.units) {
      if (TERMINAL.includes(u.status) || u.status === "RUNNING") continue;
      const deps = u.dependsOn.map((d) => this.unit(d));
      if (deps.some((d) => d.status !== "COMPLETE")) {
        u.status = "WAITING_ON_DEPENDENCY";
        delete u.parked;
        continue;
      }
      const sel = u.override ? this.overrideSelection(u, now) : this.registry.select(u.requires, this.excludedModels(u), now);
      if (sel.chosen) {
        u.status = "RUNNABLE";
        const from = u.assignment?.resourceId;
        let reroutedFrom: { resourceId: string; reason: string } | undefined;
        if (from && from !== sel.chosen.id) {
          const prior = this.registry.get(from);
          const elig = prior ? this.registry.eligibility(prior, now) : undefined;
          const reason = !prior
            ? "previous resource is no longer configured"
            : u.override?.resourceId === sel.chosen.id
              ? `operator assigned ${sel.chosen.id}`
              : elig && !elig.eligible
                ? elig.blocking.map((b) => b.reason).join("; ")
                : `${sel.chosen.id} is the preferred qualified resource`;
          reroutedFrom = { resourceId: from, reason };
        }
        choices.set(u.id, { resource: sel.chosen, ...(reroutedFrom ? { reroutedFrom } : {}) });
        continue;
      }
      const temporary = sel.qualified.filter((c) => !c.eligibility.permanent && c.eligibility.eligibleAt !== undefined);
      if (temporary.length) {
        const wakeAt = Math.min(...temporary.map((c) => c.eligibility.eligibleAt!));
        const reason = temporary
          .map((c) => `${c.resource.id} ${c.eligibility.blocking.map((b) => b.reason).join(", ")}`)
          .join("; ");
        const wasParked = u.status === "PARKED";
        u.status = "PARKED";
        u.parked = {
          since: wasParked && u.parked ? u.parked.since : new Date(now).toISOString(),
          reason,
          resourceIds: temporary.map((c) => c.resource.id),
          wakeAt: new Date(wakeAt).toISOString(),
        };
        continue;
      }
      this.block(u, this.noQualifiedResource(u, sel));
    }

    for (const u of this.state.units) {
      const before = previous.get(u.id);
      if (u.status === "PARKED" && before !== "PARKED") {
        const others = this.productiveOthers(u.id, choices);
        this.emit(
          "WORK_PARKED",
          `${u.title} parked: ${u.parked!.reason}; eligible again ${clockTime(Date.parse(u.parked!.wakeAt!))}.` +
            (others ? ` Continuing ${others} independent ${others === 1 ? "task" : "tasks"}.` : ""),
          { unitId: u.id, detail: { parked: u.parked } },
        );
      }
    }

    // Required work first; advisory work runs when it can but never ahead of the objective.
    const runnable = this.state.units
      .filter((u) => u.status === "RUNNABLE" && choices.has(u.id))
      .sort((a, b) => Number(!isRequired(a)) - Number(!isRequired(b)));
    if (runnable.length) {
      const unit = runnable[0];
      const choice = choices.get(unit.id)!;
      return { kind: "run", unit, resource: choice.resource, ...(choice.reroutedFrom ? { reroutedFrom: choice.reroutedFrom } : {}) };
    }

    if (this.state.units.filter(isRequired).every((u) => u.status === "COMPLETE")) return { kind: "complete" };

    const parked = this.state.units.filter((u) => u.status === "PARKED");
    if (parked.length) {
      const waitSince = this.state.wait ? Date.parse(this.state.wait.since) : now;
      if (now - waitSince >= this.state.policy.maxWaitMs) {
        for (const u of parked) this.block(u, this.waitBound(u, now - waitSince));
        return this.decide();
      }
      const wakeAt = Math.max(now + this.state.policy.minWaitMs, Math.min(...parked.map((u) => Date.parse(u.parked!.wakeAt!))));
      return {
        kind: "wait",
        wakeAt,
        reason: parked.map((u) => `${u.title}: ${u.parked!.reason}`).join("; "),
        parked: parked.map((u) => u.id),
      };
    }

    const decisions = this.state.units.filter((u) => u.status === "BLOCKED" && u.blocked).map((u) => u.blocked!.decision);
    return { kind: "blocked", decisions };
  }

  /** The operator-assigned resource, if eligible; parks on it when temporarily unavailable. */
  private overrideSelection(u: WorkUnit, now: number): ReturnType<ResourceRegistry["select"]> {
    const r = this.registry.get(u.override!.resourceId);
    if (!r) return { qualified: [], rejected: [{ resourceId: u.override!.resourceId, reasons: ["no longer configured"] }] };
    const eligibility = this.registry.eligibility(r, now);
    return { ...(eligibility.eligible ? { chosen: r } : {}), qualified: [{ resource: r, eligibility }], rejected: [] };
  }

  private productiveOthers(exceptId: string, choices: Map<string, unknown>): number {
    return this.state.units.filter((u) => u.id !== exceptId && (u.status === "RUNNING" || (u.status === "RUNNABLE" && choices.has(u.id)))).length;
  }

  /** Resources the operator may assign `u` to, with the requirements each would override (never trust). */
  private assignable(u: WorkUnit, exclude: string[] = []): OptionSpec[] {
    const excluded = this.excludedModels(u);
    const out: OptionSpec[] = [];
    for (const r of this.registry.list()) {
      if (exclude.includes(r.id)) continue;
      if (u.requires.minTrust && this.registry.qualifies(r, { minTrust: u.requires.minTrust }, new Set()).length) continue;
      const overriding = this.registry.qualifies(r, u.requires, excluded);
      out.push({
        label: overriding.length ? `assign to ${r.id} despite: ${overriding.join(", ")}` : `assign to ${r.id}`,
        action: { kind: "assign", resourceId: r.id, overriding },
      });
    }
    return out;
  }

  private noQualifiedResource(u: WorkUnit, sel: ReturnType<ResourceRegistry["select"]>): BlockSpec {
    if (sel.qualified.length) {
      const ids = sel.qualified.map((c) => c.resource.id);
      const why = sel.qualified.map((c) => `${c.resource.id}: ${c.eligibility.blocking.map((b) => b.reason).join(", ")}`).join("; ");
      return {
        cause: "RESOURCE_NEEDS_OPERATOR",
        reason: `every qualified resource is unavailable without a recovery window (${why})`,
        question: `${u.title} can only run on ${ids.join(", ")}, which need operator action (${why}). Fix the resource, or assign the unit elsewhere?`,
        options: [{ label: `retry after fixing ${ids.join(", ")}`, action: { kind: "retry", clearResources: ids } }, ...this.assignable(u, ids)],
      };
    }
    const req = u.requires;
    const need = [
      ...(req.capabilities ?? []).map((c) => `capability '${c}'`),
      ...(req.qualification ? [`qualification '${req.qualification}'`] : []),
      ...(req.minContext ? [`context >= ${req.minContext}`] : []),
      ...(req.independentOf?.length ? [`a model independent of ${req.independentOf.join(", ")}`] : []),
    ].join(", ");
    return {
      cause: "NO_QUALIFIED_RESOURCE",
      reason: `no configured resource is qualified (${sel.rejected.map((r) => `${r.resourceId}: ${r.reasons.join(", ")}`).join("; ")})`,
      question: `${u.title} needs ${need || "a qualified resource"}, and no configured resource provides it. Configure one and start a new operation, or relax the requirement?`,
      options: this.assignable(u),
    };
  }

  private waitBound(u: WorkUnit, waitedMs: number): BlockSpec {
    const ids = u.parked!.resourceIds;
    return {
      cause: "WAIT_BOUND",
      reason: `waited ${Math.round(waitedMs / 60_000)} min for ${ids.join(", ")}`,
      question: `${u.title} has waited longer than the operation's wait bound for ${ids.join(", ")}. Keep waiting, or assign it to another resource?`,
      options: [{ label: "keep waiting", action: { kind: "keep_waiting" } }, ...this.assignable(u, ids)],
    };
  }

  block(u: WorkUnit, why: BlockSpec): void {
    u.status = "BLOCKED";
    delete u.parked;
    const terminal: OptionSpec = isRequired(u)
      ? { label: "stop the operation", action: { kind: "cancel_operation" } }
      : { label: "drop this advisory unit", action: { kind: "drop" } };
    const options = [...why.options, terminal].map((o, i) => ({ id: String(i + 1), label: o.label, action: o.action }));
    const decision: EscalationDecision = { id: `${u.id}#${(u.decisions?.length ?? 0) + 1}`, unitId: u.id, cause: why.cause, question: why.question, options };
    u.blocked = { since: new Date(this.now()).toISOString(), reason: why.reason, decision };
    this.emit("WORK_BLOCKED", `${u.title} needs a decision: ${why.question}`, { unitId: u.id, detail: { reason: why.reason, cause: why.cause, decisionId: decision.id } });
  }

  /**
   * Applies an operator decision to a BLOCKED unit: validates it against the pending decision, records it durably
   * on the unit, and makes the unit schedulable again. The next decide() re-evaluates; nothing runs here.
   */
  resolve(decisionId: string, optionId: string, note?: string): AppliedDecision {
    if (this.state.status === "COMPLETE" || this.state.status === "CANCELLED") {
      throw new DecisionRejected(`Operation ${this.state.id} is ${this.state.status}; it has no pending decisions.`);
    }
    const u = this.state.units.find((x) => x.status === "BLOCKED" && x.blocked?.decision.id === decisionId);
    if (!u) {
      const opDecision = this.state.blocked?.decisions?.find((d) => d.id === decisionId);
      if (opDecision) {
        const option = opDecision.options.find((o) => o.id === optionId);
        if (!option) {
          throw new DecisionRejected(`Option '${optionId}' was not offered for ${decisionId} (offered: ${opDecision.options.map((o) => `${o.id}=${o.label}`).join("; ")}).`);
        }
        const action = option.action;
        const text = note?.trim();
        const applied: AppliedDecision = { decisionId, optionId, label: option.label, action, ...(text ? { note: text } : {}), at: new Date(this.now()).toISOString() };
        (this.state.decisions ??= []).push(applied);
        this.emit("DECISION_APPLIED", `Operation: operator chose "${option.label}"${text ? ` (${text})` : ""}.`, {
          detail: { decisionId, optionId, action },
        });
        if (action.kind === "cancel_operation") {
          this.cancel();
        } else {
          this.state.status = "RUNNING";
          delete this.state.blocked;
        }
        return applied;
      }
      const pending = [
        ...this.state.units.filter((x) => x.status === "BLOCKED" && x.blocked).map((x) => x.blocked!.decision.id),
        ...(this.state.blocked?.decisions?.map((d) => d.id) ?? []),
      ];
      throw new DecisionRejected(`No pending decision '${decisionId}' (pending: ${pending.join(", ") || "none"}).`);
    }
    const decision = u.blocked!.decision;
    const option = decision.options.find((o) => o.id === optionId);
    if (!option) {
      throw new DecisionRejected(`Option '${optionId}' was not offered for ${decisionId} (offered: ${decision.options.map((o) => `${o.id}=${o.label}`).join("; ")}).`);
    }
    const action = option.action;
    const text = note?.trim();
    if (action.kind === "revise" && !text) throw new DecisionRejected("Revising a unit requires a note describing the revision.");
    if (action.kind === "drop" && isRequired(u)) throw new DecisionRejected(`${u.title} is required; dropping it would leave the objective unmet.`);
    if (action.kind === "assign") {
      const r = this.registry.get(action.resourceId);
      if (!r) throw new DecisionRejected(`Resource ${action.resourceId} is not configured for this operation.`);
      if (u.requires.minTrust && this.registry.qualifies(r, { minTrust: u.requires.minTrust }, new Set()).length) {
        throw new DecisionRejected(`${action.resourceId} is outside ${u.title}'s trust boundary; that cannot be overridden by a decision.`);
      }
    }
    const applied: AppliedDecision = { decisionId, optionId, label: option.label, action, ...(text ? { note: text } : {}), at: new Date(this.now()).toISOString() };
    (u.decisions ??= []).push(applied);
    delete u.blocked;
    switch (action.kind) {
      case "retry":
        for (const id of action.clearResources ?? []) {
          const r = this.registry.get(id);
          if (r) this.registry.clearOperatorConditions(r);
        }
        u.runsBase = u.runs;
        u.unknownResumes = 0;
        u.status = "RUNNABLE";
        break;
      case "keep_waiting":
        delete this.state.wait;
        u.status = "RUNNABLE";
        break;
      case "assign":
        u.override = { resourceId: action.resourceId, overriding: action.overriding, decisionId };
        u.runsBase = u.runs;
        u.status = "RUNNABLE";
        break;
      case "revise":
        u.prompt = `${u.prompt}${REVISION_MARKER}${text}`;
        u.runsBase = u.runs;
        u.status = "RUNNABLE";
        break;
      case "drop":
        u.dropped = true;
        break;
      case "accept_no_change":
        u.status = "COMPLETE";
        u.result = {
          summary: "accepted as no-op by operator",
          completedAt: new Date(this.now()).toISOString(),
          resourceId: u.assignment?.resourceId ?? "unknown",
          outcome: "NOT_REQUIRED",
        };
        break;
      case "cancel_operation":
        break;
    }
    if (action.kind !== "drop" && action.kind !== "cancel_operation" && action.kind !== "accept_no_change") {
      u.pendingDecision = { label: option.label, ...(text ? { note: text } : {}), ...(action.kind === "retry" && action.restart ? { restart: true } : {}) };
    }
    this.emit("DECISION_APPLIED", `${u.title}: operator chose "${option.label}"${text ? ` (${text})` : ""}.`, {
      unitId: u.id,
      detail: { decisionId, optionId, action },
    });
    if (action.kind === "cancel_operation") {
      this.cancel();
    } else if (this.state.status === "BLOCKED") {
      const hasOtherBlocked = this.state.units.some((x) => x.status === "BLOCKED");
      if (!hasOtherBlocked) {
        this.state.status = "RUNNING";
        delete this.state.blocked;
      }
    }
    return applied;
  }

  /** Marks the unit RUNNING on `resource`, recording the reroute and the operation resuming if it was waiting. */
  start(d: Extract<Decision, { kind: "run" }>): void {
    const { unit, resource, reroutedFrom } = d;
    const at = new Date(this.now()).toISOString();
    const wasParked = this.state.units.some((u) => u.status === "PARKED");
    if (this.state.status === "WAITING") {
      this.emit("OPERATION_RESUMED", `Resuming: ${unit.title} is eligible on ${resource.id}.`, { unitId: unit.id, resourceId: resource.id });
    }
    this.state.status = "RUNNING";
    delete this.state.wait;
    if (reroutedFrom) {
      unit.reroutes.push({ at, from: reroutedFrom.resourceId, to: resource.id, reason: reroutedFrom.reason });
      this.emit("WORK_REROUTED", `${unit.title} rerouted from ${reroutedFrom.resourceId} to ${resource.id}: ${reroutedFrom.reason}.`, {
        unitId: unit.id,
        resourceId: resource.id,
        detail: { from: reroutedFrom.resourceId, to: resource.id, reason: reroutedFrom.reason },
      });
    }
    const resumed = unit.agentTaskId !== undefined;
    unit.status = "RUNNING";
    unit.runs++;
    unit.assignment = { resourceId: resource.id, model: resource.model, since: at };
    if (!unit.modelsUsed.includes(resource.model)) unit.modelsUsed.push(resource.model);
    if (wasParked) {
      const parked = this.state.units.filter((u) => u.status === "PARKED").map((u) => u.title);
      this.emit("CONTINUING_INDEPENDENT_WORK", `${unit.title} running on ${resource.id} while ${parked.join(", ")} ${parked.length === 1 ? "is" : "are"} parked.`, {
        unitId: unit.id,
        resourceId: resource.id,
        detail: { parked },
      });
    }
    this.emit(resumed ? "WORK_RESUMED" : "WORK_STARTED", `${unit.title} ${resumed ? "resumed" : "started"} on ${resource.id}.`, { unitId: unit.id, resourceId: resource.id });
  }

  apply(unitId: string, result: UnitRunResult): void {
    const u = this.unit(unitId);
    const at = new Date(this.now()).toISOString();
    const resourceId = u.assignment?.resourceId ?? "unknown";
    if (result.kind !== "cancelled") delete u.pendingDecision;
    switch (result.kind) {
      case "completed":
        u.status = "COMPLETE";
        u.result = {
          summary: result.summary,
          completedAt: at,
          resourceId,
          outcome: result.outcome,
          ...(u.override?.overriding.length && u.override.resourceId === resourceId ? { overriding: u.override.overriding } : {}),
        };
        this.emit("WORK_COMPLETED", `${u.title} completed on ${resourceId}.`, { unitId, resourceId, detail: { outcome: result.outcome } });
        return;
      case "resource_unavailable":
        // The condition is in the registry; the next decide() reroutes or parks with the unit's history intact.
        u.status = "RUNNABLE";
        if (u.runs - (u.runsBase ?? 0) >= this.state.policy.maxRunsPerUnit) {
          this.block(u, {
            cause: "RUN_BUDGET",
            reason: `resources failed ${u.runs} times`,
            question: `${u.title} has been displaced by resource failures ${u.runs} times. Keep trying?`,
            options: [{ label: "keep trying", action: { kind: "retry" } }],
          });
        }
        return;
      case "execution_unknown":
        this.block(u, {
          cause: "EXECUTION_UNKNOWN",
          reason: `inference on ${resourceId} may have executed (request ${result.failure.requestId ?? "?"}); its replay budget is spent`,
          question: `${u.title}: Nexus cannot tell whether its last request to ${resourceId} executed, and will not resubmit it elsewhere on its own. Replay the step, or stop?`,
          options: [{ label: "replay the step", action: { kind: "retry" } }],
        });
        return;
      case "failed":
        this.block(u, { ...result, options: [...result.options, ...(result.offerReassign ? this.assignable(u, [resourceId]) : [])] });
        return;
      case "cancelled":
        u.status = "RUNNABLE";
        return;
    }
  }

  /** The process ended while these units were RUNNING: their in-flight outcome is unknown. */
  reconcileInterruptedRuns(): void {
    for (const u of this.state.units.filter((x) => x.status === "RUNNING")) {
      u.unknownResumes++;
      if (u.unknownResumes > this.state.policy.unknownResumeBudget) {
        this.block(u, {
          cause: "INTERRUPTED",
          reason: `interrupted ${u.unknownResumes} times with an unknown outcome`,
          question: `${u.title} was interrupted mid-run ${u.unknownResumes} times. Resume it again, or stop?`,
          options: [{ label: "resume again", action: { kind: "retry" } }],
        });
      } else {
        u.status = "RUNNABLE";
      }
    }
  }

  wait(d: Extract<Decision, { kind: "wait" }>): void {
    const first = this.state.status !== "WAITING";
    this.state.status = "WAITING";
    const since = this.state.wait?.since ?? new Date(this.now()).toISOString();
    this.state.wait = { since, wakeAt: new Date(d.wakeAt).toISOString(), reason: d.reason, parkedUnits: d.parked };
    if (first) {
      this.emit("OPERATION_WAITING", `Nothing else can run: ${d.reason}. Resuming at ${clockTime(d.wakeAt)}; no model context is held while waiting.`, {
        detail: { wakeAt: this.state.wait.wakeAt, parked: d.parked },
      });
    }
  }

  finish(d: Extract<Decision, { kind: "complete" } | { kind: "blocked" }>): void {
    delete this.state.wait;
    if (d.kind === "complete") {
      this.state.status = "COMPLETE";
      delete this.state.blocked;
      const required = this.state.units.filter(isRequired).length;
      const advisoryOpen = this.state.units.filter((u) => !isRequired(u) && u.status !== "COMPLETE").map((u) => u.title);
      this.emit(
        "OPERATION_COMPLETED",
        `Objective complete: ${required} required work ${required === 1 ? "unit" : "units"} done.` +
          (advisoryOpen.length ? ` Advisory work not done: ${advisoryOpen.join(", ")}.` : ""),
      );
      return;
    }
    this.state.status = "BLOCKED";
    this.state.blocked = { since: new Date(this.now()).toISOString(), decisions: d.decisions };
    const first = d.decisions[0];
    this.emit(
      "OPERATION_BLOCKED",
      first ? `Decision needed: ${first.question} Options: ${first.options.map((o) => `[${o.id}] ${o.label}`).join(" | ")}.` : "Operation blocked with no runnable work.",
      { detail: { decisions: d.decisions } },
    );
  }

  cancel(): void {
    for (const u of this.state.units) if (u.status === "RUNNING") u.status = "RUNNABLE";
    this.state.status = "CANCELLED";
    this.emit("OPERATION_CANCELLED", "Operation cancelled; work units and their history are preserved.");
  }
}
