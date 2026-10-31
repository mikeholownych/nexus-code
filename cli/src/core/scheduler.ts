/**
 * Pure convergence scheduling over durable operation state. OperationRunner owns time, execution and persistence.
 */
import type {
  AppliedDecision,
  Assignment,
  BlockSpec,
  Decision,
  DecisionAction,
  DecisionOption,
  DurableOperationState,
  EscalationDecision,
  OperationEvent,
  OperationEventType,
  OptionSpec,
  UnitRunResult,
  WorkUnit,
  WorkUnitStatus,
} from "./operation.js";
import type { ResourceDescriptor, ResourceRegistry, Selection } from "./resources.js";
import { reportOperationDiagnostic, type OperationDiagnosticHandler } from "./operation_runner_diagnostics.js";
import { effectiveConcurrency } from "./operation_schema.js";

/** Separates a unit's original task from operator revisions appended to it. */
export const REVISION_MARKER = "\n\nOperator revision: ";
const MAX_EVENTS = 300;
const TERMINAL: WorkUnitStatus[] = ["COMPLETE", "BLOCKED"];

function clockTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + " UTC";
}

/** An operator decision Nexus will not apply (stale, not offered, or outside the unit's authority). */
export class DecisionRejected extends Error {}

export const isRequired = (u: Pick<WorkUnit, "required">): boolean => u.required !== false;

export class ConvergenceScheduler {
  constructor(
    readonly state: DurableOperationState,
    readonly registry: ResourceRegistry,
    private readonly now: () => number,
    private readonly onEvent?: (e: OperationEvent) => void,
    private readonly onDiagnostic?: OperationDiagnosticHandler,
  ) {}

  /** Last truncation signature reported, so repeated decide() calls do not flood the event ring. */
  private concurrencyNotice?: string;

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
    } catch {
      reportOperationDiagnostic(this.onDiagnostic, "scheduler", "event_callback_failed");
    }
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
    // The whole selection is kept, not just the preferred resource: a unit whose preferred resource is reserved by
    // an earlier assignment in the same batch may use its next qualified, eligible resource instead of waiting.
    const choices = new Map<string, Selection>();
    const reroutes = new Map<string, { resourceId: string; reason: string }>();

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
        choices.set(u.id, sel);
        if (reroutedFrom) reroutes.set(u.id, reroutedFrom);
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
    const runnable = this.state.units.filter((u) => u.status === "RUNNABLE" && choices.has(u.id));
    const ordered = this.orderRunnable(runnable);
    const assignments = this.assign(ordered, choices, reroutes);
    if (assignments.length) {
      const limit = effectiveConcurrency(this.state);
      const running = this.state.units.filter((u) => u.status === "RUNNING").length;
      if (ordered.length > assignments.length && running + assignments.length >= limit) {
        // One notice per distinct truncation, not one per decide() call: the scheduler is called repeatedly over the
        // same state and the event ring holds 300 entries for the whole operation.
        const signature = `${limit}|${running}|${ordered.map((u) => u.id).join(",")}`;
        if (this.concurrencyNotice !== signature) {
          this.concurrencyNotice = signature;
          this.emit(
            "CONCURRENCY_LIMIT",
            `${ordered.length} units are runnable; starting ${assignments.length} (limit ${limit}).`,
            { detail: { limit, eligible: ordered.length } },
          );
        }
      }
      return { kind: "run", assignments };
    }

    // Every runnable unit's qualified slots are held by work already in flight: nothing can start now, and the batch
    // that holds them will re-enter decide() when it settles. This is not a block and not a wait on a resource window.
    if (assignments.length === 0 && this.state.units.some((u) => u.status === "RUNNING")) {
      return {
        kind: "wait",
        wakeAt: now + this.state.policy.minWaitMs,
        reason: "every runnable unit's qualified resource is busy",
        parked: [],
      };
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

  /**
   * Total order over the runnable set: required first, then the longest unfinished dependency chain, then the
   * operation's declared unit order. Arrival order and iteration order never participate, so the same persisted state
   * and observations always produce the same batch. Declaration order is used rather than unit id as the tie-break so
   * an operation authored for v1.0.0 keeps running its independent units in the same order after upgrade.
   */
  private orderRunnable(runnable: WorkUnit[]): WorkUnit[] {
    // Length of the longest unfinished chain that starts at each unit and runs forward through its dependents. A unit
    // that gates a long tail is started before one that gates nothing, so concurrency does not delay the objective.
    const unfinished = new Set(this.state.units.filter((unit) => unit.status !== "COMPLETE").map((unit) => unit.id));
    const dependents = new Map<string, string[]>();
    for (const unit of this.state.units) {
      for (const dependency of unit.dependsOn) {
        const list = dependents.get(dependency) ?? [];
        list.push(unit.id);
        dependents.set(dependency, list);
      }
    }
    const depth = new Map<string, number>();
    const chain = (id: string, seen: Set<string>): number => {
      const memo = depth.get(id);
      if (memo !== undefined) return memo;
      if (!unfinished.has(id) || seen.has(id)) return 0;
      seen.add(id);
      let longest = 0;
      for (const dependent of dependents.get(id) ?? []) longest = Math.max(longest, chain(dependent, seen));
      seen.delete(id);
      const total = 1 + longest;
      depth.set(id, total);
      return total;
    };
    const declared = new Map(this.state.units.map((unit, index) => [unit.id, index]));
    return [...runnable].sort((a, b) => {
      const required = Number(!isRequired(a)) - Number(!isRequired(b));
      if (required) return required;
      const depthDelta = chain(b.id, new Set()) - chain(a.id, new Set());
      if (depthDelta) return depthDelta;
      return declared.get(a.id)! - declared.get(b.id)!;
    });
  }

  /**
   * Reserves resource slots for the ordered runnable set, up to the operation's concurrency limit. A unit whose
   * resource is already fully reserved stays RUNNABLE and is considered again after the batch; being busy is not a
   * failure, so it is never parked or blocked here.
   */
  private assign(
    ordered: WorkUnit[],
    choices: Map<string, Selection>,
    reroutes: Map<string, { resourceId: string; reason: string }>,
  ): Assignment[] {
    const limit = Math.max(1, effectiveConcurrency(this.state));
    const used = new Map<string, number>();
    for (const running of this.state.units) {
      if (running.status !== "RUNNING") continue;
      const id = running.assignment?.resourceId;
      if (id) used.set(id, (used.get(id) ?? 0) + 1);
    }
    const free = (resourceId: string): boolean => {
      const resource = this.registry.get(resourceId);
      const capacity = Math.max(1, resource?.maxConcurrentUnits ?? 1);
      return (used.get(resourceId) ?? 0) < capacity;
    };
    // Running units already count against the limit: the limit bounds units in flight, not units started this call.
    const inFlight = this.state.units.filter((u) => u.status === "RUNNING").length;
    const out: Assignment[] = [];
    for (const unit of ordered) {
      if (inFlight + out.length >= limit) break;
      const sel = choices.get(unit.id);
      if (!sel) continue;
      // Preference order: the registry's chosen resource first, then the rest of its qualified list in registry order.
      const preferred = sel.chosen ? [sel.chosen, ...sel.qualified.map((c) => c.resource).filter((r) => r.id !== sel.chosen!.id)] : sel.qualified.map((c) => c.resource);
      const eligible = new Set(sel.qualified.filter((c) => c.eligibility.eligible).map((c) => c.resource.id));
      const resource = preferred.find((candidate) => (eligible.has(candidate.id) || candidate.id === sel.chosen?.id) && free(candidate.id));
      if (!resource) continue; // eligible but every qualified slot is busy: stay RUNNABLE, do not park or block
      used.set(resource.id, (used.get(resource.id) ?? 0) + 1);
      // A reroute is a condition story about the preferred resource; being displaced by a busy slot is not one.
      const reroutedFrom = sel.chosen?.id === resource.id ? reroutes.get(unit.id) : undefined;
      out.push({ unit, resource, ...(reroutedFrom ? { reroutedFrom } : {}) });
    }
    return out;
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
      case "lift_context_budget":
        delete u.contextBudget;
        delete u.context;
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

  /** Marks the unit RUNNING on its assigned resource, recording the reroute and the operation resuming if waiting. */
  start(d: Assignment): void {
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
