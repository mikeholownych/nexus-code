import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildMcpEnvironment } from "./mcp.js";
import { MAX_DIAGNOSTIC_MESSAGE, MAX_DIAGNOSTIC_RECORDS, UNTRUSTED_FENCE_END, UNTRUSTED_FENCE_START, fenceUntrusted, sanitizeDiagnosticMessage } from "./diagnostics.js";
import { MAX_SNAPSHOT_BYTES } from "./file_diff.js";
import { redactPlain } from "./protocol.js";
import { MAX_SHARED_RESOURCE_CAPACITY, SharedResourceAdmission, type ResourceSlotLease } from "./core/shared_resource_admission.js";
import { OFFERED_POSITION_ENCODINGS, DEFAULT_POSITION_ENCODING, TextLines, negotiatedEncoding, rangeToModel, toEncoded, type PositionEncoding } from "./lsp_positions.js";
import { findProjectRoot, rootLabel, type RootRule } from "./lsp_roots.js";

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

// ----------------------------------------------------------------------------------------------------------- bounds
// What the client reads, keeps and hands on, each with a named limit. Everything a server sends is untrusted in size too.

/**
 * A file larger than this is not given to a language server: it is refused before it is read, and closed if it grows
 * past this while open. The number is the one Nexus already uses for "too large to show a change line by line"
 * (file_diff.ts MAX_SNAPSHOT_BYTES, 2 MiB; the verification snapshot uses the same): a query here is about a line and a
 * column, and a file the edit path no longer handles by line is outside that. The cost side: this client syncs full
 * text, so every change to an open file sends the whole file again, and the client keeps one copy of each open file.
 */
export const LSP_MAX_FILE_BYTES = MAX_SNAPSHOT_BYTES;
/**
 * One message from a server (its Content-Length). A larger one is not buffered: the server is stopped and reported as
 * failed with that cause. 16 MiB is the limit this client has had since it was written (pinned by lsp_trust.test.ts:
 * a message just under it is accepted); answers to the three queries made here are kilobytes.
 */
export const LSP_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** The header block of one message; the protocol's two headers are under 100 bytes. Bytes that never form a header are not collected past this. */
const LSP_MAX_HEADER_BYTES = 8 * 1024;
/**
 * Diagnostics kept per list: what the tool shows (diagnostics.ts MAX_DIAGNOSTIC_RECORDS), so the output never cuts a
 * second time and the count of what was left out is the client's. When a list is longer the most severe are kept.
 */
export const LSP_MAX_DIAGNOSTICS = MAX_DIAGNOSTIC_RECORDS;
/** Characters kept of one diagnostic's message (the tool shows MAX_DIAGNOSTIC_MESSAGE after cleaning, which can only shorten), and of its source and code. */
const LSP_MAX_DIAGNOSTIC_TEXT = 2 * MAX_DIAGNOSTIC_MESSAGE;
const LSP_MAX_LABEL = 200;
/** A pull report's `resultId` longer than this is not kept: the next request then asks for a full report. */
const LSP_MAX_RESULT_ID = 1024;
/** Definition targets returned by one query; the rest are counted. One is usual, a handful for overloads and merged declarations. A judgement. */
export const LSP_MAX_DEFINITION_TARGETS = 20;
/** Characters of hover text returned (a quarter of the 32,000 a diagnostics block may take); the rest is cut with a note. A judgement. */
export const LSP_MAX_HOVER_CHARS = 8_000;
/** Progress tokens tracked at once, capabilities a server may have registered, and `window/showMessage` / `logMessage` lines kept for `status()`. */
const LSP_MAX_PROGRESS_TOKENS = 256;
const LSP_MAX_REGISTRATIONS = 256;
const LSP_SERVER_MESSAGE_RING = 20;

/**
 * Language servers one manager keeps running: one per server command and project root, so a monorepo's packages each
 * get their own. Starting one more first stops the least recently used one that is not answering a query, and waits
 * for its process to end. 8 is room for the six languages planned (the four here, clangd, jdtls) at one root and two
 * more, or for a few packages in two languages; each is a process that holds a project in memory (hundreds of
 * megabytes for a real one), so the number is what bounds a session's memory, not a count of packages. A judgement.
 */
export const LSP_MAX_SERVERS = 8;
export function parseLspSharedServerLimit(value: string | undefined): number {
  if (value === undefined) return LSP_MAX_SERVERS;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`NEXUS_MAX_LSP_SERVER_PROCESSES must be an integer from 1 to ${MAX_SHARED_RESOURCE_CAPACITY}`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_SHARED_RESOURCE_CAPACITY) {
    throw new Error(`NEXUS_MAX_LSP_SERVER_PROCESSES must be an integer from 1 to ${MAX_SHARED_RESOURCE_CAPACITY}`);
  }
  return limit;
}

/** Limits a test may lower; the product runs with LSP_LIMITS. */
export interface LspLimits {
  fileBytes: number;
  messageBytes: number;
  servers: number;
}
export const LSP_LIMITS: Readonly<LspLimits> = Object.freeze({ fileBytes: LSP_MAX_FILE_BYTES, messageBytes: LSP_MAX_MESSAGE_BYTES, servers: LSP_MAX_SERVERS });

/*
 * WORST-CASE MEMORY one client retains between queries (bytes; a JavaScript string costs up to 2 bytes per character):
 *
 *   MAX_OPEN_DOCUMENTS x ( 2 x fileBytes                                               text of one open document
 *                        + 2 x LSP_MAX_DIAGNOSTICS x 2 x (LSP_MAX_DIAGNOSTIC_TEXT + 2 x LSP_MAX_LABEL)
 *                                                                                      its pushed and its pulled list
 *                        + 2 x LSP_MAX_RESULT_ID )
 *   + messageBytes + LSP_MAX_HEADER_BYTES + one stdout chunk (64 KiB)                  the parse buffer
 *   + STDERR_RING_BYTES
 *   + LSP_MAX_PROGRESS_TOKENS x 2 x LSP_MAX_LABEL + LSP_MAX_REGISTRATIONS x 4 x LSP_MAX_LABEL
 *   + LSP_SERVER_MESSAGE_RING x 2 x (MAX_DIAGNOSTIC_MESSAGE + 60)
 *
 * With the product's values: 32 x (4 MiB + 280 KB + 2 KB) + 16 MiB + ... = about 153 MiB, of which 128 MiB is the text
 * of 32 files that are each at the size limit and not ASCII. Nothing is kept per query: a request and a waiter live
 * as long as the call that made them. Closing a document (eviction, deletion, growth past the limit) drops all of the
 * first term for it: `documents` and `opened` are the only references to an OpenDocument. A manager runs at most
 * LSP_MAX_SERVERS clients. Converting positions keeps nothing: the line table of a text lives as long as one conversion.
 */

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
/**
 * Stopping a server, in order: the `shutdown` request (wait for its reply), the `exit` notification (wait for the
 * process to end), SIGTERM to its process group (wait), SIGKILL to the group (wait for the kernel to report the exit).
 * No measurement of real servers exists for these (docs/LSP_REAL_SERVERS.md records none), so each is a judgement:
 * an orderly server answers `shutdown` and exits within milliseconds; the first two together give a server that
 * writes an index on the way out (jdtls, rust-analyzer) 3 s to do it; SIGTERM gets as long as the request did. A
 * server that ignores everything is gone 5 s after the call, plus at most the last wait, which only bounds how long an
 * unkillable process is waited for. A server that had not answered `initialize` holds nothing to save and is killed at once.
 */
export const LSP_SHUTDOWN_REPLY_MS = 2_000;
export const LSP_EXIT_GRACE_MS = 1_000;
export const LSP_TERM_GRACE_MS = 2_000;
export const LSP_KILL_GRACE_MS = 1_000;

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
  shutdownReplyMs: number;
  exitGraceMs: number;
  termGraceMs: number;
  killGraceMs: number;
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
  shutdownReplyMs: LSP_SHUTDOWN_REPLY_MS,
  exitGraceMs: LSP_EXIT_GRACE_MS,
  termGraceMs: LSP_TERM_GRACE_MS,
  killGraceMs: LSP_KILL_GRACE_MS,
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
  kind: "not_installed" | "spawn_failed" | "exited" | "initialize_timeout" | "crashed" | "crash_loop" | "message_too_large";
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
  /** The project root the server is (or would be) started for: relative to the workspace, "/"-separated, "." for the workspace itself. */
  root?: string;
  state: LspServerState;
  /** How long it has been in this state. */
  forMs: number;
  detail?: string;
  cause?: LspFailure;
  /** Crashes of this server in this session. */
  crashes?: number;
  /**
   * The server's latest `window/showMessage` and `window/logMessage` lines, oldest first: untrusted text, each cleaned as
   * a diagnostic message is (one line, capped, redacted). For an operator's view; show it to a model only inside the fence.
   */
  serverMessages?: string[];
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
/** JSON-RPC: the answer to a server request this client does not implement, and to one it cannot take. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const APPLY_EDIT_REFUSAL = "This client does not let a language server edit files.";
/** How often one diagnostics query asks again after such a cancellation (within its timeout). */
const PULL_RETRIGGER_LIMIT = 3;
/** Wakes a query waiting for evidence that the server has settled: any publish, the end of a progress cycle, a close. */
const ANY_DOCUMENT = "";

/**
 * `omitted`: how many more the server reported than `diagnostics` holds (LSP_MAX_DIAGNOSTICS; the most severe are kept).
 * `state` and `detail` are present only when the server's state is why there is no answer.
 */
export type DiagnosticsAnswer = { status: "ok"; diagnostics: LspDiagnostic[]; omitted?: number } | { status: "unavailable"; reason: string; state?: LspServerStatus; detail?: string };

const SEVERITIES = ["error", "warning", "information", "hint"] as const;
/**
 * A diagnostic whose severity is missing (the protocol leaves that to the client) or is not 1 to 4 is reported as
 * this, one fixed value. "error" because the reader is an agent deciding whether its edit broke something: a server
 * that omits the severity of a real error must not have it read as a remark. (This client used to say "information".)
 */
export const LSP_DEFAULT_SEVERITY: LspDiagnostic["severity"] = "error";

/** A protocol range with whole, non-negative numbers, or null when it is not one. */
function toRange(range: any): LspRange | null {
  const position = (p: any): LspPosition | null => (Number.isSafeInteger(p?.line) && p.line >= 0 && Number.isSafeInteger(p?.character) && p.character >= 0 ? { line: p.line, character: p.character } : null);
  const start = position(range?.start);
  const end = position(range?.end);
  return start && end ? { start, end } : null;
}

const NO_RANGE: LspRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/** One list as it is kept: at most LSP_MAX_DIAGNOSTICS entries, each field bounded, and the count of what was left out. */
interface DiagnosticList {
  list: LspDiagnostic[];
  omitted: number;
}

/** `toModel`: a range as the server counts it, to the model's unit (`LspClient.incoming`). */
function toDiagnostics(items: any[], toModel: (range: LspRange) => LspRange): DiagnosticList {
  const rank = (d: any): number => (d?.severity >= 1 && d?.severity <= 4 ? d.severity - 1 : SEVERITIES.indexOf(LSP_DEFAULT_SEVERITY));
  // Over the bound, the most severe are the ones kept (in the server's order among equals): the first fifty hints must not hide the error after them.
  const kept = items.length > LSP_MAX_DIAGNOSTICS ? [...items].sort((a, b) => rank(a) - rank(b)).slice(0, LSP_MAX_DIAGNOSTICS) : items;
  const list = kept.map((d: any): LspDiagnostic => ({
    range: toModel(toRange(d?.range) ?? NO_RANGE),
    severity: SEVERITIES[d?.severity - 1] ?? LSP_DEFAULT_SEVERITY,
    message: String(d?.message ?? "").slice(0, LSP_MAX_DIAGNOSTIC_TEXT),
    source: typeof d?.source === "string" ? d.source.slice(0, LSP_MAX_LABEL) : undefined,
    ...(typeof d?.code === "number" ? { code: d.code } : d?.code !== undefined && d?.code !== null ? { code: String(d.code).slice(0, LSP_MAX_LABEL) } : {}),
  }));
  return { list, omitted: items.length - list.length };
}

const okAnswer = (d: DiagnosticList): DiagnosticsAnswer => ({ status: "ok", diagnostics: d.list, ...(d.omitted > 0 ? { omitted: d.omitted } : {}) });

/** The text of a hover result in any of its forms (a string, a MarkedString, a list of those, MarkupContent); a code block keeps its language tag. */
function hoverContents(contents: unknown): string {
  const one = (c: any): string => {
    if (typeof c === "string") return c;
    if (typeof c?.value !== "string") return "";
    return typeof c.language === "string" && c.language !== "" ? `\`\`\`${c.language}\n${c.value}\n\`\`\`` : c.value;
  };
  return Array.isArray(contents) ? contents.map(one).filter((t) => t !== "").join("\n\n") : one(contents);
}

/**
 * Hover text as it may be shown: it is written by whoever wrote the code under the cursor (doc comments), so it is
 * untrusted. Secrets redacted and terminal escapes removed (the helper the diagnostics path uses), control characters
 * removed (line breaks and tabs stay: it is prose and code), fence markers defused as in a diagnostic message, capped
 * with a note. The caller still puts it inside the untrusted-output fence.
 */
export function sanitizeHoverText(raw: string): string {
  // Cleaning can only shorten, so nothing past four times the cap can end up inside it: the rest is not worked on.
  const text = redactPlain(raw.slice(0, 4 * LSP_MAX_HOVER_CHARS))
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, " ")
    .split(UNTRUSTED_FENCE_START).join("(untrusted-tool-output")
    .split(UNTRUSTED_FENCE_END).join("(end-untrusted-tool-output)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= LSP_MAX_HOVER_CHARS && raw.length <= 4 * LSP_MAX_HOVER_CHARS) return text;
  return `${text.slice(0, LSP_MAX_HOVER_CHARS)}\n…[truncated: the hover text is ${raw.length} characters, the first ${Math.min(text.length, LSP_MAX_HOVER_CHARS)} are shown]`;
}

/** A position argument as the tools take it: a whole number from 1 (a string of digits is read as that number), or null. */
function positiveInteger(value: unknown): number | null {
  const n = typeof value === "string" && /^[0-9]{1,10}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= 0x7fffffff ? n : null;
}

const POSITION_FORM = "line and character must be positive integers, counted from 1 (the first line is 1, the first character of a line is 1)";
const pastEnd = (filePath: string, line: number, shown: number): Error => new Error(`Line ${line} is past the end of ${filePath}, which has ${shown} line${shown === 1 ? "" : "s"}; the language server was not asked.`);
const PATH_FORM = "path must be a non-empty string naming a file inside the workspace";

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
const tooLarge = (filePath: string, bytes: number, limit: number): Error =>
  new Error(`${filePath} is ${bytes} bytes, over the ${limit}-byte limit for language-server queries: it was not read and not given to the language server. search_code and read_file still work on it.`);

/** Signals a process group; false when there is none to signal (it has ended, or the leader moved to another group). */
function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

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
 * A file over `maxBytes` is not read: its size comes back instead (also when it grew past the limit between the stat and
 * the read, in which case what was read is dropped).
 */
function readRegularFile(real: string, maxBytes: number): FileState | { tooLarge: number } | null {
  let fd: number | undefined;
  try {
    const readAtMs = Date.now();
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    if (st.size > BigInt(maxBytes)) return { tooLarge: Number(st.size) };
    const text = fs.readFileSync(fd, "utf-8");
    const bytes = text.length > maxBytes ? text.length : Buffer.byteLength(text, "utf-8");
    if (bytes > maxBytes) return { tooLarge: bytes };
    return { text, ...stampOf(st, readAtMs) };
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
  diagnostics?: DiagnosticList & { seq: number };
  /** The last full report pulled for it, kept so that an "unchanged" reply to its `resultId` has a list to stand for. */
  pulled?: DiagnosticList & { resultId?: string };
  /** Diagnostics queries waiting on this document; it is not evicted meanwhile. */
  waiting: number;
}

/**
 * A position as the protocol shapes it: line and character from 0. Inside this client and in everything it returns
 * (`LspDiagnostic.range`), `character` counts Unicode code points, the model-facing unit (lsp_positions.ts); only
 * `LspClient.outgoing` and `LspClient.incoming` see a server's own encoding.
 */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/**
 * Where a definition is, in the units the tools take as input, so an answer can be asked about as it stands: lines and
 * columns count from 1 (`endLine`/`endColumn`: the position just past the name). One shape for every form a server
 * answers in (Location, Location[], LocationLink, LocationLink[]; for a link, its `targetSelectionRange`).
 */
export interface LspTarget {
  /** Relative to the workspace, "/"-separated, for a file inside it; the absolute path, with `external`, for one outside it (a dependency, the standard library). */
  file?: string;
  external?: true;
  /** In place of `file` when the target is not a file (`jdt://`, `deno:`): the URI as the server gave it, cleaned. */
  uri?: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /**
   * The columns are the server's own offsets plus one, as if every character before them were ASCII: the server does
   * not count in code points and the text of the target's line could not be had to convert with (a file outside the
   * workspace, over the size limit, gone or changed, or not a file). The line is exact.
   */
  approximate?: true;
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
  /** The marker files that make a directory this language's project root (lsp_roots.ts). Without it: the workspace. */
  root?: RootRule;
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
  private admissionLease?: ResourceSlotLease;
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
  /** Resolves the moment the process has exited. */
  private exited: Promise<void> = Promise.resolve();
  /** The stop in progress or done; a second `shutdown` gets the same one. */
  private stopping?: Promise<void>;
  /** The server leads its own process group (POSIX), so signals reach what it started as well. */
  private ownGroup = false;
  /** Set once the server broke the message limit: nothing more it writes is read. */
  private deaf = false;
  /** Capabilities the server registered dynamically (`client/registerCapability`), id to method. Recorded; nothing acts on them yet. */
  private registered: Map<string, string> = new Map();
  /** The server's latest `window/showMessage` / `window/logMessage` lines, cleaned. */
  private serverMessages: string[] = [];
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
  /** What the server counts `character` in: negotiated at `initialize`; UTF-16 until then and when it names none. */
  public positionEncoding: PositionEncoding = DEFAULT_POSITION_ENCODING;
  /** Set when the server named an encoding that was not offered: said in `status()`. */
  private encodingNotice?: string;
  /** The workspace the tools' paths are relative to; `rootPath` is the project root inside it that the server is started for. */
  public workspacePath: string;

  constructor(
    serverCmd: string,
    rootPath: string,
    serverArgs: string[] = [],
    private extraEnv: Record<string, string> = {},
    private awaitProgress: boolean = false,
    private t: LspTimings = LSP_TIMINGS,
    private installHint?: string,
    private limits: Pick<LspLimits, "fileBytes" | "messageBytes"> = LSP_LIMITS,
    workspacePath: string = rootPath,
    admissionLease?: ResourceSlotLease,
  ) {
    this.serverCmd = serverCmd;
    this.serverArgs = serverArgs;
    this.rootPath = path.resolve(rootPath);
    this.workspacePath = path.resolve(workspacePath);
    this.admissionLease = admissionLease;
  }

  /** Supplies a same-host process slot after the manager has waited for an evicted server to exit. */
  public setAdmissionLease(lease: ResourceSlotLease): void {
    if (this.child || this.admissionLease) throw new Error("LSP process admission lease was already set");
    this.admissionLease = lease;
  }

  private releaseAdmissionLease(): void {
    const lease = this.admissionLease;
    this.admissionLease = undefined;
    lease?.release();
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
    const said = this.serverMessages.length > 0 ? { serverMessages: [...this.serverMessages] } : {};
    const root = rootLabel(this.workspacePath, this.rootPath);
    if (this.lifecycle !== "running") {
      return { server: this.serverCmd, root, state: this.lifecycle, forMs: now - (this.failure?.at ?? this.lifecycleSince), ...(this.failure ? { detail: this.failure.message, cause: this.failure } : {}), ...said };
    }
    const r = this.readiness(now);
    const detail = this.encodingNotice ? `${r.detail}; ${this.encodingNotice}` : r.detail;
    return { server: this.serverCmd, root, state: r.ready ? "ready" : "indexing", forMs: now - (r.ready ? Math.max(r.at ?? 0, this.initializedAt) : this.busySince), detail, ...said };
  }

  /** What the server registered dynamically and has not unregistered. */
  public registrations(): Array<{ id: string; method: string }> {
    return [...this.registered].map(([id, method]) => ({ id, method }));
  }

  private notRunning(): Error {
    return new Error(this.lifecycle === "stopped" ? `Language server '${this.serverCmd}' was stopped.` : (this.failure?.message ?? `LSP server '${this.serverCmd}' is not running`));
  }

  /**
   * Signals the server: its process group where it has one, so that what it started gets the signal too, else the
   * process itself (Windows has no groups; a server that moved to another group is still our child). SIGKILL goes to
   * both. Nothing is signalled once the process has exited: its group was swept then, and its pid may be reused.
   */
  private signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (this.ownGroup && killGroup(child.pid, signal) && signal !== "SIGKILL") return;
    try {
      child.kill(signal);
    } catch {}
  }

  /** The synchronous last resort (process exit, where nothing can be waited for): SIGKILL to the group. */
  public kill(): void {
    this.signal("SIGKILL");
  }

  private exitedWithin(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
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
    if (this.stopping) {
      this.releaseAdmissionLease();
      throw this.notRunning(); // stopped before it was started (the manager was closed while this start waited its turn)
    }
    this.setLifecycle("starting");
    // PATH is cleaned against the whole workspace, not only this project: no directory of the workspace supplies the binary.
    const env = { ...buildLspEnvironment(this.workspacePath), ...this.extraEnv };
    // Looked up where the server's own environment would find it, before anything is spawned.
    const where = /[\\/]/.test(this.serverCmd) ? "" : " on PATH";
    const notInstalled = `Language server not installed: ${this.serverCmd} was not found${where}.${this.installHint ? ` Install it with: ${this.installHint}` : ""}`;
    if (findCommand(this.serverCmd, env.PATH ?? "", this.rootPath) === null) {
      this.releaseAdmissionLease();
      throw this.fail("not_installed", notInstalled);
    }
    let child: ChildProcess;
    try {
      // Its own process group (POSIX: a session of its own), so that stopping it stops what it started. Not unref'd:
      // the process is this client's to end.
      this.ownGroup = process.platform !== "win32";
      const inheritedFd = this.admissionLease?.inheritedFd;
      let command = this.serverCmd;
      let args = this.serverArgs;
      let stdio: any[] = ["pipe", "pipe", "pipe"];
      if (inheritedFd !== undefined) {
        // The trusted supervisor keeps the lock descriptor open without exposing it to the language server.
        const sourceMode = import.meta.url.endsWith(".ts");
        const supervisor = fileURLToPath(new URL(sourceMode ? "./lsp_process_guard.ts" : "./lsp_process_guard.js", import.meta.url));
        command = process.execPath;
        const tsxLoader = sourceMode ? fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)) : undefined;
        args = [...(tsxLoader ? ["--import", tsxLoader] : []), supervisor, this.serverCmd, ...this.serverArgs];
        stdio = ["pipe", "pipe", "pipe", inheritedFd];
      }
      child = spawn(command, args, { cwd: this.rootPath, env, stdio, detached: this.ownGroup });
    } catch (err: any) {
      this.releaseAdmissionLease();
      throw this.fail("spawn_failed", `Language server '${this.serverCmd}' failed to start: it could not be executed (${err.code ?? err.message}).`);
    }
    this.child = child;
    child.once("close", () => this.releaseAdmissionLease());
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

      let exited!: () => void;
      this.exited = new Promise<void>((resolve) => (exited = resolve));
      // No process, no exit: a spawn that failed (the `error` above) leaves nothing to wait for.
      child.once("error", () => {
        if (child.pid === undefined) exited();
      });
      this.gone = new Promise<void>((resolve) => {
        child.on("exit", (code, signal) => {
          // Whatever the server started and left in its group goes with it, however it ended. Done at once: the group's
          // id is the pid just reaped.
          if (this.ownGroup && child.pid !== undefined) killGroup(child.pid, "SIGKILL");
          exited();
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
            // A process that outlived the server (outside its group) may hold the pipes open: they are not waited for.
            for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
            if (this.failure) this.failure.stderrTail = this.stderrTail();
            this.failInFlight(this.notRunning());
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
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) }],
        capabilities: {
          general: { positionEncodings: [...OFFERED_POSITION_ENCODINGS] },
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
          workspace: { workspaceFolders: true, ...(this.awaitProgress ? {} : { diagnostics: { refreshSupport: true } }) },
          // Declared so that servers which report progress (rust-analyzer) send $/progress, which diagnostics wait on.
          window: { workDoneProgress: true },
        },
      }, this.t.startMs);

      if ((this.lifecycle as string) === "stopped") throw this.notRunning(); // stopped while the answer was on its way
      if (!initRes) throw new Error("it answered initialize with no result");
      const sync = initRes.capabilities?.textDocumentSync;
      if (typeof sync === "object" && sync?.save) {
        this.saveOptions = typeof sync.save === "object" ? sync.save : {};
      }
      const negotiated = negotiatedEncoding(initRes.capabilities?.positionEncoding);
      this.positionEncoding = negotiated.encoding;
      if (negotiated.rejected !== undefined) {
        this.encodingNotice = `it named the position encoding ${sanitizeDiagnosticMessage(negotiated.rejected)}, which was not offered: its positions are read as ${DEFAULT_POSITION_ENCODING.toUpperCase()}`;
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
      // A client that offers workspace folders is expected to push its configuration next. Pyright holds every
      // request for a workspace until that arrives: with the capability offered and no push, it answers nothing and
      // publishes nothing. Nothing is configured on a server's behalf here, so the settings are empty.
      this.sendNotification("workspace/didChangeConfiguration", { settings: {} });
      this.initializedAt = this.busySince = Date.now();
      this.setLifecycle("running");
    } catch (err: any) {
      const failure = timedOut(err)
        ? this.fail("initialize_timeout", `Language server '${this.serverCmd}' did not answer initialize within ${seconds(this.t.startMs)}; it was killed.`)
        : this.fail("spawn_failed", `Language server '${this.serverCmd}' failed to start: ${err.message}.`);
      this.initialized = false;
      this.signal("SIGKILL");
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

  /**
   * A server that announces a message over the limit, or writes bytes that never form a header, is not trusted with
   * memory: what it sent is dropped, nothing more is read from it, and it is stopped and reported as failed with this cause.
   */
  private dropOversized(what: string): void {
    this.buffer = Buffer.alloc(0);
    this.deaf = true;
    this.failInFlight(this.fail("message_too_large", `Language server '${this.serverCmd}' sent ${what}; it was not read and the server was killed.`));
    this.initialized = false;
    this.signal("SIGKILL");
  }

  private handleData(chunk: Buffer): void {
    if (this.deaf) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1 ? this.buffer.length > LSP_MAX_HEADER_BYTES : headerEnd > LSP_MAX_HEADER_BYTES) return this.dropOversized(`more than ${LSP_MAX_HEADER_BYTES} bytes that are not a message header`);
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString("latin1");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      // Refused on its announced size: the body is never collected.
      if (contentLength > this.limits.messageBytes) return this.dropOversized(`a message of ${contentLength} bytes, over the ${this.limits.messageBytes}-byte limit`);
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
          const token = String(msg.params.token).slice(0, LSP_MAX_LABEL);
          const kind = msg.params.value?.kind;
          if (kind === "begin") {
            // Work that begins after a quiet spell is a new analysis; phases that follow one another are one.
            if (this.progressActive.size === 0 && this.progressEnded > 0 && Date.now() - this.lastProgressAt >= this.t.quietMs) this.busySince = Date.now();
            // Beyond the bound a new token is not tracked; the ones that are keep the server "in progress".
            if (this.progressActive.size < LSP_MAX_PROGRESS_TOKENS || this.progressActive.has(token)) this.progressActive.set(token, this.seq);
          } else if (kind === "end") {
            this.progressSettledSeq = Math.max(this.progressSettledSeq, this.progressActive.get(token) ?? 0);
            if (this.progressActive.delete(token)) this.progressEnded++;
          }
          this.lastProgressAt = Date.now();
          this.wake(ANY_DOCUMENT);
          continue;
        }
        if ((msg.method === "window/showMessage" || msg.method === "window/logMessage") && msg.id === undefined) {
          this.note(msg.params);
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
            current.diagnostics = { ...toDiagnostics(params.diagnostics, this.incoming(current.text)), seq: this.seq };
            if (!this.awaitProgress) this.answered = true;
            this.wake(current.key);
          }
        }
      } catch {}
    }
  }

  /** Keeps one `window/showMessage` / `window/logMessage` line for `status()`: cleaned as a diagnostic message is, in a ring. */
  private note(params: any): void {
    const line = sanitizeDiagnosticMessage(String(params?.message ?? "").slice(0, LSP_MAX_DIAGNOSTIC_TEXT));
    if (line === "") return;
    this.serverMessages.push(`${["error", "warning", "info", "log", "debug"][params?.type - 1] ?? "message"}: ${line}`);
    if (this.serverMessages.length > LSP_SERVER_MESSAGE_RING) this.serverMessages.shift();
  }

  /**
   * One request. It ends with the answer, at the timeout, when `signal` fires, or when the server is gone. A request
   * given up on (timeout, cancellation) is withdrawn with `$/cancelRequest`, so the server stops working on it.
   */
  public async sendRequest(method: string, params: any, timeoutMs: number = 8000, signal?: AbortSignal): Promise<any> {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null || (this.lifecycle === "stopped" && method !== "shutdown")) {
      throw this.notRunning();
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

  /**
   * The answer to each request a server may send. A request this client does not implement is answered with the
   * protocol's MethodNotFound, never with a success the server could build on.
   */
  private serverRequest(method: string, params: any): { result: unknown } | { error: { code: number; message: string } } {
    const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
    switch (method) {
      case "workspace/applyEdit":
        // A language server never writes files here; an edit it wants is proposed through Nexus's own edit path.
        return { result: { applied: false, failureReason: APPLY_EDIT_REFUSAL } };
      case "workspace/configuration":
        // Nothing is configured on the server's behalf: one null per item asked for.
        if (list(params?.items).length > LSP_MAX_REGISTRATIONS) return { error: { code: INVALID_PARAMS, message: `More than ${LSP_MAX_REGISTRATIONS} configuration items in one request` } };
        return { result: list(params?.items).map(() => null) };
      case "client/registerCapability":
        for (const r of list(params?.registrations)) {
          if (typeof r?.id !== "string" || typeof r?.method !== "string") continue;
          const id = r.id.slice(0, LSP_MAX_LABEL);
          this.registered.delete(id);
          if (this.registered.size >= LSP_MAX_REGISTRATIONS) this.registered.delete(this.registered.keys().next().value!); // the oldest makes room
          this.registered.set(id, r.method.slice(0, LSP_MAX_LABEL));
        }
        return { result: null };
      case "client/unregisterCapability":
        // `unregisterations`: the protocol's own spelling.
        for (const r of list(params?.unregisterations ?? params?.unregistrations)) if (typeof r?.id === "string") this.registered.delete(r.id.slice(0, LSP_MAX_LABEL));
        return { result: null };
      case "window/workDoneProgress/create":
        return { result: null };
      case "window/showMessageRequest":
        return { result: null }; // no action is chosen
      case "workspace/workspaceFolders":
        return { result: [{ uri: pathToFileURL(this.rootPath).href, name: path.basename(this.rootPath) }] };
      case "workspace/diagnostic/refresh":
        // The server's results changed for a reason the client did not cause: no kept report may stand in for a new one.
        for (const doc of this.documents.values()) doc.pulled = undefined;
        return { result: null };
      default:
        return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method.slice(0, LSP_MAX_LABEL)}` } };
    }
  }

  private answerServerRequest(msg: { id: number | string; method: string; params?: any }): void {
    if (!this.child || !this.child.stdin || this.child.killed || this.child.exitCode !== null) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...this.serverRequest(msg.method, msg.params) });
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
   * workspace (renamed, or replaced by a symlink), or has grown past the size limit is closed without being read.
   * Per document: one realpath and one stat; the content is read only when the stamp moved or cannot be trusted yet.
   */
  private resync(realRoot: string | null): void {
    for (const doc of [...this.documents.values()]) {
      let state: FileState | null = null;
      if (realRoot !== null && realOrNull(doc.key) === doc.key && !outsideRoot(realRoot, doc.key)) {
        try {
          const st = fs.statSync(doc.key, { bigint: true });
          if (doc.settled && stampOf(st, 0).stamp === doc.stamp) continue;
          if (st.isFile()) {
            // Grown past the size limit: closed like a file that is gone (the server reads the disk from here on), without a read.
            const read = readRegularFile(doc.key, this.limits.fileBytes);
            state = read && !("tooLarge" in read) ? read : null;
          }
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
   * Throws when the file cannot be read, lies outside the workspace, or is over the size limit (it is then not read).
   */
  private open(filePath: string, languageId: string): OpenDocument {
    // Resolve symlinks before the containment check: a link inside the workspace must not read a file outside it.
    const realRoot = realOrNull(this.rootPath);
    this.resync(realRoot);
    const key = realRoot === null ? null : realOrNull(path.resolve(this.workspacePath, filePath));
    if (realRoot === null || key === null || outsideRoot(realRoot, key)) throw unreadable(filePath);
    let doc = this.documents.get(key);
    if (doc) {
      this.documents.delete(key);
    } else {
      const state = readRegularFile(key, this.limits.fileBytes);
      if (!state) throw unreadable(filePath);
      if ("tooLarge" in state) throw tooLarge(filePath, state.tooLarge, this.limits.fileBytes);
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
    const current = (): DiagnosticList | null => {
      const d = held();
      return d && d.seq >= since ? d : null;
    };
    const stands = (now: number): DiagnosticList | null => {
      const d = held();
      const at = d ? this.settledAt(d.seq) : null;
      return d && at !== null && now >= at ? d : null;
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
      if (list && final(now)) return okAnswer(list);
      const stood = list ? null : stands(now);
      if (stood) return okAnswer(stood);
      if (this.lifecycle !== "running") return unavailable(`${this.notRunning().message} No diagnostics for ${filePath}.`);
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
    const keepable = (resultId: unknown): resultId is string => typeof resultId === "string" && resultId.length <= LSP_MAX_RESULT_ID;
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
        doc.pulled = { ...toDiagnostics(report.items, this.incoming(doc.text)), ...(keepable(report.resultId) ? { resultId: report.resultId } : {}) };
        this.answered = true;
        return okAnswer(doc.pulled);
      }
      if (report?.kind === "unchanged" && previousResultId !== undefined) {
        if (doc.pulled) {
          if (keepable(report.resultId)) doc.pulled.resultId = report.resultId;
          else if (report.resultId !== undefined) delete doc.pulled.resultId; // a new id too long to keep: the next request asks for a full report
          return okAnswer(doc.pulled);
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
    const deadline = this.deadline(Date.now());
    for (let pause = this.t.retryMs; ; pause = Math.min(pause * 2, READINESS_RETRY_CAP_MS)) {
      // Converted for each request: the document may have been re-synced (its text changed) while this call waited.
      const params = { textDocument: { uri: doc.uri }, position: this.outgoing(doc, filePath, line, character) };
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

  /**
   * THE ONE PLACE A POSITION LEAVES FOR THE SERVER. `line` and `character` as the tools take them (from 1, `character`
   * in code points) to the protocol's position in the server's encoding, from the text the server holds for the
   * document. A column past the end of the line is the end of the line. Throws for a line the document does not have.
   */
  private outgoing(doc: OpenDocument, filePath: string, line: number, character: number): LspPosition {
    const lines = new TextLines(doc.text);
    const text = lines.line(line - 1);
    if (text === undefined) throw pastEnd(filePath, line, lines.shown);
    return { line: line - 1, character: toEncoded(text, character - 1, this.positionEncoding) };
  }

  /**
   * THE ONE PLACE A POSITION COMES IN FROM THE SERVER: a converter for the ranges of one text (a document's
   * diagnostics, one definition target), built once per batch so the text is divided into lines once. `text` null: it
   * could not be had; the converter then reports through `approximate` (see `rangeToModel`).
   */
  private incoming(text: string): (range: LspRange) => LspRange;
  private incoming(text: string | null, approximate: () => void): (range: LspRange) => LspRange;
  private incoming(text: string | null, approximate?: () => void): (range: LspRange) => LspRange {
    let lines: TextLines | null | undefined;
    return (range) => {
      if (lines === undefined) lines = text === null ? null : new TextLines(text);
      const converted = rangeToModel(lines, range, this.positionEncoding);
      if (converted.approximate) approximate?.();
      return converted.range;
    };
  }

  /** `text` null with `notReady` null: the server answered and has nothing at this position. The text is cleaned and capped (`sanitizeHoverText`), not fenced. */
  public async getHover(filePath: string, languageId: string, line: number, character: number, signal?: AbortSignal): Promise<{ text: string | null; notReady: LspServerStatus | null }> {
    const { result, notReady } = await this.ask("textDocument/hover", filePath, languageId, line, character, (res) => hoverContents(res?.contents).trim() === "", signal);
    return { text: sanitizeHoverText(hoverContents(result?.contents)) || null, notReady };
  }

  /**
   * Where the server's `uri` is, as a query's input would name it (relative to the workspace, not to this server's
   * project root), and `inside`: its real path, when it is a file inside the workspace that exists.
   */
  private place(uri: string, realWorkspace: string | null): { where: Pick<LspTarget, "file" | "external" | "uri">; inside?: string } {
    let named: string;
    try {
      named = fileURLToPath(uri);
    } catch {
      return { where: { uri: sanitizeDiagnosticMessage(uri) } }; // not a file
    }
    // Compared by canonical path, as published diagnostics are: a server may name the file through a symlink or by its real path.
    const resolved = realOrNull(named);
    const real = resolved ?? comparablePath(named);
    for (const root of [realWorkspace, this.workspacePath]) {
      if (root !== null && real !== root && isInside(root, real)) {
        return { where: { file: sanitizeDiagnosticMessage(path.relative(root, real).split(path.sep).join("/")) }, ...(resolved !== null && root === realWorkspace ? { inside: resolved } : {}) };
      }
    }
    return { where: { file: sanitizeDiagnosticMessage(real), external: true } };
  }

  /**
   * The text a definition target's columns are converted with, or null when there is none to be had: what the server
   * holds for a document that is open; else the file, when it is inside the workspace and within the size limit, read
   * once per query and file (`cache`) and not opened on the server. A file outside the workspace is not read. Nothing
   * is read when the server counts in code points (UTF-32), or when no column of the range is past the first.
   */
  private targetText(uri: string, range: LspRange, inside: string | undefined, cache: Map<string, string | null>): string | null {
    if (this.positionEncoding === "utf-32" || (range.start.character === 0 && range.end.character === 0)) return null;
    const open = this.documentForUri(uri);
    if (open) return open.text;
    if (inside === undefined) return null;
    if (!cache.has(inside)) {
      const read = readRegularFile(inside, this.limits.fileBytes);
      cache.set(inside, read && !("tooLarge" in read) ? read.text : null);
    }
    return cache.get(inside)!;
  }

  /**
   * A definition answer in any of its forms as one list: distinct targets, at most LSP_MAX_DEFINITION_TARGETS of them
   * (only those are looked up on disk), and the number left out. Entries that are not a location are skipped.
   */
  private targets(result: unknown): { list: LspTarget[]; omitted: number } {
    const distinct = new Map<string, { uri: string; range: LspRange }>();
    for (const item of Array.isArray(result) ? result : result ? [result] : []) {
      // A LocationLink names its target by `targetUri`; the position of the name itself is `targetSelectionRange`.
      const link = typeof item?.targetUri === "string";
      const uri = link ? item.targetUri : item?.uri;
      const range = toRange(link ? (item.targetSelectionRange ?? item.targetRange) : item?.range);
      if (typeof uri === "string" && range) distinct.set(JSON.stringify([uri, range]), { uri, range });
    }
    const realWorkspace = realOrNull(this.workspacePath);
    const texts = new Map<string, string | null>();
    const list = new Map<string, LspTarget>();
    for (const { uri, range: sent } of [...distinct.values()].slice(0, LSP_MAX_DEFINITION_TARGETS)) {
      const { where, inside } = this.place(uri, realWorkspace);
      let approximate = false;
      const range = this.incoming(this.targetText(uri, sent, inside, texts), () => (approximate = true))(sent);
      const target: LspTarget = { ...where, line: range.start.line + 1, column: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1, ...(approximate ? { approximate: true } : {}) };
      list.set(JSON.stringify(target), target); // two spellings of one file are one target
    }
    return { list: [...list.values()], omitted: Math.max(0, distinct.size - LSP_MAX_DEFINITION_TARGETS) };
  }

  /** An empty list with `notReady` null: the server answered and has nothing to go to from this position. */
  public async getDefinition(filePath: string, languageId: string, line: number, character: number, signal?: AbortSignal): Promise<{ targets: LspTarget[]; omitted: number; notReady: LspServerStatus | null }> {
    // A single Location or LocationLink is an answer too: reading it as empty would report "nothing here" for a real definition.
    const { result, notReady } = await this.ask("textDocument/definition", filePath, languageId, line, character, (res) => (Array.isArray(res) ? res.length === 0 : !res), signal);
    const { list, omitted } = this.targets(result);
    return { targets: list, omitted, notReady };
  }

  /**
   * Stops the server and resolves when its process is gone: the `shutdown` request, `exit`, SIGTERM to its process
   * group, SIGKILL to the group, each after the wait named in LspTimings (see LSP_SHUTDOWN_REPLY_MS). A server that
   * had not finished starting, or has failed, is killed at once. Every query in flight ends now, as "stopped".
   * Never rejects, and a second call returns the same stop. Safe to call without awaiting: `kill` is the synchronous
   * backstop the manager uses at process exit.
   * Limits: a process the server started that left its group (its own session) is out of reach and is not waited for;
   * on Windows there are no groups, so only the server itself is ended; a process that survives SIGKILL (it cannot,
   * short of a kernel fault) is given up on after the last wait.
   */
  public shutdown(): Promise<void> {
    return (this.stopping ??= this.stop().catch(() => {}));
  }

  private async stop(): Promise<void> {
    const orderly = this.lifecycle === "running";
    // A deliberate stop: the exit that follows is not a crash.
    if (this.lifecycle !== "failed") this.setLifecycle("stopped");
    this.initialized = false;
    this.failInFlight(this.notRunning());
    const child = this.child;
    if (!child || child.pid === undefined) return;
    if (orderly) {
      await Promise.race([this.sendRequest("shutdown", {}, this.t.shutdownReplyMs).catch(() => {}), this.exited]);
      this.sendNotification("exit", {});
      if (!(await this.exitedWithin(this.t.exitGraceMs))) {
        this.signal("SIGTERM");
        await this.exitedWithin(this.t.termGraceMs);
      }
    }
    this.signal("SIGKILL"); // nothing, when it has exited
    if (await this.exitedWithin(this.t.killGraceMs)) {
      await this.gone; // its stderr is collected and its pipes are closed: no timer or handle of this client is left
    } else {
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      child.unref();
    }
    this.child = null;
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
  /** With `found`: the server's text, cleaned and capped. It is untrusted: a model reads `fenced`, never this. */
  hoverText?: string;
  /** With `found`: `hoverText` inside the untrusted-output fence, as diagnostics and a server's stderr are shown. */
  fenced?: string;
  error?: string;
  state?: LspServerStatus;
  detail?: string;
}

export interface LspDefinitionResult {
  found: boolean;
  /** True when the server answered and has nothing to go to: a real answer, with `message` saying so. */
  answered?: boolean;
  locations?: LspTarget[];
  /** Targets beyond LSP_MAX_DEFINITION_TARGETS that `locations` leaves out. */
  omitted?: number;
  message?: string;
  error?: string;
  state?: LspServerStatus;
  detail?: string;
}

/**
 * The marker files of each built-in language (see `RootRule`). typescript-language-server and pyright: the nearest
 * directory with a project or package file. rust-analyzer: the nearest Cargo.toml, or the Cargo workspace it belongs
 * to. gopls: a go.work above the file, else the nearest go.mod.
 */
const TYPESCRIPT_ROOT: RootRule = { markers: [["tsconfig.json", "jsconfig.json", "package.json"]] };
const PYTHON_ROOT: RootRule = { markers: [["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json"]] };
const RUST_ROOT: RootRule = { markers: [["Cargo.toml"]], enclosing: { file: "Cargo.toml", declares: /^[ \t]*\[workspace[\].]/m } };
const GO_ROOT: RootRule = { markers: [["go.work"], ["go.mod"]] };

/** A file's server: its spec, the project root it runs for, and the key of that pair. */
interface Route {
  info: LspServerSpec;
  root: string;
  key: string;
}

/**
 * Manager to auto-route LSP queries based on file extension
 */
export class LspBridgeManager {
  private static live: Set<LspBridgeManager> = new Set();
  private static exitHookInstalled = false;

  private workspace: string;
  /** Running clients by server and project root, least recently used first. */
  private clients: Map<string, LspClient> = new Map();
  /** Queries each client is answering: one that has any is not stopped to make room for another server. */
  private inUse: Map<LspClient, number> = new Map();
  private starting: Map<string, Promise<LspClient | null>> = new Map();
  /** The client of a start in flight, so that its state can be reported. */
  private launching: Map<string, LspClient> = new Map();
  private failures: Map<string, KnownFailure> = new Map();
  /** Crashes per server in this session. */
  private crashes: Map<string, number> = new Map();
  /** Clients being stopped, each with its stop: the manager stays in `live` until they are gone. */
  private stopping: Map<LspClient, Promise<void>> = new Map();
  private closed = false;
  private servers: Record<string, LspServerSpec>;
  private gate?: () => string | null;
  private timingOverrides: Partial<LspTimings>;
  private limits: LspLimits;
  private sharedAdmission?: SharedResourceAdmission;
  private sharedServerLimit = LSP_MAX_SERVERS;
  private admissionRefusals: Map<string, string> = new Map();

  /**
   * `gate` returns the reason a server must not start right now (untrusted workspace, sandbox), or null to allow it.
   * `timings` and `limits` override the product's (LSP_TIMINGS and each server's own; LSP_LIMITS) for every server: for tests.
   */
  constructor(workspace: string, opts: { servers?: Record<string, LspServerSpec>; gate?: () => string | null; timings?: Partial<LspTimings>; limits?: Partial<LspLimits>; sharedAdmission?: SharedResourceAdmission; sharedServerLimit?: number } = {}) {
    this.workspace = path.resolve(workspace);
    this.gate = opts.gate;
    this.servers = opts.servers ?? {};
    this.timingOverrides = opts.timings ?? {};
    this.limits = { ...LSP_LIMITS, ...opts.limits };
    this.sharedAdmission = opts.sharedAdmission;
    this.sharedServerLimit = opts.sharedServerLimit ?? LSP_MAX_SERVERS;
    LspBridgeManager.live.add(this);
    if (!LspBridgeManager.exitHookInstalled) {
      LspBridgeManager.exitHookInstalled = true;
      // Backstop: a language server must never outlive the process, even if no owner called shutdownAll or waited for
      // it. Nothing can be waited for here, so every server still alive (running, starting, or being stopped) and its
      // process group is killed outright.
      process.on("exit", () => {
        for (const m of LspBridgeManager.live) m.killAll();
      });
    }
  }

  private killAll(): void {
    for (const client of [...this.clients.values(), ...this.launching.values(), ...this.stopping.keys()]) client.kill();
  }

  /** Stops one client; the same stop for a client already being stopped. Never rejects. */
  private stop(client: LspClient): Promise<void> {
    let stop = this.stopping.get(client);
    if (!stop) {
      stop = client.shutdown().then(() => {
        this.stopping.delete(client);
        this.release();
      });
      this.stopping.set(client, stop);
    }
    return stop;
  }

  /** A closed manager with no process left has nothing for the exit backstop to do. */
  private release(): void {
    if (this.closed && this.clients.size === 0 && this.launching.size === 0 && this.stopping.size === 0) LspBridgeManager.live.delete(this);
  }

  /** The gate's refusal, if any. A refusal also stops servers that started, or are starting, while the workspace was still allowed. */
  private refusal(): string | null {
    const reason = this.gate?.() ?? null;
    if (reason) {
      for (const client of [...this.clients.values(), ...this.launching.values()]) void this.stop(client);
      this.clients.clear();
    }
    return reason;
  }

  /** Whether `filePath` names a regular file that resolves, through symlinks, to a place inside the workspace. */
  private askable(filePath: string): boolean {
    const realRoot = realOrNull(this.workspace);
    const real = realRoot === null ? null : realOrNull(path.resolve(this.workspace, filePath));
    try {
      return realRoot !== null && real !== null && !outsideRoot(realRoot, real) && fs.statSync(real).isFile();
    } catch {
      return false;
    }
  }

  public getServerForFile(filePath: string): LspServerSpec | null {
    const ext = path.extname(filePath).toLowerCase();
    if (this.servers[ext]) return this.servers[ext];
    if (ext === ".rs") {
      return { cmd: "rust-analyzer", languageId: "rust", awaitProgress: true, timings: { coldStartMs: RUST_ANALYZER_COLD_START_ALLOWANCE_MS }, installHint: "rustup component add rust-analyzer", root: RUST_ROOT };
    }
    if (ext === ".ts" || ext === ".tsx") {
      return { cmd: "typescript-language-server", args: ["--stdio"], languageId: "typescript", installHint: "npm install -g typescript typescript-language-server", root: TYPESCRIPT_ROOT };
    }
    if (ext === ".js" || ext === ".jsx") {
      return { cmd: "typescript-language-server", args: ["--stdio"], languageId: "javascript", installHint: "npm install -g typescript typescript-language-server", root: TYPESCRIPT_ROOT };
    }
    if (ext === ".py") {
      return { cmd: "pyright-langserver", args: ["--stdio"], languageId: "python", installHint: "npm install -g pyright", root: PYTHON_ROOT };
    }
    if (ext === ".go") {
      return { cmd: "gopls", languageId: "go", installHint: "go install golang.org/x/tools/gopls@latest", root: GO_ROOT };
    }
    return null;
  }

  /** The timings the server for this file runs with: the product's, then the server's own, then this manager's overrides. */
  public timingsFor(filePath: string): LspTimings {
    return { ...LSP_TIMINGS, ...this.getServerForFile(filePath)?.timings, ...this.timingOverrides };
  }

  /**
   * The server for a file and the project root it runs for (`findProjectRoot`: the nearest directory inside the
   * workspace with a marker of the server's language, else the workspace), or null when no server is configured.
   * One server process per pair: two packages of a monorepo are two servers.
   */
  private route(filePath: string): Route | null {
    const info = this.getServerForFile(filePath);
    if (!info) return null;
    const root = findProjectRoot(this.workspace, filePath, info.root);
    return { info, root, key: `${info.cmd}\0${(info.args ?? []).join("\0")}\0${root}` };
  }

  /** The project root a server for `filePath` runs for, as `status()` names it; null when no server is configured for it. */
  public rootFor(filePath: string): string | null {
    const route = this.route(filePath);
    return route ? rootLabel(this.workspace, route.root) : null;
  }

  private known({ info, root, key }: Route, known: KnownFailure): NoAnswer {
    return noAnswer(known.cause.message, { server: info.cmd, root: rootLabel(this.workspace, root), state: "failed", forMs: Date.now() - known.cause.at, detail: known.cause.message, cause: known.cause, crashes: this.crashes.get(key) ?? 0 });
  }

  /** Counts a query on `client`; `done` ends it. */
  private hold(client: LspClient, info: LspServerSpec): { client: LspClient; info: LspServerSpec; done: () => void } {
    this.inUse.set(client, (this.inUse.get(client) ?? 0) + 1);
    let ended = false;
    return {
      client,
      info,
      done: () => {
        if (ended) return;
        ended = true;
        const left = (this.inUse.get(client) ?? 1) - 1;
        if (left > 0) this.inUse.set(client, left);
        else this.inUse.delete(client);
      },
    };
  }

  /**
   * The running client for the file's server, started if need be, or why there is none. A start that failed is not
   * tried again on every call (LSP_START_FAILURE_RECHECK_MS, or a changed PATH); a server that crashed is started again,
   * after a pause that doubles, up to LSP_MAX_RESTARTS times. The client comes held (`hold`): the caller calls `done`
   * when its query has ended.
   */
  private async acquire(filePath: string): Promise<{ client: LspClient; info: LspServerSpec; done: () => void } | NoAnswer> {
    if (typeof filePath !== "string" || filePath.trim() === "" || filePath.includes("\0")) return { reason: `${PATH_FORM}.` };
    const route = this.route(filePath);
    if (!route) return { reason: `No LSP server configured for ${filePath}.` };
    const refused = this.refusal();
    if (refused) return { reason: refused };
    this.closed = false;
    LspBridgeManager.live.add(this);
    const { info, key } = route;
    const t = this.timingsFor(filePath);
    const pathNow = process.env.PATH ?? "";

    const known = this.failures.get(key);
    if (known) {
      if (known.path === pathNow && Date.now() < known.recheckAt) return this.known(route, known);
      this.failures.delete(key);
      if (known.path !== pathNow) this.crashes.delete(key); // the environment changed (an install, a repair): start over
    }
    const afterStart = (client: LspClient | null) => {
      if (client) return this.hold(client, info);
      const admissionRefusal = this.admissionRefusals.get(key);
      if (admissionRefusal) return { reason: admissionRefusal };
      const failed = this.failures.get(key);
      return failed ? this.known(route, failed) : { reason: `Language server '${info.cmd}' was stopped before it had started.` };
    };

    const existing = this.clients.get(key);
    if (existing?.initialized) {
      // Most recently used: last in the order the cap evicts in.
      this.clients.delete(key);
      this.clients.set(key, existing);
      return this.hold(existing, info);
    }
    const inFlight = this.starting.get(key);
    if (inFlight) return afterStart(await inFlight);

    if (existing) {
      // It ran and is gone.
      this.clients.delete(key);
      const cause = existing.failure;
      if (cause?.kind === "crashed" || cause?.kind === "message_too_large") {
        const count = (this.crashes.get(key) ?? 0) + 1;
        this.crashes.set(key, count);
        const how = cause.kind === "message_too_large" ? "a message over the size limit" : cause.signal ? `killed by ${cause.signal}` : typeof cause.exitCode === "number" ? `exit code ${cause.exitCode}` : "it stopped working";
        let failure: KnownFailure | undefined;
        if (count > t.maxRestarts) {
          failure = { cause: { ...cause, kind: "crash_loop", message: `Language server '${info.cmd}' crashed ${count} times (last: ${how}); not restarting until PATH changes or Nexus is restarted.` }, path: pathNow, recheckAt: Infinity };
        } else {
          const restartAt = cause.at + t.restartBackoffMs * 2 ** (count - 1);
          const what = cause.kind === "message_too_large" ? "was stopped for sending a message over the size limit" : `crashed (${how})`;
          if (Date.now() < restartAt) failure = { cause: { ...cause, message: `Language server '${info.cmd}' ${what}; it is restarted by the next query after ${seconds(restartAt - cause.at)}.` }, path: pathNow, recheckAt: restartAt };
        }
        if (failure) {
          this.failures.set(key, failure);
          return this.known(route, failure);
        }
      }
    }

    // No server is started for a file it could not be asked about (the client checks again, for every query).
    if (!this.askable(filePath)) return { reason: unreadable(filePath).message };

    // The cap on live servers: at the limit, the least recently used one that is answering nothing is stopped first,
    // and the new one starts when that process is gone, so there are never more than the limit. Decided here, in one
    // turn with the bookkeeping below, so two calls cannot both take the last place.
    let room: Promise<void> | undefined;
    let idleToEvict: [string, LspClient] | undefined;
    if (this.clients.size + this.launching.size >= this.limits.servers) {
      const idle = [...this.clients].find(([, c]) => !this.inUse.has(c));
      if (!idle) return { reason: `The limit of ${this.limits.servers} running language servers is reached and each is answering a query or starting; ask again when one has finished.` };
      idleToEvict = idle;
    }

    const client = new LspClient(info.cmd, route.root, info.args ?? [], info.env, info.awaitProgress === true, t, info.installHint, this.limits, this.workspace);
    this.launching.set(key, client);
    this.admissionRefusals.delete(key);
    const startup = (async (): Promise<LspClient | null> => {
      try {
        if (this.sharedAdmission && idleToEvict) {
          this.clients.delete(idleToEvict[0]);
          room = this.stop(idleToEvict[1]);
          await room;
        }
        let lease: ResourceSlotLease | null = null;
        if (this.sharedAdmission) {
          lease = this.sharedAdmission.acquireNamed("lsp-server-processes-v1", this.sharedServerLimit, "LSP server process");
          if (!lease && idleToEvict) {
            // The local idle process may itself have filled the shared cap. Releasing it is safe; retry only after exit.
            this.clients.delete(idleToEvict[0]);
            room ??= this.stop(idleToEvict[1]);
            await room;
            lease = this.sharedAdmission.acquireNamed("lsp-server-processes-v1", this.sharedServerLimit, "LSP server process");
          }
          if (!lease) {
            const reason = `The shared limit of ${this.sharedServerLimit} language server processes across Nexus clients is reached; ask again when one has finished.`;
            this.admissionRefusals.set(key, reason);
            return null;
          }
          client.setAdmissionLease(lease);
        } else if (idleToEvict) {
          this.clients.delete(idleToEvict[0]);
          room = this.stop(idleToEvict[1]);
          await room;
        }
        await client.start();
        if (this.closed) {
          void this.stop(client);
          return null;
        }
        this.clients.set(key, client);
        return client;
      } catch (error) {
        // Admission failures are operational refusals, not a failed language-server start; a later query may retry.
        if (this.sharedAdmission && !client.failure) {
          const message = error instanceof Error ? error.message : "unknown admission error";
          this.admissionRefusals.set(key, `Language server admission could not be established: ${message}.`);
        }
        void this.stop(client);
        if (client.failure) this.failures.set(key, { cause: client.failure, path: pathNow, recheckAt: Date.now() + t.startRecheckMs });
        return null;
      }
    })().finally(() => {
        this.starting.delete(key);
        this.launching.delete(key);
        this.release();
      });
    this.starting.set(key, startup);
    return afterStart(await startup);
  }

  public async getClientForFile(filePath: string): Promise<LspClient | null> {
    const got = await this.acquire(filePath);
    if (!("client" in got)) return null;
    got.done();
    return got.client;
  }

  /**
   * The state of the file's server, without starting or stopping anything; null when no server is configured for it.
   * A gate's refusal is reported as `not_started` with the refusal as the detail. `root`: the project root the server
   * runs for, or would.
   */
  public serverStatus(filePath: string): LspServerStatus | null {
    const route = this.route(filePath);
    if (!route) return null;
    const { info, key } = route;
    const root = rootLabel(this.workspace, route.root);
    const refused = this.gate?.() ?? null;
    if (refused) return { server: info.cmd, root, state: "not_started", forMs: 0, detail: refused };
    const crashes = this.crashes.get(key) ?? 0;
    const known = this.failures.get(key);
    if (known) return { ...this.known(route, known).state!, crashes };
    const client = this.clients.get(key) ?? this.launching.get(key);
    if (client) return { ...client.status(), crashes };
    return { server: info.cmd, root, state: this.closed ? "stopped" : "not_started", forMs: 0, crashes };
  }

  /**
   * Starts the file's server, if the gate allows one, and opens that one file so the server loads its project
   * (typescript-language-server and pyright load a project only for an open document); nothing is asked. It returns
   * once the server has answered `initialize` (or failed to), with its state: indexing goes on after that, so a first
   * query made later finds a server that is ready, or says how long it has been indexing.
   */
  public async warmUp(filePath: string): Promise<LspServerStatus | null> {
    const got = await this.acquire(filePath);
    if ("client" in got) {
      got.client.prepare(filePath, got.info.languageId);
      got.done();
    }
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
    } finally {
      got.done();
    }
  }

  public serverPids(): number[] {
    return [...this.clients.values()].map((c) => c.pid()).filter((p): p is number => typeof p === "number");
  }

  private static notReady(what: string, state: LspServerStatus): NoAnswer {
    return noAnswer(`Language server '${state.server}' is still indexing after ${seconds(state.forMs)} (${state.detail}) and has ${what} yet; this does not mean there is none. Ask again shortly.`, state);
  }

  /** Why a position cannot be asked about, or the position. Checked before anything is started or asked. */
  private static position(line: unknown, character: unknown): { line: number; character: number } | string {
    const l = positiveInteger(line);
    const c = positiveInteger(character);
    if (l !== null && c !== null) return { line: l, character: c };
    const got = (v: unknown): string => (v === undefined ? "nothing" : (JSON.stringify(v) ?? String(v)).slice(0, 40));
    return `${POSITION_FORM}; got line ${got(line)}, character ${got(character)}.`;
  }

  public async hover(filePath: string, line: number, character: number, signal?: AbortSignal): Promise<LspHoverResult> {
    const at = LspBridgeManager.position(line, character);
    if (typeof at === "string") return { found: false, error: at };
    const got = await this.acquire(filePath);
    if (!("client" in got)) {
      const { reason, ...rest } = got;
      return { found: false, error: reason, ...rest };
    }
    try {
      const { text, notReady } = await got.client.getHover(filePath, got.info.languageId, at.line, at.character, signal);
      if (text) return { found: true, hoverText: text, fenced: fenceUntrusted(`lsp hover for ${filePath}:${at.line}:${at.character}`, text) };
      if (!notReady) return { found: false, answered: true, hoverText: `No hover information at ${filePath}:${at.line}:${at.character}: the language server answered and has nothing for this position.` };
      const { reason, ...rest } = LspBridgeManager.notReady(`no hover information for ${filePath}:${at.line}:${at.character}`, notReady);
      return { found: false, error: reason, ...rest };
    } catch (err: any) {
      return { found: false, error: err.message };
    } finally {
      got.done();
    }
  }

  public async definition(filePath: string, line: number, character: number, signal?: AbortSignal): Promise<LspDefinitionResult> {
    const at = LspBridgeManager.position(line, character);
    if (typeof at === "string") return { found: false, error: at };
    const got = await this.acquire(filePath);
    if (!("client" in got)) {
      const { reason, ...rest } = got;
      return { found: false, error: reason, ...rest };
    }
    try {
      const { targets, omitted, notReady } = await got.client.getDefinition(filePath, got.info.languageId, at.line, at.character, signal);
      if (targets.length > 0) return { found: true, locations: targets, ...(omitted > 0 ? { omitted } : {}) };
      if (!notReady) return { found: false, answered: true, locations: [], message: `No definition found for ${filePath}:${at.line}:${at.character}: the language server answered and has nothing to go to from this position.` };
      const { reason, ...rest } = LspBridgeManager.notReady(`no definition for ${filePath}:${at.line}:${at.character}`, notReady);
      return { found: false, error: reason, ...rest };
    } catch (err: any) {
      return { found: false, error: err.message };
    } finally {
      got.done();
    }
  }

  /**
   * Stops every server, running or still starting, and resolves when their processes are gone (`LspClient.shutdown`:
   * bounded, never rejects). A second call waits for the same stops. A caller that cannot wait may drop the promise:
   * the stops go on, and the exit backstop kills whatever is left when the process ends first.
   */
  public shutdownAll(): Promise<void> {
    this.closed = true;
    for (const client of [...this.clients.values(), ...this.launching.values()]) void this.stop(client);
    this.clients.clear();
    this.release();
    return Promise.all(this.stopping.values()).then(() => {});
  }
}
