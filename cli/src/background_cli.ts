/**
 * BG-1: detached, resumable background runs. `nexus runner serve` is the foreground runner (meant for a systemd user
 * unit or any supervisor), `nexus job` commands are its clients, and `nexus job __worker` is what the runner starts
 * for each job. A client only writes a request file and reads records, so ending it never ends a job.
 *
 * A job runs unattended: review or read-only mode in a fresh worktree, never auto mode, and no option here can change
 * that (`--yes`, `--mode` and `--approve` do not exist on these commands). See core/unattended.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { getBuildIdentity } from "./build_identity.js";
import { JobRunner, loadJobOperation, readReceipt, readRunnerInfo, requestRefusal, RunnerBusyError, runnerAlive, submitRequest } from "./core/job_runner.js";
import { buildJobStatus } from "./core/job_receipt.js";
import { buildJobSubmission, promptSpec } from "./core/job_submission.js";
import { EVENT_LOG_LIMIT, runJobWorker } from "./core/job_worker.js";
import { DEFAULT_JOB_BUDGETS, isTerminal, listJobs, parseJobBudgets, readJob, runnerPaths, RunnerStoreError, type JobBudgets, type JobRecord, type JobSubmission, type RunnerPaths } from "./core/runner_store.js";
import { OperationSpecError, validateOperationSpec } from "./operation_cli.js";
import { safeTerminal } from "./ui.js";
import { gitOut } from "./worktrunk/git.js";

/** How long a client waits for the runner to accept a request. */
export const ACK_WAIT_MS = 10_000;
/** How long `job stop` waits for the job to end (the runner's grace before SIGKILL is 30 s). */
const STOP_WAIT_MS = 40_000;

const NO_RUNNER = "no runner is running; start it with `systemctl --user start nexus-runner` or run `nexus runner serve` under your own supervisor (docs/RUNNER.md)";

/** Something the operator must change: reported on stderr, exit 2. */
export class BackgroundUsageError extends Error {}

export function action<T extends unknown[]>(run: (...args: T) => void | Promise<void>): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await run(...args);
    } catch (error: any) {
      console.error(pc.red(safeTerminal(String(error?.message ?? error))));
      process.exitCode = error instanceof BackgroundUsageError || error instanceof OperationSpecError || error instanceof RunnerStoreError ? 2 : 1;
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  for (const deadline = Date.now() + timeoutMs; ;) {
    const value = read();
    if (value !== undefined || Date.now() > deadline) return value;
    await sleep(100);
  }
}

export function requireRunner(paths: RunnerPaths): void {
  if (!runnerAlive(paths)) throw new BackgroundUsageError(NO_RUNNER);
}

/** The job's budgets from the command line; unset flags take the unattended defaults. The command line's floor for both deadlines is one minute. */
export function budgetsFrom(options: Record<string, unknown>): JobBudgets {
  const number = (flag: string, key: keyof JobBudgets, min: number): number => {
    const raw = options[key];
    if (raw === undefined) return DEFAULT_JOB_BUDGETS[key];
    const value = Number(raw);
    if (!String(raw).trim() || !Number.isFinite(value) || value < min) throw new BackgroundUsageError(`${flag} must be a number of at least ${min} (got '${String(raw)}').`);
    return value;
  };
  return parseJobBudgets("budgets", {
    maxTotalSteps: number("--max-total-steps", "maxTotalSteps", 1),
    maxToolInvocations: number("--max-tool-invocations", "maxToolInvocations", 1),
    maxInferenceSubmissions: number("--max-inference-submissions", "maxInferenceSubmissions", 1),
    maxTurnMinutes: number("--max-turn-minutes", "maxTurnMinutes", 1),
    timeoutMinutes: number("--timeout-minutes", "timeoutMinutes", 1),
  });
}

function readSpec(specPath: string | undefined, prompt: string | undefined, writable: boolean): unknown {
  if ((specPath === undefined) === (prompt === undefined)) throw new BackgroundUsageError("Give either an operation spec file or --prompt <text>, not both.");
  if (prompt !== undefined) {
    if (!prompt.trim()) throw new BackgroundUsageError("--prompt needs a task.");
    return promptSpec(prompt, writable);
  }
  try {
    return JSON.parse(fs.readFileSync(path.resolve(specPath!), "utf8"));
  } catch (error: any) {
    throw new OperationSpecError(`cannot read operation spec ${specPath}: ${String(error?.message ?? error)}`);
  }
}

/** Top-level options that select an approval mode or loosen the sandbox for an attended run. None applies to a job. */
const REFUSED_GLOBAL_FLAGS: ReadonlyArray<[string, string]> = [["yes", "--yes"], ["mode", "--mode"], ["approve", "--approve"], ["readOnly", "--read-only"], ["sandbox", "--sandbox"], ["sandboxNetwork", "--sandbox-network"], ["dryRun", "--dry-run"]];

/** `nexus --yes job start ...` parses: the flag belongs to the top-level command. It is refused here, never ignored. */
export function refuseModeFlags(command: Command): void {
  const globals = command.parent?.parent?.opts() ?? {};
  for (const [key, flag] of REFUSED_GLOBAL_FLAGS) {
    if (globals[key] !== undefined && globals[key] !== false) throw new BackgroundUsageError(`${flag} does not apply to a background job and is refused: a job runs unattended, read-only or (with --allow-worktree-write) writing only inside its own fresh worktree, and never in auto mode.`);
  }
}

/** Everything `job start` decides before it writes a request. Nothing here reads an approval mode. */
function prepareSubmission(specPath: string | undefined, options: Record<string, any>): { job: JobSubmission; spec: Record<string, unknown>; dirty: boolean } {
  // The variable does not apply to a job. Refusing is kinder than ignoring it: whoever set it may believe it does.
  if (process.env.NEXUS_APPROVAL_MODE?.trim().toLowerCase() === "auto") {
    throw new BackgroundUsageError("NEXUS_APPROVAL_MODE=auto is set, and a background job never runs in auto mode. Unset it for this command; a job runs read-only, or with --allow-worktree-write writes only inside its own fresh worktree.");
  }
  let workspace: string;
  try {
    workspace = fs.realpathSync(path.resolve(options.workspace ?? process.cwd()));
  } catch {
    throw new BackgroundUsageError(`Workspace ${String(options.workspace)} does not exist.`);
  }
  const policy = options.allowWorktreeWrite ? "worktree-write" : "read-only";
  const given = readSpec(specPath, options.prompt, policy === "worktree-write");
  validateOperationSpec(given);
  const verifier = options.verifier === undefined ? null : String(options.verifier).trim();
  if (verifier === "") throw new BackgroundUsageError("--verifier needs a command.");
  const { job, spec } = buildJobSubmission({
    workspace,
    given,
    policy,
    verifier,
    deliverableFiles: options.deliverableFile,
    provider: Object.fromEntries((["endpoint", "model", "provider"] as const).flatMap((key) => (options[key] ? [[key, String(options[key])]] : []))),
    budgets: budgetsFrom(options),
    origin: { kind: "cli" },
  });
  return { job, spec, dirty: gitOut(workspace, ["status", "--porcelain"], { allowFailure: true }).trim() !== "" };
}

const EXIT_OF: Record<string, number> = { COMPLETE: 0, CANCELLED: 130 };

/** Prints the job's event log as it grows until the job ends; returns the ended record. Ending this never ends the job. */
async function follow(paths: RunnerPaths, id: string): Promise<JobRecord> {
  let offset = 0;
  let pending = "";
  const drain = () => {
    let fd: number;
    try {
      fd = fs.openSync(paths.events(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch {
      return;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new RunnerStoreError(`Job log ${paths.events(id)} is not a private regular file owned by this user.`);
      if (stat.size > EVENT_LOG_LIMIT + 4096) throw new RunnerStoreError(`Job log ${paths.events(id)} exceeds the 16 MiB limit.`);
      const buffer = Buffer.alloc(64 * 1024);
      const end = Math.min(stat.size, EVENT_LOG_LIMIT + 4096);
      for (let count = offset < end ? fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset) : 0; count > 0; count = offset < end ? fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset) : 0) {
        offset += count;
        pending += buffer.subarray(0, count).toString("utf8");
      }
    } finally {
      fs.closeSync(fd);
    }
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        console.log(pc.dim(`${safeTerminal(String(event.type ?? "?"))}${event.message ? ` ${safeTerminal(String(event.message))}` : ""}`));
      } catch {
        // A torn or foreign line is not shown.
      }
    }
  };
  for (;;) {
    const job = readJob(paths, id);
    drain();
    if (!job) throw new Error(`Job ${id} disappeared.`);
    if (isTerminal(job.state)) return job;
    await sleep(250);
  }
}

function readEventLog(paths: RunnerPaths, id: string): string {
  const file = paths.events(id);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw new RunnerStoreError(`Job log ${file} cannot be read (${error?.code ?? "error"}).`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new RunnerStoreError(`Job log ${file} is not a regular file.`);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new RunnerStoreError(`Job log ${file} is not a private file owned by this user.`);
    if (stat.size > EVENT_LOG_LIMIT + 4096) throw new RunnerStoreError(`Job log ${file} exceeds the 16 MiB limit.`);
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function resolveLauncher(explicit: string | undefined): string {
  const candidates = explicit ? [explicit] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir, "nexus"));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      if (explicit) throw new BackgroundUsageError("--exec must be an absolute path.");
      continue;
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return fs.realpathSync(candidate);
    } catch {
      if (explicit) throw new BackgroundUsageError(`The launcher ${candidate} is not an executable file.`);
    }
  }
  throw new BackgroundUsageError("Cannot find an executable `nexus` launcher on PATH; pass its absolute path with --exec.");
}

function systemdArg(value: string): string {
  return `"${value.replace(/%/g, "%%").replace(/[\\"]/g, "\\$&")}"`;
}

function runnerUnit(execPath: string): string {
  return [
    "[Unit]",
    "Description=Nexus Code detached job runner",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdArg(execPath)} runner serve`,
    "Restart=on-failure",
    "RestartSec=5",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "TimeoutStopSec=60",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function ensurePrivateUnitDirectory(configHome: string): string {
  const user = typeof process.getuid === "function" ? process.getuid() : undefined;
  const ensure = (dir: string) => {
    try { fs.mkdirSync(dir, { mode: 0o755 }); } catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (user !== undefined && stat.uid !== user) || (stat.mode & 0o022) !== 0) {
      throw new BackgroundUsageError(`Refusing to write a runner unit through an unsafe directory: ${dir}`);
    }
  };
  ensure(configHome);
  const systemd = path.join(configHome, "systemd");
  ensure(systemd);
  const userDir = path.join(systemd, "user");
  ensure(userDir);
  return userDir;
}

function printJob(job: JobRecord): void {
  console.log(pc.bold(`Job ${safeTerminal(job.id)}: ${job.state}`) + pc.dim(`  (${job.policy}, unattended, operation ${safeTerminal(job.operationId)})`));
  console.log(pc.dim(`  workspace ${safeTerminal(job.workspace)} at ${job.baseCommit.slice(0, 12)}; deadline ${job.deadlineAt}; attempts ${job.attempts.length}, crash resumes ${job.autoResumes}/${job.maxAutoResumes}`));
}

export function registerBackgroundCommands(program: Command): void {
  const runner = program.command("runner").description("[experimental] The detached job runner (see docs/RUNNER.md)");

  runner.command("status")
    .description("Show whether the runner is serving this state directory")
    .option("-j, --json", "JSON output")
    .action(action((options: any) => {
      const paths = runnerPaths();
      const alive = runnerAlive(paths);
      let info: ReturnType<typeof readRunnerInfo>;
      let infoError: string | undefined;
      try { info = readRunnerInfo(paths); } catch (error: any) { infoError = String(error?.message ?? error); }
      const status = { alive, ...(info ? { runner: info } : {}), ...(infoError ? { infoError } : {}) };
      if (options.json) console.log(JSON.stringify(status, null, 2));
      else if (!alive) console.log("Runner is not running.");
      else if (info) console.log(`Runner is running (pid ${info.pid}, Nexus ${info.nexusVersion}, max ${info.maxJobs} job${info.maxJobs === 1 ? "" : "s"}).`);
      else console.log(`Runner is running; its status record is unreadable${infoError ? `: ${safeTerminal(infoError)}` : "."}`);
      if (!alive) process.exitCode = 1;
    }));

  runner.command("install-unit")
    .description("Write, but do not enable, a systemd --user unit for this runner")
    .option("--exec <path>", "Absolute path to the nexus launcher")
    .option("--print", "Print the unit without writing it")
    .action(action((options: any) => {
      if (process.platform !== "linux") throw new BackgroundUsageError("runner install-unit needs Linux and systemd --user.");
      const launcher = resolveLauncher(options.exec);
      const contents = runnerUnit(launcher);
      if (options.print) {
        process.stdout.write(contents);
        return;
      }
      const configHome = path.resolve(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
      const dir = ensurePrivateUnitDirectory(configHome);
      const file = path.join(dir, "nexus-runner.service");
      let fd: number;
      try {
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      } catch (error: any) {
        if (error?.code === "EEXIST") throw new BackgroundUsageError(`Refusing to overwrite ${file}; move or remove the existing unit yourself.`);
        throw error;
      }
      try {
        fs.writeFileSync(fd, contents, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      console.log(`Wrote ${file}. Review it, then run: systemctl --user daemon-reload && systemctl --user enable --now nexus-runner`);
      console.log("For runs that must survive logout and start at boot, enable lingering with: loginctl enable-linger $USER");
    }));

  runner.command("serve")
    .description("Run the job runner in the foreground (what the systemd user unit runs)")
    .option("--max-jobs <n>", "Jobs that may run at once (1 to 4)", "1")
    .action(action(async (options: any) => {
      if (process.platform !== "linux") throw new BackgroundUsageError("nexus runner serve needs Linux.");
      const maxJobs = Number(options.maxJobs);
      let jobRunner: JobRunner;
      try {
        jobRunner = new JobRunner({
          maxJobs,
          // The worker is this same program, so it starts with the same recovery, lease and policy steps as any command.
          workerCommand: [process.execPath, ...process.execArgv, process.argv[1]],
          nexusVersion: getBuildIdentity().version,
          log: (line) => console.error(`${new Date().toISOString()} ${safeTerminal(line)}`),
        });
      } catch (error: any) {
        throw new BackgroundUsageError(String(error?.message ?? error));
      }
      const stop = new AbortController();
      const onSignal = () => stop.abort();
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      try {
        console.error(`nexus runner: serving ${safeTerminal(jobRunner.paths.root)} (max ${maxJobs} job${maxJobs === 1 ? "" : "s"} at once)`);
        await jobRunner.serve(stop.signal);
        console.error("nexus runner: stopped; unfinished jobs resume when a runner starts again");
      } catch (error) {
        if (!(error instanceof RunnerBusyError)) throw error;
        console.error(pc.red(safeTerminal(error.message)));
        process.exitCode = 3;
      } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
    }));

  const job = program.command("job").description("[experimental] Detached background jobs: unattended, in a fresh worktree, resumable (see docs/RUNNER.md)");

  job.command("list")
    .description("List background jobs, newest first")
    .option("-j, --json", "JSON output")
    .action(action((options: any) => {
      const { jobs, invalid } = listJobs(runnerPaths());
      const ordered = [...jobs].reverse();
      if (options.json) {
        console.log(JSON.stringify({ jobs: ordered, invalid }, null, 2));
        return;
      }
      if (!ordered.length && !invalid.length) {
        console.log("No background jobs.");
        return;
      }
      for (const record of ordered) console.log(`${record.id.padEnd(16)} ${record.state.padEnd(10)} ${record.policy.padEnd(14)} ${safeTerminal(record.workspace)}  ${record.createdAt}`);
      for (const item of invalid) console.error(pc.yellow(`Unreadable job entry ${safeTerminal(item.id)}: ${safeTerminal(item.error)}`));
    }));

  job.command("start")
    .argument("[spec]", "Operation spec JSON file (or use --prompt)")
    .description("Submit a job to the runner and print its id; the job continues when this command ends")
    .option("--prompt <text>", "Run one task instead of a spec file")
    .option("-w, --workspace <path>", "Repository to work on (default: current directory); the job runs in its own worktree from HEAD")
    .option("--allow-worktree-write", "Let the job write files inside its own worktree (default: read-only)")
    .option("--verifier <command>", "Your verifier command: it gates every completion")
    .option("--deliverable-file <path>", "Workspace-relative file the job must deliver (repeatable)", (value: string, all: string[] = []) => [...all, value])
    .option("--max-total-steps <n>", `Steps for the whole job (default ${DEFAULT_JOB_BUDGETS.maxTotalSteps})`)
    .option("--max-tool-invocations <n>", `Tool calls for the whole job (default ${DEFAULT_JOB_BUDGETS.maxToolInvocations})`)
    .option("--max-inference-submissions <n>", `Model requests for the whole job (default ${DEFAULT_JOB_BUDGETS.maxInferenceSubmissions})`)
    .option("--max-turn-minutes <n>", `Minutes for one attempt's turn (default ${DEFAULT_JOB_BUDGETS.maxTurnMinutes})`)
    .option("--timeout-minutes <n>", `Minutes until the job is stopped as TIMED_OUT (default ${DEFAULT_JOB_BUDGETS.timeoutMinutes})`)
    .option("-e, --endpoint <url>", "Endpoint (default: your configured endpoint)")
    .option("-m, --model <name>", "Model")
    .option("--provider <id>", "Cloud provider (openrouter, openai, anthropic, compatible)")
    .option("--wait", "Follow the job until it ends and exit with its result")
    .action(action(async (specPath: string | undefined, options: any, command: Command) => {
      refuseModeFlags(command);
      const paths = runnerPaths();
      const { job: submission, spec, dirty } = prepareSubmission(specPath, options);
      requireRunner(paths);
      const requestId = submitRequest(paths, { kind: "start", job: submission, spec });
      const accepted = await waitFor(() => readJob(paths, submission.id) ?? requestRefusal(paths, requestId), ACK_WAIT_MS);
      if (typeof accepted === "string") throw new BackgroundUsageError(`The runner refused the job: ${accepted}`);
      if (!accepted) throw new Error(`The runner did not accept the job within ${ACK_WAIT_MS / 1000} s; it stays queued as request ${requestId}. Check \`nexus job status ${submission.id}\`.`);
      console.log(submission.id);
      if (dirty) console.error(pc.yellow("warning: this checkout has uncommitted changes; they are not part of the job, which runs from HEAD."));
      console.error(pc.dim(`${submission.policy}, unattended; nothing is merged into your branch. Status: nexus job status ${submission.id}`));
      if (!options.wait) return;
      const ended = await follow(paths, submission.id);
      printJob(ended);
      process.exitCode = EXIT_OF[ended.state] ?? 2;
    }));

  job.command("status")
    .argument("<id>", "Job id")
    .option("-j, --json", "JSON output")
    .description("Show a job's record, its operation and, once it ended, its receipt")
    .action(action((id: string, options: any) => {
      const paths = runnerPaths();
      const record = readJob(paths, id);
      if (!record) {
        console.error(pc.red(`There is no job ${safeTerminal(id)}.`));
        process.exitCode = 1;
        return;
      }
      let operation: ReturnType<typeof loadJobOperation>;
      try {
        operation = loadJobOperation(record);
      } catch {
        operation = undefined;
      }
      const receipt = isTerminal(record.state) ? readReceipt(paths, id) : undefined;
      if (options.json) {
        console.log(JSON.stringify(buildJobStatus(record, operation, receipt), null, 2));
        return;
      }
      printJob(record);
      if (operation) for (const unit of operation.units) console.log(`  ${unit.status.padEnd(22)} ${safeTerminal(unit.title)}${unit.status === "BLOCKED" && unit.blocked ? pc.dim(` — ${safeTerminal(unit.blocked.reason)}`) : ""}`);
      if (!receipt) return;
      console.log(safeTerminal(receipt.summary));
      if (receipt.integration_branch) console.log(pc.dim(`  results: ${safeTerminal(receipt.integration_branch)}`));
      for (const decision of receipt.pending_decisions) console.log(pc.red(`  decision ${safeTerminal(decision.id)}: ${safeTerminal(decision.question)}\n    ${safeTerminal(decision.decide)}`));
    }));

  job.command("logs")
    .argument("<id>", "Job id")
    .option("-f, --follow", "Follow the event log until the job ends")
    .description("Read a job's bounded, redacted event log")
    .action(action(async (id: string, options: any) => {
      const paths = runnerPaths();
      if (!readJob(paths, id)) throw new BackgroundUsageError(`There is no job ${safeTerminal(id)}.`);
      if (options.follow) {
        const ended = await follow(paths, id);
        printJob(ended);
      } else {
        const log = readEventLog(paths, id);
        if (log) process.stdout.write(log);
      }
    }));

  job.command("resume")
    .argument("<id>", "Job id")
    .description("Requeue a BLOCKED job before its deadline")
    .action(action(async (id: string) => {
      const paths = runnerPaths();
      const record = readJob(paths, id);
      if (!record) throw new BackgroundUsageError(`There is no job ${safeTerminal(id)}.`);
      if (record.state !== "BLOCKED") throw new BackgroundUsageError(`Job ${id} is ${record.state}; only a BLOCKED job can be resumed.`);
      requireRunner(paths);
      const requestId = submitRequest(paths, { kind: "resume", jobId: id });
      const accepted = await waitFor(() => {
        const current = readJob(paths, id);
        if (current && current.state !== "BLOCKED") return current;
        return requestRefusal(paths, requestId);
      }, ACK_WAIT_MS);
      if (typeof accepted === "string") throw new BackgroundUsageError(`The runner refused the resume: ${accepted}`);
      if (!accepted) throw new Error(`The runner did not accept the resume within ${ACK_WAIT_MS / 1000} s; request ${requestId} remains available for inspection.`);
      console.log(`Job ${id} queued to resume.`);
    }));

  job.command("stop")
    .argument("<id>", "Job id")
    .description("Ask the runner to stop a job; its operation is cancelled cleanly")
    .action(action(async (id: string) => {
      const paths = runnerPaths();
      const record = readJob(paths, id);
      if (!record) {
        console.error(pc.red(`There is no job ${safeTerminal(id)}.`));
        process.exitCode = 1;
        return;
      }
      if (!isTerminal(record.state)) {
        requireRunner(paths);
        submitRequest(paths, { kind: "stop", jobId: id });
      }
      const ended = await waitFor(() => {
        const now = readJob(paths, id);
        return now && isTerminal(now.state) ? now : undefined;
      }, STOP_WAIT_MS);
      if (ended) printJob(ended);
      else console.error(pc.red(`Job ${safeTerminal(id)} did not stop within ${STOP_WAIT_MS / 1000} s.`));
      process.exitCode = ended?.state === "CANCELLED" ? 0 : 1;
    }));

  // Started by the runner only; a worker run by hand finds no attempt recorded for its process and ends.
  job.command("__worker", { hidden: true })
    .argument("<id>")
    .action(async (id: string) => {
      process.exit(await runJobWorker(id));
    });
}
