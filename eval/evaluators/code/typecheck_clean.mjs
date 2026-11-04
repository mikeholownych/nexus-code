import path from "node:path";
import { runArgv } from "./command.mjs";
import { evaluatorResult } from "./result.mjs";

function diagnosticLines(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * Compare baseline and candidate typecheck diagnostics: new diagnostics fail, and so does a non-zero candidate exit when
 * the baseline exited 0 or the candidate printed no diagnostics (a silent failure).
 */
export async function evaluateTypecheckClean({ baseline, candidate, runner = runArgv }) {
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
  const baselineOutput = diagnosticLines(baselineResult);
  const candidateOutput = diagnosticLines(candidateResult);
  const baselineCounts = new Map();
  for (const line of baselineOutput) baselineCounts.set(line, (baselineCounts.get(line) ?? 0) + 1);
  const seenCandidate = new Map();
  const newDiagnostics = candidateOutput.filter((line) => {
    const seen = (seenCandidate.get(line) ?? 0) + 1;
    seenCandidate.set(line, seen);
    return seen > (baselineCounts.get(line) ?? 0);
  });
  const recognizedDiagnostic = (lines) => lines.some((line) => /\berror\s+TS\d+:|\berror\[E\d+\]:/i.test(line));
  const infrastructureFailure = [baselineResult, candidateResult].some((result) =>
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
