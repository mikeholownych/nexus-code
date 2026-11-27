/** Durable batches are operation specs driven by Nexus's existing operation scheduler and store. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createOperationAccountIdentity } from "./core/account_identity.js";
import { parseBoundaryRules } from "./core/boundary_rules.js";
import { newOperation, type DurableOperationState, type OperationEvent } from "./core/operation.js";
import {
  AgentWorkUnitExecutor,
  OperationExistsError,
  OperationRunner,
  OperationStore,
  driveOperation,
  type WorkUnitExecutor,
} from "./core/operation_runner.js";
import { ensureIntegrationWorktree, newOperationGitState, planOperationGit } from "./core/operation_git.js";
import { ResourceRegistry, type ResourceDescriptor } from "./core/resources.js";
import { credentialStorageHome } from "./client.js";
import { mergeOperationPolicy } from "./config.js";
import { validateBatchSpec, type BatchSpecification } from "./batch_spec.js";
import { normalizeResources, type OperationSpec } from "./operation_cli.js";
import type { BatchPlanAcceptance, BatchPlanStore } from "./batch_plan.js";
import { batchPlanExecution } from "./batch_plan_execution.js";
import { parseOperationVerificationChecks } from "./core/operation_verification.js";
import { realpathAllowingMissing } from "./core/socket_files.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";
import type { HarnessConfig } from "./types.js";

export type BatchStatus = "RUNNING" | "WAITING" | "PAUSED" | "COMPLETE" | "PARTIAL" | "BLOCKED" | "CANCELLED" | "FAILED";

export interface BatchResult {
  id: string;
  status: BatchStatus;
  operation: DurableOperationState;
}
export interface BatchRunnerOptions {
  signal?: AbortSignal;
  onEvent?: (event: OperationEvent) => void;
  store?: OperationStore;
  executor?: WorkUnitExecutor;
  resources?: ResourceDescriptor[];
  maxInProcessWaitMs?: number;
  now?: () => number;
}

const BATCH_ID_PREFIX = "batch-";
const MAX_BATCH_SPEC_BYTES = 256 * 1024;

/** Strictly parse shell-like words for command arguments; quotes and backslash escapes are preserved semantically. */
export function parseBatchWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (escaped) throw new Error("trailing escape in /batch arguments");
  if (quote) throw new Error("unclosed quote in /batch arguments");
  if (started) words.push(current);
  return words;
}

/** Batch specification files are bounded, regular files inside the selected workspace, including through symlinks. */
export function readBatchInputFile(fileName: string, workspace: string): string {
  const root = fs.realpathSync(workspace);
  const written = path.resolve(root, fileName);
  let real: string;
  try {
    real = fs.realpathSync(written);
  } catch {
    throw new Error(`batch specification '${fileName}' was not found`);
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`batch specification '${fileName}' is outside the workspace`);
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX_BATCH_SPEC_BYTES) throw new Error(`batch specification must be a regular file no larger than ${MAX_BATCH_SPEC_BYTES} bytes`);
  return fs.readFileSync(real, "utf8");
}

export function readBatchSpecFile(fileName: string, workspace: string): unknown {
  const input = readBatchInputFile(fileName, workspace);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`cannot parse batch specification '${fileName}': ${error instanceof Error ? error.message : String(error)}`);
  }
  validateBatchSpec(parsed);
  return parsed;
}

function batchId(spec: BatchSpecification): string {
  const suffix = (spec.id ?? randomUUID().slice(0, 12)).replace(/^batch-/, "");
  if (!suffix || suffix.length > 154) throw new Error("batch id must leave room for the required 'batch-' prefix (maximum 154 characters)");
  return `${BATCH_ID_PREFIX}${suffix}`;
}

function isBatch(operation: DurableOperationState): boolean {
  return operation.id.startsWith(BATCH_ID_PREFIX);
}

export function batchStatus(operation: DurableOperationState): BatchStatus {
  if (operation.status === "COMPLETE") return "COMPLETE";
  if (operation.status === "CANCELLED") return "CANCELLED";
  if (operation.status === "PAUSED") return "PAUSED";
  if (operation.status === "RUNNING") return "RUNNING";
  if (operation.status === "WAITING") return "WAITING";
  const required = operation.units.filter((unit) => unit.required !== false && !unit.dropped);
  const completed = required.filter((unit) => unit.status === "COMPLETE").length;
  if (completed > 0) return "PARTIAL";
  const failures = required.filter((unit) => unit.status === "BLOCKED" && unit.blocked?.decision.cause === "EXECUTION_FAILED");
  return failures.length === required.length && required.length > 0 ? "FAILED" : "BLOCKED";
}

export function renderBatchResult(result: BatchResult): string {
  const lines = [`Batch ${result.id}: ${result.status}`, `Objective: ${result.operation.objective}`, ""];
  for (const unit of result.operation.units) {
    const evidence = unit.result?.verification
      ? ` · verifier ${unit.result.verification.status}`
      : unit.result?.outcome ? ` · ${unit.result.outcome}` : "";
    lines.push(`  ${unit.id}: ${unit.status}${unit.required === false ? " (advisory)" : ""}${evidence}`);
    if (unit.result?.summary) lines.push(`    ${unit.result.summary}`);
    if (unit.blocked?.reason) lines.push(`    blocked: ${unit.blocked.reason}`);
  }
  const checks = result.operation.git?.verificationChecks;
  if (checks?.length) {
    const latest = [...(result.operation.integrations ?? [])].reverse().find((receipt) => receipt.verificationBinding?.typedChecks?.length);
    const binding = latest?.verificationBinding;
    lines.push("", binding ? `Checks on candidate ${binding.commit}:` : "Verification checks:");
    for (const check of checks) {
      const outcome = binding?.typedChecks?.find((item) => item.id === check.id);
      const scope = check.unitId ? `unit ${check.unitId}` : "integration";
      lines.push(`  ${check.purpose} (${scope}, ${check.requirement}): ${outcome?.status ?? "PENDING"}`);
      if (outcome?.detail) lines.push(`    ${outcome.detail}`);
    }
  }
  if (result.operation.wait) lines.push("", `Waiting until ${result.operation.wait.wakeAt}: ${result.operation.wait.reason}`);
  if (result.status !== "COMPLETE" && result.status !== "CANCELLED") lines.push("", `Resume with: /batch resume ${result.id}`);
  return lines.join("\n");
}

/**
 * Batch orchestration only maps a validated specification to the existing durable operation model. Dependency
 * admission, resource scheduling, retries, recovery and persistence remain in ConvergenceScheduler/OperationRunner.
 */
export class BatchOrchestrator {
  private readonly store: OperationStore;
  private readonly executor: WorkUnitExecutor;

  constructor(private readonly config: HarnessConfig, private readonly options: BatchRunnerOptions = {}) {
    this.store = options.store ?? new OperationStore(config.workspace);
    this.executor = options.executor ?? new AgentWorkUnitExecutor({ baseConfig: config });
  }

  list(): DurableOperationState[] {
    return this.store.list().filter(isBatch).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  resolveTarget(id?: string): DurableOperationState {
    if (id !== undefined) {
      if (!id.startsWith(BATCH_ID_PREFIX)) throw new Error(`batch id '${id}' must start with '${BATCH_ID_PREFIX}'`);
      const operation = this.store.load(id);
      if (!isBatch(operation)) throw new Error(`'${id}' is not a batch`);
      return operation;
    }
    const all = this.list();
    const active = all.filter((operation) => operation.status === "RUNNING" || operation.status === "WAITING" || operation.status === "PAUSED");
    if (active.length === 1) return active[0];
    if (active.length > 1) throw new Error(`multiple active batches: ${active.map((operation) => operation.id).join(", ")}; choose one id`);
    if (all.length === 1) return all[0];
    if (!all.length) throw new Error("no batch exists in this workspace");
    throw new Error(`no active batch can be selected; choose one id from: ${all.map((operation) => operation.id).join(", ")}`);
  }

  async run(raw: unknown): Promise<BatchResult> {
    const spec = validateBatchSpec(raw);
    const id = batchId(spec);
    const createdAt = this.options.now?.() ?? Date.now();
    const identity = createOperationAccountIdentity(credentialStorageHome());
    const resources = this.options.resources ?? normalizeResources(spec as OperationSpec, this.config, identity);
    // Batch defaults to sequential execution. Parallel admission must be an explicit per-spec choice and, through
    // validateOperationSpec, is refused without isolated worktrees.
    const policy = {
      ...mergeOperationPolicy(this.config.operationPolicy, spec.policy),
      maxConcurrentUnits: spec.policy?.maxConcurrentUnits ?? 1,
    };
    const operation = newOperation(id, spec.objective, spec.units, resources, createdAt, policy);
    if (spec.boundaries) operation.boundaries = parseBoundaryRules(spec.boundaries);
    if (spec.git?.isolate) {
      const plan = planOperationGit(this.config.workspace, operation.id, spec.git.baseRef);
      const git = newOperationGitState(plan);
      ensureIntegrationWorktree(plan, git);
      operation.git = git;
    }
    const result = await driveOperation(operation, {
      store: this.store,
      executor: this.executor,
      workspace: this.config.workspace,
      signal: this.options.signal,
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      ...(this.options.maxInProcessWaitMs !== undefined ? { maxInProcessWaitMs: this.options.maxInProcessWaitMs } : {}),
      entry: "new",
    });
    return { id: result.id, status: batchStatus(result), operation: result };
  }

  async runAcceptedPlan(plans: BatchPlanStore, draftId: string, digest: string, reviewDigest?: string): Promise<BatchResult> {
    if (this.config.readOnly || this.config.approvalMode === "read-only" || this.config.dryRun) {
      throw new Error("This mode cannot execute an approved plan.");
    }
    if (!isWorkspaceTrusted(this.config.workspace)) throw new Error("Plan execution requires a trusted workspace.");
    this.options.signal?.throwIfAborted();
    const prior = plans.readAcceptance(draftId);
    const draft = prior?.draft ?? plans.read(draftId);
    if (draft.workspace !== fs.realpathSync(this.config.workspace)) throw new Error("Plan belongs to a different workspace.");
    if (draft.digest !== digest) throw new Error("Plan approval must name the exact displayed draft digest.");
    const mapped = batchPlanExecution(draft.plan);
    const checks = parseOperationVerificationChecks(mapped.verificationChecks);
    const allowed = new Set(this.config.batchVerifierCommands);
    if (this.config.authoritativeVerifierCommand) allowed.add(this.config.authoritativeVerifierCommand.trim());
    if (checks.some((check) => !allowed.has(check.command))) {
      throw new Error("Every plan check must use an operator-configured verifier command.");
    }
    const existingResult = (acceptance: BatchPlanAcceptance): BatchResult => {
      const existing = this.results(acceptance.operationId);
      if (existing.operation.git?.acceptedPlanDigest !== acceptance.digest) {
        throw new Error("The operation ID is already in use by a different plan.");
      }
      return existing;
    };
    if (prior && this.store.has(prior.operationId)) return existingResult(plans.accept(draftId, digest, reviewDigest));
    const resources = this.options.resources ?? normalizeResources(
      { objective: draft.plan.objective, units: mapped.units },
      this.config,
      createOperationAccountIdentity(credentialStorageHome()),
    );
    const registry = new ResourceRegistry(resources);
    const candidates = new Map(mapped.units.map((unit) => [
      unit.id, registry.select(unit.requires ?? {}).qualified.map(({ resource }) => resource),
    ]));
    for (const unit of mapped.units.filter((entry) => entry.required !== false)) {
      const eligible = candidates.get(unit.id)!.some((candidate) =>
        (unit.requires?.independentOf ?? []).every((source) =>
          candidates.get(source)?.some((resource) => resource.model !== candidate.model)));
      if (!eligible) throw new Error(`For unit '${unit.id}', no configured resource meets the approved requirements.`);
    }
    const acceptance = plans.accept(draftId, digest, reviewDigest);
    const operation = newOperation(
      acceptance.operationId, draft.plan.objective, mapped.units, resources,
      this.options.now?.() ?? Date.now(), { ...mergeOperationPolicy(this.config.operationPolicy, undefined), maxConcurrentUnits: 1, ...mapped.policy },
    );
    const gitPlan = planOperationGit(this.config.workspace, operation.id, acceptance.base.commit);
    if (gitPlan.repoRoot !== draft.workspace) throw new Error("Plan execution requires the repository root.");
    operation.git = {
      ...newOperationGitState(gitPlan),
      verificationChecks: checks,
      acceptedPlanDigest: acceptance.digest,
    };
    try {
      const result = await driveOperation(operation, {
        store: this.store,
        executor: this.executor,
        workspace: this.config.workspace,
        signal: this.options.signal,
        onEvent: this.options.onEvent,
        maxInProcessWaitMs: this.options.maxInProcessWaitMs,
        entry: "new",
        prepare: () => {
          this.options.signal?.throwIfAborted();
          if (realpathAllowingMissing(gitPlan.integrationWorktree) !== gitPlan.integrationWorktree) {
            throw new Error("Plan execution refuses a redirected integration worktree.");
          }
          plans.reserveAdmission(acceptance);
        },
      });
      return { id: result.id, status: batchStatus(result), operation: result };
    } catch (error) {
      if (error instanceof OperationExistsError) return existingResult(acceptance);
      throw error;
    }
  }

  async resume(id?: string): Promise<BatchResult> {
    const selected = this.resolveTarget(id);
    const result = await driveOperation(selected, {
      store: this.store,
      executor: this.executor,
      workspace: this.config.workspace,
      signal: this.options.signal,
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      ...(this.options.maxInProcessWaitMs !== undefined ? { maxInProcessWaitMs: this.options.maxInProcessWaitMs } : {}),
      entry: "existing",
      resumeAfterDecision: true,
      prepare: (fresh) => {
        if (fresh.status === "CANCELLED") fresh.status = "RUNNING";
        else if (fresh.status === "PAUSED") fresh.status = fresh.wait ? "WAITING" : "RUNNING";
      },
    });
    return { id: result.id, status: batchStatus(result), operation: result };
  }

  async cancel(id?: string): Promise<BatchResult> {
    const selected = this.resolveTarget(id);
    const release = this.store.acquire(selected.id);
    let result: DurableOperationState;
    try {
      // Re-read under the lock: a concurrent driver may have completed after resolveTarget read the summary.
      const fresh = this.store.load(selected.id);
      if (fresh.status === "COMPLETE" || fresh.status === "CANCELLED") {
        result = fresh;
      } else if (fresh.units.some((unit) => unit.status === "RUNNING")) {
        throw new Error(`batch ${fresh.id} has an unsettled work unit; resume it first so Nexus can reconcile any unknown effects before cancellation`);
      } else {
        const runner = new OperationRunner(fresh, {
          executor: this.executor,
          workspace: this.config.workspace,
          persist: (state) => this.store.save(state),
          ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
        });
        result = await runner.run(AbortSignal.abort());
      }
    } finally {
      release();
    }
    return { id: result.id, status: batchStatus(result), operation: result };
  }

  async pause(id?: string): Promise<BatchResult> {
    const selected = this.resolveTarget(id);
    const release = this.store.acquire(selected.id);
    let operation: DurableOperationState;
    try {
      operation = this.store.load(selected.id);
      if (operation.status === "COMPLETE" || operation.status === "CANCELLED" || operation.status === "PAUSED") {
        return { id: operation.id, status: batchStatus(operation), operation };
      }
      if (operation.units.some((unit) => unit.status === "RUNNING")) {
        throw new Error(`batch ${operation.id} is executing a work unit; wait for it to settle, then pause at the next safe boundary`);
      }
      const runner = new OperationRunner(operation, {
        executor: this.executor,
        workspace: this.config.workspace,
        store: this.store,
        persist: (state) => this.store.save(state),
        ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      });
      runner.scheduler.pause();
      this.store.save(operation);
    } finally {
      release();
    }
    return { id: operation.id, status: batchStatus(operation), operation };
  }

  results(id?: string): BatchResult {
    const operation = this.resolveTarget(id);
    return { id: operation.id, status: batchStatus(operation), operation };
  }
}
