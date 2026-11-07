import path from "node:path";
import { runArgv } from "./command.mjs";
import { evaluatorResult } from "./result.mjs";

// Colored (`--pretty`) output: ANSI escapes would hide the diagnostic code from the recogniser.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// Source excerpts and squiggles that --pretty and rustc print under a diagnostic; they carry line numbers, not messages.
const CODE_FRAME = /^(?:\d+\s.*|[|\s~^]+)$/;
// A coded diagnostic opens a frame; only gutter lines inside one are dropped, so an unrelated line that merely starts
// with a number (for example a task-supplied "2 problems: ...") is still compared.
const CODED_DIAGNOSTIC = /\berror\s+TS\d+:|\berror\[E\d+\]:/i;
// Rustc's location and note lines belong to the frame but are not gutters.
const FRAME_CONTINUATION = /^(?:-->|=)\s/;
// Whole-line summaries restate the count (and, for tsc, the first location); the diagnostics above them are what is
// compared. Coded diagnostics are recognised first, so a file named like a summary cannot hide one.
const SUMMARY = /^(?:Found \d+ errors? in [^\n]*|Found \d+ errors?\.?|Errors\s+Files|error: aborting due to \d+ previous errors?(?:; [^\n]*)?)$/i;
// A configuration error means the checker did not check the project, whatever the baseline printed.
const CHECKER_NOT_RUN = /\berror\s+TS(?:5057|5058|5083|5012|18003|6053):/i;

function diagnosticLines(result, extraDiagnostic = null) {
  const kept = [];
  let inFrame = false;
  for (const raw of `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (CODED_DIAGNOSTIC.test(line) || extraDiagnostic?.test(line)) { kept.push(line); inFrame = true; continue; }
    if (SUMMARY.test(line)) continue;
    if (inFrame && CODE_FRAME.test(line)) continue;
    kept.push(line);
    if (!FRAME_CONTINUATION.test(line)) inFrame = false;
  }
  return kept;
}

/**
 * Compare diagnostics by message: a position that merely moves (an insertion above it) is not a new diagnostic. Only the
 * location field is normalized (tsc `file(l,c):`, pretty `file:l:c -`, rustc `--> file:l:c`, `file:l:` prefixes); text
 * inside the message is compared as printed.
 */
function diagnosticKey(line) {
  return line
    .replace(/^([^\s(]+)\(\d+,\d+\):/, "$1(L,C):")
    .replace(/^([^\s:]+):\d+:\d+ - /, "$1:L:C - ")
    .replace(/^--> (.+?):\d+:\d+$/, "--> $1:L:C")
    .replace(/^([^\s:]+):\d+:(?=\s)/, "$1:L:");
}

function recognizer(diagnosticPattern) {
  if (diagnosticPattern === undefined) return null;
  try { return new RegExp(diagnosticPattern, "i"); }
  catch (error) { throw new TypeError(`diagnosticPattern is not a valid regular expression: ${error.message}`); }
}

/**
 * Compare baseline and candidate typecheck diagnostics: new diagnostics fail, and so does a non-zero candidate exit when
 * the baseline exited 0 or the candidate printed no diagnostics (a silent failure).
 */
export async function evaluateTypecheckClean({ baseline, candidate, runner = runArgv, diagnosticPattern }) {
  let extraDiagnostic;
  try { extraDiagnostic = recognizer(diagnosticPattern); }
  catch (error) { return evaluatorResult("typecheck_clean", false, 0, { error: error.message }); }
  for (const revision of [baseline, candidate]) {
    if (!revision || typeof revision.command !== "string" || !revision.command || !Array.isArray(revision.args ?? []) ||
        typeof revision.cwd !== "string" || !path.isAbsolute(revision.cwd)) {
      throw new TypeError("baseline and candidate typecheck command specs are required");
    }
  }
  if (path.resolve(baseline.cwd) === path.resolve(candidate.cwd)) {
    throw new TypeError("baseline and candidate typecheck workspaces must be separate");
  }
  const invoke = async (spec) => {
    try { return await runner(spec.command, spec.args ?? [], { cwd: spec.cwd, timeoutMs: spec.timeoutMs }); }
    catch (error) { return { status: null, error: String(error?.message ?? error), stdout: "", stderr: "" }; }
  };
  const [baselineResult, candidateResult] = await Promise.all([invoke(baseline), invoke(candidate)]);
  const baselineOutput = diagnosticLines(baselineResult, extraDiagnostic);
  const candidateOutput = diagnosticLines(candidateResult, extraDiagnostic);
  const baselineCounts = new Map();
  for (const line of baselineOutput) baselineCounts.set(diagnosticKey(line), (baselineCounts.get(diagnosticKey(line)) ?? 0) + 1);
  const seenCandidate = new Map();
  const newDiagnostics = candidateOutput.filter((line) => {
    const key = diagnosticKey(line);
    const seen = (seenCandidate.get(key) ?? 0) + 1;
    seenCandidate.set(key, seen);
    return seen > (baselineCounts.get(key) ?? 0);
  });
  const recognizedDiagnostic = (lines) => lines.some((line) => CODED_DIAGNOSTIC.test(line) || extraDiagnostic?.test(line));
  const checkerDidNotRun = [...baselineOutput, ...candidateOutput].some((line) => CHECKER_NOT_RUN.test(line));
  const infrastructureFailure = checkerDidNotRun || [baselineResult, candidateResult].some((result) =>
    result?.status == null || result?.signal != null || result?.timedOut === true || result?.error != null) ||
    (baselineResult.status !== 0 && !recognizedDiagnostic(baselineOutput)) ||
    (candidateResult.status !== 0 && !recognizedDiagnostic(candidateOutput));
  // A candidate that fails where the baseline passed, or that fails without printing any diagnostic, has regressed even
  // though no new diagnostic line appears. A failing baseline's exit code alone is not compared: it varies with settings.
  const statusRegression = !infrastructureFailure && candidateResult.status !== 0 &&
    (baselineResult.status === 0 || candidateOutput.length === 0);
  const passed = !infrastructureFailure && !statusRegression && newDiagnostics.length === 0;
  return evaluatorResult("typecheck_clean", passed, passed ? 1 : 0, {
    baseline: { command: baseline.command, args: baseline.args ?? [], status: baselineResult.status ?? null },
    candidate: { command: candidate.command, args: candidate.args ?? [], status: candidateResult.status ?? null },
    baselineDiagnosticCount: baselineOutput.length, candidateDiagnosticCount: candidateOutput.length,
    newDiagnostics, infrastructureFailure, statusRegression,
  });
}
