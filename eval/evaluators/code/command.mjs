import { spawnSync } from "node:child_process";

/** Execute a fixed argv vector without a shell and with a bounded timeout. */
export function runArgv(command, args = [], { cwd, timeoutMs = 120_000, env } = {}) {
  if (typeof command !== "string" || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("command and string argv are required");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
  const safeEnv = env ?? {
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  const result = spawnSync(command, args, { cwd, env: safeEnv, timeout: timeoutMs, encoding: "utf8", shell: false, maxBuffer: 4 * 1024 * 1024 });
  return {
    status: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error ? result.error.message : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function commandSucceeded(result) {
  return result?.status === 0 && result?.signal == null && result?.timedOut !== true && result?.error == null;
}
