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

export interface ReviewEvidencePackage {
  operationId: string;
  unitId: string;
  objective: string;
  authorizedScope: readonly string[];
  baselineCommit: string;
  candidateCommit?: string;
  unifiedDiff: string;
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
  reviewerConfidenceNote: string;
}

/**
 * Parses files modified from a unified git diff.
 * Checks both source and destination headers, renames, and git index lines.
 */
export function extractModifiedFilesFromDiff(diff: string): string[] {
  const modified = new Set<string>();
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git a/")) {
      const parts = line.split(" ");
      if (parts.length >= 4) {
        const fileA = parts[2].replace(/^a\//, "").trim();
        const fileB = parts[3].replace(/^b\//, "").trim();
        if (fileA && fileA !== "/dev/null" && fileA !== "dev/null") modified.add(fileA);
        if (fileB && fileB !== "/dev/null" && fileB !== "dev/null") modified.add(fileB);
      }
    } else if (line.startsWith("--- a/")) {
      const file = line.replace(/^---\s+a\//, "").trim();
      if (file && file !== "/dev/null" && file !== "dev/null") modified.add(file);
    } else if (line.startsWith("+++ b/")) {
      const file = line.replace(/^\+\+\+\s+b\//, "").trim();
      if (file && file !== "/dev/null" && file !== "dev/null") modified.add(file);
    } else if (line.startsWith("rename from ")) {
      const file = line.replace(/^rename from\s+/, "").trim();
      if (file) modified.add(file);
    } else if (line.startsWith("rename to ")) {
      const file = line.replace(/^rename to\s+/, "").trim();
      if (file) modified.add(file);
    }
  }
  return Array.from(modified);
}

/**
 * Checks whether any modified file is outside the authorized change boundary.
 */
export function detectScopeViolations(
  diff: string,
  authorizedScope: readonly string[],
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
  operationId: string;
  unitId: string;
  objective: string;
  authorizedScope: readonly string[];
  baselineCommit: string;
  candidateCommit?: string;
  unifiedDiff: string;
  verifierCommand?: string;
  verifierOutput?: string;
  verifierExitCode?: number;
  unresolvedAssumptions?: readonly string[];
}): ReviewEvidencePackage {
  return {
    operationId: params.operationId,
    unitId: params.unitId,
    objective: params.objective.trim(),
    authorizedScope: Object.freeze([...params.authorizedScope]),
    baselineCommit: params.baselineCommit.trim(),
    candidateCommit: params.candidateCommit?.trim(),
    unifiedDiff: params.unifiedDiff,
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
  const scopeWarning = scopeViolations.length
    ? `\n[AUTOMATED SCOPE WARNING] The diff touches files outside authorizedScope: [${scopeViolations.join(", ")}]\n`
    : "";

  const isDiffTruncated = pkg.unifiedDiff.length > 20000;
  const diffContent = isDiffTruncated
    ? `${pkg.unifiedDiff.slice(0, 20000)}\n\n[TRUNCATED: Unified diff exceeded 20,000 characters. Remaining content omitted for context budget.]`
    : pkg.unifiedDiff;

  const diffWarning = isDiffTruncated
    ? `\n[AUTOMATED TRUNCATION WARNING] Unified diff exceeded 20,000 characters and was truncated. Complete independent inspection requires deterministic passing verifier evidence.\n`
    : "";

  return `[Independent Review Task for Unit '${pkg.unitId}' in Operation '${pkg.operationId}']

Objective Requirements:
${pkg.objective}

Authorized Scope:
${pkg.authorizedScope.length ? pkg.authorizedScope.map((s) => `- ${s}`).join("\n") : "Unrestricted (Repository-wide)"}
${scopeWarning}${diffWarning}
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
2. Evaluate the code diff against the objective requirements and authorized scope.
3. Check for regressions, unhandled edge cases, security boundaries, and incomplete logic.
4. You MUST respond with a JSON block adhering strictly to this schema:
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

    const verdict: "ACCEPT" | "REJECT" = parsed.verdict === "ACCEPT" ? "ACCEPT" : "REJECT";
    const verifiedObservations = Array.isArray(parsed.verifiedObservations)
      ? parsed.verifiedObservations.map(String)
      : [];
    const unprovenCriteria = Array.isArray(parsed.unprovenCriteria)
      ? parsed.unprovenCriteria.map(String)
      : [];
    const scopeViolations = Array.isArray(parsed.scopeViolations)
      ? parsed.scopeViolations.map(String)
      : [];

    const suspectedDefects: ReviewDefect[] = [];
    if (Array.isArray(parsed.suspectedDefects)) {
      for (const d of parsed.suspectedDefects) {
        if (d && typeof d === "object" && typeof d.path === "string" && typeof d.description === "string") {
          suspectedDefects.push({
            path: d.path,
            line: typeof d.line === "number" ? d.line : undefined,
            description: d.description,
          });
        }
      }
    }

    // Deterministic gate enforcement: If verifier explicitly failed (exitCode !== 0)
    // or deterministic scope violations exist, model ACCEPT cannot override objective failure.
    let finalVerdict = verdict;
    if (pkg) {
      const autoViolations = detectScopeViolations(pkg.unifiedDiff, pkg.authorizedScope);
      for (const v of autoViolations) {
        if (!scopeViolations.includes(v)) scopeViolations.push(v);
      }
      if (pkg.verifierExitCode !== undefined && pkg.verifierExitCode !== 0) {
        finalVerdict = "REJECT";
        unprovenCriteria.push(`Deterministic verifier failed with exit code ${pkg.verifierExitCode}`);
      }
      if (scopeViolations.length > 0) {
        finalVerdict = "REJECT";
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

    return {
      verdict: finalVerdict,
      verifiedObservations,
      suspectedDefects,
      unprovenCriteria,
      scopeViolations,
      reviewerConfidenceNote: typeof parsed.reviewerConfidenceNote === "string"
        ? parsed.reviewerConfidenceNote
        : "Automated parsed verdict",
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
