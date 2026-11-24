/**
 * BG-1: the worker of one detached job (`nexus job __worker <id>`, started by the runner only). It holds the job's
 * kernel lock for its whole life, builds the unattended configuration and drives exactly one durable operation, the
 * same way `nexus operation run|resume` does. It has no front end: nothing can approve a call, so a call that needs a
 * decision is denied and the unit ends blocked with its question.
 */
import * as fs from "node:fs";
import { AutonomousAgent } from "../agent.js";
import { credentialStorageHome } from "../client.js";
import { buildConfig as buildOperatorConfig, mergeOperationPolicy } from "../config.js";
import { normalizeResources, type OperationSpec } from "../operation_cli.js";
import { isSandboxAvailable, sandboxNetworkEnabled } from "../sandbox.js";
import type { HarnessConfig } from "../types.js";
import { redactSecrets } from "../ui.js";
import { createOperationAccountIdentity } from "./account_identity.js";
import { parseBoundaryRules } from "./boundary_rules.js";
import { appendPrivateFile } from "./durable_file.js";
import { acquireFileGuard } from "./file_guard.js";
import { specDigest, submissionProblem } from "./job_runner.js";
import { newOperation, type DurableOperationState, type OperationPolicy } from "./operation.js";
import { ensureIntegrationWorktree, newOperationGitState, planOperationGit } from "./operation_git.js";
import { AgentWorkUnitExecutor, driveOperation, OperationStore } from "./operation_runner.js";
import { identityOf } from "./process_identity.js";
import {
  parseJobSpecFile, readJob, readPrivateJson, RUNNER_FILE_VERSION, runnerPaths, writePrivateJson, type JobAttempt, type JobRecord, type RunnerPaths, type WorkerInfo,
  type WorkerResult,
} from "./runner_store.js";
import { scrubUnattendedEnv, UnattendedApprovalPolicy, UnattendedClampError, unattendedConfig } from "./unattended.js";

/** The event log stops growing here; one last line says so. */
export const EVENT_LOG_LIMIT = 16 * 1024 * 1024;
/** How long the worker waits for the runner's record of this attempt, and for its own lock. */
const START_WAIT_MS = 15_000;

/** A failure outside the operation. The runner ends the job with `reason`. */
class WorkerFailure extends Error {
  constructor(readonly reason: string, message: string, readonly exit = 1) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSON line per event, secrets redacted, bounded. Appending never throws into the run. */
function eventLog(paths: RunnerPaths, id: string): (event: Record<string, unknown>) => void {
  const file = paths.events(id);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* not written yet */ }
  let full = size >= EVENT_LOG_LIMIT;
  return (event) => {
    if (full) return;
    try {
      let line = `${redactSecrets(JSON.stringify({ at: new Date().toISOString(), ...event }))}\n`;
      if (size + line.length > EVENT_LOG_LIMIT) {
        full = true;
        line = `${JSON.stringify({ at: new Date().toISOString(), type: "LOG_TRUNCATED" })}\n`;
      }
      appendPrivateFile(file, line);
      size += line.length;
    } catch {
      // The log is for the operator; the operation record is the truth.
    }
  };
}

/** Waits until the runner has recorded this process as the job's current attempt. Anything else is not this worker's job. */
async function ownAttempt(paths: RunnerPaths, id: string): Promise<{ job: JobRecord; attempt: JobAttempt }> {
  const self = identityOf(process.pid);
  for (const deadline = Date.now() + START_WAIT_MS; ;) {
    const job = readJob(paths, id);
    const attempt = job?.attempts[job.attempts.length - 1];
    if (job && attempt && self && attempt.pid === self.pid && attempt.startTicks === self.startTicks && attempt.bootId === self.bootId && !attempt.end) return { job, attempt };
    if (Date.now() > deadline) throw new WorkerFailure("NOT_STARTED_BY_RUNNER", `job ${id} has no attempt recorded for this process; a worker is started by the runner only`);
    await sleep(50);
  }
}

function createOperation(job: JobRecord, spec: OperationSpec, config: HarnessConfig, remainingMs: number): DurableOperationState {
  const policy = mergeOperationPolicy(config.operationPolicy, spec.policy) as Partial<OperationPolicy> | undefined;
  const state = newOperation(job.operationId, spec.objective, spec.units, normalizeResources(spec, config, createOperationAccountIdentity(credentialStorageHome())), Date.now(), policy);
  // An in-process wait must not outlive the job.
  state.policy.maxWaitMs = Math.max(1, Math.min(state.policy.maxWaitMs, remainingMs));
  if (spec.boundaries) state.boundaries = parseBoundaryRules(spec.boundaries);
  // The base is the commit that was HEAD at submit; the operation id is new, so these worktrees did not exist before.
  const plan = planOperationGit(config.workspace, state.id, job.baseCommit);
  const git = newOperationGitState(plan);
  ensureIntegrationWorktree(plan, git);
  state.git = git;
  state.origin = { kind: "job", jobId: job.id, ...(job.origin.kind === "schedule" ? { scheduleId: job.origin.scheduleId } : {}), unattended: true };
  return state;
}

export interface JobWorkerOptions {
  root?: string;
  buildConfig?: (options: Record<string, unknown>) => HarnessConfig;
}

/** Runs the job's operation to where it stops and returns the process exit code (0 COMPLETE, 130 CANCELLED, 2 otherwise, 1 a failure outside the operation). */
export async function runJobWorker(id: string, options: JobWorkerOptions = {}): Promise<number> {
  // Before any configuration or trust is read in this function. The runner also starts the worker without them.
  scrubUnattendedEnv(process.env);
  const paths = runnerPaths(options.root);
  let current: { job: JobRecord; attempt: JobAttempt } | undefined;
  const finish = (operationStatus: string | null, exit: number, error?: WorkerResult["error"]): number => {
    if (current) {
      const result: WorkerResult = { format: "nexus-job-result", version: RUNNER_FILE_VERSION, jobId: id, attempt: current.attempt.n, operationId: current.job.operationId, operationStatus, exit, ...(error ? { error } : {}) };
      writePrivateJson(paths.result(id), result);
    }
    return exit;
  };
  try {
    current = await ownAttempt(paths, id);
    const { job, attempt } = current;
    // Held until this process ends, however it ends: the kernel releases it, so the lock is the worker's liveness.
    const guard = acquireFileGuard(paths.workerGuard(id), { label: "Worker guard", waitMs: START_WAIT_MS });
    if (!guard) throw new WorkerFailure("WORKER_LOCKED", `another worker holds the lock of job ${id}`);
    const self = identityOf(process.pid)!;
    const info: WorkerInfo = { format: "nexus-job-worker", version: RUNNER_FILE_VERSION, jobId: id, attempt: attempt.n, ...self, startedAt: new Date().toISOString() };
    writePrivateJson(paths.workerJson(id), info);

    const specFile = readPrivateJson(paths.spec(id), { label: "Job spec" });
    if (specFile === undefined) throw new WorkerFailure("SPEC_MISSING", `job ${id} has no spec.json`);
    const { spec, specSha256 } = parseJobSpecFile(specFile);
    if (specSha256 !== job.specSha256 || specDigest(spec) !== job.specSha256) throw new WorkerFailure("SPEC_CHANGED", `the spec of job ${id} does not match the digest in its record`);
    const problem = submissionProblem(job, spec);
    if (problem) throw new WorkerFailure("SUBMISSION_REFUSED", problem);

    let config: HarnessConfig;
    try {
      config = unattendedConfig(job, options.buildConfig ?? buildOperatorConfig, sandboxNetworkEnabled());
    } catch (error) {
      throw new WorkerFailure(error instanceof UnattendedClampError ? error.reason : "CONFIG_ERROR", error instanceof Error ? error.message : String(error));
    }
    // A job that may write runs its commands confined or not at all; found out before any inference is paid for.
    if (job.policy === "worktree-write" && !isSandboxAvailable("auto")) {
      throw new WorkerFailure("SANDBOX_UNAVAILABLE", "worktree-write needs a sandbox engine (bubblewrap or docker) and none is usable here", 2);
    }

    const remainingMs = Date.parse(job.deadlineAt) - Date.now();
    const store = new OperationStore(config.workspace);
    const existing = store.has(job.operationId);
    const state = existing ? store.load(job.operationId) : createOperation(job, spec as unknown as OperationSpec, config, remainingMs);

    const log = eventLog(paths, id);
    log({ type: "WORKER_STARTED", attempt: attempt.n, resumed: existing });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    // The runner enforces the deadline too; this ends the operation cleanly even if the runner is not there.
    const deadline = setTimeout(cancel, Math.max(1, Math.min(remainingMs, 2_147_483_647)));
    deadline.unref();
    try {
      const out = await driveOperation(state, {
        store,
        signal: controller.signal,
        entry: existing ? "existing" : "new",
        // As `nexus operation resume`: a cancelled or paused operation continues; the stale-driver pause and the
        // executor's recovery of an interrupted tool call apply unchanged.
        ...(existing ? { prepare: (fresh: DurableOperationState) => {
          if (fresh.status === "CANCELLED") fresh.status = "RUNNING";
          else if (fresh.status === "PAUSED") fresh.status = fresh.wait ? "WAITING" : "RUNNING";
          fresh.policy.maxWaitMs = Math.max(1, Math.min(fresh.policy.maxWaitMs, remainingMs));
        } } : {}),
        workspace: config.workspace,
        executor: new AgentWorkUnitExecutor({
          baseConfig: config,
          createAgent: (agentConfig, depth, agentOptions) => {
            const agent = new AutonomousAgent(agentConfig, depth, undefined, { durable: true, role: agentOptions?.role, unitId: agentOptions?.unitId });
            agent.setApprovalPolicy(new UnattendedApprovalPolicy(job.policy));
            // Nobody reads this process's terminal: its output goes nowhere, and the event log gets the notices.
            (agent as unknown as { ui: unknown }).ui = new Proxy({}, { get: () => () => {} });
            agent.setObserver({
              onNotice: (text) => log({ type: "NOTICE", unit: agentOptions?.unitId, message: text.slice(0, 2000) }),
              onToolEnd: (event) => log({ type: "TOOL_END", unit: agentOptions?.unitId, tool: event.tool, success: event.success, ...(event.error ? { error: event.error.slice(0, 600) } : {}) }),
            });
            return agent;
          },
        }),
        onEvent: (event) => log({ ...event }),
      });
      log({ type: "WORKER_FINISHED", operationStatus: out.status });
      return finish(out.status, out.status === "COMPLETE" ? 0 : out.status === "CANCELLED" ? 130 : 2);
    } finally {
      clearTimeout(deadline);
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
    }
  } catch (error) {
    const failure = error instanceof WorkerFailure ? error : new WorkerFailure("WORKER_ERROR", error instanceof Error ? error.message : String(error));
    process.stderr.write(`nexus job worker ${id}: ${failure.reason}: ${redactSecrets(failure.message)}\n`);
    return finish(null, failure.exit, { reason: failure.reason, message: redactSecrets(failure.message).slice(0, 2000) || failure.reason });
  }
}
