/**
 * BG-2: `nexus schedule` commands. Schedules are durable records; execution happens as
 * detached unattended jobs in fresh worktrees through the existing runner.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { validateOperationSpec, OperationSpecError } from "./operation_cli.js";
import { submitRequest, requestRefusal, chooseJobIds, specDigest, unattendedSpec, submissionProblem } from "./core/job_runner.js";
import { parseJobBudgets, readJob, runnerPaths, RunnerStoreError, type JobSubmission, DEFAULT_JOB_BUDGETS } from "./core/runner_store.js";
import { createScheduleId, listSchedules, nextDueAt, parseScheduleRecord, readSchedule, removeSchedule, schedulePaths, writeSchedule, type ScheduleRecord } from "./schedule.js";
import { normalizeTrustedDeliverableFiles } from "./config.js";
import { gitOut } from "./worktrunk/git.js";
import { safeTerminal } from "./ui.js";

class ScheduleUsageError extends Error {}

function action<T extends unknown[]>(run: (...args: T) => void | Promise<void>): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try { await run(...args); }
    catch (error: any) {
      console.error(pc.red(safeTerminal(String(error?.message ?? error))));
      process.exitCode = error instanceof ScheduleUsageError || error instanceof OperationSpecError || error instanceof RunnerStoreError ? 2 : 1;
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  for (const deadline = Date.now() + timeoutMs; ;) {
    const value = read();
    if (value !== undefined || Date.now() > deadline) return value;
    await sleep(100);
  }
}

function parseTriggerFromOptions(options: any): ScheduleRecord["trigger"] {
  const kinds = [options.once, options.every, options.cron].filter((v) => v !== undefined);
  if (kinds.length !== 1) throw new ScheduleUsageError("Specify exactly one trigger: --once <iso>, --every <minutes>, or --cron <5-field expr>.");
  if (options.once !== undefined) return { kind: "once", at: String(options.once) };
  if (options.every !== undefined) {
    const minutes = Number(options.every);
    if (!Number.isFinite(minutes) || minutes < 1) throw new ScheduleUsageError("--every must be a positive number of minutes.");
    return { kind: "every", minutes: Math.floor(minutes) };
  }
  const expression = String(options.cron).trim();
  if (expression.split(/\s+/).length !== 5) throw new ScheduleUsageError("--cron must have 5 fields (min hour dom month dow).");
  return { kind: "cron", expression, ...(options.timezone ? { timezone: String(options.timezone) } : {}) };
}

function readSpecFile(workspace: string, specFile: string): unknown {
  const full = path.resolve(workspace, specFile);
  let real: string;
  try { real = fs.realpathSync(full); } catch { throw new ScheduleUsageError(`spec file not found: ${specFile}`); }
  const root = fs.realpathSync(workspace);
  if (real !== root && !real.startsWith(root + path.sep)) throw new ScheduleUsageError("spec file must be inside workspace");
  return JSON.parse(fs.readFileSync(real, "utf8"));
}

function buildSubmission(record: ScheduleRecord): { submission: JobSubmission; spec: Record<string, unknown> } {
  const workspace = fs.realpathSync(record.workspace);
  const rawSpec = record.specFile
    ? readSpecFile(workspace, record.specFile)
    : { objective: record.objective, units: [{ id: "task", title: "task", role: record.policy === "worktree-write" ? "implementer" : "researcher", prompt: record.objective }] };
  validateOperationSpec(rawSpec);
  const chosen = chooseJobIds(workspace, rawSpec.units.map((u: any) => u.id));
  const { baseCommit, ...ids } = chosen;
  const spec = unattendedSpec(rawSpec, { ...ids, baseCommit });
  const budgets = parseJobBudgets("budgets", {
    maxTotalSteps: DEFAULT_JOB_BUDGETS.maxTotalSteps,
    maxToolInvocations: DEFAULT_JOB_BUDGETS.maxToolInvocations,
    maxInferenceSubmissions: DEFAULT_JOB_BUDGETS.maxInferenceSubmissions,
    maxTurnMinutes: record.timeoutMinutes ?? DEFAULT_JOB_BUDGETS.maxTurnMinutes,
    timeoutMinutes: record.timeoutMinutes ?? DEFAULT_JOB_BUDGETS.timeoutMinutes,
  });
  const submission = {
    ...ids,
    workspace,
    baseCommit,
    specSha256: specDigest(spec),
    origin: { kind: "schedule" as const, scheduleId: record.id, dueAt: record.nextDueAt ?? new Date().toISOString() },
    unattended: true as const,
    policy: record.policy,
    verifier: record.verifier ?? null,
    deliverables: record.deliverables ?? [],
    provider: {},
    budgets,
  };
  const problem = submissionProblem(submission, spec);
  if (problem) throw new ScheduleUsageError(problem);
  return { submission: submission as JobSubmission, spec: spec as Record<string, unknown> };
}

export async function runScheduleNow(record: ScheduleRecord): Promise<string> {
  if (record.trigger.kind === "cron") {
    // Structural cron is accepted in the spec/store; deterministic runtime evaluation is not wired yet.
    // Refuse clearly rather than guessing.
    throw new ScheduleUsageError(`cron schedule '${record.id}' is stored but cron runtime evaluation is not yet wired; use --every/--once or run-now after manual due decision.`);
  }
  const { submission, spec } = buildSubmission(record);
  const paths = runnerPaths();
  const requestId = submitRequest(paths, { kind: "start", job: submission, spec });
  const accepted = await waitFor(() => readJob(paths, submission.id) ?? requestRefusal(paths, requestId), 10_000);
  if (typeof accepted === "string") throw new ScheduleUsageError(`runner refused schedule run: ${accepted}`);
  if (!accepted) throw new Error(`runner did not accept schedule run within 10s; request ${requestId}`);
  return submission.id;
}

export function registerScheduleCommands(program: Command): void {
  const schedule = program.command("schedule").description("[experimental] Durable unattended schedules (BG-2); runs execute as detached jobs in fresh worktrees");

  schedule.command("list")
    .option("-j, --json", "JSON output")
    .action(action(async (options: any) => {
      const recs = listSchedules(schedulePaths());
      if (options.json) { console.log(JSON.stringify(recs, null, 2)); return; }
      if (!recs.length) { console.log("No schedules."); return; }
      for (const r of recs) {
        console.log(`${r.id.padEnd(20)} ${r.enabled ? "enabled" : "disabled"} ${r.policy.padEnd(14)} next=${r.nextDueAt ?? "-"} missed=${r.missedRuns} last=${r.lastOutcome ?? "-"}`);
        console.log(pc.dim(`  ${safeTerminal(r.workspace)} :: ${safeTerminal(r.objective)}`));
      }
    }));

  schedule.command("add")
    .description("Add a durable schedule. Runs are unattended; read-only by default.")
    .requiredOption("--workspace <path>", "Repository workspace")
    .requiredOption("--objective <text>", "Objective for the run")
    .option("--spec-file <path>", "Operation spec JSON file inside workspace (optional)")
    .option("--once <iso>", "Run once at ISO timestamp")
    .option("--every <minutes>", "Run every N minutes")
    .option("--cron <expr>", "5-field cron expression (stored; runtime evaluation may be limited)")
    .option("--timezone <tz>", "Timezone for cron trigger")
    .option("--allow-worktree-write", "Allow writes only inside fresh job worktree (default read-only)")
    .option("--verifier <command>", "Verifier command")
    .option("--deliverable-file <path>", "Workspace-relative deliverable file (repeatable)", (v: string, a: string[] = []) => [...a, v])
    .option("--max-rounds <n>", "Maximum rounds/runs (remainingRuns)")
    .option("--timeout-minutes <n>", "Timeout minutes per run")
    .option("--id <id>", "Explicit schedule id")
    .action(action(async (options: any) => {
      const workspace = fs.realpathSync(path.resolve(options.workspace));
      const trigger = parseTriggerFromOptions(options);
      const policy = options.allowWorktreeWrite ? "worktree-write" : "read-only";
      const id = options.id ? String(options.id) : createScheduleId();
      const nowIso = new Date().toISOString();
      const rec = parseScheduleRecord({
        format: "nexus-schedule",
        version: 1,
        id,
        createdAt: nowIso,
        updatedAt: nowIso,
        workspace,
        objective: String(options.objective),
        ...(options.specFile ? { specFile: String(options.specFile) } : {}),
        trigger,
        policy,
        unattended: true,
        missedRuns: 0,
        enabled: true,
        ...(options.maxRounds !== undefined ? { remainingRuns: Number(options.maxRounds) } : {}),
        ...(options.timeoutMinutes !== undefined ? { timeoutMinutes: Number(options.timeoutMinutes) } : {}),
        ...(options.verifier ? { verifier: String(options.verifier) } : {}),
        ...(options.deliverableFile?.length ? { deliverables: normalizeTrustedDeliverableFiles(workspace, options.deliverableFile) } : {}),
        nextDueAt: trigger.kind === "once" ? String(options.once) : nextDueAt({ trigger }, Date.now()),
      });
      // Validate spec shape early if provided.
      if (rec.specFile) validateOperationSpec(readSpecFile(workspace, rec.specFile));
      writeSchedule(schedulePaths(), rec);
      console.log(rec.id);
      console.log(pc.dim(`schedule saved: ${rec.policy}, unattended; nextDueAt=${rec.nextDueAt ?? "-"}`));
    }));

  schedule.command("rm")
    .argument("<id>", "Schedule id")
    .action(action(async (id: string) => {
      const ok = removeSchedule(schedulePaths(), id);
      if (!ok) throw new ScheduleUsageError(`No schedule ${id}.`);
      console.log(`Removed ${id}`);
    }));

  schedule.command("run-now")
    .argument("<id>", "Schedule id")
    .description("Enqueue one unattended job for this schedule now (requires runner)")
    .action(action(async (id: string) => {
      const paths = schedulePaths();
      const rec = readSchedule(paths, id);
      if (!rec) throw new ScheduleUsageError(`No schedule ${id}.`);
      if (!rec.enabled) throw new ScheduleUsageError(`Schedule ${id} is disabled.`);
      const jobId = await runScheduleNow(rec);
      rec.lastRunAt = new Date().toISOString();
      rec.lastJobId = jobId;
      rec.updatedAt = rec.lastRunAt;
      rec.nextDueAt = nextDueAt(rec, Date.now());
      if (rec.remainingRuns !== null && rec.remainingRuns !== undefined) rec.remainingRuns = Math.max(0, rec.remainingRuns - 1);
      if (rec.remainingRuns === 0) rec.enabled = false;
      writeSchedule(paths, rec);
      console.log(jobId);
      console.log(pc.dim(`enqueued from schedule ${id}; status: nexus job status ${jobId}`));
    }));
}
