/**
 * HK-1: runs one command hook as a subprocess and reduces what it answered to a decision.
 *
 * The process gets the event as one JSON object on standard input, a scrubbed environment (no credentials of the
 * Nexus process), its own process group and a hard deadline. Its answer can only deny: `reduceHookOutput` has no
 * path from any output to "admit what was refused", and everything that goes wrong is a denial.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { buildMcpEnvironment } from "../mcp.js";
import type { HookDenialReason, HookEvent, HookSource } from "./hooks.js";
import { ProcessTreeMemory } from "./process_identity.js";
import { parseStrictJson } from "./strict_json.js";
import { withoutUnprintable } from "./printable.js";

/**
 * Expand a leading `~/` in an argv command to an absolute path under the operator home.
 * Callers must expand before `runHookProcess`: the runner never joins `os.homedir()` into the
 * spawn executable (CodeQL js/shell-command-injection-from-environment).
 */
export function expandHookArgv(command: string[], home = os.homedir()): string[] | { problem: string } {
  if (command.length === 0) return { problem: "hook command argv is empty" };
  const exe = command[0]!;
  if (exe !== "~" && !exe.startsWith("~/")) return command;
  const homeRoot = path.resolve(home);
  const rest = exe === "~" ? "" : exe.slice(2);
  const resolved = path.resolve(homeRoot, rest);
  const relative = path.relative(homeRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { problem: `hook command '${exe}' escapes the home directory` };
  }
  return [resolved, ...command.slice(1)];
}

export const HOOK_STDOUT_LIMIT = 64 * 1024;
export const HOOK_STDERR_LIMIT = 8 * 1024;
/** Time a hook gets after SIGTERM before it and everything it started is killed. */
export const HOOK_KILL_GRACE_MS = 2_000;
/** Time a hook's output pipes may stay open after it exited (something it started still holds them). */
export const HOOK_DRAIN_MS = 2_000;
const REASON_LIMIT = 1000;

export type HookFailure = "spawn" | "timeout" | "stdout_oversize" | "stderr_oversize" | "output_left_open";

export interface HookProcessResult {
  exit: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Set when the run did not end as an ordinary exit with complete, bounded output. */
  failure?: HookFailure;
  detail?: string;
  durationMs: number;
}

export interface HookProcessRequest {
  /** A string runs under `/bin/sh -c`; an array is executed directly. */
  command: string | string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  killGraceMs?: number;
  drainMs?: number;
}

/** The environment of a hook: the MCP server scrubber's safe variables plus the hook's own, and nothing else. */
export function hookEnvironment(hook: { event: HookEvent; name: string; source: HookSource; workspace: string }): Record<string, string> {
  const env = buildMcpEnvironment({
    NEXUS_HOOK_EVENT: hook.event,
    NEXUS_HOOK_NAME: hook.name,
    NEXUS_HOOK_SOURCE: hook.source,
    NEXUS_PROJECT_DIR: hook.workspace,
    CLAUDE_PROJECT_DIR: hook.workspace,
  });
  // Where node looks for modules: a value that leads into the workspace would load its code into a hook.
  delete env.NODE_PATH;
  return env;
}

/** One line, bounded: what a hook said, safe to show and to store. */
export function hookLine(text: string, limit = REASON_LIMIT): string {
  const line = withoutUnprintable(text).replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** The hooks running now, each as "kill its process group". One process listener serves them all, however many run. */
const running = new Set<() => void>();
let exitListening = false;
function killOnProcessExit(kill: () => void): () => void {
  if (!exitListening) {
    exitListening = true;
    process.on("exit", () => {
      for (const each of running) each();
    });
  }
  running.add(kill);
  return () => running.delete(kill);
}

/** Runs the hook to its end. Never rejects: every way a run can go wrong is a `failure` on the result. */
export function runHookProcess(request: HookProcessRequest): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const killGraceMs = request.killGraceMs ?? HOOK_KILL_GRACE_MS;
    // Fixed interpreter for shell form; argv form must already be absolute or a PATH name (no `~/` here).
    let file: string;
    let args: string[];
    if (typeof request.command === "string") {
      file = "/bin/sh";
      args = ["-c", request.command];
    } else {
      const exe = request.command[0] ?? "";
      if (!exe) {
        resolve({ exit: null, signal: null, stdout: "", stderr: "", failure: "spawn", detail: "hook command argv is empty", durationMs: 0 });
        return;
      }
      if (exe === "~" || exe.startsWith("~/")) {
        resolve({
          exit: null,
          signal: null,
          stdout: "",
          stderr: "",
          failure: "spawn",
          detail: "hook argv still starts with '~/'; expand with expandHookArgv before runHookProcess",
          durationMs: 0,
        });
        return;
      }
      file = exe;
      args = request.command.slice(1);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let failure: HookFailure | undefined;
    let detail: string | undefined;
    let settled = false;
    let exited: { code: number | null; signal: string | null } | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let drainNote: NodeJS.Timeout | undefined;
    const tree = new ProcessTreeMemory();

    let child: ReturnType<typeof spawn>;
    try {
      // shell:false — argv only; string commands use fixed /bin/sh (never an env-derived absolute executable).
      child = spawn(file, args, { cwd: request.cwd, env: request.env, detached: true, stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (error) {
      resolve({ exit: null, signal: null, stdout: "", stderr: "", failure: "spawn", detail: error instanceof Error ? error.message : String(error), durationMs: 0 });
      return;
    }

    // Once the hook has exited its pid may belong to another process: it is then neither signalled nor searched.
    const alivePid = () => (child.pid !== undefined && child.exitCode === null && child.signalCode === null ? child.pid : undefined);
    const signalAll = (name: NodeJS.Signals) => {
      const pid = alivePid();
      tree.remember(pid);
      if (pid !== undefined) {
        try {
          process.kill(-pid, name);
        } catch {
          // already gone
        }
      }
      // What left the group (its own session) is reached by pid, and only while it is still the process that was seen.
      tree.signal(name);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      clearTimeout(drainNote);
      forget();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exit: exited?.code ?? null,
        signal: exited?.signal ?? null,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        ...(failure ? { failure } : {}),
        ...(detail ? { detail } : {}),
        durationMs: Date.now() - started,
      });
    };
    const stop = (why: HookFailure) => {
      if (failure || settled) return;
      failure = why;
      signalAll("SIGTERM");
      killTimer = setTimeout(() => {
        signalAll("SIGKILL");
        // A killed process exits; this only covers a pid that can no longer be waited for.
        killTimer = setTimeout(finish, killGraceMs);
      }, killGraceMs);
    };
    const onProcessExit = () => {
      const pid = alivePid();
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    const deadline = setTimeout(() => stop("timeout"), request.timeoutMs);
    const forget = killOnProcessExit(onProcessExit);

    child.stdout!.on("data", (chunk: Buffer) => {
      if (failure) return;
      outBytes += chunk.length;
      if (outBytes > HOOK_STDOUT_LIMIT) return stop("stdout_oversize");
      out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (failure) return;
      errBytes += chunk.length;
      if (errBytes > HOOK_STDERR_LIMIT) return stop("stderr_oversize");
      err.push(chunk);
    });
    // A hook that does not read its input closes the pipe early; that is its choice, not an error.
    child.stdin!.on("error", () => {});
    child.stdin!.end(request.stdin);

    child.once("error", (error) => {
      failure ??= "spawn";
      detail = error.message;
      finish();
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (failure) {
        // The hook is over; what it started and left behind is not given the rest of the grace period.
        clearTimeout(killTimer);
        tree.remember(undefined);
        tree.signal("SIGKILL");
        return finish();
      }
      // Output may still be in the pipe. If something the hook started keeps the pipe open, the answer cannot be known
      // to be complete, and an incomplete answer must not read as "no objection".
      const drainMs = request.drainMs ?? HOOK_DRAIN_MS;
      // The pipes normally close at once. When they have not after a moment, what the hook left in its process group
      // is noted while the group still exists, each with its start time, so that it can be ended by pid below.
      let noted = false;
      const note = () => {
        noted = true;
        if (child.pid !== undefined) tree.rememberGroup(child.pid);
        tree.remember(undefined);
      };
      const noteTimer = setTimeout(note, Math.min(50, drainMs));
      drainTimer = setTimeout(() => {
        clearTimeout(noteTimer);
        if (!noted) note();
        failure = "output_left_open";
        // The answer is refused, so nothing the hook started has a reason to go on running.
        tree.signal("SIGKILL");
        finish();
      }, drainMs);
      drainNote = noteTimer;
    });
    child.once("close", () => {
      if (exited) finish();
    });
  });
}

export interface HookVerdict {
  decision: "none" | "deny" | "ignored_allow" | "error";
  /** Set for `deny` and `error`. */
  denialReason?: Exclude<HookDenialReason, "HOOKS_CONFIG_INVALID">;
  reason?: string;
  ignored?: string[];
}

const DENY_DECISIONS = new Set(["block", "deny"]);
const ALLOW_DECISIONS = new Set(["approve", "allow"]);
const IGNORED_MEMBERS = ["updatedInput", "additionalContext", "suppressOutput", "systemMessage"];
const FAILURE_TEXT: Record<HookFailure, string> = {
  spawn: "the hook could not be started",
  timeout: "the hook did not finish in time and was stopped",
  stdout_oversize: `the hook wrote more than ${HOOK_STDOUT_LIMIT / 1024} KiB to standard output`,
  stderr_oversize: `the hook wrote more than ${HOOK_STDERR_LIMIT / 1024} KiB to standard error`,
  output_left_open: "the hook exited but something it started kept its output open, so its answer may be incomplete",
};

/**
 * What a finished hook run means. Pure. `deny` and `error` both refuse a tool call before it runs (`error` is the
 * fail-closed case); `none` and `ignored_allow` leave the call as the gates decided it. No result admits anything.
 */
export function reduceHookOutput(result: Pick<HookProcessResult, "exit" | "signal" | "stdout" | "stderr" | "failure" | "detail">): HookVerdict {
  const error = (reason: string, denialReason: HookVerdict["denialReason"] = "HOOK_FAILED"): HookVerdict => ({ decision: "error", denialReason, reason: hookLine(reason) });
  if (result.failure) return error(`${FAILURE_TEXT[result.failure]}${result.detail ? ` (${result.detail})` : ""}`);
  if (result.signal) return error(`the hook was ended by ${result.signal}`);
  if (result.exit === 2) return { decision: "deny", denialReason: "HOOK_DENIED", reason: hookLine(result.stderr) || "the hook exited with status 2" };
  if (result.exit !== 0) return error(`the hook exited with status ${result.exit}`);

  const text = result.stdout.trim();
  if (!text) return { decision: "none" };
  if (!text.startsWith("{")) return { decision: "none", reason: hookLine(text) };
  let answer: Record<string, unknown>;
  try {
    // The strict parser: with a repeated "decision" key, which one counts must not depend on the parser.
    answer = parseStrictJson(text, { maxDepth: 32 }) as Record<string, unknown>;
  } catch (problem) {
    return error(`the hook's output is not a valid JSON object: ${problem instanceof Error ? problem.message : String(problem)}`, "HOOK_OUTPUT_INVALID");
  }
  const specific = answer.hookSpecificOutput;
  if (specific !== undefined && (specific === null || typeof specific !== "object" || Array.isArray(specific))) return error("the hook's hookSpecificOutput is not an object", "HOOK_OUTPUT_INVALID");
  const nested = (specific ?? {}) as Record<string, unknown>;
  const text1 = (value: unknown) => (typeof value === "string" && value.trim() ? hookLine(value) : undefined);

  const ignored = [
    ...IGNORED_MEMBERS.filter((key) => key in answer),
    ...IGNORED_MEMBERS.filter((key) => key in nested).map((key) => `hookSpecificOutput.${key}`),
  ];
  const withIgnored = (verdict: HookVerdict): HookVerdict => (ignored.length ? { ...verdict, ignored } : verdict);
  const deny = (reason: string | undefined, fallback: string): HookVerdict => withIgnored({ decision: "deny", denialReason: "HOOK_DENIED", reason: reason ?? fallback });

  const { decision } = answer;
  const permission = nested.permissionDecision;
  // A denial anywhere in the answer wins over an allow anywhere else in it.
  if (typeof decision === "string" && DENY_DECISIONS.has(decision)) return deny(text1(answer.reason), `the hook answered ${decision}`);
  if (permission === "deny") return deny(text1(nested.permissionDecisionReason) ?? text1(answer.reason), "the hook answered deny");
  if (permission === "ask") return deny(text1(nested.permissionDecisionReason), "a hook asked for a human; this version treats ask as deny");
  if (answer.continue === false) return deny(text1(answer.stopReason) ?? text1(answer.reason), "the hook answered continue: false");
  // A decision this version does not know cannot be read as "no objection".
  if (decision !== undefined && !(typeof decision === "string" && ALLOW_DECISIONS.has(decision))) return withIgnored(error(`the hook's decision ${hookLine(JSON.stringify(decision), 80)} is not one of block, deny, approve, allow`, "HOOK_OUTPUT_INVALID"));
  if (permission !== undefined && permission !== "allow") return withIgnored(error(`the hook's permissionDecision ${hookLine(JSON.stringify(permission), 80)} is not one of allow, deny, ask`, "HOOK_OUTPUT_INVALID"));
  if (answer.continue !== undefined && answer.continue !== true) return withIgnored(error("the hook's continue is not true or false", "HOOK_OUTPUT_INVALID"));
  if (decision !== undefined || permission !== undefined) return withIgnored({ decision: "ignored_allow" });
  return withIgnored({ decision: "none" });
}

/** SHA-256 of a hook's standard output: the receipt names what was said without keeping it. */
export function hookOutputDigest(stdout: string): string {
  return createHash("sha256").update(stdout).digest("hex");
}
