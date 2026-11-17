/**
 * Objective Independent Review Boundary (Nexus Code v1.1.2)
 *
 * Mitigates common-mode failure and confirmation bias in multi-agent workflows.
 * The independent reviewer receives an objective evidence package containing:
 * - Original task requirements and acceptance criteria
 * - Authorized scope (files permitted to be modified)
 * - Repository baseline and candidate diff
 * - Deterministic verifier receipts (exit code, raw logs)
 *
 * CRITICAL INVARIANT: The implementer's narrative ("I fixed this and verified it works")
 * is strictly stripped from the evidence package to prevent confirmation bias.
 *
 * Internal model metrics may veto an implementation, but deterministic verification
 * gates remain the authoritative ground truth for completion.
 */

import { checkBoundaries, describeBoundaryReport, type BoundaryReport, type BoundaryRules } from "./boundary_rules.js";

export interface ReviewEvidencePackage {
  operationId?: string;
  unitId: string;
  objective: string;
  /** Files the change may touch. Absent when no scope was declared: the package then makes no scope claim. */
  authorizedScope?: readonly string[];
  baselineCommit: string;
  candidateCommit?: string;
  unifiedDiff: string;
  /** SI-5: operator-declared boundary rules checked on the diff (core/boundary_rules.ts). Absent: no boundary check. */
  boundaries?: BoundaryRules;
  /** Why the candidate diff could not be collected. A package with no diff is not evidence: no ACCEPT survives it. */
  diffError?: string;
  verifierCommand?: string;
  verifierOutput?: string;
  verifierExitCode?: number;
  unresolvedAssumptions?: readonly string[];
}

export interface ReviewDefect {
  path: string;
  line?: number;
  description: string;
}

export interface IndependentReviewVerdict {
  verdict: "ACCEPT" | "REJECT";
  verifiedObservations: string[];
  suspectedDefects: ReviewDefect[];
  unprovenCriteria: string[];
  scopeViolations: string[];
  /** SI-5: the boundary check's report when the package declared rules (violations force REJECT; advisories and coverage are information). */
  boundaryReport?: BoundaryReport;
  reviewerConfidenceNote: string;
}

export { extractModifiedFilesFromDiff, diffSidePath, headerPath } from "./unified_diff.js";
import { extractModifiedFilesFromDiff } from "./unified_diff.js";

/**
 * Checks whether any modified file is outside the authorized change boundary.
 */
export function detectScopeViolations(
  diff: string,
  authorizedScope: readonly string[] = [],
): string[] {
  if (authorizedScope.length === 0) return [];
  const modifiedFiles = extractModifiedFilesFromDiff(diff);
  const violations: string[] = [];

  for (const file of modifiedFiles) {
    const isAuthorized = authorizedScope.some(
      (auth) => file === auth || file.startsWith(`${auth}/`) || auth === "*",
    );
    if (!isAuthorized) {
      violations.push(file);
    }
  }
  return violations;
}

/**
 * Builds an objective evidence package. Strips any author-supplied narrative summaries.
 */
export function buildReviewEvidencePackage(params: {
  operationId?: string;
  unitId: string;
  objective: string;
  authorizedScope?: readonly string[];
  baselineCommit: string;
  candidateCommit?: string;
  unifiedDiff: string;
  boundaries?: BoundaryRules;
  diffError?: string;
  verifierCommand?: string;
  verifierOutput?: string;
  verifierExitCode?: number;
  unresolvedAssumptions?: readonly string[];
}): ReviewEvidencePackage {
  return {
    operationId: params.operationId,
    unitId: params.unitId,
    objective: params.objective.trim(),
    authorizedScope: params.authorizedScope ? Object.freeze([...params.authorizedScope]) : undefined,
    baselineCommit: params.baselineCommit.trim(),
    candidateCommit: params.candidateCommit?.trim(),
    unifiedDiff: params.unifiedDiff,
    ...(params.boundaries ? { boundaries: params.boundaries } : {}),
    ...(params.diffError ? { diffError: params.diffError } : {}),
    verifierCommand: params.verifierCommand?.trim(),
    verifierOutput: params.verifierOutput,
    verifierExitCode: params.verifierExitCode,
    unresolvedAssumptions: params.unresolvedAssumptions
      ? Object.freeze([...params.unresolvedAssumptions])
      : undefined,
  };
}

/**
 * Formats raw verifier output, preserving the beginning and the tail
 * so that failure logs at the end are never lost to naive slicing.
 */
export function formatVerifierOutput(output?: string): string {
  if (!output) return "No verifier output recorded";
  if (output.length <= 10000) return output;
  const head = output.slice(0, 2000);
  const tail = output.slice(-8000);
  return `${head}\n\n... [truncated ${output.length - 10000} characters; retaining verifier tail] ...\n\n${tail}`;
}

/**
 * Formats the review prompt, instructing the independent model to evaluate
 * only the objective evidence package and emit a strict JSON verdict.
 */
export function formatIndependentReviewPrompt(
  pkg: ReviewEvidencePackage,
): string {
  const scopeViolations = detectScopeViolations(pkg.unifiedDiff, pkg.authorizedScope);
  const scopeSection = pkg.authorizedScope
    ? `Authorized Scope:\n${pkg.authorizedScope.length ? pkg.authorizedScope.map((s) => `- ${s}`).join("\n") : "Unrestricted (Repository-wide)"}\n`
    : "";
  const scopeWarning = scopeViolations.length
    ? `\n[AUTOMATED SCOPE WARNING] The diff touches files outside authorizedScope: [${scopeViolations.join(", ")}]\n`
    : "";

  const boundary = checkBoundaries(pkg.unifiedDiff, pkg.boundaries, { authorizedScope: pkg.authorizedScope });
  const boundaryLines = boundary ? describeBoundaryReport(boundary) : [];
  const boundaryWarning = boundaryLines.length
    ? `\n[AUTOMATED BOUNDARY CHECK] Rules the operator declared were checked on the diff. A VIOLATION is rejected regardless of your verdict:\n${boundaryLines.map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const isDiffTruncated = pkg.unifiedDiff.length > 20000;
  const diffContent = pkg.diffError
    ? `[Nexus could not collect the candidate diff: ${pkg.diffError}. A review cannot be accepted without it.]`
    : isDiffTruncated
    ? `${pkg.unifiedDiff.slice(0, 20000)}\n\n[TRUNCATED: Unified diff exceeded 20,000 characters. Remaining content omitted for context budget.]`
    : pkg.unifiedDiff;

  const diffWarning = isDiffTruncated
    ? `\n[AUTOMATED TRUNCATION WARNING] Unified diff exceeded 20,000 characters and was truncated. Complete independent inspection requires deterministic passing verifier evidence.\n`
    : "";

  return `[Independent Review Task for Unit '${pkg.unitId}'${pkg.operationId ? ` in Operation '${pkg.operationId}'` : ""}]

Objective Requirements:
${pkg.objective}

${scopeSection}${scopeWarning}${boundaryWarning}${diffWarning}
Repository Baseline:
- Base Commit: ${pkg.baselineCommit}${pkg.candidateCommit ? `\n- Candidate Commit: ${pkg.candidateCommit}` : ""}

Verifier Execution Evidence:
- Command: ${pkg.verifierCommand ?? "None"}
- Exit Code: ${pkg.verifierExitCode !== undefined ? pkg.verifierExitCode : "Untested"}
- Raw Verifier Output:
\`\`\`
${formatVerifierOutput(pkg.verifierOutput)}
\`\`\`

Candidate Unified Diff:
\`\`\`diff
${diffContent}
\`\`\`

INSTRUCTIONS FOR INDEPENDENT REVIEWER:
1. Do not assume the implementation is correct. The implementer's self-assessed narrative has been excluded.
2. Evaluate the code diff against the objective requirements${pkg.authorizedScope ? " and authorized scope" : ""}.
3. Check for regressions, unhandled edge cases, security boundaries, and incomplete logic.
4. "unprovenCriteria" lists every requirement you could not confirm from the evidence above. Any entry makes the verdict REJECT, so answer ACCEPT only with an empty list.
5. You MUST respond with a JSON block adhering strictly to this schema:
\`\`\`json
{
  "verdict": "ACCEPT" | "REJECT",
  "verifiedObservations": ["string"],
  "suspectedDefects": [{"path": "string", "line": 0, "description": "string"}],
  "unprovenCriteria": ["string"],
  "scopeViolations": ["string"],
  "reviewerConfidenceNote": "string"
}
\`\`\`
`;
}

/**
 * Parses and validates an independent reviewer verdict.
 * Fails closed as "REJECT" if parsing fails or critical schema invariants are violated.
 */
export function parseIndependentReviewVerdict(
  rawText: string,
  pkg?: ReviewEvidencePackage,
): IndependentReviewVerdict {
  try {
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, rawText];
    const candidate = jsonMatch[1] ? jsonMatch[1].trim() : rawText.trim();
    const parsed = JSON.parse(candidate);

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Verdict is not a JSON object");
    }

    // Every schema field is required and must have its declared type. A missing or malformed field (for example
    // "suspectedDefects": "found a bug") throws, which the catch below turns into REJECT; nothing is coerced away.
    if (parsed.verdict !== "ACCEPT" && parsed.verdict !== "REJECT") {
      throw new Error(`"verdict" must be "ACCEPT" or "REJECT", got ${JSON.stringify(parsed.verdict)}`);
    }
    const verdict: "ACCEPT" | "REJECT" = parsed.verdict;
    const stringArray = (field: string): string[] => {
      const value = parsed[field];
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new Error(`"${field}" must be an array of strings`);
      }
      return [...value];
    };
    const verifiedObservations = stringArray("verifiedObservations");
    const unprovenCriteria = stringArray("unprovenCriteria");
    const scopeViolations = stringArray("scopeViolations");
    if (typeof parsed.reviewerConfidenceNote !== "string") {
      throw new Error(`"reviewerConfidenceNote" must be a string`);
    }

    if (!Array.isArray(parsed.suspectedDefects)) {
      throw new Error(`"suspectedDefects" must be an array`);
    }
    const suspectedDefects: ReviewDefect[] = parsed.suspectedDefects.map((d: unknown, i: number) => {
      const entry = d as { path?: unknown; line?: unknown; description?: unknown } | null;
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.path !== "string" ||
        typeof entry.description !== "string" ||
        (entry.line !== undefined && entry.line !== null && typeof entry.line !== "number")
      ) {
        throw new Error(`"suspectedDefects[${i}]" must be {path: string, line?: number, description: string}`);
      }
      return { path: entry.path, line: typeof entry.line === "number" ? entry.line : undefined, description: entry.description };
    });

    // Deterministic gate enforcement: If verifier explicitly failed (exitCode !== 0)
    // or deterministic scope violations exist, model ACCEPT cannot override objective failure.
    let finalVerdict = verdict;
    let boundaryReport: BoundaryReport | undefined;
    if (pkg) {
      const autoViolations = detectScopeViolations(pkg.unifiedDiff, pkg.authorizedScope);
      for (const v of autoViolations) {
        if (!scopeViolations.includes(v)) scopeViolations.push(v);
      }
      if (pkg.diffError) {
        finalVerdict = "REJECT";
        unprovenCriteria.push(`Candidate diff could not be collected (${pkg.diffError}); there is nothing to accept`);
      }
      if (pkg.verifierExitCode === undefined) {
        finalVerdict = "REJECT";
        unprovenCriteria.push("No deterministic verifier evidence reached this review; a model ACCEPT cannot establish acceptance on its own; make the review unit depend on a unit that runs a verifier command, or accept the operation manually");
      }
      if (pkg.verifierExitCode !== undefined && pkg.verifierExitCode !== 0) {
        finalVerdict = "REJECT";
        unprovenCriteria.push(`Deterministic verifier failed with exit code ${pkg.verifierExitCode}`);
      }
      if (scopeViolations.length > 0) {
        finalVerdict = "REJECT";
      }
      boundaryReport = checkBoundaries(pkg.unifiedDiff, pkg.boundaries, { authorizedScope: pkg.authorizedScope });
      if (boundaryReport?.violations.length) {
        finalVerdict = "REJECT";
        for (const v of boundaryReport.violations) unprovenCriteria.push(`Boundary rule violated [${v.rule}] ${v.path}: ${v.detail}`);
      }
      if (pkg.unifiedDiff.length > 20000 && pkg.verifierExitCode !== 0) {
        finalVerdict = "REJECT";
        unprovenCriteria.push(
          "Unified diff was truncated (>20000 characters) and lacks passing deterministic verifier evidence"
        );
      }
    }

    if (suspectedDefects.length > 0) {
      finalVerdict = "REJECT";
    }
    if (unprovenCriteria.length > 0) {
      finalVerdict = "REJECT";
    }

    return {
      verdict: finalVerdict,
      verifiedObservations,
      suspectedDefects,
      unprovenCriteria,
      scopeViolations,
      ...(boundaryReport ? { boundaryReport } : {}),
      reviewerConfidenceNote: parsed.reviewerConfidenceNote,
    };
  } catch (err) {
    // Fail-closed as REJECT on any parse failure
    return {
      verdict: "REJECT",
      verifiedObservations: [],
      suspectedDefects: [
        {
          path: "review_verdict.json",
          description: `Failed to parse structured review verdict: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      unprovenCriteria: ["Structured review verdict validation"],
      scopeViolations: [],
      reviewerConfidenceNote: "Parser failure: default fail-closed REJECT",
    };
  }
}
