/**
 * Drives a ConvergenceScheduler: executes the unit it picks, feeds resource observations back into the registry,
 * waits durably when nothing is runnable, revalidates resources on wake, and persists after every transition so a
 * restarted process continues from the same decision point.
 */
import { credentialStorageHome, storedCredentialFor } from "../client.js";
import type { HarnessConfig } from "../types.js";
import { realRecoveryClock, type RecoveryClock } from "./provider_recovery.js";
import { ConvergenceScheduler, type Decision, type DurableOperationState, type OperationEvent, type UnitRunResult, type WorkUnit } from "./operation.js";
import { OperationGit, ensureIntegrationWorktree, type OperationGitPlan } from "./operation_git.js";
import { REQUIREMENTS_CAPABILITY, READ_OBJECTIVE_CAPABILITY } from "./objective.js";
import {
  credentialFingerprint,
  ResourceRegistry,
  type ResourceConditionRecord,
  type RegistryEvent,
  type ResourceDescriptor,
} from "./resources.js";
import { createOperationAccountIdentity } from "./account_identity.js";
import type { InferenceFailure } from "./turn.js";
import { OperationRevalidator } from "./operation_runner_revalidation.js";
import type { OperationDiagnosticHandler } from "./operation_runner_diagnostics.js";
import type { OperationStore } from "./operation_runner_persistence.js";

export { OperationStore, OperationLockedError, migrateLegacyAccountIdentities } from "./operation_runner_persistence.js";
export { AgentWorkUnitExecutor } from "./operation_runner_execution.js";
export type { AgentExecutorOptions } from "./operation_runner_execution.js";


export interface UnitRunContext {
  signal?: AbortSignal;
  objective: string;
  dependencies: Array<{ id: string; title: string; summary: string }>;
  /** Why the unit is being resumed on this resource (undefined on its first run). */
  resumeReason?: string;
  /** Operator decision applied since the unit last ran (told to the unit). `restart` authorizes starting it over. */
  operatorDecision?: { label: string; note?: string; restart?: boolean };
  /** Durably records the unit's conversation task before execution, so a crash mid-run can be reconciled. */
  bindAgentTask(taskId: string): void;
  /** Isolated operations: the unit's worktree. Absent means the executor's configured workspace. */
  workspace?: string;
  observeFailure(failure: InferenceFailure): ResourceConditionRecord | null;
  observeSuccess(): void;
  shouldYield(failure: InferenceFailure, plannedDelayMs: number): boolean;
}

export interface WorkUnitExecutor {
  run(unit: WorkUnit, resource: ResourceDescriptor, ctx: UnitRunContext): Promise<UnitRunResult>;
  /** Side-effect-free reachability check used to revalidate endpoint-scope conditions on wake. */
  probe?(resource: ResourceDescriptor, signal?: AbortSignal): Promise<{ available: boolean; failure?: InferenceFailure }>;
  /** Re-reads provider catalogs, if enabled. */
  refresh?(registry: ResourceRegistry, signal?: AbortSignal): Promise<void>;
}

export interface OperationRunnerOptions {
  executor: WorkUnitExecutor;
  clock?: RecoveryClock;
  persist(state: DurableOperationState): void;
  onEvent?(event: OperationEvent): void;
  /** Receives fixed, secret-free debug events for best-effort checks. */
  onDiagnostic?: OperationDiagnosticHandler;
  /** Provider waits longer than this hand the unit back to the scheduler (shorter blips are waited in place). */
  inPlaceMaxWaitMs?: number;
  /**
   * Interactive callers: an operation-level wait longer than this is persisted as WAITING and returned instead of
   * slept in-process (resume continues it). Default: wait in-process.
   */
  maxInProcessWaitMs?: number;
  maxIterations?: number;
}

function planFromState(state: DurableOperationState): OperationGitPlan {
  const git = state.git!;
  const key = git.integrationBranch.split("/")[1]?.replace(/^op-/, "") ?? "op";
  return {
    key,
    repoRoot: git.repoRoot,
    baseRef: git.baseRef,
    baseCommit: git.baseCommit,
    integrationBranch: git.integrationBranch,
    integrationWorktree: git.integrationWorktree,
    baseDir: git.baseDir,
  };
}

export class OperationRunner {
  readonly registry: ResourceRegistry;
  readonly scheduler: ConvergenceScheduler;
  private readonly clock: RecoveryClock;
  private readonly revalidator: OperationRevalidator;
  private readonly git: OperationGit | undefined;

  constructor(
    readonly state: DurableOperationState,
    private readonly opts: OperationRunnerOptions,
  ) {
    this.clock = opts.clock ?? realRecoveryClock;
    this.registry = new ResourceRegistry(state.resources, state.conditions, this.clock, (e) => this.onRegistryEvent(e));
    this.revalidator = new OperationRevalidator(opts.executor, this.registry, opts.onDiagnostic);
    this.scheduler = new ConvergenceScheduler(state, this.registry, () => this.clock.now(), opts.onEvent, opts.onDiagnostic);
    this.git = state.git?.isolate ? new OperationGit(planFromState(state), state.git) : undefined;
  }

  async run(signal?: AbortSignal): Promise<DurableOperationState> {
    if (this.state.status === "COMPLETE" || this.state.status === "CANCELLED") {
      this.git?.disposeAllUnits();
      return this.state;
    }
    if (this.git) {
      try {
        ensureIntegrationWorktree(planFromState(this.state), this.state.git!, {
          hasHistory:
            (this.state.integrations?.length ?? 0) > 0 ||
            Object.values(this.state.git!.units).some((entry) => entry.integratedCommit !== undefined),
        });
      } catch (error: any) {
        this.blockOnGit(`The isolation worktree is unusable (${error?.message ?? error}).`);
        return this.state;
      }
      const rewound = this.git.historyProblems(this.state.integrations ?? []);
      if (rewound.length) {
        const names = rewound.map((entry) => `${entry.unitId}@${entry.integratedCommit.slice(0, 12)}`).join(", ");
        this.blockOnGit(`The integration branch no longer contains accepted work (${names}); it was reset or rewritten.`);
        return this.state;
      }
    }
    this.reconcileIntegrated();
    this.scheduler.reconcileInterruptedRuns();
    if (this.state.status === "WAITING" && this.state.wait && Date.parse(this.state.wait.wakeAt) <= this.clock.now()) {
      await this.revalidator.revalidate(signal);
    } else await this.revalidator.refresh(signal);
    this.save();
    const maxIterations = this.opts.maxIterations ?? 10_000;
    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) return this.cancelled();
      const d = this.scheduler.decide();
      if (d.kind === "run") {
        if (this.git) {
          // An authorized restart recreates the worktree; only a unit without that authorization fails closed here.
          const restart = Boolean(d.unit.pendingDecision?.restart);
          const missing = restart ? undefined : this.git.missingWorktrees().find((entry) => entry.unitId === d.unit.id);
          if (missing) {
            this.scheduler.start(d);
            this.scheduler.apply(d.unit.id, {
              kind: "failed",
              cause: "EXECUTION_FAILED",
              reason: `isolated worktree is missing (${missing.worktree})`,
              question: `${d.unit.title}'s isolated worktree was removed outside Nexus. Restart it from the integration tip, or stop?`,
              options: [{ label: "restart the unit from the integration tip", action: { kind: "retry", restart: true } }],
            });
            this.save();
            continue;
          }
        }
        if (await this.revalidator.beforeAssign(d.resource, signal)) continue;
        this.scheduler.start(d);
        this.save();
        const result = await this.execute(d, signal);
        if (result.kind === "cancelled" || signal?.aborted) {
          this.scheduler.apply(d.unit.id, { kind: "cancelled" });
          return this.cancelled();
        }
        this.scheduler.apply(d.unit.id, result);
        this.save();
        continue;
      }
      if (d.kind === "wait") {
        this.scheduler.wait(d);
        this.save();
        if (this.opts.maxInProcessWaitMs !== undefined && d.wakeAt - this.clock.now() > this.opts.maxInProcessWaitMs) return this.state;
        try {
          await this.clock.sleep(Math.max(0, d.wakeAt - this.clock.now()), signal);
        } catch {
          return this.cancelled();
        }
        await this.revalidator.revalidate(signal);
        continue;
      }
      this.scheduler.finish(d);
      // A blocked operation keeps its unit worktrees: the retry/restart remedies run the unit again in them.
      if (d.kind === "complete") this.git?.disposeAllUnits();
      this.save();
      return this.state;
    }
    this.scheduler.finish({
      kind: "blocked",
      decisions: [{
        id: "operation#not-converging",
        unitId: "*",
        cause: "NOT_CONVERGING",
        question: `The scheduler made ${maxIterations} transitions without converging. Resume (nexus operation resume), or stop the operation?`,
        options: [
          { id: "1", label: "resume the operation", action: { kind: "keep_waiting" } },
          { id: "2", label: "stop the operation", action: { kind: "cancel_operation" } },
        ],
      }],
    });
    this.save();
    return this.state;
  }

  private async execute(d: Extract<Decision, { kind: "run" }>, signal?: AbortSignal): Promise<UnitRunResult> {
    const { unit, resource } = d;
    let workspace: string | undefined;
    let recoverMerged = false;
    if (this.git) {
      recoverMerged = !unit.pendingDecision?.restart && this.git.canRecoverMissingWorktree(unit.id);
      if (!recoverMerged) {
        try {
          workspace = this.git.prepareUnit(unit, { restart: Boolean(unit.pendingDecision?.restart) }).workspace;
          this.save();
        } catch (err: any) {
          return {
            kind: "failed",
            cause: "EXECUTION_FAILED",
            reason: `cannot prepare the unit's git worktree: ${err?.message ?? err}`,
            question: `${unit.title}: its isolated worktree could not be prepared (${err?.message ?? err}). Retry, or stop?`,
            options: [{ label: "retry", action: { kind: "retry" } }],
          };
        }
      }
    }
    const ctx: UnitRunContext = {
      signal,
      objective: this.state.objective,
      dependencies: unit.dependsOn.map((id) => {
        const dep = this.scheduler.unit(id);
        return { id, title: dep.title, summary: dep.result?.summary ?? "" };
      }),
      ...(unit.agentTaskId
        ? {
            resumeReason:
              d.reroutedFrom?.reason ??
              (unit.pendingDecision ? `operator decision "${unit.pendingDecision.label}"` : undefined) ??
              unit.parked?.reason ??
              "resource became eligible again",
          }
        : {}),
      ...(unit.pendingDecision ? { operatorDecision: unit.pendingDecision } : {}),
      bindAgentTask: (taskId) => {
        if (unit.agentTaskId === taskId) return;
        unit.agentTaskId = taskId;
        this.save();
      },
      observeFailure: (f) => this.registry.observeFailure(resource, f),
      observeSuccess: () => this.registry.observeSuccess(resource),
      shouldYield: (_f, delay) => this.shouldYield(unit, resource, delay),
      ...(workspace ? { workspace } : {}),
    };
    try {
      if (recoverMerged) {
        return {
          kind: "failed",
          cause: "EXECUTION_UNKNOWN",
          reason: `unit ${unit.id} is present in the integration history, but its durable result is missing`,
          question:
            `${unit.title}: its branch is already merged, but Nexus has no saved result to verify the task. ` +
            `Restart it from the merged source so it can verify the work, or stop the operation?`,
          options: [{ label: "restart from the merged source and verify", action: { kind: "retry", restart: true } }],
        };
      }
      const result: UnitRunResult = await this.opts.executor.run(unit, resource, ctx);
      if (result.kind !== "completed" || !this.git) return result;
      const integration = await this.git.integrate(unit, result);
      if (integration.kind === "conflict") {
        const files = integration.files.length ? ` (${integration.files.join(", ")})` : "";
        return {
          kind: "failed",
          cause: "MERGE_CONFLICT",
          reason: `merging ${unit.id} into the operation branch conflicts${files}`,
          question:
            `${unit.title} completed, but its branch conflicts with the integrated work${files}. Merge ` +
            `${this.state.git?.integrationBranch} into the unit's branch (${this.git.unitState(unit.id)?.worktree}), ` +
            `resolve and commit it there, then retry; or revise the unit, or stop?`,
          options: [
            { label: "retry after resolving the conflict", action: { kind: "retry" } },
            { label: "revise the unit (note required)", action: { kind: "revise" } },
          ],
        };
      }
      if (integration.kind === "failed") {
        return {
          kind: "failed",
          cause: "INTEGRATION_FAILED",
          reason: integration.reason,
          question: `${unit.title} could not be integrated: ${integration.reason}. Retry the unit, or stop?`,
          options: [{ label: "retry", action: { kind: "retry" } }],
        };
      }
      this.state.integrations = [...(this.state.integrations ?? []), integration.receipt];
      this.scheduler.emit(
        "WORK_COMPLETED",
        integration.receipt.verification === "NOT_RUN"
          ? `${unit.id} integrated on ${integration.receipt.integratedCommit.slice(0, 12)} (not re-verified).`
          : `${unit.id} integrated on ${integration.receipt.integratedCommit.slice(0, 12)}.`,
        { unitId: unit.id, detail: { integration: integration.receipt } },
      );
      this.save();
      this.git.disposeUnit(unit.id);
      this.save();
      return result;
    } catch (err: any) {
      if (signal?.aborted) return { kind: "cancelled" };
      return {
        kind: "failed",
        cause: "EXECUTION_FAILED",
        reason: `executor error: ${err?.message ?? err}`,
        question: `${unit.title} failed with an internal error (${err?.message ?? err}). Retry it, or stop?`,
        options: [{ label: "retry", action: { kind: "retry" } }],
      };
    }
  }

  /** Yield a NOT_EXECUTED step when waiting in place would idle the operation or a qualified alternate exists. */
  private shouldYield(unit: WorkUnit, resource: ResourceDescriptor, plannedDelayMs: number): boolean {
    if (plannedDelayMs > (this.opts.inPlaceMaxWaitMs ?? 10_000)) return true;
    const excluded = (u: WorkUnit) => new Set((u.requires.independentOf ?? []).flatMap((id) => this.scheduler.unit(id).modelsUsed));
    const alternate = this.registry.select(unit.requires, excluded(unit)).chosen;
    if (alternate && alternate.id !== resource.id) return true;
    return this.state.units.some(
      (u) =>
        u.id !== unit.id &&
        (u.status === "RUNNABLE" || u.status === "PARKED" || u.status === "WAITING_ON_DEPENDENCY") &&
        u.dependsOn.every((dep) => this.scheduler.unit(dep).status === "COMPLETE") &&
        this.registry.select(u.requires, excluded(u)).chosen !== undefined,
    );
  }

  private onRegistryEvent(e: RegistryEvent): void {
    const r = e.record;
    const until = r.eligibleAt ?? r.recheckAt;
    const scope = r.scope === "model" ? r.resourceId : `${r.scope} of ${r.resourceId}`;
    if (e.type === "RESOURCE_INELIGIBLE") {
      this.scheduler.emit(
        "RESOURCE_INELIGIBLE",
        r.temporary
          ? `${scope} ${r.reason}; ${r.eligibleAt ? "eligible" : "rechecked"} at ${until ? new Date(until).toISOString().slice(11, 19) : "?"} UTC (${r.source}).`
          : `${scope} ${r.reason}; needs operator action.`,
        { resourceId: r.resourceId, detail: { scope: r.scope, condition: r.condition, eligibleAt: r.eligibleAt, recheckAt: r.recheckAt, source: r.source } },
      );
    } else {
      this.scheduler.emit("RESOURCE_ELIGIBLE", `${scope} is eligible again.`, { resourceId: r.resourceId, detail: { scope: r.scope, condition: r.condition } });
    }
  }

  /**
   * A crash between the merge and the scheduler transition leaves a receipt but a RUNNING unit; finish that unit from
   * the receipt instead of running it again on a branch that is already merged.
   */
  private reconcileIntegrated(): void {
    const receipts = this.state.integrations ?? [];
    for (const receipt of receipts) {
      const unit = this.state.units.find((candidate) => candidate.id === receipt.unitId);
      if (!unit || unit.status !== "RUNNING") continue;
      unit.status = "COMPLETE";
      unit.result = {
        summary: receipt.summary,
        completedAt: receipt.mergedAt,
        resourceId: unit.assignment?.resourceId ?? "unknown",
        outcome: receipt.outcome,
      };
      this.git?.disposeUnit(unit.id);
      this.scheduler.emit("WORK_COMPLETED", `${unit.id} completed before the restart and is already integrated.`, {
        unitId: unit.id,
        detail: { integration: receipt },
      });
    }
  }

  private blockOnGit(reason: string): void {
    this.scheduler.finish({
      kind: "blocked",
      decisions: [{
        id: "operation#git",
        unitId: "*",
        cause: "INTEGRATION_FAILED",
        question: `${reason} Restore the integration branch/worktree, then resume.`,
        options: [{ id: "1", label: "resume after fixing the integration state", action: { kind: "keep_waiting" } }],
      }],
    });
    this.save();
  }

  private cancelled(): DurableOperationState {
    this.scheduler.cancel();
    this.git?.disposeAllUnits();
    this.save();
    return this.state;
  }

  private save(): void {
    this.state.conditions = this.registry.snapshot();
    this.state.updatedAt = new Date(this.clock.now()).toISOString();
    this.opts.persist(this.state);
  }
}

export interface DriveOptions extends Omit<OperationRunnerOptions, "persist"> {
  store: OperationStore;
  signal?: AbortSignal;
}

/** Runs an operation under its driver lock, persisting every transition through the store. */
export async function driveOperation(state: DurableOperationState, opts: DriveOptions): Promise<DurableOperationState> {
  const { store, signal, ...runnerOpts } = opts;
  const release = store.acquire(state.id);
  try {
    return await new OperationRunner(state, { ...runnerOpts, persist: (s) => store.save(s) }).run(signal);
  } finally {
    release();
  }
}

/**
 * Applies an operator decision under the driver lock: validated against the persisted decision (DecisionRejected
 * otherwise), recorded on the unit, persisted. The next run re-evaluates the operation from there.
 */
export function applyOperatorDecision(
  store: OperationStore,
  id: string,
  decisionId: string,
  optionId: string,
  note?: string,
  opts: { now?: () => number; onEvent?: (e: OperationEvent) => void; onDiagnostic?: OperationDiagnosticHandler } = {},
): DurableOperationState {
  const release = store.acquire(id);
  try {
    const state = store.load(id);
    const now = opts.now ?? Date.now;
    const registry = new ResourceRegistry(state.resources, state.conditions, { now, random: Math.random });
    new ConvergenceScheduler(state, registry, now, opts.onEvent, opts.onDiagnostic).resolve(decisionId, optionId, note);
    state.conditions = registry.snapshot();
    state.updatedAt = new Date(now()).toISOString();
    store.save(state);
    return state;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- resources from configuration

function origin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

function normalizeEndpoint(ep: string): string {
  const e = ep.trim().replace(/\/+$/, "");
  return e.endsWith("/v1") ? e : `${e}/v1`;
}

/** The configured planner/coder models keep their cognitive-routing roles as scheduling preferences. */
const PLANNER_PREFERRED = ["research", "architecture", "review"];
const CODER_PREFERRED = ["implementation", "verification"];

/** Resources implied by the existing configuration (primary model, fallback endpoints, planner and coder slots). */
export function resourcesFromConfig(config: HarnessConfig, identity = createOperationAccountIdentity(credentialStorageHome())): ResourceDescriptor[] {
  const account = credentialFingerprint(config.apiKey, identity) ?? (config.provider ? undefined : credentialFingerprint(storedCredentialFor(config.endpoint) ?? undefined, identity));
  const make = (id: string, endpoint: string, model: string, rank: number, taskClass?: string, key = account, preferredFor?: string[], providerId?: string): ResourceDescriptor => ({
    id,
    provider: providerId ?? origin(normalizeEndpoint(endpoint)),
    endpoint: providerId ? endpoint.trim().replace(/\/+$/, "") : normalizeEndpoint(endpoint),
    model,
    ...(providerId ? { providerId } : {}),
    capabilities: ["tools"],
    rank,
    ...(key ? { account: key } : {}),
    ...(key ? { accountIdentitySource: "credential" as const } : {}),
    ...(taskClass ? { taskClass } : {}),
    ...(preferredFor ? { preferredFor } : {}),
  });
  const out: ResourceDescriptor[] = [make("primary", config.endpoint, config.model, 0, config.taskClass, account, undefined, config.provider)];
  if (!config.provider) (config.fallbackEndpoints ?? []).forEach((ep, i) => out.push(make(`primary@fallback${i + 1}`, ep, config.model, 1, config.taskClass)));
  // Same role binding as the agent: own provider, else own endpoint, else the main connection.
  const roleProvider = (own?: string, ownEndpoint?: string) => own ?? (ownEndpoint ? undefined : config.provider);
  if (config.plannerModel) {
    const p = roleProvider(config.plannerProvider, config.plannerEndpoint);
    out.push(make("planner", config.plannerEndpoint ?? config.endpoint, config.plannerModel, 2, config.plannerTaskClass, credentialFingerprint(config.plannerApiKey, identity) ?? account, PLANNER_PREFERRED, p));
  }
  if (config.coderModel) {
    const p = roleProvider(config.coderProvider, config.coderEndpoint);
    out.push(make("coder", config.coderEndpoint ?? config.endpoint, config.coderModel, 2, config.taskClass, credentialFingerprint(config.coderApiKey, identity) ?? account, CODER_PREFERRED, p));
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.endpoint}|${r.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
