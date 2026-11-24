/** Durable engineering goals are existing team operations with a pinned ObjectiveLedger. */
import { randomUUID } from "node:crypto";
import { acceptDescoping, applyRequirementUpdates, createLedger, recordAttempt, requirementDone, type ObjectiveLedger, type VerificationAttempt } from "./core/objective.js";
import { OperationRunner, AgentWorkUnitExecutor, OperationLockedError, OperationStore, driveOperation, currentBootId, type WorkUnitExecutor } from "./core/operation_runner.js";
import { TeamOrchestrator } from "./team.js";
import type { DurableOperationState, OperationEvent, WorkUnit } from "./core/operation.js";
import type { ResourceDescriptor } from "./core/resources.js";
import type { HarnessConfig } from "./types.js";

export const GOAL_ID_PREFIX = "goal-";
export type GoalStatus = "RUNNING" | "WAITING" | "PAUSED" | "BLOCKED" | "COMPLETE" | "CANCELLED";

export interface GoalUsage {
  agentRuns: number;
  reportedTokens: number;
  estimatedTokens: number;
  inferenceRequests: number;
  totalTokens: number;
  tokenAccountingComplete: boolean;
  maxTotalTokens?: number;
}

export interface GoalResult {
  id: string;
  status: GoalStatus;
  operation: DurableOperationState;
  ledger?: ObjectiveLedger;
  reason?: string;
  usage?: GoalUsage;
}

export interface GoalRunnerOptions {
  signal?: AbortSignal;
  onEvent?: (event: OperationEvent) => void;
  store?: OperationStore;
  executor?: WorkUnitExecutor;
  resources?: ResourceDescriptor[];
  maxInProcessWaitMs?: number;
  now?: () => number;
}

function isGoal(operation: DurableOperationState): boolean {
  return operation.id.startsWith(GOAL_ID_PREFIX);
}

function reviewerAccepted(operation: DurableOperationState): boolean {
  const implement = operation.units.find((unit) => unit.id === "implement");
  const reviewer = operation.units.find((unit) => unit.id === "review");
  if (!implement || !reviewer || reviewer.status !== "COMPLETE" || !reviewer.result?.summary.startsWith("ACCEPT:")) return false;
  if (!(reviewer.requires.independentOf ?? []).includes(implement.id)) return false;
  if (reviewer.result.overriding?.some((entry) => entry.includes("not independent"))) return false;
  const implementers = new Set(implement.modelsUsed);
  return reviewer.modelsUsed.length > 0 && reviewer.modelsUsed.every((model) => !implementers.has(model));
}

function deterministicVerificationPassed(operation: DurableOperationState): boolean {
  const tester = operation.units.find((unit) => unit.id === "verify");
  return tester?.status === "COMPLETE" && tester.result?.verification?.status === "PASSED" && tester.result.verification.hasExecutedTests && tester.result.verification.definitionBound !== false;
}

import * as os from "node:os";

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err: any) { return err?.code === "EPERM"; }
}

function staleDriverReason(operation: DurableOperationState, bootId = currentBootId()): string | undefined {
  if (!["RUNNING", "WAITING", "BLOCKED"].includes(operation.status)) return undefined;
  const reasons: string[] = [];
  if (bootId && operation.activeBootId && operation.activeBootId !== bootId) reasons.push(`earlier host boot (${operation.activeBootId.slice(0, 12)})`);
  if (operation.activePid !== undefined && operation.activeHost === os.hostname() && !processAlive(operation.activePid)) {
    reasons.push(`earlier process (pid ${operation.activePid}) is no longer running`);
  }
  if (reasons.length === 0 && operation.activePid === undefined && operation.activeBootId === undefined) {
    reasons.push("an earlier process left it active without driver identity metadata");
  }
  if (reasons.length === 0) return undefined;
  return operation.pauseReason?.startsWith("Paused on resume:")
    ? operation.pauseReason
    : `Paused on resume: this goal was left active by ${reasons.join("; ")}. It was not cleanly paused before this process started. Resume it explicitly after inspecting its state.`;
}

export function goalStatus(operation: DurableOperationState, ledger?: ObjectiveLedger, bootId = currentBootId()): { status: GoalStatus; reason?: string } {
  if (operation.status === "CANCELLED") return { status: "CANCELLED" };
  const stale = staleDriverReason(operation, bootId);
  if (operation.status === "PAUSED" || stale) return { status: "PAUSED", ...(operation.pauseReason || stale ? { reason: operation.pauseReason ?? stale } : {}) };
  if (operation.status === "WAITING") return { status: "WAITING" };
  if (operation.status === "RUNNING") return { status: "RUNNING" };
  if (operation.status === "BLOCKED") return { status: "BLOCKED", reason: "A required work unit or operator decision is blocked." };
  if (!ledger || ledger.objectiveSha256 !== createLedger(operation.objective).objectiveSha256) {
    return { status: "BLOCKED", reason: "The durable objective ledger is missing or does not match the original objective." };
  }
  if (!reviewerAccepted(operation)) return { status: "BLOCKED", reason: "Independent acceptance review is missing, rejected, or not independent of implementation." };
  if (!deterministicVerificationPassed(operation)) return { status: "BLOCKED", reason: "A passing deterministic verification receipt is missing or incomplete." };
  const unresolved = ledger.requirements.filter((requirement) => !requirementDone(requirement));
  if (unresolved.length) {
    return { status: "BLOCKED", reason: `Requirements remain open: ${unresolved.map((requirement) => requirement.id).join(", ")}.` };
  }
  return { status: "COMPLETE" };
}

function copiedAttempt(ledger: ObjectiveLedger, source: VerificationAttempt): VerificationAttempt {
  const { n: _n, at, parent: _parent, diffHash: _diffHash, ...attempt } = source;
  return recordAttempt(ledger, attempt, at);
}

/**
 * A goal's top-level ObjectiveLedger is the acceptance ledger. Work-unit ledgers remain attached to their durable
 * task records; only implementer evidence and verifier-backed tester states are folded into the parent ledger.
 */
function foldUnitLedgers(operation: DurableOperationState, store: OperationStore, workspace: string): ObjectiveLedger | undefined {
  const parent = store.manager.loadTaskState(operation.id, workspace);
  if (!parent.objective || parent.objective.objective !== operation.objective) return parent.objective ?? undefined;
  const ledger = parent.objective;
  const before = JSON.stringify(ledger);
  const byRole = (role: string): { unit: WorkUnit; ledger?: ObjectiveLedger } | undefined => {
    const unit = operation.units.find((candidate) => candidate.role === role);
    if (!unit?.agentTaskId) return unit ? { unit } : undefined;
    try {
      const state = store.manager.loadTaskState(unit.agentTaskId, workspace);
      const child = state.objective;
      return { unit, ...(child?.objectiveSha256 === ledger.objectiveSha256 ? { ledger: child } : {}) };
    } catch {
      return { unit };
    }
  };
  const implementation = byRole("implementer");
  const verification = byRole("tester");
  const review = byRole("reviewer");
  const accepted = reviewerAccepted(operation);
  const verifierPassed = deterministicVerificationPassed(operation);

  for (const requirement of ledger.requirements) {
    const implemented = implementation?.ledger?.requirements.find((entry) => entry.id === requirement.id);
    const tested = verification?.ledger?.requirements.find((entry) => entry.id === requirement.id);
    const by = tested?.verifiedBy;
    const sourceAttempt = by && verification?.ledger?.verification.find((entry) => entry.n === by.attempt && entry.command === by.command && entry.inputs === by.inputs && entry.status === "PASSED");
    const verifierMatches = requirement.kind ? requirement.verifierSource === "operator" && requirement.verifier === sourceAttempt?.command : true;
    const eligibleForVerification = tested?.status === "verified" && Boolean(sourceAttempt) && verifierMatches && accepted && verifierPassed;
    const alreadyVerifiedForSameInput = Boolean(
      eligibleForVerification && requirement.status === "verified" && requirement.verifiedBy?.command === sourceAttempt?.command && requirement.verifiedBy?.inputs === sourceAttempt?.inputs,
    );
    if (implemented && ["implemented", "verified"].includes(implemented.status) && implemented.evidence.length) {
      if (requirement.status !== "verified" || !alreadyVerifiedForSameInput) {
        requirement.status = "implemented";
        delete requirement.verifiedBy;
      }
      requirement.evidence = [...new Set([...requirement.evidence, ...implemented.evidence])].slice(-6);
      requirement.evidenceSources = { ...(requirement.evidenceSources ?? {}), ...(implemented.evidenceSources ?? {}) };
      requirement.updatedAt = implemented.updatedAt;
    }

    if (eligibleForVerification && sourceAttempt && tested && !alreadyVerifiedForSameInput) {
      const attempt = copiedAttempt(ledger, { ...sourceAttempt, requirementId: requirement.id });
      const result = applyRequirementUpdates(
        ledger,
        [{ id: requirement.id, status: "verified", evidence: tested.evidence }],
        undefined,
        new Date().toISOString(),
        attempt,
        (command, id) => command === attempt.command && id === requirement.id && attempt.status === "PASSED" ? attempt : undefined,
      );
      if (result.ok) requirement.evidenceSources = { ...(requirement.evidenceSources ?? {}), ...(tested.evidenceSources ?? {}) };
    }
  }
  if (JSON.stringify(ledger) !== before) {
    parent.updatedAt = new Date().toISOString();
    parent.objective = ledger;
    store.manager.saveTaskState(parent);
  }
  return ledger;
}

/** Objective supplied to a fresh durable role task; the tester sees implementation evidence folded into the parent. */
export function objectiveLedgerForGoalUnit(
  operationId: string,
  unit: WorkUnit,
  store: OperationStore,
  workspace: string,
): ObjectiveLedger | undefined {
  if (unit.role !== "implementer" && unit.role !== "tester") return undefined;
  const operation = store.load(operationId);
  if (!isGoal(operation)) return undefined;
  const ledger = unit.role === "tester"
    ? foldUnitLedgers(operation, store, workspace)
    : store.manager.loadTaskState(operationId, workspace).objective ?? undefined;
  return ledger ? structuredClone(ledger) : undefined;
}

export class GoalOrchestrator {
  private readonly store: OperationStore;
  private readonly executor: WorkUnitExecutor;

  constructor(private readonly config: HarnessConfig, private readonly options: GoalRunnerOptions = {}) {
    this.store = options.store ?? new OperationStore(config.workspace);
    this.executor = options.executor ?? new AgentWorkUnitExecutor({
      baseConfig: { ...config, maxSteps: Math.min(config.maxSteps, 15) },
      objectiveLedgerForUnit: (operationId, unit) => objectiveLedgerForGoalUnit(operationId, unit, this.store, this.config.workspace),
    });
  }

  list(): GoalResult[] {
    return this.store.list().filter(isGoal).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((operation) => {
      try { return this.result(operation); }
      catch (error) {
        if (!(error instanceof OperationLockedError)) throw error;
        let ledger: ObjectiveLedger | undefined;
        try { ledger = this.store.manager.loadTaskState(operation.id, this.config.workspace).objective ?? undefined; } catch { /* fail closed below */ }
        const state = goalStatus(operation, ledger);
        return { id: operation.id, status: state.status, operation, ...(ledger ? { ledger } : {}), ...(state.reason ? { reason: state.reason } : {}) };
      }
    });
  }

  resolveTarget(id?: string): DurableOperationState {
    if (id !== undefined) {
      if (!id.startsWith(GOAL_ID_PREFIX)) throw new Error(`goal id '${id}' must start with '${GOAL_ID_PREFIX}'`);
      const operation = this.store.load(id);
      if (!isGoal(operation)) throw new Error(`'${id}' is not a goal`);
      return operation;
    }
    const goals = this.list();
    const active = goals.filter((goal) => ["RUNNING", "WAITING", "PAUSED", "BLOCKED"].includes(goal.status));
    if (active.length === 1) return active[0].operation;
    if (active.length > 1) throw new Error(`multiple active goals: ${active.map((goal) => goal.id).join(", ")}; choose one id`);
    if (goals.length === 1) return goals[0].operation;
    if (!goals.length) throw new Error("no goal exists in this workspace");
    throw new Error(`no active goal can be selected; choose one id from: ${goals.map((goal) => goal.id).join(", ")}`);
  }

  private persistInitialLedger(id: string, objective: string): void {
    const task = this.store.manager.loadTaskState(id, this.config.workspace);
    task.objective = createLedger(objective, new Date(this.options.now?.() ?? Date.now()).toISOString());
    this.store.manager.saveTaskState(task);
  }

  private usage(operation: DurableOperationState): GoalUsage {
    const usage: GoalUsage = { agentRuns: 0, reportedTokens: 0, estimatedTokens: 0, inferenceRequests: 0, totalTokens: 0, tokenAccountingComplete: true };
    for (const unit of operation.units) {
      usage.agentRuns += unit.runs;
      if (!unit.agentTaskId) {
        if (unit.runs > 0) usage.tokenAccountingComplete = false;
        continue;
      }
      try {
        const stats = this.store.manager.loadTaskState(unit.agentTaskId, this.config.workspace).tokenStats;
        if (!stats || !Number.isSafeInteger(stats.total) || stats.total < 0) {
          usage.tokenAccountingComplete = false;
          continue;
        }
        if (typeof stats.requests === "number" && stats.requests > 0 && stats.reportedRequests === stats.requests) usage.reportedTokens += stats.total;
        else usage.estimatedTokens += stats.total;
        usage.totalTokens += stats.total;
        usage.inferenceRequests += stats.requests ?? 0;
      } catch {
        usage.tokenAccountingComplete = false;
      }
    }
    if (operation.policy.maxTotalTokens !== undefined) usage.maxTotalTokens = operation.policy.maxTotalTokens;
    return usage;
  }

  private result(operation: DurableOperationState): GoalResult {
    const release = this.store.acquire(operation.id);
    try {
      const fresh = this.store.load(operation.id);
      const ledger = foldUnitLedgers(fresh, this.store, this.config.workspace);
      const state = goalStatus(fresh, ledger);
      return { id: fresh.id, status: state.status, operation: fresh, usage: this.usage(fresh), ...(ledger ? { ledger } : {}), ...(state.reason ? { reason: state.reason } : {}) };
    } finally {
      release();
    }
  }

  async start(objective: string): Promise<GoalResult> {
    const text = objective.trim();
    if (!text) throw new Error("goal objective cannot be empty");
    if (text.length > 24_000) throw new Error("goal objective exceeds 24,000 characters");
    const id = `${GOAL_ID_PREFIX}${randomUUID()}`;
    const team = new TeamOrchestrator(this.config, {
      id,
      independentReview: true,
      resources: this.options.resources,
      store: this.store,
      executor: this.executor,
      signal: this.options.signal,
      onEvent: this.options.onEvent,
      maxInProcessWaitMs: this.options.maxInProcessWaitMs,
    });
    const operation = team.plan("full", text);
    const bootId = currentBootId();
    if (bootId) operation.activeBootId = bootId;
    operation.activePid = process.pid;
    operation.activeHost = os.hostname();
    const reviewer = operation.units.find((unit) => unit.id === "review");
    if (!reviewer || !operation.units.some((unit) => unit.id === "verify")) throw new Error("goal workflow is missing its verification or independent review unit");
    // Independent acceptance review must inspect the post-verification candidate, including any test changes.
    reviewer.dependsOn = ["verify"];
    this.store.save(operation);
    this.persistInitialLedger(id, text);
    const result = await driveOperation(operation, {
      store: this.store,
      executor: this.executor,
      workspace: this.config.workspace,
      signal: this.options.signal,
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      ...(this.options.maxInProcessWaitMs !== undefined ? { maxInProcessWaitMs: this.options.maxInProcessWaitMs } : {}),
      entry: "existing",
    });
    return this.result(result);
  }

  async resume(id?: string): Promise<GoalResult> {
    const selected = this.resolveTarget(id);
    if (selected.status === "CANCELLED") throw new Error(`goal ${selected.id} was cancelled and cannot be resumed`);
    const result = await driveOperation(selected, {
      store: this.store,
      executor: this.executor,
      workspace: this.config.workspace,
      signal: this.options.signal,
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      ...(this.options.maxInProcessWaitMs !== undefined ? { maxInProcessWaitMs: this.options.maxInProcessWaitMs } : {}),
      entry: "existing",
      prepare: (fresh) => {
        if (fresh.status === "PAUSED") {
          fresh.status = fresh.wait ? "WAITING" : "RUNNING";
          delete fresh.pauseReason;
        }
      },
    });
    return this.result(result);
  }

  async cancel(id?: string): Promise<GoalResult> {
    const selected = this.resolveTarget(id);
    const release = this.store.acquire(selected.id);
    let result: DurableOperationState;
    try {
      const fresh = this.store.load(selected.id);
      if (fresh.status === "COMPLETE" || fresh.status === "CANCELLED") result = fresh;
      else if (fresh.units.some((unit) => unit.status === "RUNNING")) {
        throw new Error(`goal ${fresh.id} has an unsettled work unit; resume it first so Nexus can reconcile unknown effects before cancellation`);
      } else {
        result = await new OperationRunner(fresh, {
          executor: this.executor,
          workspace: this.config.workspace,
          store: this.store,
          persist: (state) => this.store.save(state),
          ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
        }).run(AbortSignal.abort());
      }
    } finally { release(); }
    return this.result(result);
  }

  async pause(id?: string): Promise<GoalResult> {
    const selected = this.resolveTarget(id);
    const release = this.store.acquire(selected.id);
    let operation: DurableOperationState;
    let unchanged = false;
    try {
      operation = this.store.load(selected.id);
      const stale = staleDriverReason(operation);
      if (stale) {
        operation.status = "PAUSED";
        operation.pauseReason = stale;
        delete operation.wait;
        delete operation.blocked;
        this.store.save(operation);
        unchanged = true;
      } else if (["COMPLETE", "CANCELLED", "PAUSED"].includes(operation.status)) unchanged = true;
      else if (operation.units.some((unit) => unit.status === "RUNNING")) {
        throw new Error(`goal ${operation.id} is executing a work unit; let it settle, then pause at the next safe boundary`);
      } else {
        const runner = new OperationRunner(operation, {
          executor: this.executor,
          workspace: this.config.workspace,
          store: this.store,
          persist: (state) => this.store.save(state),
          ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
        });
        runner.scheduler.pause();
        operation.pauseReason = "Paused by operator at a safe boundary.";
        this.store.save(operation);
      }
    } finally { release(); }
    return this.result(unchanged ? selected : operation!);
  }

  results(id?: string): GoalResult {
    return this.result(this.resolveTarget(id));
  }

  updateDescoping(action: "descope" | "accept", requirementId: string, reason?: string, id?: string): ObjectiveLedger {
    const operation = this.resolveTarget(id);
    const release = this.store.acquire(operation.id);
    try {
      const fresh = this.store.load(operation.id);
      if (fresh.status === "RUNNING" || fresh.units.some((unit) => unit.status === "RUNNING")) {
        throw new Error("pause the goal before changing its requirement scope");
      }
      const state = this.store.manager.loadTaskState(operation.id, this.config.workspace);
      const ledger = state.objective;
      if (!ledger) throw new Error("goal objective ledger is missing or corrupt");
      if (action === "descope") {
        const note = reason?.trim();
        if (!note) throw new Error("operator descoping requires a reason");
        const changed = applyRequirementUpdates(ledger, [{ id: requirementId, status: "descoped", note }]);
        if (!changed.ok) throw new Error(changed.errors.join("; "));
      } else {
        const accepted = acceptDescoping(ledger, [requirementId]);
        if (!accepted.accepted.includes(requirementId)) throw new Error(`requirement ${requirementId} is not proposed as descoped`);
      }
      this.store.manager.saveTaskState(state);
      return ledger;
    } finally { release(); }
  }
}

export function goalRequirementRows(result: GoalResult): string[] {
  const ledger = result.ledger;
  if (!ledger) return ["Objective ledger is missing or corrupt; the goal cannot be accepted."];
  return ledger.requirements.map((requirement) => {
    const evidence = requirement.evidence.length ? ` · evidence: ${requirement.evidence.join("; ")}` : "";
    return `${requirement.id} [${requirement.status}${requirement.operatorAccepted ? ", operator accepted" : ""}] ${requirement.text}${evidence}${requirement.note ? ` · ${requirement.note}` : ""}`;
  });
}

export function goalEvidenceRows(operation: DurableOperationState): string[] {
  const rows: string[] = [];
  for (const unit of operation.units) {
    const result = unit.result;
    if (!result) {
      rows.push(`${unit.id}: no completed evidence (${unit.status})`);
      continue;
    }
    rows.push(`${unit.id}: ${result.outcome} — ${result.summary}`);
    if (result.verification) rows.push(`  verifier: ${result.verification.command} — ${result.verification.status}${result.verification.hasExecutedTests ? " (tests executed)" : ""}`);
  }
  for (const receipt of operation.integrations ?? []) rows.push(`integration ${receipt.sequence ?? "?"}: ${receipt.unitId} ${receipt.verification} at ${receipt.integratedCommit}`);
  return rows;
}
