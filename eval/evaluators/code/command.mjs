import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedProcessArgv, runIsolatedProcess, sandboxAvailable } from "../../isolate.mjs";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const SYSTEM_COMMAND_DIRS = ["/usr/bin", "/bin"];

function resolveCommand(command, cwd) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return fs.realpathSync(path.isAbsolute(command) ? command : path.resolve(cwd, command));
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
  return async (command, args = [], { cwd, timeoutMs = 120_000 } = {}) => {
    if (typeof command !== "string" || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new TypeError("command and string argv are required");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");

    let temporaryCwd;
    try {
      const workingDirectory = cwd ? fs.realpathSync(cwd) : (temporaryCwd = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-evaluator-command-")));
      if (!hasSandbox()) throw new Error("Bubblewrap is unavailable; refusing to execute candidate commands");
      const runtimeCommand = resolveCommand(command, workingDirectory);
      const spec = buildSpec({
        cwd: workingDirectory,
        command: runtimeCommand,
        argv: args,
        readOnlyPaths: [runtimeCommand],
        allowedFiles: [runtimeCommand],
        timeoutMs,
      });
      const result = await runProcess(spec, { outputLimit: OUTPUT_LIMIT });
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
