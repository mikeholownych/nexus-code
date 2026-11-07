import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedProcessArgv, runIsolatedProcess, sandboxAvailable } from "../../isolate.mjs";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const SYSTEM_COMMAND_DIRS = ["/usr/bin", "/bin"];
const PRLIMIT = "/usr/bin/prlimit";
/** Largest single file a command may write (RLIMIT_FSIZE). Total disk and memory come from the resource contract. */
const DEFAULT_MAX_FILE_BYTES = 1024 ** 3;

function resolveCommand(command, cwd) {
  if (path.isAbsolute(command)) return fs.realpathSync(command);
  if (command.includes(path.sep)) {
    // A relative command is part of the candidate tree: it must stay there after `..` and symlinks resolve.
    const resolved = fs.realpathSync(path.resolve(cwd, command));
    if (resolved !== cwd && !resolved.startsWith(`${cwd}${path.sep}`)) throw new Error(`command resolves outside the workspace: ${command}`);
    return resolved;
  }
  for (const directory of SYSTEM_COMMAND_DIRS) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error(`command is not present in the isolated runtime: ${command}`);
}

/** Create an argv-only evaluator runner with injectable isolation checks for deterministic tests. */
export function createContainedRunner(dependencies = {}) {
  const hasSandbox = dependencies.sandboxAvailable ?? sandboxAvailable;
  const buildSpec = dependencies.isolatedProcessArgv ?? isolatedProcessArgv;
  const runProcess = dependencies.runIsolatedProcess ?? runIsolatedProcess;
  const hasPrlimit = dependencies.prlimitAvailable ?? (() => fs.existsSync(PRLIMIT));
  return async (command, args = [], { cwd, timeoutMs = 120_000, resources = null, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) => {
    if (typeof command !== "string" || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new TypeError("command and string argv are required");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new RangeError("maxFileBytes must be a positive integer");

    let temporaryCwd;
    try {
      const workingDirectory = cwd ? fs.realpathSync(cwd) : (temporaryCwd = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-evaluator-command-")));
      if (!hasSandbox()) throw new Error("Bubblewrap is unavailable; refusing to execute candidate commands");
      const runtimeCommand = resolveCommand(command, workingDirectory);
      // Per-file write budget (and no core dumps) for the command and everything it starts. Memory, process count, CPU and
      // total disk are the resource contract's (cgroup) job: pass it through when the run has one.
      if (!hasPrlimit()) throw new Error("prlimit is unavailable; refusing to execute candidate commands without a file-size budget");
      const spec = buildSpec({
        cwd: workingDirectory,
        command: PRLIMIT,
        argv: [`--fsize=${maxFileBytes}`, "--core=0", "--", runtimeCommand, ...args],
        readOnlyPaths: [runtimeCommand],
        allowedFiles: [runtimeCommand],
        timeoutMs,
      });
      const result = await runProcess(spec, { outputLimit: OUTPUT_LIMIT, resources });
      const error = result.error ?? (result.overflow ? "candidate command exceeded the output limit" : result.containmentProblem ?? null);
      return {
        status: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal ?? null,
        timedOut: result.timedOut === true,
        error,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    } catch (error) {
      return { status: null, signal: null, timedOut: false, error: String(error?.message ?? error), stdout: "", stderr: "" };
    } finally {
      if (temporaryCwd) fs.rmSync(temporaryCwd, { recursive: true, force: true });
    }
  };
}

/** Execute a fixed argv vector inside a Bubblewrap workspace with bounded output, time, and process cleanup. */
export const runArgv = createContainedRunner();

export function commandSucceeded(result) {
  return result?.status === 0 && result?.signal == null && result?.timedOut !== true && result?.error == null;
}
