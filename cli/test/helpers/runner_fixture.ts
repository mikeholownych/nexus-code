/**
 * What the detached-runner tests share (BG-1): a throwaway HOME and state directory, the real CLI as runner and
 * client processes, and cleanup that stops every runner, worker and tool process by pid after checking it is still the
 * process that was started (pid + kernel start time), never by name.
 */
import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JobRunner, runnerAlive, specDigest, submitRequest, unattendedSpec, type JobRunnerOptions, type SpawnedWorker } from "../../src/core/job_runner.js";
import { descendants, identityOf, sameProcess, signalProcess, type ProcessIdentity } from "../../src/core/process_identity.js";
import { DEFAULT_JOB_BUDGETS, listJobs, newJobIds, readJob, RUNNER_FILE_VERSION, runnerPaths, writePrivateJson, type JobRecord, type JobState, type JobSubmission, type RunnerPaths, type WorkerResult } from "../../src/core/runner_store.js";
import { cliEntry } from "./audit_fixture.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface CliProcess {
  proc: ChildProcess;
  identity: ProcessIdentity | undefined;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
}

export interface RunnerWorld {
  root: string;
  home: string;
  stateDir: string;
  paths: RunnerPaths;
  env: NodeJS.ProcessEnv;
  /** Starts the CLI and returns at once. */
  spawn(args: string[], env?: Record<string, string>): CliProcess;
  /** Runs the CLI to its end. */
  run(args: string[], env?: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** `nexus runner serve`, returned once it holds the runner lock. */
  startRunner(args?: string[], env?: Record<string, string>): Promise<CliProcess>;
  job(id: string): JobRecord | undefined;
  /** Waits until the job is in one of `states`; the error names where it was instead. */
  waitJob(id: string, states: JobState[], timeoutMs?: number): Promise<JobRecord>;
  /** Notes every process below `pid` now, so cleanup can stop the ones that outlive it. */
  remember(pid: number): void;
  /** The remembered processes that are still running. */
  survivors(): ProcessIdentity[];
  /** Stops everything this world started and removes its directories. Call from `finally`. */
  cleanup(): Promise<void>;
}

export async function until<T>(read: () => T | undefined | false, timeoutMs: number, what: () => string): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; ;) {
    let value: T | undefined | false;
    try { value = read(); } catch { value = undefined; }
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function runnerWorld(): RunnerWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runner-"));
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = runnerPaths(path.join(stateDir, "runner"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  // No operator setting reaches these processes: only what a test passes.
  for (const key of Object.keys(env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|GIT_)/.test(key) || key === "NODE_TEST_CONTEXT" || key === "FORCE_COLOR") delete env[key];
  Object.assign(env, { HOME: home, NEXUS_STATE_DIR: stateDir, NO_COLOR: "1", XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") });
  const started: CliProcess[] = [];
  const remembered: ProcessIdentity[] = [];

  const spawnCli = (args: string[], extra: Record<string, string> = {}): CliProcess => {
    const proc = spawn(process.execPath, [...cliEntry(), ...args], { cwd: CLI_DIR, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (chunk) => (stdout += chunk));
    proc.stderr!.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => resolve({ code, signal }));
    });
    const cli: CliProcess = { proc, identity: proc.pid === undefined ? undefined : identityOf(proc.pid), exited, stdout: () => stdout, stderr: () => stderr };
    started.push(cli);
    return cli;
  };

  const remember = (pid: number) => {
    for (const child of [pid, ...descendants([pid])]) {
      const identity = identityOf(child);
      if (identity && !remembered.some((r) => r.pid === identity.pid && r.startTicks === identity.startTicks)) remembered.push(identity);
    }
  };

  const job = (id: string) => readJob(paths, id);

  return {
    root, home, stateDir, paths, env,
    spawn: spawnCli,
    run: async (args, extra) => {
      const cli = spawnCli(args, extra);
      const { code } = await cli.exited;
      return { code, stdout: cli.stdout(), stderr: cli.stderr() };
    },
    startRunner: async (args = [], extra) => {
      const cli = spawnCli(["runner", "serve", ...args], extra);
      await until(() => {
        if (cli.proc.exitCode !== null || cli.proc.signalCode !== null) throw new Error("exited");
        return fs.existsSync(paths.runnerJson) && runnerAlive(paths);
      }, 90_000, () => `the runner to hold its lock\n${cli.stderr()}`).catch((error) => {
        throw new Error(`${error.message}\nrunner exit ${cli.proc.exitCode}\n${cli.stderr()}`);
      });
      return cli;
    },
    job,
    waitJob: (id, states, timeoutMs = 120_000) => until(() => {
      const record = job(id);
      return record && states.includes(record.state) ? record : undefined;
    }, timeoutMs, () => {
      let stderr = "";
      try { stderr = fs.readFileSync(paths.stderr(id), "utf8").slice(-2000); } catch { /* none */ }
      return `job ${id} to be ${states.join(" or ")}; it is ${JSON.stringify(job(id), null, 1)}\nworker stderr: ${stderr}\nrunner: ${started.map((c) => c.stderr().slice(-1500)).join("\n---\n")}`;
    }),
    remember,
    survivors: () => remembered.filter((identity) => sameProcess(identity)),
    cleanup: async () => {
      // Workers are detached from the runner, so each is found through the record of its attempts.
      try {
        for (const record of listJobs(paths).jobs) for (const attempt of record.attempts) remember(attempt.pid);
      } catch { /* no jobs directory */ }
      for (const cli of started) if (cli.proc.pid !== undefined && cli.proc.exitCode === null && cli.proc.signalCode === null) remember(cli.proc.pid);
      for (const identity of remembered) signalProcess(identity, "SIGKILL");
      for (const cli of started) {
        if (cli.proc.exitCode === null && cli.proc.signalCode === null) cli.proc.kill("SIGKILL");
        await Promise.race([cli.exited.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The job id `job start` printed. */
export function startedJobId(stdout: string): string {
  const id = /^job-[0-9a-f]{12}$/m.exec(stdout)?.[0];
  if (!id) throw new Error(`no job id in: ${stdout}`);
  return id;
}

// ---------------------------------------------------------------- the runner as a library, with stand-in workers


export interface Bench {
  root: string;
  paths: RunnerPaths;
  repo: string;
  log: string[];
  /** Every stand-in worker started, in order. */
  workers: Array<{ jobId: string; child: ChildProcess; identity: ProcessIdentity | undefined }>;
  runner(options?: Partial<JobRunnerOptions> & { standIn?: StandIn }): JobRunner;
  /** A valid read-only submission for the bench's repository. */
  submission(overrides?: Partial<JobSubmission>, spec?: Record<string, unknown>): { job: JobSubmission; spec: Record<string, unknown> };
  /** Writes a start request and returns the job id. */
  submit(overrides?: Partial<JobSubmission>, at?: Date): string;
  /** Ticks `runner` until `done` holds. */
  drive(runner: JobRunner, done: () => boolean, timeoutMs?: number): Promise<void>;
  job(id: string): JobRecord;
  cleanup(): Promise<void>;
}

/** What a stand-in worker does: a command line, and optionally the result file it leaves before it exits. */
export type StandIn = (job: JobRecord) => { command: string[]; result?: Pick<WorkerResult, "operationStatus" | "exit" | "error"> };

export const SLEEPER: StandIn = () => ({ command: ["sleep", "300"] });
export const CRASHER: StandIn = () => ({ command: ["sh", "-c", "exit 7"] });

export function bench(repoDir: string): Bench {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runner-bench-"));
  const paths = runnerPaths(path.join(root, "runner"));
  const log: string[] = [];
  const workers: Bench["workers"] = [];
  const runners: JobRunner[] = [];
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  const submission: Bench["submission"] = (overrides = {}, given) => {
    const ids = { ...newJobIds(), ...(overrides.id ? { id: overrides.id, operationId: `bg-${overrides.id.slice(4)}` } : {}) };
    const spec = given ?? unattendedSpec({ objective: "look", units: [{ id: "task", title: "task", role: "researcher", prompt: "look" }] }, { ...ids, baseCommit });
    return { job: { ...ids, workspace: fs.realpathSync(repoDir), baseCommit, specSha256: specDigest(spec), origin: { kind: "cli" }, unattended: true, policy: "read-only", verifier: null, deliverables: [], provider: {}, budgets: { ...DEFAULT_JOB_BUDGETS }, ...overrides }, spec };
  };

  return {
    root, paths, repo: repoDir, log, workers,
    runner: (options = {}) => {
      const { standIn = SLEEPER, ...rest } = options;
      const made = new JobRunner({
        root: paths.root,
        workerCommand: [],
        log: (line) => log.push(line),
        loadOperation: () => undefined,
        timings: { pollMs: 20, adoptPollMs: 50, stopGraceMs: 300, runnerStopWaitMs: 5_000 },
        spawnWorker: (record, at): SpawnedWorker => {
          const { command, result } = standIn(record);
          if (result) writePrivateJson(at.result(record.id), { format: "nexus-job-result", version: RUNNER_FILE_VERSION, jobId: record.id, attempt: record.attempts.length + 1, operationId: record.operationId, ...result });
          const child = spawn(command[0], command.slice(1), { stdio: "ignore", detached: true });
          const worker: SpawnedWorker = { pid: child.pid!, onExit: (listener) => child.once("exit", listener) };
          child.once("exit", (code, signal) => { worker.exit = { code, signal }; });
          workers.push({ jobId: record.id, child, identity: identityOf(child.pid!) });
          return worker;
        },
        ...rest,
      });
      runners.push(made);
      return made;
    },
    submission,
    submit: (overrides, at) => {
      const { job: submitted, spec } = submission(overrides);
      submitRequest(paths, { kind: "start", job: submitted, spec }, at);
      return submitted.id;
    },
    drive: async (runner, done, timeoutMs = 60_000) => {
      for (const deadline = Date.now() + timeoutMs; ;) {
        runner.tick();
        if (done()) return;
        if (Date.now() > deadline) throw new Error(`timed out driving the runner\n${log.slice(-20).join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    job: (id) => {
      const record = readJob(paths, id);
      if (!record) throw new Error(`no job ${id}`);
      return record;
    },
    cleanup: async () => {
      for (const made of runners) made.abandon();
      for (const { child, identity } of workers) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const closed = new Promise((resolve) => child.once("close", resolve));
        // Its own group (detached), so this reaches what it started and nothing else.
        if (identity && sameProcess(identity)) { try { process.kill(-identity.pid, "SIGKILL"); } catch { signalProcess(identity, "SIGKILL"); } }
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A gateway that lists one model and never answers a chat request: the job that calls it stays mid-inference until it
 * is stopped. No timers, so nothing is left pending when the test ends. Close it in `finally`.
 */
export async function stalledGateway(): Promise<{ url: string; requests: unknown[]; close(): Promise<void> }> {
  const requests: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url?.endsWith("/tokenize")) {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      try { requests.push(JSON.parse(raw)); } catch { requests.push(raw); }
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
