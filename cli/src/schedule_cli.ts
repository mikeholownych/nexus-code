/**
 * BG-2: `nexus schedule add|list|status|remove|pause|resume|run-now`. A schedule is an operator's standing order to
 * start a background job (see background_cli.ts and docs/SCHEDULES.md) at a time: it cannot ask for more than
 * `nexus job start` could. The permission level, the verifier and the workspace are fixed when it is added. The runner
 * fires it; these commands only edit and read the schedule files under the schedule lock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { action, ACK_WAIT_MS, BackgroundUsageError, budgetsFrom, refuseModeFlags, requireRunner, waitFor } from "./background_cli.js";
import { buildJobSubmission, promptSpec } from "./core/job_submission.js";
import { readReceipt, requestRefusal, runnerAlive, submitRequest } from "./core/job_runner.js";
import { ensureRunnerTree, isTerminal, listJobs, readJob, runnerPaths, RunnerStoreError, type JobRecord, type JobPolicy } from "./core/runner_store.js";
import { describeTrigger, nextAfter, parseEvery, parseOnceAt, ScheduleSpecError, validateTrigger, type ScheduleTrigger } from "./core/schedule.js";
import { submissionFor } from "./core/schedule_engine.js";
import {
  ensureScheduleDir, listSchedules, MAX_REMAINING_RUNS, MAX_SCHEDULES, newScheduleId, newScheduleState, readSchedule, readSchedulePointer, SCHEDULE_ID, SCHEDULE_ON_MISSED, schedulePaths,
  withScheduleLock, writeSchedule, type ScheduleOnMissed, type ScheduleRecord,
} from "./core/schedule_store.js";
import { OperationSpecError } from "./operation_cli.js";
import { safeTerminal } from "./ui.js";
import { isWorkspaceListed } from "./workspace_trust.js";

const when = (value: string | null | undefined) => (value ? safeTerminal(value) : "-");

/** The next `count` slots after `from`, for `add` to show. */
function upcoming(record: ScheduleRecord, from: number, count: number): string[] {
  const slots: string[] = [];
  for (let cursor = from; slots.length < count;) {
    const slot = nextAfter(record.trigger, Date.parse(record.createdAt), cursor);
    if (slot === undefined) break;
    slots.push(new Date(slot).toISOString());
    cursor = slot;
  }
  return slots;
}

function triggerFrom(options: Record<string, any>): ScheduleTrigger {
  const given = [options.cron !== undefined, options.every !== undefined, options.at !== undefined].filter(Boolean).length;
  if (given !== 1) throw new BackgroundUsageError("Give exactly one of --cron <expr>, --every <interval> or --at <UTC time>.");
  try {
    if (options.cron !== undefined) return validateTrigger({ kind: "cron", expr: String(options.cron) });
    if (options.every !== undefined) return { kind: "every", seconds: parseEvery(String(options.every)) };
    return validateTrigger({ kind: "once", at: parseOnceAt(String(options.at)) });
  } catch (error) {
    if (error instanceof ScheduleSpecError) throw new BackgroundUsageError(error.message);
    throw error;
  }
}

function readOrFail(id: string): { record: ScheduleRecord; paths: ReturnType<typeof schedulePaths> } {
  const paths = schedulePaths(runnerPaths());
  const record = readSchedule(paths, id);
  if (!record) throw new BackgroundUsageError(`There is no schedule ${safeTerminal(id)}.`);
  return { record, paths };
}

function jobSummary(job: JobRecord | undefined): string {
  return job ? `${job.id} ${job.state}` : "-";
}

function printRecord(record: ScheduleRecord): void {
  const state = record.state;
  console.log(pc.bold(`Schedule ${safeTerminal(record.id)}`) + pc.dim(`  ${record.enabled ? "enabled" : "paused or finished"}, ${record.policy}, unattended`));
  console.log(`  ${describeTrigger(record.trigger)}; next ${when(state.nextDueAt)}; runs left ${record.remainingRuns ?? "unlimited"}; when runs are missed: ${record.onMissed === "run-once" ? "report them and run one catch-up" : "report them"}`);
  console.log(pc.dim(`  workspace ${safeTerminal(record.workspace)}${record.verifier ? `; verifier ${safeTerminal(record.verifier)}` : ""}`));
  console.log(pc.dim(`  task: ${safeTerminal(record.task.prompt.slice(0, 200))}`));
}

export function registerScheduleCommands(program: Command): void {
  const schedule = program.command("schedule").description("[experimental] Unattended schedules that start background jobs (see docs/SCHEDULES.md)");

  schedule.command("add")
    .description("Add a schedule: --cron, --every or --at, and a prompt. The runner fires it as an unattended job")
    .option("--name <id>", "Schedule id (lowercase letters, digits and '-'; default sch-<8 hex>)")
    .option("--cron <expr>", "Five-field cron expression, UTC (for example '0 3 * * 1-5')")
    .option("--every <interval>", "Interval from 5m to 30d (for example 15m, 2h, 1d)")
    .option("--at <time>", "One run at this UTC time (2026-12-01T03:00:00Z)")
    .requiredOption("--prompt <text>", "The task each run is given")
    .option("-w, --workspace <path>", "Repository to work on (default: current directory); it must be a trusted workspace")
    .option("--allow-worktree-write", "Let each run write files inside its own fresh worktree (default: read-only). Fixed now; nothing can change it later")
    .option("--verifier <command>", "Your verifier command: it gates every completion")
    .option("--deliverable-file <path>", "Workspace-relative file each run must deliver (repeatable)", (value: string, all: string[] = []) => [...all, value])
    .option("--max-runs <n>", "Stop after this many runs (default: no limit)")
    .option("--on-missed <policy>", "What to do with runs that were missed: run-once (report, then one catch-up; default) or report", "run-once")
    .option("--max-total-steps <n>", "Steps for the whole job")
    .option("--max-tool-invocations <n>", "Tool calls for the whole job")
    .option("--max-inference-submissions <n>", "Model requests for the whole job")
    .option("--max-turn-minutes <n>", "Minutes for one attempt's turn")
    .option("--timeout-minutes <n>", "Minutes until a run is stopped as TIMED_OUT")
    .option("-e, --endpoint <url>", "Endpoint (default: your configured endpoint)")
    .option("-m, --model <name>", "Model")
    .option("--provider <id>", "Cloud provider (openrouter, openai, anthropic, compatible)")
    .option("-j, --json", "JSON output")
    .action(action((options: any, command: Command) => {
      refuseModeFlags(command);
      if (process.env.NEXUS_APPROVAL_MODE?.trim().toLowerCase() === "auto") {
        throw new BackgroundUsageError("NEXUS_APPROVAL_MODE=auto is set, and a scheduled job never runs in auto mode. Unset it for this command.");
      }
      const trigger = triggerFrom(options);
      let workspace: string;
      try {
        workspace = fs.realpathSync(path.resolve(options.workspace ?? process.cwd()));
      } catch {
        throw new BackgroundUsageError(`Workspace ${String(options.workspace)} does not exist.`);
      }
      // A standing order is a bigger decision than one job: the repository must be one the operator has already trusted.
      if (!isWorkspaceListed(workspace)) throw new BackgroundUsageError(`${workspace} is not a trusted workspace; a schedule cannot be added for it. Review the repository, then run \`nexus trust ${workspace}\`.`);
      if (!options.prompt?.trim()) throw new BackgroundUsageError("--prompt needs a task.");
      const policy: JobPolicy = options.allowWorktreeWrite ? "worktree-write" : "read-only";
      const verifier = options.verifier === undefined ? null : String(options.verifier).trim();
      if (verifier === "") throw new BackgroundUsageError("--verifier needs a command.");
      if (!SCHEDULE_ON_MISSED.includes(options.onMissed)) throw new BackgroundUsageError(`--on-missed must be one of ${SCHEDULE_ON_MISSED.join(", ")}.`);
      let remainingRuns: number | null = null;
      if (options.maxRuns !== undefined) {
        remainingRuns = Number(options.maxRuns);
        if (!Number.isSafeInteger(remainingRuns) || remainingRuns < 1 || remainingRuns > MAX_REMAINING_RUNS) throw new BackgroundUsageError(`--max-runs must be a whole number from 1 to ${MAX_REMAINING_RUNS}.`);
      }
      const id = options.name ?? newScheduleId();
      if (!SCHEDULE_ID.test(id)) throw new BackgroundUsageError(`'${safeTerminal(String(id).slice(0, 60))}' is not a schedule id (lowercase letters, digits and '-', at most 40 characters).`);
      const now = new Date();
      const provider = Object.fromEntries((["endpoint", "model", "provider"] as const).flatMap((key) => (options[key] ? [[key, String(options[key])]] : [])));
      const record: ScheduleRecord = {
        format: "nexus-schedule", version: 1, id, createdAt: now.toISOString(), enabled: true, workspace, trigger,
        task: { prompt: String(options.prompt) }, policy, verifier, deliverables: [], provider, budgets: budgetsFrom(options), remainingRuns, onMissed: options.onMissed as ScheduleOnMissed,
        state: newScheduleState(null),
      };
      // The job a run would be, checked now with the same rules the run will meet: repository, verifier, deliverables and managed policy.
      const probe = buildJobSubmission({
        workspace, given: promptSpec(record.task.prompt, policy === "worktree-write"), policy, verifier, deliverableFiles: options.deliverableFile, provider, budgets: record.budgets,
        origin: { kind: "schedule", scheduleId: id, dueAt: now.toISOString() },
      });
      record.deliverables = probe.job.deliverables;
      const first = nextAfter(trigger, now.getTime(), now.getTime());
      if (first === undefined) {
        throw new BackgroundUsageError(trigger.kind === "once" ? `${trigger.at} is not in the future.` : `'${safeTerminal(trigger.kind === "cron" ? trigger.expr : "")}' never matches a date within four years.`);
      }
      record.state = newScheduleState(new Date(first).toISOString());
      const paths = schedulePaths(runnerPaths());
      ensureRunnerTree();
      withScheduleLock(paths, () => {
        ensureScheduleDir(paths);
        const { schedules, invalid } = listSchedules(paths);
        if (schedules.length + invalid.length >= MAX_SCHEDULES) throw new BackgroundUsageError(`There are already ${MAX_SCHEDULES} schedules; remove one first.`);
        if (schedules.some((s) => s.id === id) || invalid.some((s) => s.id === id)) throw new BackgroundUsageError(`There is already a schedule ${id}.`);
        writeSchedule(paths, record);
      });
      if (options.json) {
        console.log(JSON.stringify({ schedule: record, upcoming: upcoming(record, now.getTime(), 3) }, null, 2));
        return;
      }
      console.log(`Added schedule ${safeTerminal(id)}.`);
      printRecord(record);
      console.log(`  next runs: ${upcoming(record, now.getTime(), 3).join(", ")}`);
      console.log(pc.dim(`  Each run is an unattended job in a fresh worktree: ${policy === "worktree-write" ? "it may write inside that worktree only" : "read-only"}; it never approves a command or a network call, and results are never merged for you.`));
      if (!runnerAlive(runnerPaths())) console.error(pc.yellow("warning: no runner is running, so nothing fires until `nexus runner serve` is up; runs missed meanwhile are reported (docs/SCHEDULES.md)."));
    }));

  schedule.command("list")
    .description("List schedules")
    .option("-j, --json", "JSON output")
    .action(action((options: any) => {
      const paths = schedulePaths(runnerPaths());
      const { schedules, invalid } = listSchedules(paths);
      if (options.json) {
        console.log(JSON.stringify({ schedules, invalid }, null, 2));
        return;
      }
      if (!schedules.length && !invalid.length) console.log("No schedules.");
      for (const record of schedules) {
        const missed = record.state.missedCount ? pc.yellow(`  ${record.state.missedCount} missed`) : "";
        console.log(`${record.id.padEnd(20)} ${(record.enabled ? "enabled" : "off").padEnd(8)} ${describeTrigger(record.trigger).padEnd(28)} ${record.policy.padEnd(14)} next ${when(record.state.nextDueAt).padEnd(26)} last ${record.state.lastOutcome ?? "-"}${missed}`);
      }
      for (const item of invalid) console.error(pc.yellow(`Invalid schedule ${safeTerminal(item.id)} (it will not run): ${safeTerminal(item.error)}`));
    }));

  schedule.command("status")
    .argument("<id>", "Schedule id")
    .description("Show a schedule: when it runs next, its last runs and every gap that was missed")
    .option("-j, --json", "JSON output")
    .action(action((id: string, options: any) => {
      const { record, paths } = readOrFail(id);
      const jobs = listJobs(runnerPaths()).jobs.filter((job) => job.origin.kind === "schedule" && job.origin.scheduleId === id);
      const latestJob = jobs[jobs.length - 1];
      const fired = record.state.lastFire ? jobs.find((job) => job.id === record.state.lastFire!.jobId) : undefined;
      let pointer: ReturnType<typeof readSchedulePointer>;
      try { pointer = readSchedulePointer(paths, id); } catch { pointer = undefined; }
      const receipt = latestJob && isTerminal(latestJob.state) ? readReceipt(runnerPaths(), latestJob.id) : undefined;
      if (options.json) {
        console.log(JSON.stringify({ schedule: record, latest_job: latestJob ?? null, last_fired_job: fired ?? null, pointer: pointer ?? null, receipt: receipt ?? null }, null, 2));
        return;
      }
      printRecord(record);
      const s = record.state;
      console.log(`  last run: ${s.lastFire ? `${s.lastFire.kind === "catch_up" ? "catch-up " : ""}for ${s.lastFire.dueAt}, ${jobSummary(fired)}` : "-"}; last outcome ${s.lastOutcome ?? "-"}`);
      console.log(`  latest job: ${jobSummary(latestJob)}${receipt ? ` — ${safeTerminal(receipt.summary)}` : ""}`);
      if (pointer) console.log(pc.dim(`  newest result: ${safeTerminal(pointer.receipt)}${pointer.integrationBranch ? `; results on ${safeTerminal(pointer.integrationBranch)}` : ""}`));
      console.log(`  missed runs: ${s.missedCount}${s.missedCount ? "" : " (none)"}`);
      for (const gap of s.missed.slice(-10)) console.log(pc.yellow(`    ${gap.count}${gap.truncated ? "+" : ""} slot${gap.count === 1 ? "" : "s"} ${gap.first}${gap.count > 1 ? ` .. ${gap.last}` : ""}: ${gap.reason.replace(/_/g, " ")}${gap.detail ? ` (${safeTerminal(gap.detail)})` : ""}; reported ${gap.reportedAt}`));
      if (s.clockSteps) console.log(pc.yellow(`  the clock stepped backwards ${s.clockSteps} time${s.clockSteps === 1 ? "" : "s"}; slots already run are not run again`));
    }));

  schedule.command("remove")
    .alias("rm")
    .argument("<id>", "Schedule id")
    .description("Remove a schedule and its pointer and missed-run receipts; a job it already started keeps running")
    .action(action((id: string) => {
      const paths = schedulePaths(runnerPaths());
      withScheduleLock(paths, () => {
        if (!readSchedule(paths, id)) throw new BackgroundUsageError(`There is no schedule ${safeTerminal(id)}.`);
        for (const name of fs.readdirSync(paths.dir)) if (name === `${id}.json` || name === `${id}.latest.json` || name.startsWith(`${id}.missed-`)) fs.rmSync(path.join(paths.dir, name), { force: true });
      });
      console.log(`Removed schedule ${safeTerminal(id)}. A job it already started is not stopped (see \`nexus job list\`).`);
    }));

  schedule.command("pause")
    .argument("<id>", "Schedule id")
    .description("Stop a schedule firing; time spent paused is not reported as missed")
    .action(action((id: string) => {
      const paths = schedulePaths(runnerPaths());
      withScheduleLock(paths, () => {
        const record = readSchedule(paths, id);
        if (!record) throw new BackgroundUsageError(`There is no schedule ${safeTerminal(id)}.`);
        writeSchedule(paths, { ...record, enabled: false });
      });
      console.log(`Paused schedule ${safeTerminal(id)}.`);
    }));

  schedule.command("resume")
    .argument("<id>", "Schedule id")
    .description("Let a paused schedule fire again, from the next slot after now")
    .action(action((id: string) => {
      const paths = schedulePaths(runnerPaths());
      let resumed: ScheduleRecord | undefined;
      withScheduleLock(paths, () => {
        const record = readSchedule(paths, id);
        if (!record) throw new BackgroundUsageError(`There is no schedule ${safeTerminal(id)}.`);
        if (record.remainingRuns === 0) throw new BackgroundUsageError(`Schedule ${id} has used all its runs; add a new one.`);
        const now = Date.now();
        const next = nextAfter(record.trigger, Date.parse(record.createdAt), now);
        if (next === undefined) throw new BackgroundUsageError(`Schedule ${id} has no slot left (${describeTrigger(record.trigger)}); add a new one.`);
        resumed = { ...record, enabled: true, state: { ...record.state, nextDueAt: new Date(next).toISOString(), lastTickAt: new Date(now).toISOString() } };
        writeSchedule(paths, resumed);
      });
      console.log(`Resumed schedule ${safeTerminal(id)}; next run ${resumed!.state.nextDueAt}.`);
    }));

  schedule.command("run-now")
    .argument("<id>", "Schedule id")
    .description("Start one run of a schedule now, as an unattended job; its next slot and its run count do not change")
    .option("-j, --json", "JSON output")
    .action(action(async (id: string, options: any) => {
      const { record } = readOrFail(id);
      const paths = runnerPaths();
      if (!isWorkspaceListed(record.workspace)) throw new BackgroundUsageError(`${record.workspace} is not a trusted workspace; a schedule does not run there. Run \`nexus trust ${record.workspace}\` after reviewing it.`);
      if (listJobs(paths).jobs.some((job) => job.origin.kind === "schedule" && job.origin.scheduleId === id && !isTerminal(job.state))) {
        throw new BackgroundUsageError(`Schedule ${id} still has a running job; wait for it (\`nexus schedule status ${id}\`).`);
      }
      requireRunner(paths);
      let built: ReturnType<typeof submissionFor>;
      try {
        built = submissionFor(record, new Date().toISOString());
      } catch (error) {
        if (error instanceof RunnerStoreError || error instanceof OperationSpecError) throw new BackgroundUsageError(error.message);
        throw error;
      }
      const requestId = submitRequest(paths, { kind: "start", job: built.job, spec: built.spec });
      const accepted = await waitFor(() => readJob(paths, built.job.id) ?? requestRefusal(paths, requestId), ACK_WAIT_MS);
      if (typeof accepted === "string") throw new BackgroundUsageError(`The runner refused the job: ${accepted}`);
      if (!accepted) throw new Error(`The runner did not accept the job within ${ACK_WAIT_MS / 1000} s; it stays queued as request ${requestId}.`);
      if (options.json) console.log(JSON.stringify({ schedule: id, job: built.job.id }, null, 2));
      else console.log(built.job.id);
    }));
}
