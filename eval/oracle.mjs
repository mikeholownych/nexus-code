// Black-box qualification oracle: expected values stay in the evaluator process and are never mounted into candidate
// execution. The candidate receives one public input at a time and returns JSON for comparison by this parent.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { confinedPath } from "./isolate.mjs";
import { isolatedProcessArgv, runIsolatedProcess } from "./isolate.mjs";

const RUNTIMES = Object.freeze({ node: process.execPath, python3: "/usr/bin/python3" });
const MAX_ORACLE_BYTES = 1_048_576;
const MAX_CASES = 256;
const MAX_CASE_BYTES = 16_384;
const MAX_OUTPUT_BYTES = 32_768;
const MAX_TIMEOUT_MS = 30_000;
const MAX_TOTAL_TIMEOUT_MS = 300_000;

/** Validate a frozen black-box oracle definition without exposing its case contents in diagnostics. */
export function blackBoxOracleProblem(check, taskDir, candidateFixture = null) {
  if (!check || check.protocol !== "blackbox-v1") return "hidden oracle protocol must be blackbox-v1";
  if (Object.keys(check).some((key) => !["protocol", "casesFile", "runtime", "argv", "timeoutMs", "totalTimeoutMs", "maxOutputBytes"].includes(key))) {
    return "hidden black-box oracle has unsupported fields";
  }
  if (typeof check.casesFile !== "string") return "hidden black-box oracle casesFile is required";
  let casesPath;
  try { casesPath = confinedPath(taskDir, check.casesFile); }
  catch { return "hidden black-box oracle casesFile is unsafe"; }
  if (candidateFixture) {
    let fixturePath;
    try { fixturePath = confinedPath(taskDir, candidateFixture); }
    catch { return "candidate fixture path is unsafe"; }
    const relative = path.relative(fixturePath, casesPath);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return "hidden black-box oracle casesFile must be outside the candidate fixture";
    }
  }
  try {
    const stat = fs.statSync(casesPath);
    if (!stat.isFile() || stat.size > MAX_ORACLE_BYTES) return "hidden black-box oracle case file is not a bounded regular file";
    const rows = JSON.parse(fs.readFileSync(casesPath, "utf8"));
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_CASES) return "hidden black-box oracle case count is outside the allowed range";
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "expected,input") {
        return "hidden black-box oracle cases must contain only input and expected fields";
      }
      if (Buffer.byteLength(JSON.stringify(row), "utf8") > MAX_CASE_BYTES) return "hidden black-box oracle case exceeds the size limit";
    }
  } catch {
    return "hidden black-box oracle cases are unavailable or malformed";
  }
  if (!Object.hasOwn(RUNTIMES, check.runtime)) return "hidden black-box oracle runtime is not allowlisted";
  if (!Array.isArray(check.argv) || check.argv.length !== 1 || typeof check.argv[0] !== "string" || check.argv[0].includes("\0") || Buffer.byteLength(check.argv[0]) > 1024) {
    return "hidden black-box oracle argv must name only one candidate entrypoint";
  }
  const entrypoint = check.argv[0];
  if (path.posix.isAbsolute(entrypoint) || entrypoint.startsWith("-") || entrypoint.includes("\\") || entrypoint.split("/").some((part) => !part || part === "." || part === "..")) {
    return "hidden black-box oracle argv must be a normalized relative candidate entrypoint";
  }
  if (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > MAX_TIMEOUT_MS) return "hidden black-box oracle timeout is outside the allowed range";
  if (!Number.isSafeInteger(check.totalTimeoutMs) || check.totalTimeoutMs < check.timeoutMs || check.totalTimeoutMs > MAX_TOTAL_TIMEOUT_MS) return "hidden black-box oracle total timeout is outside the allowed range";
  if (!Number.isSafeInteger(check.maxOutputBytes) || check.maxOutputBytes < 2 || check.maxOutputBytes > MAX_OUTPUT_BYTES) return "hidden black-box oracle output limit is outside the allowed range";
  return null;
}

/** Run candidate code as a black box. Only bounded summaries leave this function; raw output is discarded. */
export async function runBlackBoxOracle(task, workspace, check, { resources = null } = {}) {
  const problem = blackBoxOracleProblem(check, task.dir, task.fixture ?? null);
  if (problem) throw new Error(problem);
  const casesPath = confinedPath(task.dir, check.casesFile);
  const entrypoint = confinedPath(workspace, check.argv[0]);
  if (!fs.statSync(entrypoint).isFile()) throw new Error("black-box candidate entrypoint is not a regular file");
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const command = RUNTIMES[check.runtime];
  const failures = [];
  const timeoutCases = [];
  const outputLimitCases = [];
  const executionFailureCases = [];
  const invalidOutputCases = [];
  const mismatchCases = [];
  const fixturePath = task.fixture ? confinedPath(task.dir, task.fixture) : null;
  const candidateWorkspace = fs.realpathSync(workspace);
  const relativeCases = path.relative(candidateWorkspace, casesPath);
  if (relativeCases === "" || (!relativeCases.startsWith(`..${path.sep}`) && relativeCases !== ".." && !path.isAbsolute(relativeCases))) {
    throw new Error("black-box oracle cases unexpectedly overlap the candidate workspace");
  }
  if (fixturePath) {
    const relativeFixtureCases = path.relative(fixturePath, casesPath);
    if (relativeFixtureCases === "" || (!relativeFixtureCases.startsWith(`..${path.sep}`) && relativeFixtureCases !== ".." && !path.isAbsolute(relativeFixtureCases))) {
      throw new Error("black-box oracle cases unexpectedly overlap the copied candidate fixture");
    }
  }
  const deadline = Date.now() + check.totalTimeoutMs;
  const containment = { executions: 0, oomKills: 0, pidsMaxEvents: 0, survivorsAfterExit: 0 };
  for (let index = 0; index < cases.length; index++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 100) {
      const unrun = Array.from({ length: cases.length - index }, (_, offset) => index + offset);
      failures.push(...unrun);
      timeoutCases.push(...unrun);
      break;
    }
    const spec = isolatedProcessArgv({
      cwd: workspace,
      command,
      argv: [`/workspace/${check.argv[0]}`],
      readOnlyPaths: [command],
      allowedFiles: [command],
      workspaceReadOnly: true,
      timeoutMs: Math.min(check.timeoutMs, remainingMs),
    });
    const result = await runIsolatedProcess(spec, {
      outputLimit: check.maxOutputBytes,
      input: `${JSON.stringify(cases[index].input)}\n`,
      resources,
    });
    if (result.containmentProblem) throw new Error(`black-box oracle containment failed: ${result.containmentProblem}`);
    if (result.resources) {
      containment.executions++;
      containment.oomKills += result.resources.oomKills ?? 0;
      containment.pidsMaxEvents += result.resources.pidsMaxEvents ?? 0;
      containment.survivorsAfterExit += result.resources.survivorsAfterExit;
    }
    if (result.timedOut) timeoutCases.push(index);
    if (result.overflow) outputLimitCases.push(index);
    if (result.status !== 0 || result.error) executionFailureCases.push(index);
    let actual;
    let validOutput = false;
    if (result.status === 0 && !result.timedOut && !result.overflow && !result.error) {
      try {
        actual = JSON.parse(result.stdout);
        validOutput = true;
      } catch { /* Candidate output is intentionally never copied to diagnostics. */ }
    }
    if (!validOutput) invalidOutputCases.push(index);
    if (validOutput && !isDeepStrictEqual(actual, cases[index].expected)) mismatchCases.push(index);
    if (result.timedOut || result.overflow || result.status !== 0 || result.error || !validOutput || !isDeepStrictEqual(actual, cases[index].expected)) failures.push(index);
  }
  return {
    pass: failures.length === 0,
    cases: cases.length,
    failedCases: failures,
    timeoutCases,
    outputLimitCases,
    executionFailureCases,
    invalidOutputCases,
    mismatchCases,
    timedOut: timeoutCases.length > 0,
    overflow: outputLimitCases.length > 0,
    outcome: failures.length === 0 ? "matched" : "mismatch_or_execution_failure",
    resources: resources ? containment : null,
  };
}
