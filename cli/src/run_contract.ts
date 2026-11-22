/**
 * PF-2: the machine contract of `nexus run`: the JSON document `--json` prints, the process exit codes, and the task
 * input read from `--input-json` or stdin. The published schema (docs/protocol/run-result-v1.schema.json) is generated
 * from the types here by scripts/gen_run_result_schema.mjs; docs/USER_MANUAL.md documents the exit codes from the table
 * below, and test/run_json_contract.test.ts fails when either falls behind.
 */
import fs from "node:fs";
import type { TaskExecutionResult } from "./core/app.js";
import type { EngineeringOutcome, ExecutionState } from "./core/turn.js";
import type { UsageTotals } from "./usage.js";

/**
 * Version of the document `nexus run --json` prints. Adding an optional member keeps the version; removing or renaming
 * a member, or changing a member's type or meaning, bumps it. Every change is recorded in
 * docs/protocol/RUN_RESULT_VERSIONS.json.
 */
export const RUN_RESULT_SCHEMA_VERSION = 1;

/** Printed when the task ran to an ending (whatever the ending): the task result with the contract version first. */
export interface RunJsonResult extends TaskExecutionResult {
  /** Version of this document's schema. Always the first member. */
  schema_version: typeof RUN_RESULT_SCHEMA_VERSION;
  /** Cloud provider usage of this process; present only when at least one cloud request was made. */
  cloudUsage?: UsageTotals;
}

/**
 * Printed instead of a result when the run threw before producing one (for example `--resume` of a task that does not
 * exist). It has no `turn` and no `exitCode`: read the process exit code.
 */
export interface RunJsonError {
  /** Version of this document's schema. Always the first member. */
  schema_version: typeof RUN_RESULT_SCHEMA_VERSION;
  taskId: string;
  success: false;
  status: "failed";
  prompt: string;
  output: string;
  plan: TaskExecutionResult["plan"];
  milestones: TaskExecutionResult["milestones"];
  validationReceipts: TaskExecutionResult["validationReceipts"];
  tokenStats: TaskExecutionResult["tokenStats"];
  durationMs: number;
  /** Why the run failed (redacted). */
  error: string;
}

/** The one JSON document `nexus run --json` writes to stdout. A result has `turn`; an error document does not. */
export type RunJsonOutput = RunJsonResult | RunJsonError;

/** The document for a finished task: `schema_version` first, every result member unchanged, `cloudUsage` when cloud requests were made. */
export function runJsonResult(result: TaskExecutionResult, cloud?: UsageTotals): RunJsonResult {
  return { schema_version: RUN_RESULT_SCHEMA_VERSION, ...result, ...(cloud?.requests ? { cloudUsage: cloud } : {}) };
}

export interface RunExitCode {
  code: number;
  name: string;
  when: string;
}

/**
 * Every exit code of `nexus run`, one row per condition. A code can appear in several rows (2 does): the exit code
 * alone does not tell those conditions apart, the JSON document does. The "Exit codes" table in docs/USER_MANUAL.md is
 * this table.
 */
export const RUN_EXIT_CODES = [
  { code: 0, name: "ok", when: "The task completed and its changes were verified (`VERIFIED`), or it changed nothing that needs verifying (`NOT_REQUIRED`)." },
  { code: 1, name: "failed", when: "Any other ending: the task failed, was blocked (a question for the operator, a capacity or convergence stop), reached a limit, or completed without establishing a result; or the run threw an error." },
  { code: 1, name: "missing_prompt", when: "No task was given as an argument and `--resume` was not used (with a terminal on stdin and no `--input-json`)." },
  { code: 1, name: "option_parse", when: "The command line could not be parsed: an unknown option or an option without its value (the option parser exits before the command runs)." },
  { code: 2, name: "unverified", when: "The task completed but nothing verifies the change (`UNVERIFIED`), or the tests passed without covering it (`REGRESSION_FREE`)." },
  { code: 2, name: "usage", when: "A usage error before the run started: an invalid option value or combination, or an invalid, oversized or empty `--input-json` or stdin task." },
  { code: 2, name: "resume_unavailable", when: "`--resume` found no task in the workspace, or `--fork-session` could not make the copy." },
  { code: 2, name: "task_not_found", when: "The task named by `--resume <id>` has no saved state." },
  { code: 130, name: "interrupted", when: "The task was interrupted (SIGINT). A second SIGINT exits at once with this code and may leave no JSON document." },
] as const satisfies readonly RunExitCode[];

export type RunExitName = (typeof RUN_EXIT_CODES)[number]["name"];

export function runExitCode(name: RunExitName): number {
  return RUN_EXIT_CODES.find((row) => row.name === name)!.code;
}

/** The exit-code row of a turn that did not complete, by execution state. A new state does not compile until its row is decided. */
export const RUN_EXIT_FOR_EXECUTION: Record<Exclude<ExecutionState, "COMPLETED">, RunExitName> = {
  INTERRUPTED: "interrupted",
  FAILED: "failed",
  BLOCKED: "failed",
  LIMIT_REACHED: "failed",
};

/** The exit-code row of a completed turn, by outcome. A new outcome does not compile until its row is decided. */
export const RUN_EXIT_FOR_COMPLETED_OUTCOME: Record<EngineeringOutcome, RunExitName> = {
  VERIFIED: "ok",
  NOT_REQUIRED: "ok",
  UNVERIFIED: "unverified",
  REGRESSION_FREE: "unverified",
  NOT_ESTABLISHED: "failed",
};

/** The table's row for a turn. `exitCodeForTurn` (core/turn.ts) computes the code itself; a test pins the two together. */
export function runExitNameForTurn(turn: { execution: ExecutionState; outcome: EngineeringOutcome }): RunExitName {
  return turn.execution === "COMPLETED" ? RUN_EXIT_FOR_COMPLETED_OUTCOME[turn.outcome] : RUN_EXIT_FOR_EXECUTION[turn.execution];
}

/** Version of the `--input-json` document. */
export const RUN_INPUT_SCHEMA_VERSION = 1;
/** Largest task input accepted from `--input-json` or stdin, in bytes. A larger input is rejected, never truncated. */
export const RUN_INPUT_MAX_BYTES = 1024 * 1024;

/** Reads a whole stream as UTF-8 text, refusing more than RUN_INPUT_MAX_BYTES. */
async function readBounded(stream: AsyncIterable<Buffer | string>, what: string): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += piece.length;
    if (bytes > RUN_INPUT_MAX_BYTES) throw new Error(`${what} is larger than ${RUN_INPUT_MAX_BYTES} bytes`);
    chunks.push(piece);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error(`${what} is not valid UTF-8`);
  }
}

/**
 * The task of an `--input-json` document: `{ "schema_version": 1, "task": "<text>" }`. Only `task` is read. Every other
 * member is ignored, so the document cannot set the approval mode, sandbox, endpoint, credentials or workspace: those
 * stay with the command line and the operator's configuration.
 */
export function parseRunInput(text: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("--input-json: the input is not valid JSON");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("--input-json: the input must be a JSON object");
  const { schema_version: version, task } = doc as Record<string, unknown>;
  if (version !== RUN_INPUT_SCHEMA_VERSION) {
    throw new Error(`--input-json: ${version === undefined ? "schema_version is missing" : `unsupported schema_version ${JSON.stringify(version)}`} (this nexus reads schema_version ${RUN_INPUT_SCHEMA_VERSION})`);
  }
  if (typeof task !== "string" || !task.trim()) throw new Error('--input-json: "task" must be a non-empty string');
  return task.trim();
}

export interface RunTaskSource {
  /** The task given as command-line arguments, joined and trimmed; empty when none. */
  prompt: string;
  /** The value of `--input-json`: a file path, or `-` for stdin. */
  inputJson?: string;
  /** `--resume` or `--fork-session` is in effect: a missing task is allowed and stdin is not read for one. */
  resuming: boolean;
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean };
}

/**
 * The task text of a run. An argument wins when it is the only source; `--input-json` supplies it from a document;
 * otherwise, when not resuming and stdin is not a terminal, stdin is the task as plain text. Throws a usage error
 * (exit code `usage`) for a conflict or an invalid input. Returns "" when no source applies (a terminal on stdin, or a
 * resume): the caller keeps its existing handling of a missing task.
 */
export async function resolveRunTask(source: RunTaskSource): Promise<string> {
  if (source.inputJson !== undefined) {
    if (source.prompt) throw new Error("give the task either as an argument or with --input-json, not both");
    if (source.inputJson === "-") return parseRunInput(await readBounded(source.stdin, "--input-json: the input"));
    let text: string;
    try {
      text = await readBounded(fs.createReadStream(source.inputJson), "--input-json: the input");
    } catch (err: any) {
      if (!err?.code) throw err;
      throw new Error(`--input-json: cannot read ${source.inputJson} (${err.code})`);
    }
    return parseRunInput(text);
  }
  if (source.prompt || source.resuming || source.stdin.isTTY) return source.prompt;
  const task = (await readBounded(source.stdin, "the task on stdin")).trim();
  if (!task) throw new Error("no task: stdin was empty (give the task as an argument, on stdin, or with --input-json)");
  return task;
}
