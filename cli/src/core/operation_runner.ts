/**
 * Drives a ConvergenceScheduler: executes the unit it picks, feeds resource observations back into the registry,
 * waits durably when nothing is runnable, revalidates resources on wake, and persists after every transition so a
 * restarted process continues from the same decision point.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AutonomousAgent } from "../agent.js";
import { LocalLlmClient, mayBindCredential, storedCredentialFor } from "../client.js";
import { providerDefinition } from "../providers.js";
import { providerApiKey } from "../credentials.js";
import type { ChatMessage, HarnessConfig } from "../types.js";
import { realRecoveryClock, type RecoveryClock } from "./provider_recovery.js";
import { ConvergenceScheduler, unitBaseTask, type Decision, type DurableOperationState, type OperationEvent, type UnitRunResult, type WorkUnit } from "./operation.js";
import { redactForPersistence } from "./persistence_protection.js";
import { ROLE_PROFILES } from "./roles.js";
import {
  applyProviderCatalog,
  credentialFingerprint,
  ResourceRegistry,
  type RegistryEvent,
  type ResourceConditionRecord,
  type ResourceDescriptor,
} from "./resources.js";
import { DurableStateManager, type DurableTaskState, type TaskRecoveryResult } from "./state.js";
import { turnSucceeded, type InferenceFailure, type TurnResult } from "./turn.js";
import { WorkspacePath } from "./workspace_path.js";

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
  /** Provider waits longer than this hand the unit back to the scheduler (shorter blips are waited in place). */
  inPlaceMaxWaitMs?: number;
  /**
   * Interactive callers: an operation-level wait longer than this is persisted as WAITING and returned instead of
   * slept in-process (resume continues it). Default: wait in-process.
   */
  maxInProcessWaitMs?: number;
  maxIterations?: number;
}

const ENDPOINT_SCOPES = new Set(["endpoint", "provider"]);

export class OperationRunner {
  readonly registry: ResourceRegistry;
  readonly scheduler: ConvergenceScheduler;
  private readonly clock: RecoveryClock;

  constructor(
    readonly state: DurableOperationState,
    private readonly opts: OperationRunnerOptions,
  ) {
    this.clock = opts.clock ?? realRecoveryClock;
    this.registry = new ResourceRegistry(state.resources, state.conditions, this.clock, (e) => this.onRegistryEvent(e));
    this.scheduler = new ConvergenceScheduler(state, this.registry, () => this.clock.now(), opts.onEvent);
  }

  async run(signal?: AbortSignal): Promise<DurableOperationState> {
    if (this.state.status === "COMPLETE" || this.state.status === "CANCELLED") return this.state;
    this.scheduler.reconcileInterruptedRuns();
    if (this.state.status === "WAITING" && this.state.wait && Date.parse(this.state.wait.wakeAt) <= this.clock.now()) {
      await this.revalidate(signal);
    } else {
      try {
        await this.opts.executor.refresh?.(this.registry, signal);
      } catch {}
    }
    this.save();
    const maxIterations = this.opts.maxIterations ?? 10_000;
    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) return this.cancelled();
      const d = this.scheduler.decide();
      if (d.kind === "run") {
        if (await this.revalidateBeforeAssign(d.resource, signal)) continue;
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
        await this.revalidate(signal);
        continue;
      }
      this.scheduler.finish(d);
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
        options: [],
      }],
    });
    this.save();
    return this.state;
  }

  private async execute(d: Extract<Decision, { kind: "run" }>, signal?: AbortSignal): Promise<UnitRunResult> {
    const { unit, resource } = d;
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
    };
    try {
      return await this.opts.executor.run(unit, resource, ctx);
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

  /** On wake: refresh catalogs and probe endpoints whose recheck time has come; model/quota windows simply end. */
  private async revalidate(signal?: AbortSignal): Promise<void> {
    try {
      await this.opts.executor.refresh?.(this.registry, signal);
    } catch {}
    if (!this.opts.executor.probe) return;
    const probed = new Set<string>();
    for (const c of this.registry.due()) {
      if (!ENDPOINT_SCOPES.has(c.scope) || probed.has(c.key)) continue;
      probed.add(c.key);
      const resource = this.registry.get(c.resourceId);
      if (!resource) continue;
      try {
        const r = await this.opts.executor.probe(resource, signal);
        this.registry.observeProbe(resource, r.available, r.failure);
      } catch {
        if (signal?.aborted) return;
      }
    }
  }

  /**
   * A resource whose catalog or endpoint condition merely expired is checked side-effect free (catalog refresh,
   * probe) before work is sent to it, so a still-present condition is not rediscovered with a real request.
   * True when the check changed the resource's conditions and the decision must be re-made.
   */
  private async revalidateBeforeAssign(resource: ResourceDescriptor, signal?: AbortSignal): Promise<boolean> {
    const checkable = (c: ResourceConditionRecord) => c.source === "provider-catalog" || ENDPOINT_SCOPES.has(c.scope);
    const stale = this.registry.dueFor(resource).filter(checkable);
    if (!stale.length) return false;
    const before = JSON.stringify(stale);
    if (stale.some((c) => c.source === "provider-catalog")) {
      try {
        await this.opts.executor.refresh?.(this.registry, signal);
      } catch {}
    }
    if (stale.some((c) => ENDPOINT_SCOPES.has(c.scope)) && this.opts.executor.probe) {
      try {
        const r = await this.opts.executor.probe(resource, signal);
        this.registry.observeProbe(resource, r.available, r.failure);
      } catch {}
    }
    return JSON.stringify(this.registry.dueFor(resource).filter(checkable)) !== before;
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

  private cancelled(): DurableOperationState {
    this.scheduler.cancel();
    this.save();
    return this.state;
  }

  private save(): void {
    this.state.conditions = this.registry.snapshot();
    this.state.updatedAt = new Date(this.clock.now()).toISOString();
    this.opts.persist(this.state);
  }
}

// ---------------------------------------------------------------- persistence

const LIFECYCLE: Record<DurableOperationState["status"], DurableTaskState["status"]> = {
  RUNNING: "in_progress",
  WAITING: "in_progress",
  BLOCKED: "in_progress",
  COMPLETE: "completed",
  CANCELLED: "interrupted",
};

/** Operations are durable tasks: the same atomic, workspace-bound task store that turn recovery uses. */
export class OperationStore {
  readonly manager: DurableStateManager;
  private readonly workspace: WorkspacePath;

  /** `baseDir` defaults to the task store turn recovery uses (~/.nexus/tasks). */
  constructor(workspace: string, baseDir?: string) {
    this.workspace = WorkspacePath.fromSelectedWorkspace(path.resolve(workspace));
    this.manager = new DurableStateManager({ ...(baseDir ? { baseDir } : {}), workspacePaths: [this.workspace] });
  }

  save(op: DurableOperationState): void {
    const existing = this.manager.hasTaskState(op.id) ? this.manager.loadTaskState(op.id) : undefined;
    const state: DurableTaskState = {
      schemaVersion: 1,
      taskId: op.id,
      sessionId: op.id,
      id: op.id,
      title: `Operation: ${op.objective.slice(0, 80)}`,
      workspacePath: this.workspace.value,
      workspace: this.workspace.value,
      createdAt: existing?.createdAt ?? op.createdAt,
      updatedAt: op.updatedAt,
      status: LIFECYCLE[op.status],
      activePlan: op.units.map((u) => ({ name: u.title, status: u.status === "COMPLETE" ? "completed" : u.status === "RUNNING" ? "in_progress" : "pending", detail: u.status })),
      milestones: existing?.milestones ?? [],
      validationReceipts: [],
      messages: [],
      currentOperation: null,
      operation: op,
    };
    this.manager.saveTaskState(state, [this.workspace]);
  }

  load(id: string): DurableOperationState {
    const state = this.manager.loadTaskState(id, this.workspace.value, [this.workspace]);
    if (!state.operation) throw new Error(`Task ${id} is not an operation`);
    return state.operation;
  }

  list(): DurableOperationState[] {
    const out: DurableOperationState[] = [];
    for (const t of this.manager.listTasks()) {
      if (!t.title.startsWith("Operation: ")) continue;
      try {
        out.push(this.load(t.taskId));
      } catch {}
    }
    return out;
  }

  /**
   * One driver per operation: a second process resuming it would execute its units twice. The lock names the
   * holder's pid; a lock whose holder on this host is gone is stale and taken over. Returns the release function.
   */
  acquire(id: string): () => void {
    const lockPath = path.join(this.manager.getBaseDir(), `${id}.lock`);
    const create = () => fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }), { flag: "wx" });
    try {
      create();
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let holder: { pid?: number; host?: string; at?: string } = {};
      try {
        holder = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      } catch {}
      // A lock written before this host last booted is stale even if its pid has since been reused.
      const beforeBoot = holder.at !== undefined && Date.parse(holder.at) < Date.now() - os.uptime() * 1000;
      if (holder.host !== os.hostname() || (!beforeBoot && holder.pid !== undefined && processAlive(holder.pid))) {
        throw new Error(`Operation ${id} is already being driven by pid ${holder.pid ?? "?"} on ${holder.host ?? "?"} (lock ${lockPath}).`);
      }
      fs.rmSync(lockPath, { force: true });
      create();
    }
    return () => {
      try {
        if (JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid === process.pid) fs.rmSync(lockPath, { force: true });
      } catch {}
    };
  }

  /** Most recently updated operation in this workspace that is waiting or running (to resume after restart). */
  latestResumable(): DurableOperationState | undefined {
    return this.list().find((op) => op.status === "WAITING" || op.status === "RUNNING");
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
  opts: { now?: () => number; onEvent?: (e: OperationEvent) => void } = {},
): DurableOperationState {
  const release = store.acquire(id);
  try {
    const state = store.load(id);
    const now = opts.now ?? Date.now;
    const registry = new ResourceRegistry(state.resources, state.conditions, { now, random: Math.random });
    new ConvergenceScheduler(state, registry, now, opts.onEvent).resolve(decisionId, optionId, note);
    state.conditions = registry.snapshot();
    state.updatedAt = new Date(now()).toISOString();
    store.save(state);
    return state;
  } finally {
    release();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
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
export function resourcesFromConfig(config: HarnessConfig): ResourceDescriptor[] {
  const account = credentialFingerprint(config.apiKey) ?? (config.provider ? undefined : credentialFingerprint(storedCredentialFor(config.endpoint) ?? undefined));
  const make = (id: string, endpoint: string, model: string, rank: number, taskClass?: string, key = account, preferredFor?: string[], providerId?: string): ResourceDescriptor => ({
    id,
    provider: providerId ?? origin(normalizeEndpoint(endpoint)),
    endpoint: providerId ? endpoint.trim().replace(/\/+$/, "") : normalizeEndpoint(endpoint),
    model,
    ...(providerId ? { providerId } : {}),
    capabilities: ["tools"],
    rank,
    ...(key ? { account: key } : {}),
    ...(taskClass ? { taskClass } : {}),
    ...(preferredFor ? { preferredFor } : {}),
  });
  const out: ResourceDescriptor[] = [make("primary", config.endpoint, config.model, 0, config.taskClass, account, undefined, config.provider)];
  if (!config.provider) (config.fallbackEndpoints ?? []).forEach((ep, i) => out.push(make(`primary@fallback${i + 1}`, ep, config.model, 1, config.taskClass)));
  // Same role binding as the agent: own provider, else own endpoint, else the main connection.
  const roleProvider = (own?: string, ownEndpoint?: string) => own ?? (ownEndpoint ? undefined : config.provider);
  if (config.plannerModel) {
    const p = roleProvider(config.plannerProvider, config.plannerEndpoint);
    out.push(make("planner", config.plannerEndpoint ?? config.endpoint, config.plannerModel, 2, config.plannerTaskClass, credentialFingerprint(config.plannerApiKey) ?? account, PLANNER_PREFERRED, p));
  }
  if (config.coderModel) {
    const p = roleProvider(config.coderProvider, config.coderEndpoint);
    out.push(make("coder", config.coderEndpoint ?? config.endpoint, config.coderModel, 2, config.taskClass, credentialFingerprint(config.coderApiKey) ?? account, CODER_PREFERRED, p));
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.endpoint}|${r.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- agent-backed executor

export interface AgentExecutorOptions {
  baseConfig: HarnessConfig;
  /** Builds the unit's agent (tests inject state directories and clocks). */
  createAgent?: (config: HarnessConfig) => AutonomousAgent;
  /** Read provider `/v1/models` metadata on wake and at start. */
  discoverCatalog?: boolean;
}

/**
 * Why a recovered conversation cannot continue `unit`, or undefined when it holds the system prompt and a unit prompt
 * Nexus issued with the authorized task (the first prompt, or a resume prompt where compaction kept only that). The
 * task is matched before operator revisions (an earlier conversation predates them) and as persisted (redacted).
 */
function resumeHistoryProblem(messages: ChatMessage[], unit: WorkUnit): string | undefined {
  if (messages.length === 0) return "no conversation was recorded";
  if (messages[0].role !== "system") return "its recorded conversation has no system prompt";
  const task = unitBaseTask(unit.prompt);
  const forms = [task, redactForPersistence(task)];
  const holdsTask = (m: ChatMessage) =>
    m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Work unit ") && forms.some((f) => (m.content as string).includes(f));
  if (!messages.some(holdsTask)) return "its recorded conversation does not contain the unit's authorized task";
  return undefined;
}

/** Nothing happened in the conversation yet (for example, its first prompt was withdrawn before inference). */
const conversationNotStarted = (messages: ChatMessage[]): boolean => messages.length === 1 && messages[0].role === "system";

/**
 * Runs a work unit as one truthful agent turn pinned to the chosen resource. The unit's conversation is its own
 * durable task, so a parked or rerouted unit resumes from its history (tools already run are not repeated) on
 * whichever qualified resource the scheduler picks next.
 */
export class AgentWorkUnitExecutor implements WorkUnitExecutor {
  constructor(private readonly opts: AgentExecutorOptions) {}

  configFor(resource: ResourceDescriptor, unit?: WorkUnit): HarnessConfig {
    const base = this.opts.baseConfig;
    // The client sends a key only to the origin it belongs to, so the configured key never reaches another provider.
    // A spec names apiKeyEnv for its own provider keys; it cannot re-home a stored credential to another origin.
    const specKey = resource.apiKeyEnv ? process.env[resource.apiKeyEnv] : undefined;
    const def = providerDefinition(resource.providerId);
    // A provider resource uses its own key (apiKeyEnv, else the provider's variable), bound to its own origin.
    const ownKey = def ? specKey ?? providerApiKey(def.id, def.credentialEnv) : specKey;
    const credential = def || resource.apiKeyEnv
      ? { apiKey: mayBindCredential(ownKey, resource.endpoint) ? ownKey : undefined, credentialOrigin: origin(resource.endpoint) }
      : { apiKey: base.apiKey, credentialOrigin: base.credentialOrigin ?? origin(normalizeEndpoint(base.endpoint)) };
    // A resource that names a cloud provider in the operator's spec is an explicit selection of that destination.
    const authorizedDisclosureOrigins = def
      ? [...(base.authorizedDisclosureOrigins ?? []), origin(resource.endpoint)]
      : base.authorizedDisclosureOrigins;
    const contextLimit = Math.min(base.contextLimit ?? 65_536, resource.contextLength ?? Number.POSITIVE_INFINITY);
    return {
      ...base,
      endpoint: resource.endpoint,
      model: resource.model,
      provider: resource.providerId,
      ...credential,
      ...(authorizedDisclosureOrigins ? { authorizedDisclosureOrigins } : {}),
      pinEndpoint: true,
      fallbackEndpoints: [],
      taskClass: resource.taskClass ?? unit?.taskClass ?? base.taskClass,
      contextLimit,
      plannerModel: undefined,
      plannerEndpoint: undefined,
      plannerApiKey: undefined,
      coderModel: undefined,
      coderEndpoint: undefined,
      coderApiKey: undefined,
      plannerProvider: undefined,
      coderProvider: undefined,
    };
  }

  async run(unit: WorkUnit, resource: ResourceDescriptor, ctx: UnitRunContext): Promise<UnitRunResult> {
    const config = this.configFor(resource, unit);
    const agent = this.opts.createAgent ? this.opts.createAgent(config) : new AutonomousAgent(config, 1);
    let lastCondition: ResourceConditionRecord | null = null;
    try {
      let prompt: string;
      if (unit.agentTaskId) {
        let recovered: TaskRecoveryResult | undefined;
        let unusable: string | undefined;
        try {
          recovered = await agent.recoverFromTaskState(unit.agentTaskId);
        } catch (err: any) {
          unusable = `its durable state could not be loaded (${String(err?.message ?? err).slice(0, 160)})`;
        }
        if (recovered?.interrupted) {
          const op = recovered.interruptedOperation;
          const what = op?.completedAt ? "finished, but its result was not saved before the process stopped" : "was in flight when the process stopped";
          return {
            kind: "failed",
            cause: "INTERRUPTED",
            reason: `tool ${op?.toolName ?? "?"} ${what}`,
            question: `${unit.title}: tool '${op?.toolName ?? "?"}' may have partially run before Nexus stopped. Inspect and continue, or stop?`,
            options: [{ label: "continue after inspection", action: { kind: "retry" } }],
          };
        }
        // Only a record that tracks obligations can show that nothing happened; without one, earlier work is unknown.
        const notStarted =
          !unusable && recovered?.state.unverifiedChangesPending !== undefined && conversationNotStarted(agent.getMessages());
        if (!notStarted) unusable ??= resumeHistoryProblem(agent.getMessages(), unit);
        const decision = ctx.operatorDecision
          ? `The operator decided: ${ctx.operatorDecision.label}${ctx.operatorDecision.note ? ` — ${ctx.operatorDecision.note}` : ""}.\n`
          : "";
        if (unusable) {
          // A partial record is never continued or taken as evidence; only the operator can start the unit over.
          if (!ctx.operatorDecision?.restart) {
            return {
              kind: "failed",
              cause: "INTERRUPTED",
              reason: `durable history unusable: ${unusable}`,
              question: `${unit.title} cannot be resumed: ${unusable}. Restart it from its authorized task (its earlier progress is lost, and changes it may have made stay unverified), or stop?`,
              options: [{ label: "restart the unit from its authorized task", action: { kind: "retry", restart: true } }],
            };
          }
          // Without a recorded obligation (state unloadable, or written before obligations were recorded) earlier
          // changes are unknown, so they count as unverified.
          agent.restartConversation(!recovered || recovered.state.unverifiedChangesPending === undefined);
          prompt =
            `${this.initialPrompt(unit, ctx)}\n\n${decision}` +
            `Note: an earlier attempt at this unit ran, but its record was lost (${unusable}). Workspace changes it may have made are unknown and unverified; check the workspace before relying on it.`;
        } else if (notStarted) {
          prompt = `${this.initialPrompt(unit, ctx)}${decision ? `\n\n${decision}` : ""}`;
        } else {
          const op = recovered?.state.currentOperation;
          const stopped = op?.status === "interrupted"
            ? `Nexus stopped while ${op.toolName} ${op.argsSummary ?? ""} was running or before its result was saved; it may have partially run. Check its effects before relying on them.\n`
            : "";
          prompt =
            `[Work unit resumed on ${resource.id} (${resource.model}) after: ${ctx.resumeReason ?? "a resource change"}]\n${decision}` +
            `The unit's authorized task, which remains its only objective:\n${unit.prompt}\n${stopped}` +
            `Your earlier progress on this unit is above; tools that already ran are not repeated. Continue the unit and call task_completed with a concise summary when done.`;
        }
      } else {
        prompt = this.initialPrompt(unit, ctx);
      }
      ctx.bindAgentTask(agent.getTaskId());
      agent.setProviderRecoveryHooks({
        onFailure: (f) => {
          const c = ctx.observeFailure(f);
          if (c) lastCondition = c;
        },
        shouldYield: (f, delay) => ctx.shouldYield(f, delay),
      });
      const turn = await agent.runTurn(prompt, undefined, { signal: ctx.signal });
      try {
        agent.checkpointDurableState(`work unit ${unit.id}`, turn);
      } catch {}
      return this.classify(unit, resource, turn, agent.getCompletionSummary()?.summary, lastCondition, ctx);
    } finally {
      agent.setProviderRecoveryHooks(undefined);
      agent.shutdown();
    }
  }

  private initialPrompt(unit: WorkUnit, ctx: UnitRunContext): string {
    const role = unit.role ? ROLE_PROFILES[unit.role]?.systemPromptAddendum ?? "" : "";
    const deps = ctx.dependencies.length
      ? `\nCompleted prerequisite work:\n${ctx.dependencies.map((d) => `- ${d.title}: ${d.summary}`).join("\n")}\n`
      : "";
    return (
      `[Work unit '${unit.id}': ${unit.title}] Part of the operation: ${ctx.objective}\n${role}${deps}\n` +
      `Task:\n${unit.prompt}\n\nCall task_completed with a concise summary when done.`
    );
  }

  private classify(
    unit: WorkUnit,
    resource: ResourceDescriptor,
    turn: TurnResult,
    summary: string | undefined,
    condition: ResourceConditionRecord | null,
    ctx: UnitRunContext,
  ): UnitRunResult {
    if (turn.execution === "INTERRUPTED") return { kind: "cancelled" };
    if (turnSucceeded(turn)) {
      ctx.observeSuccess();
      return { kind: "completed", summary: summary ?? turn.detail ?? "completed", outcome: turn.outcome };
    }
    const f = turn.inferenceFailure;
    if (f) {
      if (f.execution === "NOT_EXECUTED" && condition) return { kind: "resource_unavailable", failure: f, condition };
      if (f.execution !== "NOT_EXECUTED") return { kind: "execution_unknown", failure: f };
      return {
        kind: "failed",
        cause: "EXECUTION_FAILED",
        reason: `inference rejected by ${resource.id}: ${f.message.slice(0, 200)}`,
        question: `${unit.title}: ${resource.id} rejected the request (${f.condition ?? f.kind}${f.httpStatus ? `, HTTP ${f.httpStatus}` : ""}). Revise the unit, retry after fixing the resource, or assign it elsewhere?`,
        options: [
          { label: "revise the unit (note required)", action: { kind: "revise" } },
          { label: `retry after fixing ${resource.id}`, action: { kind: "retry", clearResources: [resource.id] } },
        ],
        offerReassign: true,
      };
    }
    if (turn.execution === "BLOCKED" && turn.capacity) {
      return {
        kind: "failed",
        cause: "EXECUTION_FAILED",
        reason: `context capacity exceeded on ${resource.id} (limit ${turn.capacity.contextLimit})`,
        question: `${unit.title} needs more context than ${resource.id} admits (${turn.capacity.estimatedPromptTokens} of ${turn.capacity.contextLimit} tokens). Assign it to a larger-context resource, or revise it to need less?`,
        options: [{ label: "revise the unit (note required)", action: { kind: "revise" } }],
        offerReassign: true,
      };
    }
    if (turn.execution === "LIMIT_REACHED") {
      return {
        kind: "failed",
        cause: "EXECUTION_FAILED",
        reason: `step limit ${turn.steps.max} reached`,
        question: `${unit.title} used all ${turn.steps.max} steps without finishing. Continue from its history with a fresh step budget, or revise it?`,
        options: [
          { label: "continue with more steps", action: { kind: "retry" } },
          { label: "revise the unit (note required)", action: { kind: "revise" } },
        ],
      };
    }
    return {
      kind: "failed",
      cause: "EXECUTION_FAILED",
      reason: `${turn.execution}/${turn.outcome}${turn.reason ? ` (${turn.reason})` : ""}${turn.detail ? `: ${turn.detail}` : ""}`.slice(0, 300),
      question: `${unit.title} ended ${turn.execution.toLowerCase()} without an established result${turn.reason ? ` (${turn.reason})` : ""}. Retry it, or revise it?`,
      options: [
        { label: "retry", action: { kind: "retry" } },
        { label: "revise the unit (note required)", action: { kind: "revise" } },
      ],
    };
  }

  async probe(resource: ResourceDescriptor, signal?: AbortSignal): Promise<{ available: boolean; failure?: InferenceFailure }> {
    const client = new LocalLlmClient(this.configFor(resource));
    const r = await client.probeAvailability(signal, { timeoutMs: 5_000 });
    if (r.available) return { available: true };
    return {
      available: false,
      failure: {
        kind: r.httpStatus ? "http_error" : "network_error",
        origin: r.httpStatus ? "provider" : "transport",
        message: r.detail ?? r.condition,
        ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
        condition: r.condition,
        execution: "NOT_EXECUTED",
        ...(r.hints ? { hints: r.hints } : {}),
      },
    };
  }

  async refresh(registry: ResourceRegistry, signal?: AbortSignal): Promise<void> {
    if (!this.opts.discoverCatalog) return;
    const byEndpoint = new Map<string, ResourceDescriptor>();
    for (const r of registry.list()) if (!byEndpoint.has(r.endpoint)) byEndpoint.set(r.endpoint, r);
    for (const [endpoint, r] of byEndpoint) {
      try {
        const entries = await new LocalLlmClient(this.configFor(r)).listModelCatalog(signal);
        applyProviderCatalog(registry, endpoint, entries);
      } catch {}
    }
  }
}
