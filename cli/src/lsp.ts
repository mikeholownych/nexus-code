import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildMcpEnvironment } from "./mcp.js";
import { fenceUntrusted, sanitizeDiagnosticMessage } from "./diagnostics.js";
import { redactPlain } from "./protocol.js";

const LSP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const LSP_TOOLCHAIN_VARS = ["RUSTUP_HOME", "CARGO_HOME", "RUSTUP_TOOLCHAIN", "GOPATH", "GOROOT", "GOCACHE", "GOMODCACHE"];
/**
 * Documents one server keeps open; the least recently queried one beyond this is closed (`didClose`), which hands that
 * file back to the server's own reading of the disk. Every query re-checks every open document (one realpath and one
 * stat each), and a server re-analyses its open documents on each change, so the set is kept to what an agent works on
 * at one time (an editor's worth of tabs), not every file it ever asked about.
 */
export const MAX_OPEN_DOCUMENTS = 32;
/**
 * A file's stat is taken as proof that it has not changed only when its newest timestamp was at least this old when the
 * file was read. Timestamps come from a clock that advances in steps (a kernel tick, or 1 to 2 s on coarse file systems):
 * a second write inside the step of the first leaves them equal, so a file changed that recently is compared by content.
 */
export const STAT_SETTLE_MS = 2_000;
/**
 * Push-only servers: how long the server must have published nothing before a list that predates a change to another
 * document is taken as still standing (see `settledAt`). It has to outlast the gap between a server's publish for the
 * changed file and its publish for a dependent one; servers batch or debounce those within a few hundred milliseconds,
 * and 1 s is several times that. Longer would make every such query slower by as much; shorter would return more old
 * lists from a server that is slow to reach the dependent file. Counted from the last publish, so a query made a moment
 * after an edit usually finds most of it already spent.
 */
export const PUBLISH_QUIET_MS = 1_000;

// ---------------------------------------------------------------------------------------------------------- timings
// One value per phase, each tied to what was measured (docs/LSP_REAL_SERVERS.md) or marked as a judgement. A server's
// spec can override any of them (`LspServerSpec.timings`), and a manager option overrides both (tests pass small values).

/**
 * Start: how long `initialize` may take. All four real servers answered inside the former 5 s limit on the hosted runs
 * (44606102675, 44670790609); a server that is missing or exits is reported at once and no longer waits for this, so the
 * limit only costs when a process hangs. Twice the proven value, for a loaded machine. A judgement, not a measurement.
 */
export const LSP_START_TIMEOUT_MS = 10_000;
/**
 * A query on a server that is ready: the value the tools always used. Also how long a call waits, at the least, on a
 * server that is not ready, and the timeout of one hover or definition request.
 */
export const LSP_WARM_QUERY_TIMEOUT_MS = 5_000;
/**
 * Cold start: how long after `initialize` a call may wait for the server's first analysis, and how long a server that
 * reports no progress is taken to be warming up. The default adds nothing to the warm timeout: no first-query time is
 * recorded for typescript-language-server, pyright or gopls (the real-server suite passes 60 to 90 s and does not record
 * what was used), so nothing longer is justified yet.
 */
export const LSP_COLD_START_ALLOWANCE_MS = LSP_WARM_QUERY_TIMEOUT_MS;
/**
 * rust-analyzer: a first diagnostics call on a tiny crate took about 13 s locally and about 18 s on a hosted runner;
 * 25 s covers the slower one with 40% to spare.
 *
 * THE COLD-START DECISION: a bounded longer first wait, not "unavailable, try again" after the warm timeout. With the
 * measured 13 to 18 s, the warm timeout would end three or four calls in a row as "still indexing", each a model round
 * trip that costs more than the seconds it saves, where one call that waits returns the real answer. The wait is bounded
 * and is counted from the server's start, not from the call: a call made while the server is still indexing waits for
 * what is left of the allowance (at least the warm timeout), so a second call never starts the allowance over, and one
 * made after it has run out reports the state, with the time indexing has taken, after the warm timeout. A project that
 * needs longer keeps indexing between calls; `LspBridgeManager.warmUp` starts that before the first query.
 */
export const RUST_ANALYZER_COLD_START_ALLOWANCE_MS = 25_000;
/** A server's progress must have been over for this long before it counts as ready and its lists as final (rust-analyzer runs its phases back to back; passed on the real server since CS-6). */
export const LSP_PROGRESS_QUIET_MS = 1_500;
/**
 * Staged servers, after an edit: when no progress cycle begins after the change (no check on save), a list for the new
 * version is taken as final this long after the change. 8 s is the window the real rust-analyzer case needed: it
 * reproduced a version-matched list that still carried the previous `rustc` result right after an edit. A cycle that
 * began after the change and ended is the usual evidence, and does not wait for this.
 */
export const LSP_EDIT_SETTLE_MS = 8_000;
/** Hover and definition on a server that is not ready: the first pause before asking again; it doubles up to the cap. A judgement. */
export const LSP_READINESS_RETRY_MS = 250;
const READINESS_RETRY_CAP_MS = 2_000;
/**
 * A failed start (not installed, exited, no answer to initialize) is answered from memory for this long, then tried
 * again; a changed PATH ends it at once, so installing the server mid-session works. Long enough that a model asking
 * again does not spawn a process per call, short enough to notice an install. A judgement.
 */
export const LSP_START_FAILURE_RECHECK_MS = 30_000;
/** A crashed server is started again by the next query, but not sooner than this after the crash; doubled per crash. A judgement. */
export const LSP_RESTART_BACKOFF_MS = 1_000;
/** Restarts after a crash, per session and server; one more crash and it stays down until PATH changes or Nexus restarts. A judgement. */
export const LSP_MAX_RESTARTS = 3;

export interface LspTimings {
  startMs: number;
  queryMs: number;
  coldStartMs: number;
  quietMs: number;
  editSettleMs: number;
  retryMs: number;
  startRecheckMs: number;
  restartBackoffMs: number;
  maxRestarts: number;
}

export const LSP_TIMINGS: Readonly<LspTimings> = Object.freeze({
  startMs: LSP_START_TIMEOUT_MS,
  queryMs: LSP_WARM_QUERY_TIMEOUT_MS,
  coldStartMs: LSP_COLD_START_ALLOWANCE_MS,
  quietMs: LSP_PROGRESS_QUIET_MS,
  editSettleMs: LSP_EDIT_SETTLE_MS,
  retryMs: LSP_READINESS_RETRY_MS,
  startRecheckMs: LSP_START_FAILURE_RECHECK_MS,
  restartBackoffMs: LSP_RESTART_BACKOFF_MS,
  maxRestarts: LSP_MAX_RESTARTS,
});

/** The last bytes of a server's stderr that are kept, and how much of them a failure report quotes. */
const STDERR_RING_BYTES = 4096;
const STDERR_TAIL_CHARS = 400;
/** After a server's exit, how long its stderr is given to deliver what it still holds (a child of the server can keep the pipe open). */
const STDERR_DRAIN_MS = 200;

// ------------------------------------------------------------------------------------------------------------ state

/**
 * Where one server is. `indexing`: it runs but has not finished analysing: work-done progress is in flight or ended
 * less than the quiet period ago, or, for a server that reports none, it started less than the cold-start allowance ago
 * and has answered nothing yet. A server marked `awaitProgress` is ready only after a progress cycle.
 */
export type LspServerState = "not_started" | "starting" | "initializing" | "indexing" | "ready" | "failed" | "stopped";

export interface LspFailure {
  kind: "not_installed" | "spawn_failed" | "exited" | "initialize_timeout" | "crashed" | "crash_loop";
  /** One sentence, safe to show: it holds nothing the server wrote. */
  message: string;
  at: number;
  exitCode?: number | null;
  signal?: string | null;
  /** The end of the server's stderr: untrusted text, already capped, stripped of control characters and redacted. Show it fenced (`failureDetail`). */
  stderrTail?: string;
}

export interface LspServerStatus {
  server: string;
  state: LspServerState;
  /** How long it has been in this state. */
  forMs: number;
  detail?: string;
  cause?: LspFailure;
  /** Crashes of this server in this session. */
  crashes?: number;
}

/** What a query returns in place of an answer when the server's state is the reason there is none. */
interface NoAnswer {
  reason: string;
  state?: LspServerStatus;
  /** Fenced untrusted text (the server's stderr) to show after the reason. */
  detail?: string;
}

const seconds = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`);

/** The stderr tail of a failure, fenced as untrusted, or undefined when there is none. */
export function failureDetail(cause: LspFailure | undefined): string | undefined {
  return cause?.stderrTail ? fenceUntrusted("language server stderr, last output", cause.stderrTail) : undefined;
}

const noAnswer = (reason: string, state: LspServerStatus): NoAnswer => {
  const detail = failureDetail(state.cause);
  return { reason, state, ...(detail ? { detail } : {}) };
};

/** `cmd` as the server's environment would find it, or null. A name is looked up on PATH; a path is taken as given, from `cwd`. */
function findCommand(cmd: string, pathVar: string, cwd: string): string | null {
  if (process.platform === "win32") return cmd; // extensions and App Paths decide there: left to the spawn, whose error is reported the same way
  const executable = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes("/") || cmd.includes(path.sep)) return executable(path.resolve(cwd, cmd)) ? cmd : null;
  for (const dir of pathVar.split(path.delimiter)) if (dir !== "" && executable(path.join(dir, cmd))) return path.join(dir, cmd);
  return null;
}

const timedOut = (err: unknown): boolean => (err as any)?.code === "LSP_TIMEOUT";
const cancelled = (err: unknown): boolean => (err as any)?.code === "LSP_CANCELLED";
/** LSP `ServerCancelled`: the server abandoned a pull request; its data says whether to ask again. */
const SERVER_CANCELLED = -32802;
/** How often one diagnostics query asks again after such a cancellation (within its timeout). */
const PULL_RETRIGGER_LIMIT = 3;
/** Wakes a query waiting for evidence that the server has settled: any publish, the end of a progress cycle, a close. */
const ANY_DOCUMENT = "";

/** `state` and `detail` are present only when the server's state is why there is no answer. */
export type DiagnosticsAnswer = { status: "ok"; diagnostics: LspDiagnostic[] } | { status: "unavailable"; reason: string; state?: LspServerStatus; detail?: string };

const toDiagnostics = (items: any[]): LspDiagnostic[] =>
  items.map((d: any) => ({
    range: d.range,
    severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "information",
    message: d.message,
    source: d.source,
    ...(d.code !== undefined && d.code !== null ? { code: d.code } : {}),
  }));

const SYSTEM_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/sbin", "/usr/sbin"];

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The containment rule for documents; `child` and `root` are real paths. */
const outsideRoot = (root: string, child: string): boolean => {
  const rel = path.relative(root, child);
  return rel.startsWith("..") || path.isAbsolute(rel);
};

const isInside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
};

/**
 * The environment a language server starts with: the MCP allowlist (no credentials) plus the toolchain locations the
 * servers need. PATH keeps only existing absolute entries that do not resolve (through symlinks) into the workspace, so
 * project content cannot supply the binary. When the workspace is a home directory or a system prefix that itself
 * contains the toolchain, its entries are kept: dropping them would leave no server installed.
 */
export function buildLspEnvironment(workspace: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = buildMcpEnvironment();
  for (const k of LSP_TOOLCHAIN_VARS) if (source[k] !== undefined) env[k] = source[k]!;
  for (const [k, v] of Object.entries(env)) {
    if (/^(https?|all)_proxy$/i.test(k) && /\/\/[^/]*@/.test(v)) delete env[k];
  }
  const root = realOrNull(path.resolve(workspace));
  const broad =
    root !== null &&
    [os.homedir(), ...SYSTEM_BIN_DIRS].some((d) => {
      const real = realOrNull(d);
      return real !== null && isInside(root, real);
    });
  env.PATH = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => {
      if (!path.isAbsolute(d) || root === null) return false;
      const real = realOrNull(d);
      return real !== null && (broad || !isInside(root, real));
    })
    .join(path.delimiter);
  return env;
}

/** Thrown by a query whose file cannot be given to the server; the message is the answer the caller reports. */
const unreadable = (filePath: string): Error => new Error(`${filePath} is not a readable file inside the workspace.`);

/** One spelling per path for comparisons: no trailing separator, no `.` or `..`, a lower-case drive letter. */
const comparablePath = (p: string): string => path.resolve(p).replace(/^[A-Z]:/, (drive) => drive.toLowerCase());

interface FileState {
  text: string;
  /** Device, inode, size, mtime and ctime (ns). ctime is included because an edit can restore size and mtime but not it. */
  stamp: string;
  /** The stamp alone proves "unchanged" (see STAT_SETTLE_MS); otherwise the next check compares content. */
  settled: boolean;
}

function stampOf(st: fs.BigIntStats, readAtMs: number): Pick<FileState, "stamp" | "settled"> {
  const newest = st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs;
  return {
    stamp: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`,
    settled: BigInt(readAtMs) * 1_000_000n - newest >= BigInt(STAT_SETTLE_MS) * 1_000_000n,
  };
}

/**
 * The regular file at `real` (a path already resolved through symlinks), or null. The descriptor refuses a symlink put in
 * the last component since the path was resolved, and does not block on a FIFO; the stamp is of the file actually read.
 */
function readRegularFile(real: string): FileState | null {
  let fd: number | undefined;
  try {
    const readAtMs = Date.now();
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    return { text: fs.readFileSync(fd, "utf-8"), ...stampOf(st, readAtMs) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** What the server holds for one file. The client's only record of it: every query goes through `LspClient.open`. */
interface OpenDocument extends FileState {
  /** Identity: the file's real path. Two spellings of one file (a symlink, a symlinked workspace) are one document. */
  key: string;
  /** The spelling sent to the server, and the paths a server may name it by (as sent, and canonical). */
  uri: string;
  paths: string[];
  /** The version sent with the latest didOpen or didChange. */
  version: number;
  /** The sequence number of the latest didChange for it; 0 while it is as it was opened. And when that was. */
  changedSeq: number;
  changedAt: number;
  /** The latest list published for this version, and the client sequence number when it arrived. */
  diagnostics?: { list: LspDiagnostic[]; seq: number };
  /** The last full report pulled for it, kept so that an "unchanged" reply to its `resultId` has a list to stand for. */
  pulled?: { list: LspDiagnostic[]; resultId?: string };
  /** Diagnostics queries waiting on this document; it is not evicted meanwhile. */
  waiting: number;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspServerSpec {
  cmd: string;
  args?: string[];
  languageId: string;
  /** Extra variables for this server only; the built-in table never sets it. */
  env?: Record<string, string>;
  /**
   * The server analyses in stages and publishes an empty list before it has finished (rust-analyzer: before the Cargo
   * project is loaded and types are analysed). Diagnostics then wait, within the caller's timeout, until the server's own
   * progress reports (`$/progress`) have ended, instead of returning on the first publish.
   */
  awaitProgress?: boolean;
  /** Timings that differ for this server (see LSP_TIMINGS). */
  timings?: Partial<LspTimings>;
  /** One line: how to install it. Shown when it is not found. */
  installHint?: string;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}

/**
 * Lightweight Language Server Protocol Client (Candidate #44)
 * Communicates with rust-analyzer, typescript-language-server, pyright via JSON-RPC stdio
 */
export class LspClient {
  public serverCmd: string;
  public serverArgs: string[];
  public rootPath: string;
  /** Open documents by identity (real path), least recently queried first. */
  private documents: Map<string, OpenDocument> = new Map();
  /** The same documents by the URI sent to the server. */
  private opened: Map<string, OpenDocument> = new Map();
  /**
   * One counter orders everything the client tells the server about content: it supplies each document version (so a
   * version is never reused, also not by a document closed and opened again) and stamps each list on arrival.
   * `lastChangeSeq` is its value at the latest change of content the server holds: a didChange, or the close of a document
   * whose file is gone. A list that arrived before it was computed without that change.
   */
  private seq = 0;
  private lastChangeSeq = 0;
  /** The latest change no publish can vouch for any more: its document was closed (deleted, or evicted) before the server published for it. */
  private unevidencedSeq = 0;
  /** When the server last published diagnostics for any file, and whether it has ever attached a version. */
  private lastPublishAt = 0;
  private versionedPublishes = false;
  /**
   * Set when the server offers pull diagnostics (`diagnosticProvider`): a diagnostics query is then a
   * `textDocument/diagnostic` request, answered for the content the server holds, and published lists are not consulted.
   * `interFileDependencies` and `workspaceDiagnostics` are recorded as announced; workspace diagnostics are not used.
   */
  public diagnosticProvider: { identifier?: string; interFileDependencies: boolean; workspaceDiagnostics: boolean } | null = null;
  private diagnosticWaiters: Map<string, Array<() => void>> = new Map();
  private child: ChildProcess | null = null;
  private nextId: number = 1;
  private pending: Map<number, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private saveOptions?: { includeText?: boolean };
  private buffer: Buffer = Buffer.alloc(0);
  /** True while the server runs and has answered `initialize`. */
  public initialized: boolean = false;
  private lifecycle: "not_started" | "starting" | "initializing" | "running" | "failed" | "stopped" = "not_started";
  private lifecycleSince = Date.now();
  /** Why the server is not running, once it failed to start or crashed. */
  public failure?: LspFailure;
  /** The last STDERR_RING_BYTES the server wrote to stderr. */
  private stderrRing: Buffer = Buffer.alloc(0);
  /** Resolves when the process has exited and its stderr has been collected. */
  private gone: Promise<void> = Promise.resolve();
  /** When `initialize` was answered, and when the analysis now in flight began (the start, or the first progress after a quiet spell). */
  private initializedAt = 0;
  private busySince = 0;
  /** A server that reports no progress has shown that it has loaded the project: it published for an open document or answered a query. */
  private answered = false;
  /** Tokens of the server's work-done progress that has begun and not ended (with the sequence number at their begin), and when progress last changed. */
  private progressActive: Map<string, number> = new Map();
  /** The highest sequence number at which a progress cycle that has since ended began: the server finished work it started after every change up to it. */
  private progressSettledSeq = 0;
  /** Progress cycles that have ended. Nothing resets it or `lastProgressAt`: a query compares them with its own document's change, so syncing another document cannot take a waiting query's evidence away. */
  private progressEnded = 0;
  private lastProgressAt = 0;

  constructor(
    serverCmd: string,
    rootPath: string,
    serverArgs: string[] = [],
    private extraEnv: Record<string, string> = {},
    private awaitProgress: boolean = false,
    private t: LspTimings = LSP_TIMINGS,
    private installHint?: string,
  ) {
    this.serverCmd = serverCmd;
    this.serverArgs = serverArgs;
    this.rootPath = path.resolve(rootPath);
  }

  private setLifecycle(next: LspClient["lifecycle"]): void {
    this.lifecycle = next;
    this.lifecycleSince = Date.now();
    this.initialized = next === "running";
  }

  /** Records why the server is not running (the first reason stands; a deliberate stop is not a failure) and returns it as an error. */
  private fail(kind: LspFailure["kind"], message: string, extra: Partial<LspFailure> = {}): Error {
    if (this.lifecycle !== "stopped" && this.lifecycle !== "failed") {
      this.failure = { kind, message, at: Date.now(), ...extra };
      this.setLifecycle("failed");
    }
    return new Error(this.failure?.message ?? message);
  }

  /** The end of what the server wrote to stderr, as one line: secrets redacted, control characters and escapes removed, fence markers defused, capped. */
  private stderrTail(): string | undefined {
    const tail = sanitizeDiagnosticMessage(redactPlain(this.stderrRing.toString("utf-8")).slice(-STDERR_TAIL_CHARS));
    return tail === "" ? undefined : tail;
  }

  /**
   * Whether a running server has finished analysing, on the evidence there is, and when it will have if nothing more
   * happens (null: not before the server says more).
   */
  private readiness(now: number): { ready: boolean; detail: string; at: number | null } {
    if (this.progressActive.size > 0) return { ready: false, detail: "work-done progress in flight", at: null };
    if (this.progressEnded > 0) {
      const at = this.lastProgressAt + this.t.quietMs;
      return now >= at ? { ready: true, detail: "its progress has ended", at } : { ready: false, detail: "its progress has just ended", at };
    }
    if (this.awaitProgress) return { ready: false, detail: "it has reported no progress yet", at: null };
    if (this.answered) return { ready: true, detail: "it has answered", at: this.initializedAt };
    const at = this.initializedAt + this.t.coldStartMs;
    return now >= at ? { ready: true, detail: "it reports no progress and its warm-up period is over", at } : { ready: false, detail: "it reports no progress and started a moment ago", at };
  }

  /** The server's state now. For `nexus doctor`, telemetry, and every result that is not an answer. */
  public status(now: number = Date.now()): LspServerStatus {
    if (this.lifecycle !== "running") {
      return { server: this.serverCmd, state: this.lifecycle, forMs: now - (this.failure?.at ?? this.lifecycleSince), ...(this.failure ? { detail: this.failure.message, cause: this.failure } : {}) };
    }
    const r = this.readiness(now);
    return { server: this.serverCmd, state: r.ready ? "ready" : "indexing", forMs: now - (r.ready ? Math.max(r.at ?? 0, this.initializedAt) : this.busySince), detail: r.detail };
  }

  /**
   * When a call that begins at `now` gives up: after the warm timeout; for a server that is not ready, not before its
   * cold-start allowance (counted from its start, so a later call gets what is left of it, not a new one); for a staged
   * server's edited document, not before the post-edit settle can end.
   */
  private deadline(now: number, doc?: OpenDocument): number {
    const cold = this.readiness(now).ready ? 0 : this.initializedAt + this.t.coldStartMs;
    const edit = doc && this.awaitProgress && doc.changedSeq > 0 ? doc.changedAt + this.t.editSettleMs + this.t.quietMs : 0;
    return Math.max(now + this.t.queryMs, cold, edit);
  }

  /**
   * Starts the server and waits for its answer to `initialize`. Rejects, with `failure` set, when the command is not
   * there, the process cannot be executed, it exits first, or it does not answer in time (it is then killed).
   */
  public async start(): Promise<void> {
    this.setLifecycle("starting");
    const env = { ...buildLspEnvironment(this.rootPath), ...this.extraEnv };
    // Looked up where the server's own environment would find it, before anything is spawned.
    const where = /[\\/]/.test(this.serverCmd) ? "" : " on PATH";
    const notInstalled = `Language server not installed: ${this.serverCmd} was not found${where}.${this.installHint ? ` Install it with: ${this.installHint}` : ""}`;
    if (findCommand(this.serverCmd, env.PATH ?? "", this.rootPath) === null) throw this.fail("not_installed", notInstalled);
    let child: ChildProcess;
    try {
      child = spawn(this.serverCmd, this.serverArgs, { cwd: this.rootPath, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: any) {
      throw this.fail("spawn_failed", `Language server '${this.serverCmd}' failed to start: it could not be executed (${err.code ?? err.message}).`);
    }
    this.child = child;
    try {
      child.stderr?.on("data", (chunk: Buffer) => {
        this.stderrRing = (chunk.length >= STDERR_RING_BYTES ? chunk : Buffer.concat([this.stderrRing, chunk])).subarray(-STDERR_RING_BYTES);
      });

      // The process could not be executed (found, but its interpreter or a library is missing): no exit follows and
      // nothing will answer, so whoever waits is told now.
      child.on("error", (err: any) => {
        const how = this.lifecycle === "running" ? "stopped working" : "failed to start: it could not be executed";
        const failure =
          err.code === "ENOENT" && process.platform === "win32" // not looked up beforehand there (findCommand)
            ? this.fail("not_installed", notInstalled)
            : this.fail(this.lifecycle === "running" ? "crashed" : "spawn_failed", `Language server '${this.serverCmd}' ${how} (${err.code ?? err.message}).`);
        this.failInFlight(failure);
      });
      child.on("spawn", () => {
        if (this.lifecycle === "starting") this.setLifecycle("initializing");
      });

      this.gone = new Promise<void>((resolve) => {
        child.on("exit", (code, signal) => {
          const how = signal ? `killed by ${signal}` : `exit code ${code}`;
          const message = this.lifecycle === "running" ? `Language server '${this.serverCmd}' crashed (${how}).` : `Language server '${this.serverCmd}' failed to start: ${how}.`;
          this.fail(this.lifecycle === "running" ? "crashed" : "exited", message, { exitCode: code, signal });
          this.initialized = false;
          // Its last words are still in the pipe: wait for the streams to close, but not for long.
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (this.failure) this.failure.stderrTail = this.stderrTail();
            this.failInFlight(new Error(this.failure?.message ?? `LSP server '${this.serverCmd}' exited`));
            resolve();
          };
          const timer = setTimeout(finish, STDERR_DRAIN_MS);
          child.once("close", finish);
        });
      });
      child.stdin?.on("error", () => {
        this.initialized = false;
      });

      child.stdout?.on("data", (data: Buffer) => {
        this.handleData(data);
      });

      const rootUri = pathToFileURL(this.rootPath).href;

      // 1. Initialize
      const initRes = await this.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: true },
            // Ask servers to attach document versions so delayed results for pre-edit content can be rejected.
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
            synchronization: { didSave: true },
            // Pull diagnostics, except from a staged server: its lists come from several analyses and arrive by publish;
            // a pull would return one of them.
            ...(this.awaitProgress ? {} : { diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false } }),
          },
          ...(this.awaitProgress ? {} : { workspace: { diagnostics: { refreshSupport: true } } }),
          // Declared so that servers which report progress (rust-analyzer) send $/progress, which diagnostics wait on.
          window: { workDoneProgress: true },
        },
      }, this.t.startMs);

      if (!initRes) throw new Error("it answered initialize with no result");
      const sync = initRes.capabilities?.textDocumentSync;
      if (typeof sync === "object" && sync?.save) {
        this.saveOptions = typeof sync.save === "object" ? sync.save : {};
      }
      const provider = initRes.capabilities?.diagnosticProvider;
      if (!this.awaitProgress && provider && typeof provider === "object") {
        this.diagnosticProvider = {
          ...(typeof provider.identifier === "string" ? { identifier: provider.identifier } : {}),
          interFileDependencies: provider.interFileDependencies === true,
          workspaceDiagnostics: provider.workspaceDiagnostics === true,
        };
      }

      // 2. Initialized notification
      this.sendNotification("initialized", {});
      this.initializedAt = this.busySince = Date.now();
      this.setLifecycle("running");
    } catch (err: any) {
      const failure = timedOut(err)
        ? this.fail("initialize_timeout", `Language server '${this.serverCmd}' did not answer initialize within ${seconds(this.t.startMs)}; it was killed.`)
        : this.fail("spawn_failed", `Language server '${this.serverCmd}' failed to start: ${err.message}.`);
      this.initialized = false;
      try {
        child.kill("SIGKILL");
      } catch {}
      if (timedOut(err)) {
        // What a server that hung wrote to stderr belongs in the report: wait for the kill to land.
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.gone, new Promise<void>((r) => (timer = setTimeout(r, 2 * STDERR_DRAIN_MS)))]);
        clearTimeout(timer);
      }
      throw failure;
    }
  }

  /** Rejects every request still waiting and wakes every diagnostics waiter: the server is gone, so no answer is coming. */
  private failInFlight(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    const waiters = [...this.diagnosticWaiters.values()].flat();
    this.diagnosticWaiters.clear();
    for (const w of waiters) w();
  }

  /** A server that sends more than the cap in one message, or buffers past it, is dropped rather than trusted with memory. */
  private dropOversized(): void {
    this.buffer = Buffer.alloc(0);
    this.failInFlight(this.fail("crashed", `Language server '${this.serverCmd}' exceeded the ${LSP_MAX_BUFFER_BYTES}-byte message limit; it was killed.`));
    this.initialized = false;
    try {
      this.child?.kill("SIGKILL");
    } catch {}
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString("latin1");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      if (contentLength > LSP_MAX_BUFFER_BYTES) return this.dropOversized();
      const bodyStart = headerEnd + 4;

      if (this.buffer.length < bodyStart + contentLength) {
        // Incomplete body, wait for next chunk
        break;
      }

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        if (typeof msg.method === "string" && msg.id !== undefined) {
          // A request FROM the server (it has a method; its id space is its own, so it can collide with ours): answer it, or
          // a server that waits for the reply (window/workDoneProgress/create, workspace/configuration) can stall.
          this.answerServerRequest(msg);
          continue;
        }
        if (msg.method === "$/progress" && msg.params) {
          const token = String(msg.params.token);
          const kind = msg.params.value?.kind;
          if (kind === "begin") {
            // Work that begins after a quiet spell is a new analysis; phases that follow one another are one.
            if (this.progressActive.size === 0 && this.progressEnded > 0 && Date.now() - this.lastProgressAt >= this.t.quietMs) this.busySince = Date.now();
            this.progressActive.set(token, this.seq);
          } else if (kind === "end") {
            this.progressSettledSeq = Math.max(this.progressSettledSeq, this.progressActive.get(token) ?? 0);
            if (this.progressActive.delete(token)) this.progressEnded++;
          }
          this.lastProgressAt = Date.now();
          this.wake(ANY_DOCUMENT);
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { code: msg.error.code, data: msg.error.data }));
          } else {
            resolve(msg.result);
          }
        } else if (msg.method === "textDocument/publishDiagnostics") {
          const params = msg.params;
          if (params && params.uri && Array.isArray(params.diagnostics)) {
            this.lastPublishAt = Date.now();
            this.wake(ANY_DOCUMENT);
            // A list is an answer only for a document the server holds from this client: one published for a file before
            // its first open, or after its close, describes content the client never sent and is not kept.
            const current = this.documentForUri(params.uri);
            if (!current) continue;
            if (typeof params.version === "number") {
              this.versionedPublishes = true;
              if (params.version !== current.version) continue; // published for an older version of the file than the server was last told about
            } else if (this.versionedPublishes) {
              // A server that attaches versions does so for every open document: once it has, a list without one is not
              // about a document as this client sent it (a "cleared" list after a close, arriving after the reopen).
              continue;
            }
            current.diagnostics = { list: toDiagnostics(params.diagnostics), seq: this.seq };
            if (!this.awaitProgress) this.answered = true;
            this.wake(current.key);
          }
        }
      } catch {}
    }
    if (this.buffer.length > LSP_MAX_BUFFER_BYTES + 1024) this.dropOversized();
  }

  /**
   * One request. It ends with the answer, at the timeout, when `signal` fires, or when the server is gone. A request
   * given up on (timeout, cancellation) is withdrawn with `$/cancelRequest`, so the server stops working on it.
   */
  public async sendRequest(method: string, params: any, timeoutMs: number = 8000, signal?: AbortSignal): Promise<any> {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) {
      throw new Error(`LSP server '${this.serverCmd}' is not running`);
    }
    const cancelledError = () => Object.assign(new Error(`LSP request '${method}' was cancelled`), { code: "LSP_CANCELLED" });
    if (signal?.aborted) throw cancelledError();

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const abandon = (err: Error) => {
        if (!this.pending.delete(id)) return;
        settle();
        if (method !== "initialize") this.sendNotification("$/cancelRequest", { id });
        reject(err);
      };
      const timer = setTimeout(() => abandon(Object.assign(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`), { code: "LSP_TIMEOUT" })), timeoutMs);
      const onAbort = () => abandon(cancelledError());
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: (val) => {
          settle();
          resolve(val);
        },
        reject: (err) => {
          settle();
          reject(err);
        },
      });

      this.child!.stdin!.write(header + payload);
    });
  }

  private answerServerRequest(msg: { id: number | string; method: string; params?: any }): void {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) return;
    // The server's results changed for a reason the client did not cause: no kept report may stand in for a new one.
    if (msg.method === "workspace/diagnostic/refresh") for (const doc of this.documents.values()) doc.pulled = undefined;
    // Nothing is configured or registered on the server's behalf: an empty answer is a valid one for the requests servers send.
    const result = msg.method === "workspace/configuration" && Array.isArray(msg.params?.items) ? msg.params.items.map(() => null) : null;
    const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n${payload}`);
  }

  public sendNotification(method: string, params: any): void {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;
    this.child.stdin.write(header + payload);
  }

  /**
   * The open document a server means by `uri`. Servers do not echo the client's spelling: they may publish under the real
   * path where the client sent a symlinked one, and percent-encode differently, so a URI that is not the one sent is
   * decoded to a path and compared with the two paths each document goes by. No file-system access.
   */
  private documentForUri(uri: unknown): OpenDocument | undefined {
    if (typeof uri !== "string") return undefined;
    const exact = this.opened.get(uri);
    if (exact) return exact;
    let named: string;
    try {
      named = comparablePath(fileURLToPath(uri));
    } catch {
      return undefined; // not a file URI
    }
    for (const doc of this.documents.values()) if (doc.paths.includes(named)) return doc;
    return undefined;
  }

  private wake(key: string): void {
    const waiters = this.diagnosticWaiters.get(key);
    if (!waiters) return;
    this.diagnosticWaiters.delete(key);
    for (const w of waiters) w();
  }

  private change(doc: OpenDocument, state: FileState): void {
    Object.assign(doc, state);
    doc.version = doc.changedSeq = this.lastChangeSeq = ++this.seq;
    doc.diagnostics = undefined;
    // Progress that ended before this change does not vouch for the new version: `analysedAt` compares the cycles
    // with this document's `changedSeq`. The server's progress record itself is left alone (other queries count on it).
    doc.changedAt = Date.now();
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: doc.text }],
    });
    if (this.saveOptions) {
      this.sendNotification("textDocument/didSave", {
        textDocument: { uri: doc.uri },
        ...(this.saveOptions.includeText ? { text: doc.text } : {}),
      });
    }
  }

  /** `gone`: the file is no longer there for the server to read, which changes what other files' answers are computed from. */
  private close(doc: OpenDocument, gone: boolean): void {
    this.documents.delete(doc.key);
    this.opened.delete(doc.uri);
    if (gone) this.unevidencedSeq = this.lastChangeSeq = ++this.seq;
    else if (!doc.diagnostics) this.unevidencedSeq = Math.max(this.unevidencedSeq, doc.changedSeq);
    this.sendNotification("textDocument/didClose", { textDocument: { uri: doc.uri } });
    this.wake(doc.key);
    this.wake(ANY_DOCUMENT);
  }

  /**
   * Makes every open document match the disk: a file whose content moved gets a full-text didChange (and didSave where
   * the server asked for it); one that is gone, is no longer a regular file, or no longer resolves to itself inside the
   * workspace (renamed, or replaced by a symlink) is closed without being read.
   * Per document: one realpath and one stat; the content is read only when the stamp moved or cannot be trusted yet.
   */
  private resync(realRoot: string | null): void {
    for (const doc of [...this.documents.values()]) {
      let state: FileState | null = null;
      if (realRoot !== null && realOrNull(doc.key) === doc.key && !outsideRoot(realRoot, doc.key)) {
        try {
          const st = fs.statSync(doc.key, { bigint: true });
          if (doc.settled && stampOf(st, 0).stamp === doc.stamp) continue;
          if (st.isFile()) state = readRegularFile(doc.key);
        } catch {}
      }
      if (!state) this.close(doc, true);
      else if (state.text !== doc.text) this.change(doc, state);
      else Object.assign(doc, state);
    }
  }

  /**
   * The one way a query reaches a file: brings every open document up to date with the disk, then opens `filePath` if
   * the server does not hold it yet and closes the least recently queried documents beyond the bound.
   * Throws when the file cannot be read or lies outside the workspace.
   */
  private open(filePath: string, languageId: string): OpenDocument {
    // Resolve symlinks before the containment check: a link inside the workspace must not read a file outside it.
    const realRoot = realOrNull(this.rootPath);
    this.resync(realRoot);
    const key = realRoot === null ? null : realOrNull(path.resolve(this.rootPath, filePath));
    if (realRoot === null || key === null || outsideRoot(realRoot, key)) throw unreadable(filePath);
    let doc = this.documents.get(key);
    if (doc) {
      this.documents.delete(key);
    } else {
      const state = readRegularFile(key);
      if (!state) throw unreadable(filePath);
      // Named as the workspace was given to the server (its rootUri), so a server that relates documents to the root by
      // prefix finds them inside it; below the root the real path, so one file has one name.
      const sent = path.join(this.rootPath, path.relative(realRoot, key));
      doc = { ...state, key, uri: pathToFileURL(sent).href, paths: [comparablePath(sent), comparablePath(key)], version: ++this.seq, changedSeq: 0, changedAt: 0, waiting: 0 };
      this.opened.set(doc.uri, doc);
      this.sendNotification("textDocument/didOpen", { textDocument: { uri: doc.uri, languageId, version: doc.version, text: doc.text } });
    }
    this.documents.set(key, doc);
    for (const old of this.documents.values()) {
      if (this.documents.size <= MAX_OPEN_DOCUMENTS) break;
      // What the server held was just checked against the disk, so closing it changes nothing the server computes from.
      if (old !== doc && old.waiting === 0) this.close(old, false);
    }
    return doc;
  }

  /**
   * Push-only servers: when a list that arrived at `listSeq`, before a later change to another document, may be taken as
   * still current, or null while nothing shows that the server has dealt with that change. Silence is not evidence:
   *  - a staged server: a progress cycle that began after the latest change has ended, nothing is in progress, and
   *    progress has been quiet for the quiet period;
   *  - any other server: it has published for every document changed since the list arrived (that publish shows it
   *    analysed the change), and has published nothing for PUBLISH_QUIET_MS.
   * Known limit: a server that publishes for the changed document, stays silent for longer than the window, and only
   * then publishes a different list for this document has its old list returned as current once. A server that offers
   * pull diagnostics is asked instead and has no such window.
   */
  private settledAt(listSeq: number): number | null {
    if (this.awaitProgress) {
      return this.progressSettledSeq >= this.lastChangeSeq && this.progressActive.size === 0 ? this.lastProgressAt + this.t.quietMs : null;
    }
    if (this.unevidencedSeq > listSeq) return null;
    for (const doc of this.documents.values()) if (doc.changedSeq > listSeq && !doc.diagnostics) return null;
    return this.lastPublishAt + PUBLISH_QUIET_MS;
  }

  /**
   * Staged servers: when the list held for `doc` is final, or null while the server has shown nothing that says so.
   * Such a server publishes an empty list before it has analysed anything, so a list alone is never the evidence:
   *  - a progress cycle has ended, nothing is in progress, and progress has been quiet for the quiet period; and
   *  - for a document that changed: one such cycle began after the change, or (a server that checks nothing on save)
   *    the post-edit settle has passed since the change.
   */
  private analysedAt(doc: OpenDocument): number | null {
    if (this.progressActive.size > 0 || this.progressEnded === 0) return null;
    const quietAt = this.lastProgressAt + this.t.quietMs;
    if (doc.changedSeq === 0 || this.progressSettledSeq >= doc.changedSeq) return quietAt;
    return Math.max(quietAt, doc.changedAt + this.t.editSettleMs);
  }

  /**
   * The diagnostics for the file as it is on disk now, or why there are none to report.
   * From a server that offers pull diagnostics: its reply to a request made after the sync.
   * Otherwise from what it published: a list counts when it arrived after the latest change the client had sent when
   * this call began (and, where the server attaches versions, for this document's version), or when it is older than a
   * change to another document and `settledAt` says the server has dealt with that change. From a staged server such a
   * list counts only once `analysedAt` says it is final: when the time runs out first the answer is "unavailable, still
   * analysing", never the list so far. `timeoutMs`: the caller's own limit; without one the call ends at `deadline`.
   * Throws for an unreadable file.
   */
  public async waitForDiagnostics(filePath: string, languageId: string, timeoutMs?: number, signal?: AbortSignal): Promise<DiagnosticsAnswer> {
    const doc = this.open(filePath, languageId);
    const startedAt = Date.now();
    const limit = timeoutMs ?? this.deadline(startedAt, doc) - startedAt;
    if (this.diagnosticProvider) return this.pullDiagnostics(doc, filePath, limit, this.diagnosticProvider.identifier, signal);
    const key = doc.key;
    const since = this.lastChangeSeq;
    const held = () => this.documents.get(key)?.diagnostics;
    const current = (): LspDiagnostic[] | null => {
      const d = held();
      return d && d.seq >= since ? d.list : null;
    };
    const stands = (now: number): LspDiagnostic[] | null => {
      const d = held();
      const at = d ? this.settledAt(d.seq) : null;
      return d && at !== null && now >= at ? d.list : null;
    };
    /** A current list from a staged server is the answer only once the server has finished. */
    const final = (now: number): boolean => {
      if (!this.awaitProgress) return true;
      const at = this.analysedAt(doc);
      return at !== null && now >= at;
    };
    doc.waiting++;
    try {
      for (let now = startedAt; now - startedAt < limit && !signal?.aborted; now = Date.now()) {
        const left = limit - (now - startedAt);
        let at: number | null;
        if (current()) {
          if (final(now)) break;
          at = this.analysedAt(doc);
        } else {
          if (stands(now)) break;
          // No list: wait for one. A list from before another document's change: wait for the server to publish or end
          // progress, or for the moment its quiet period is over.
          const d = held();
          at = d ? this.settledAt(d.seq) : null;
          if (!d) {
            await this.nextPublish(key, left, signal);
            if (!this.documents.has(key) || !this.initialized) break; // closed, or the server is gone
            continue;
          }
        }
        // Woken by any publish and any progress report; otherwise at the moment the quiet period is over.
        await this.nextPublish(ANY_DOCUMENT, at === null ? left : Math.min(left, Math.max(1, at - now)), signal);
        if (!this.documents.has(key) || !this.initialized) break;
      }
      const now = Date.now();
      const status = this.status(now);
      const unavailable = (reason: string): DiagnosticsAnswer => ({ status: "unavailable", reason, ...(status.state === "ready" ? {} : noAnswer(reason, status)) });
      if (signal?.aborted) return { status: "unavailable", reason: `The diagnostics query for ${filePath} was cancelled.` };
      const list = current();
      if (list && final(now)) return { status: "ok", diagnostics: list };
      const stood = list ? null : stands(now);
      if (stood) return { status: "ok", diagnostics: stood };
      if (this.lifecycle !== "running") return unavailable(`${this.failure?.message ?? `Language server '${this.serverCmd}' was stopped.`} No diagnostics for ${filePath}.`);
      const busy = `after ${seconds(status.forMs)} (${status.detail})`;
      if (list) return unavailable(`Language server '${this.serverCmd}' is still analysing ${busy}; what it has published for ${filePath} so far is not final. Ask again shortly.`);
      const what = held() ? `for ${filePath} after another open file changed,` : `for ${filePath}`;
      const indexing = status.state === "indexing" ? ` It is still indexing ${busy}; ask again shortly.` : "";
      return unavailable(`Language server '${this.serverCmd}' published no diagnostics ${what} within ${limit}ms.${indexing}`);
    } finally {
      doc.waiting--;
    }
  }

  /**
   * One `textDocument/diagnostic` exchange. A full report is the answer and is kept with its `resultId`; "unchanged" is
   * an answer only for the kept list that `resultId` was sent for. Reports for related documents are not used. Asked
   * again when the server cancels with `retriggerRequest`, a bounded number of times within the timeout.
   */
  private async pullDiagnostics(doc: OpenDocument, filePath: string, timeoutMs: number, identifier?: string, signal?: AbortSignal): Promise<DiagnosticsAnswer> {
    const deadline = Date.now() + timeoutMs;
    const unavailable = (why: string): DiagnosticsAnswer => ({ status: "unavailable", reason: `Language server '${this.serverCmd}' gave no diagnostics for ${filePath}: ${why}` });
    for (let attempt = 0; ; attempt++) {
      const previousResultId = doc.pulled?.resultId;
      let report: any;
      try {
        report = await this.sendRequest(
          "textDocument/diagnostic",
          { textDocument: { uri: doc.uri }, ...(identifier !== undefined ? { identifier } : {}), ...(previousResultId !== undefined ? { previousResultId } : {}) },
          Math.max(1, deadline - Date.now()),
          signal,
        );
      } catch (err: any) {
        if (err.code === SERVER_CANCELLED && err.data?.retriggerRequest === true && attempt < PULL_RETRIGGER_LIMIT && Date.now() < deadline) continue;
        return unavailable(`${err.message}.`);
      }
      if (report?.kind === "full" && Array.isArray(report.items)) {
        doc.pulled = { list: toDiagnostics(report.items), ...(typeof report.resultId === "string" ? { resultId: report.resultId } : {}) };
        this.answered = true;
        return { status: "ok", diagnostics: doc.pulled.list };
      }
      if (report?.kind === "unchanged" && previousResultId !== undefined) {
        if (doc.pulled) {
          if (typeof report.resultId === "string") doc.pulled.resultId = report.resultId;
          return { status: "ok", diagnostics: doc.pulled.list };
        }
        // The kept list was dropped while the request was out (workspace/diagnostic/refresh): ask for a full report.
        if (attempt < PULL_RETRIGGER_LIMIT && Date.now() < deadline) continue;
      }
      return unavailable("its report was neither a full list nor 'unchanged' for a list this client holds.");
    }
  }

  /** Resolves when a list is accepted for the document, when it is closed, when the server is gone, at the timeout, or when `signal` fires. */
  private nextPublish(key: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", giveUp);
        resolve();
      };
      const giveUp = () => {
        const list = this.diagnosticWaiters.get(key)?.filter((w) => w !== leave) ?? [];
        if (list.length) this.diagnosticWaiters.set(key, list);
        else this.diagnosticWaiters.delete(key);
        leave();
      };
      const timer = setTimeout(giveUp, timeoutMs);
      this.diagnosticWaiters.set(key, [...(this.diagnosticWaiters.get(key) ?? []), leave]);
      if (signal?.aborted) giveUp();
      else signal?.addEventListener("abort", giveUp, { once: true });
    });
  }

  public pid(): number | undefined {
    return this.child?.pid;
  }

  /** Opens the file (if it is readable) so that the server starts on its project; false when it cannot be given to the server. */
  public prepare(filePath: string, languageId: string): boolean {
    try {
      this.open(filePath, languageId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One request about a position, with the readiness rule: an answer with content is the answer; an empty one is "there
   * is nothing here" only from a server that is ready. While it is not, the request is made again when its progress
   * moves, or after a pause that doubles (a server that reports none), until the call's deadline; `notReady` then says
   * what state the server was left in. A request that fails on a ready server, or for another reason than a timeout, throws.
   */
  private async ask(method: string, filePath: string, languageId: string, line: number, character: number, empty: (result: any) => boolean, signal?: AbortSignal): Promise<{ result: any; notReady: LspServerStatus | null }> {
    const doc = this.open(filePath, languageId);
    const params = { textDocument: { uri: doc.uri }, position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) } };
    const deadline = this.deadline(Date.now());
    for (let pause = this.t.retryMs; ; pause = Math.min(pause * 2, READINESS_RETRY_CAP_MS)) {
      let result: any = null;
      let failed: unknown;
      try {
        result = await this.sendRequest(method, params, this.t.queryMs, signal);
      } catch (err) {
        failed = err;
      }
      if (failed === undefined && !empty(result)) {
        if (!this.awaitProgress) this.answered = true;
        return { result, notReady: null };
      }
      const now = Date.now();
      const ready = this.lifecycle === "running" && this.readiness(now).ready;
      if (failed !== undefined && (ready || !timedOut(failed))) throw failed;
      if (ready) return { result, notReady: null };
      if (now >= deadline) return { result: null, notReady: this.status(now) };
      await this.nextPublish(ANY_DOCUMENT, Math.min(deadline - now, pause), signal);
      if (!this.documents.has(doc.key)) throw unreadable(filePath);
    }
  }

  /** `text` null with `notReady` null: the server answered and has nothing at this position. */
  public async getHover(filePath: string, languageId: string, line: number, character: number, signal?: AbortSignal): Promise<{ text: string | null; notReady: LspServerStatus | null }> {
    const text = (res: any): string | null => {
      if (!res || !res.contents) return null;
      if (typeof res.contents === "string") return res.contents;
      if (res.contents.value) return res.contents.value;
      if (Array.isArray(res.contents)) {
        return res.contents.map((c: any) => (typeof c === "string" ? c : c.value || "")).join("\n\n");
      }
      return JSON.stringify(res.contents);
    };
    const { result, notReady } = await this.ask("textDocument/hover", filePath, languageId, line, character, (res) => !text(res), signal);
    return { text: text(result) || null, notReady };
  }

  /** `locations` null with `notReady` null: the server answered and has nothing to go to from this position. */
  public async getDefinition(filePath: string, languageId: string, line: number, character: number, signal?: AbortSignal): Promise<{ locations: LspLocation[] | null; notReady: LspServerStatus | null }> {
    const locations = (res: any): LspLocation[] | null => {
      if (!res) return null;
      if (Array.isArray(res)) return res;
      if (res.uri && res.range) return [res];
      // A single LocationLink is an answer too: reading it as empty would report "nothing here" for a real definition.
      if (res.targetUri && res.targetRange) return [res];
      return null;
    };
    const { result, notReady } = await this.ask("textDocument/definition", filePath, languageId, line, character, (res) => !locations(res)?.length, signal);
    return { locations: locations(result), notReady };
  }

  public shutdown(): void {
    // A deliberate stop: the exit that follows is not a crash.
    if (this.lifecycle !== "failed") this.setLifecycle("stopped");
    if (this.child) {
      try {
        this.sendRequest("shutdown", {}).catch(() => {});
        this.sendNotification("exit", {});
        this.child.kill("SIGTERM");
      } catch {}
      this.child = null;
    }
    this.initialized = false;
  }
}

/** A failure the manager answers from without starting anything, until `recheckAt` or until PATH changes. */
interface KnownFailure {
  cause: LspFailure;
  /** PATH when it was recorded. */
  path: string;
  recheckAt: number;
}

export interface LspHoverResult {
  found: boolean;
  /** True when the server answered and has nothing at the position: a real answer, with `hoverText` saying so. */
  answered?: boolean;
  hoverText?: string;
  error?: string;
  state?: LspServerStatus;
  detail?: string;
}

export interface LspDefinitionResult {
  found: boolean;
  /** True when the server answered and has nothing to go to: a real answer, with `message` saying so. */
  answered?: boolean;
  locations?: LspLocation[];
  message?: string;
  error?: string;
  state?: LspServerStatus;
  detail?: string;
}

/**
 * Manager to auto-route LSP queries based on file extension
 */
export class LspBridgeManager {
  private static live: Set<LspBridgeManager> = new Set();
  private static exitHookInstalled = false;

  private workspace: string;
  private clients: Map<string, LspClient> = new Map();
  private starting: Map<string, Promise<LspClient | null>> = new Map();
  /** The client of a start in flight, so that its state can be reported. */
  private launching: Map<string, LspClient> = new Map();
  private failures: Map<string, KnownFailure> = new Map();
  /** Crashes per server in this session. */
  private crashes: Map<string, number> = new Map();
  private closed = false;
  private servers: Record<string, LspServerSpec>;
  private gate?: () => string | null;
  private timingOverrides: Partial<LspTimings>;

  /**
   * `gate` returns the reason a server must not start right now (untrusted workspace, sandbox), or null to allow it.
   * `timings` overrides the product's timings (LSP_TIMINGS and each server's own) for every server: for tests.
   */
  constructor(workspace: string, opts: { servers?: Record<string, LspServerSpec>; gate?: () => string | null; timings?: Partial<LspTimings> } = {}) {
    this.workspace = path.resolve(workspace);
    this.gate = opts.gate;
    this.servers = opts.servers ?? {};
    this.timingOverrides = opts.timings ?? {};
    LspBridgeManager.live.add(this);
    if (!LspBridgeManager.exitHookInstalled) {
      LspBridgeManager.exitHookInstalled = true;
      // Backstop: a language server must never outlive the process, even if no owner called shutdownAll.
      process.on("exit", () => {
        for (const m of LspBridgeManager.live) m.shutdownAll();
      });
    }
  }

  /** The gate's refusal, if any. A refusal also stops servers that started while the workspace was still allowed. */
  private refusal(): string | null {
    const reason = this.gate?.() ?? null;
    if (reason) {
      for (const client of this.clients.values()) client.shutdown();
      this.clients.clear();
    }
    return reason;
  }

  public getServerForFile(filePath: string): LspServerSpec | null {
    const ext = path.extname(filePath).toLowerCase();
    if (this.servers[ext]) return this.servers[ext];
    if (ext === ".rs") {
      return { cmd: "rust-analyzer", languageId: "rust", awaitProgress: true, timings: { coldStartMs: RUST_ANALYZER_COLD_START_ALLOWANCE_MS }, installHint: "rustup component add rust-analyzer" };
    }
    if (ext === ".ts" || ext === ".tsx") {
      return { cmd: "typescript-language-server", args: ["--stdio"], languageId: "typescript", installHint: "npm install -g typescript typescript-language-server" };
    }
    if (ext === ".js" || ext === ".jsx") {
      return { cmd: "typescript-language-server", args: ["--stdio"], languageId: "javascript", installHint: "npm install -g typescript typescript-language-server" };
    }
    if (ext === ".py") {
      return { cmd: "pyright-langserver", args: ["--stdio"], languageId: "python", installHint: "npm install -g pyright" };
    }
    if (ext === ".go") {
      return { cmd: "gopls", languageId: "go", installHint: "go install golang.org/x/tools/gopls@latest" };
    }
    return null;
  }

  /** The timings the server for this file runs with: the product's, then the server's own, then this manager's overrides. */
  public timingsFor(filePath: string): LspTimings {
    return { ...LSP_TIMINGS, ...this.getServerForFile(filePath)?.timings, ...this.timingOverrides };
  }

  private static keyOf(info: LspServerSpec): string {
    return `${info.cmd}\0${(info.args ?? []).join("\0")}`;
  }

  private known(info: LspServerSpec, known: KnownFailure): NoAnswer {
    return noAnswer(known.cause.message, { server: info.cmd, state: "failed", forMs: Date.now() - known.cause.at, detail: known.cause.message, cause: known.cause, crashes: this.crashes.get(LspBridgeManager.keyOf(info)) ?? 0 });
  }

  /**
   * The running client for the file's server, started if need be, or why there is none. A start that failed is not
   * tried again on every call (LSP_START_FAILURE_RECHECK_MS, or a changed PATH); a server that crashed is started again,
   * after a pause that doubles, up to LSP_MAX_RESTARTS times.
   */
  private async acquire(filePath: string): Promise<{ client: LspClient; info: LspServerSpec } | NoAnswer> {
    const info = this.getServerForFile(filePath);
    if (!info) return { reason: `No LSP server configured for ${filePath}.` };
    const refused = this.refusal();
    if (refused) return { reason: refused };
    this.closed = false;
    LspBridgeManager.live.add(this);
    const key = LspBridgeManager.keyOf(info);
    const t = this.timingsFor(filePath);
    const pathNow = process.env.PATH ?? "";

    const known = this.failures.get(key);
    if (known) {
      if (known.path === pathNow && Date.now() < known.recheckAt) return this.known(info, known);
      this.failures.delete(key);
      if (known.path !== pathNow) this.crashes.delete(key); // the environment changed (an install, a repair): start over
    }

    const existing = this.clients.get(key);
    if (existing?.initialized) return { client: existing, info };
    const inFlight = this.starting.get(key);
    if (inFlight) {
      const client = await inFlight;
      if (client) return { client, info };
      const failed = this.failures.get(key);
      return failed ? this.known(info, failed) : { reason: `Language server '${info.cmd}' was stopped before it had started.` };
    }

    if (existing) {
      // It ran and is gone.
      this.clients.delete(key);
      const cause = existing.failure;
      if (cause?.kind === "crashed") {
        const count = (this.crashes.get(key) ?? 0) + 1;
        this.crashes.set(key, count);
        const how = cause.signal ? `killed by ${cause.signal}` : typeof cause.exitCode === "number" ? `exit code ${cause.exitCode}` : "it stopped working";
        let failure: KnownFailure | undefined;
        if (count > t.maxRestarts) {
          failure = { cause: { ...cause, kind: "crash_loop", message: `Language server '${info.cmd}' crashed ${count} times (last: ${how}); not restarting until PATH changes or Nexus is restarted.` }, path: pathNow, recheckAt: Infinity };
        } else {
          const restartAt = cause.at + t.restartBackoffMs * 2 ** (count - 1);
          if (Date.now() < restartAt) failure = { cause: { ...cause, message: `Language server '${info.cmd}' crashed (${how}); it is restarted by the next query after ${seconds(restartAt - cause.at)}.` }, path: pathNow, recheckAt: restartAt };
        }
        if (failure) {
          this.failures.set(key, failure);
          return this.known(info, failure);
        }
      }
    }

    const client = new LspClient(info.cmd, this.workspace, info.args ?? [], info.env, info.awaitProgress === true, t, info.installHint);
    this.launching.set(key, client);
    const startup = client
      .start()
      .then(
        () => {
          if (this.closed) {
            client.shutdown();
            return null;
          }
          this.clients.set(key, client);
          return client;
        },
        () => {
          client.shutdown();
          if (client.failure) this.failures.set(key, { cause: client.failure, path: pathNow, recheckAt: Date.now() + t.startRecheckMs });
          return null;
        },
      )
      .finally(() => {
        this.starting.delete(key);
        this.launching.delete(key);
      });
    this.starting.set(key, startup);
    const started = await startup;
    if (started) return { client: started, info };
    const failed = this.failures.get(key);
    return failed ? this.known(info, failed) : { reason: `Language server '${info.cmd}' was stopped before it had started.` };
  }

  public async getClientForFile(filePath: string): Promise<LspClient | null> {
    const got = await this.acquire(filePath);
    return "client" in got ? got.client : null;
  }

  /**
   * The state of the file's server, without starting or stopping anything; null when no server is configured for it.
   * A gate's refusal is reported as `not_started` with the refusal as the detail.
   */
  public serverStatus(filePath: string): LspServerStatus | null {
    const info = this.getServerForFile(filePath);
    if (!info) return null;
    const refused = this.gate?.() ?? null;
    if (refused) return { server: info.cmd, state: "not_started", forMs: 0, detail: refused };
    const key = LspBridgeManager.keyOf(info);
    const crashes = this.crashes.get(key) ?? 0;
    const known = this.failures.get(key);
    if (known) return { ...this.known(info, known).state!, crashes };
    const client = this.clients.get(key) ?? this.launching.get(key);
    if (client) return { ...client.status(), crashes };
    return { server: info.cmd, state: this.closed ? "stopped" : "not_started", forMs: 0, crashes };
  }

  /**
   * Starts the file's server, if the gate allows one, and opens that one file so the server loads its project
   * (typescript-language-server and pyright load a project only for an open document); nothing is asked. It returns
   * once the server has answered `initialize` (or failed to), with its state: indexing goes on after that, so a first
   * query made later finds a server that is ready, or says how long it has been indexing.
   */
  public async warmUp(filePath: string): Promise<LspServerStatus | null> {
    const got = await this.acquire(filePath);
    if ("client" in got) got.client.prepare(filePath, got.info.languageId);
    return this.serverStatus(filePath);
  }

  /**
   * Diagnostics for one file. "ok" means the server finished analysing this file's current content (an empty list is
   * then a real "no errors"); "unavailable" means no answer, which callers must not read as a clean file.
   * `timeoutMs`: the caller's own limit; without one the server's timings decide (LSP_TIMINGS).
   */
  public async diagnostics(filePath: string, timeoutMs?: number, signal?: AbortSignal): Promise<DiagnosticsAnswer> {
    const got = await this.acquire(filePath);
    if (!("client" in got)) return { status: "unavailable", ...got };
    try {
      return await got.client.waitForDiagnostics(filePath, got.info.languageId, timeoutMs, signal);
    } catch (err: any) {
      return { status: "unavailable", reason: err.message };
    }
  }

  public serverPids(): number[] {
    return [...this.clients.values()].map((c) => c.pid()).filter((p): p is number => typeof p === "number");
  }

  private static notReady(what: string, state: LspServerStatus): NoAnswer {
    return noAnswer(`Language server '${state.server}' is still indexing after ${seconds(state.forMs)} (${state.detail}) and has ${what} yet; this does not mean there is none. Ask again shortly.`, state);
  }

  public async hover(filePath: string, line: number, character: number, signal?: AbortSignal): Promise<LspHoverResult> {
    const got = await this.acquire(filePath);
    if (!("client" in got)) {
      const { reason, ...rest } = got;
      return { found: false, error: reason, ...rest };
    }
    try {
      const { text, notReady } = await got.client.getHover(filePath, got.info.languageId, line, character, signal);
      if (text) return { found: true, hoverText: text };
      if (!notReady) return { found: false, answered: true, hoverText: `No hover information at ${filePath}:${line}:${character}: the language server answered and has nothing for this position.` };
      const { reason, ...rest } = LspBridgeManager.notReady(`no hover information for ${filePath}:${line}:${character}`, notReady);
      return { found: false, error: reason, ...rest };
    } catch (err: any) {
      return { found: false, error: err.message };
    }
  }

  public async definition(filePath: string, line: number, character: number, signal?: AbortSignal): Promise<LspDefinitionResult> {
    const got = await this.acquire(filePath);
    if (!("client" in got)) {
      const { reason, ...rest } = got;
      return { found: false, error: reason, ...rest };
    }
    try {
      const { locations, notReady } = await got.client.getDefinition(filePath, got.info.languageId, line, character, signal);
      if (locations && locations.length > 0) return { found: true, locations };
      if (!notReady) return { found: false, answered: true, locations: [], message: `No definition found for ${filePath}:${line}:${character}: the language server answered and has nothing to go to from this position.` };
      const { reason, ...rest } = LspBridgeManager.notReady(`no definition for ${filePath}:${line}:${character}`, notReady);
      return { found: false, error: reason, ...rest };
    } catch (err: any) {
      return { found: false, error: err.message };
    }
  }

  public shutdownAll(): void {
    this.closed = true;
    for (const client of this.clients.values()) {
      client.shutdown();
    }
    this.clients.clear();
    LspBridgeManager.live.delete(this);
  }
}
