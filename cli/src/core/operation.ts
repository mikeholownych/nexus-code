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
 */
import type { AgentRole } from "../team.js";
import type { ResourceConditionRecord, ResourceDescriptor, ResourceRegistry, WorkRequirements } from "./resources.js";
import type { InferenceFailure } from "./turn.js";

export type WorkUnitStatus = "RUNNABLE" | "RUNNING" | "PARKED" | "WAITING_ON_DEPENDENCY" | "COMPLETE" | "BLOCKED";
export type OperationStatus = "RUNNING" | "WAITING" | "BLOCKED" | "COMPLETE" | "CANCELLED";

/** The smallest decision that unblocks progress, with the concrete options Nexus can act on. */
export interface EscalationDecision {
  unitId: string;
  question: string;
  options: string[];
}

export interface WorkUnit {
  id: string;
  title: string;
  role?: AgentRole;
  prompt: string;
  dependsOn: string[];
  requires: WorkRequirements;
  status: WorkUnitStatus;
  /** Resource the unit last ran on (its conversation continues from there). */
  assignment?: { resourceId: string; model: string; since: string };
  /** Durable task state holding the unit's conversation, for resumption without live model context. */
  agentTaskId?: string;
  parked?: { since: string; reason: string; resourceIds: string[]; wakeAt?: string };
  blocked?: { since: string; reason: string; decision: EscalationDecision };
  result?: { summary: string; completedAt: string; resourceId: string; outcome: string };
  reroutes: Array<{ at: string; from: string; to: string; reason: string }>;
  runs: number;
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
  | "OPERATION_CANCELLED";

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
}

export type UnitRunResult =
  | { kind: "completed"; summary: string; outcome: string }
  /** The resource could not take the work and nothing executed (or the condition is recorded at resource scope). */
  | { kind: "resource_unavailable"; failure: InferenceFailure; condition: ResourceConditionRecord }
  /** Inference may have executed and its bounded replays are spent: never resubmitted elsewhere automatically. */
  | { kind: "execution_unknown"; failure: InferenceFailure }
  | { kind: "failed"; reason: string; question: string; options: string[] }
  | { kind: "cancelled" };

export type Decision =
  | { kind: "run"; unit: WorkUnit; resource: ResourceDescriptor; reroutedFrom?: { resourceId: string; reason: string } }
  | { kind: "wait"; wakeAt: number; reason: string; parked: string[] }
  | { kind: "complete" }
  | { kind: "blocked"; decisions: EscalationDecision[] };

const MAX_EVENTS = 300;
const TERMINAL: WorkUnitStatus[] = ["COMPLETE", "BLOCKED"];

export interface WorkUnitSpec {
  id: string;
  title?: string;
  role?: AgentRole;
  prompt: string;
  dependsOn?: string[];
  requires?: WorkRequirements;
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
  for (const u of units) {
    for (const d of u.dependsOn ?? []) if (!ids.has(d)) throw new Error(`Work unit '${u.id}' depends on unknown unit '${d}'`);
    for (const d of u.requires?.independentOf ?? []) if (!ids.has(d)) throw new Error(`Work unit '${u.id}' is independent of unknown unit '${d}'`);
  }
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
      const excluded = new Set((u.requires.independentOf ?? []).flatMap((id) => this.unit(id).modelsUsed));
      const sel = this.registry.select(u.requires, excluded, now);
      if (sel.chosen) {
        u.status = "RUNNABLE";
        const from = u.assignment?.resourceId;
        let reroutedFrom: { resourceId: string; reason: string } | undefined;
        if (from && from !== sel.chosen.id) {
          const prior = this.registry.get(from);
          const elig = prior ? this.registry.eligibility(prior, now) : undefined;
          const reason = !prior
            ? "previous resource is no longer configured"
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

    const runnable = this.state.units.filter((u) => u.status === "RUNNABLE" && choices.has(u.id));
    if (runnable.length) {
      const unit = runnable[0];
      const choice = choices.get(unit.id)!;
      return { kind: "run", unit, resource: choice.resource, ...(choice.reroutedFrom ? { reroutedFrom: choice.reroutedFrom } : {}) };
    }

    const parked = this.state.units.filter((u) => u.status === "PARKED");
    if (parked.length) {
      const waitSince = this.state.wait ? Date.parse(this.state.wait.since) : now;
      if (now - waitSince >= this.state.policy.maxWaitMs) {
        for (const u of parked) {
          this.block(u, {
            reason: `waited ${Math.round((now - waitSince) / 60_000)} min for ${u.parked!.resourceIds.join(", ")}`,
            question: `${u.title} has waited longer than the operation's wait bound for ${u.parked!.resourceIds.join(", ")}. Keep waiting, or assign it to another resource?`,
            options: ["keep waiting", ...this.state.resources.filter((r) => !u.parked!.resourceIds.includes(r.id)).map((r) => `assign to ${r.id}`), "abandon unit"],
          });
        }
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

    if (this.state.units.every((u) => u.status === "COMPLETE")) return { kind: "complete" };

    const decisions = this.state.units.filter((u) => u.status === "BLOCKED" && u.blocked).map((u) => u.blocked!.decision);
    return { kind: "blocked", decisions };
  }

  private productiveOthers(exceptId: string, choices: Map<string, unknown>): number {
    return this.state.units.filter((u) => u.id !== exceptId && (u.status === "RUNNING" || (u.status === "RUNNABLE" && choices.has(u.id)))).length;
  }

  private noQualifiedResource(u: WorkUnit, sel: ReturnType<ResourceRegistry["select"]>): { reason: string; question: string; options: string[] } {
    if (sel.qualified.length) {
      const why = sel.qualified.map((c) => `${c.resource.id}: ${c.eligibility.blocking.map((b) => b.reason).join(", ")}`).join("; ");
      return {
        reason: `every qualified resource is unavailable without a recovery window (${why})`,
        question: `${u.title} can only run on ${sel.qualified.map((c) => c.resource.id).join(", ")}, which need operator action (${why}). Fix the resource, or assign the unit elsewhere?`,
        options: ["retry after fixing the resource", ...sel.rejected.map((r) => `assign to ${r.resourceId} despite: ${r.reasons.join(", ")}`), "abandon unit"],
      };
    }
    const req = u.requires;
    const need = [
      ...(req.capabilities ?? []).map((c) => `capability '${c}'`),
      ...(req.qualification ? [`qualification '${req.qualification}'`] : []),
      ...(req.minContext ? [`context >= ${req.minContext}`] : []),
    ].join(", ");
    return {
      reason: `no configured resource is qualified (${sel.rejected.map((r) => `${r.resourceId}: ${r.reasons.join(", ")}`).join("; ")})`,
      question: `${u.title} needs ${need || "a qualified resource"}, and no configured resource provides it. Configure one, or relax the requirement?`,
      options: ["configure a qualified resource", ...sel.rejected.map((r) => `relax requirement and use ${r.resourceId}`), "abandon unit"],
    };
  }

  block(u: WorkUnit, why: { reason: string; question: string; options: string[] }): void {
    u.status = "BLOCKED";
    delete u.parked;
    u.blocked = { since: new Date(this.now()).toISOString(), reason: why.reason, decision: { unitId: u.id, question: why.question, options: why.options } };
    this.emit("WORK_BLOCKED", `${u.title} needs a decision: ${why.question}`, { unitId: u.id, detail: { reason: why.reason } });
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
    switch (result.kind) {
      case "completed":
        u.status = "COMPLETE";
        u.result = { summary: result.summary, completedAt: at, resourceId, outcome: result.outcome };
        this.emit("WORK_COMPLETED", `${u.title} completed on ${resourceId}.`, { unitId, resourceId });
        return;
      case "resource_unavailable":
        // The condition is in the registry; the next decide() reroutes or parks with the unit's history intact.
        u.status = "RUNNABLE";
        if (u.runs >= this.state.policy.maxRunsPerUnit) {
          this.block(u, {
            reason: `resources failed ${u.runs} times`,
            question: `${u.title} has been displaced by resource failures ${u.runs} times. Keep trying, or abandon it?`,
            options: ["keep trying", "abandon unit"],
          });
        }
        return;
      case "execution_unknown":
        this.block(u, {
          reason: `inference on ${resourceId} may have executed (request ${result.failure.requestId ?? "?"}); its replay budget is spent`,
          question: `${u.title}: Nexus cannot tell whether its last request to ${resourceId} executed, and will not resubmit it elsewhere on its own. Replay the step, or stop this unit?`,
          options: ["replay the step", "abandon unit"],
        });
        return;
      case "failed":
        this.block(u, { reason: result.reason, question: result.question, options: result.options });
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
          reason: `interrupted ${u.unknownResumes} times with an unknown outcome`,
          question: `${u.title} was interrupted mid-run ${u.unknownResumes} times. Resume it again, or stop it?`,
          options: ["resume again", "abandon unit"],
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
      this.emit("OPERATION_COMPLETED", `Objective complete: ${this.state.units.length} work units done.`);
      return;
    }
    this.state.status = "BLOCKED";
    this.state.blocked = { since: new Date(this.now()).toISOString(), decisions: d.decisions };
    const first = d.decisions[0];
    this.emit(
      "OPERATION_BLOCKED",
      first ? `Decision needed: ${first.question} Options: ${first.options.join(" | ")}.` : "Operation blocked with no runnable work.",
      { detail: { decisions: d.decisions } },
    );
  }

  cancel(): void {
    for (const u of this.state.units) if (u.status === "RUNNING") u.status = "RUNNABLE";
    this.state.status = "CANCELLED";
    this.emit("OPERATION_CANCELLED", "Operation cancelled; work units and their history are preserved.");
  }
}
