import { commandSucceeded, runArgv } from "./command.mjs";
import { evaluatorResult } from "./result.mjs";

/** Run a configured build argv vector and score strictly by its exit result. */
export async function evaluateBuild({ command, args = [], cwd, timeoutMs, runner = runArgv }) {
  if (typeof command !== "string" || !command || !Array.isArray(args)) throw new TypeError("build command and args are required");
  let run;
  try { run = await runner(command, args, { cwd, timeoutMs }); }
  catch (error) { run = { status: null, error: String(error?.message ?? error) }; }
  const passed = commandSucceeded(run);
  return evaluatorResult("build", passed, passed ? 1 : 0, { command, args, status: run.status ?? null, signal: run.signal ?? null, timedOut: run.timedOut === true, error: run.error ?? null });
}
