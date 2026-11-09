import fs from "node:fs";
import { spawnSync } from "node:child_process";

// The code evaluators (eval/evaluators/code/command.mjs) start every build and typecheck command through prlimit to cap
// single-file writes and disable core dumps, and refuse to run without it. prlimit is part of util-linux.
export const PRLIMIT = "/usr/bin/prlimit";

/** Why this host cannot run code-evaluator commands, or null. Dependencies are injectable for tests. */
export function prlimitProblem({ exists = (file) => fs.existsSync(file), run = (cmd, argv) => spawnSync(cmd, argv, { encoding: "utf8", timeout: 10_000 }) } = {}) {
  if (!exists(PRLIMIT)) return `${PRLIMIT} is missing (package util-linux); code-evaluator build and typecheck tasks cannot run`;
  const result = run(PRLIMIT, ["--fsize=1048576", "--core=0", "--", "/usr/bin/true"]);
  if (result.status !== 0 || result.error) return `prlimit could not apply a file-size limit (${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`})`;
  return null;
}
