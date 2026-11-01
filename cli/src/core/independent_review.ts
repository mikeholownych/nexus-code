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
/**
 * Reads one path token as Git writes it: either bare, or C-quoted ("a/\303\251.ts", with \t, \", \\ and octal
 * byte escapes) when the path contains non-ASCII bytes, tabs, quotes or backslashes. Returns the decoded path and
 * the text after the token.
 */
function readGitPath(text: string): { path: string; rest: string } | undefined {
  if (!text.startsWith('"')) return undefined;
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      return { path: Buffer.from(bytes).toString("utf-8"), rest: text.slice(i + 1) };
    }
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf-8"));
      continue;
    }
    const next = text[++i];
    if (next === undefined) return undefined;
    if (/[0-7]/.test(next)) {
      const octal = text.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal)) return undefined;
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else if (next in named) {
      bytes.push(named[next]);
    } else {
      return undefined;
    }
  }
  return undefined; // unterminated quote
}

/** Strips the a/ or b/ prefix Git adds; /dev/null means "no file on this side". */
function diffSidePath(raw: string, prefix: "a/" | "b/"): string | undefined {
  const path = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return path === "/dev/null" || path === "dev/null" || raw === "/dev/null" ? undefined : path;
}

/** Parses the path written after `---`/`+++`/`rename from`/`rename to`, quoted or bare (bare runs to end of line). */
function headerPath(text: string): string | undefined {
  if (text.startsWith('"')) return readGitPath(text)?.path;
  const bare = text.replace(/\t.*$/, ""); // GNU diff may append a tab and timestamp
  return bare || undefined;
}

/**
 * Lists every file a unified diff touches, on both sides of renames, from `diff --git`, `---`/`+++` and
 * `rename from`/`rename to` headers. Handles Git's C-quoted paths and bare paths containing spaces.
 * A header that cannot be parsed yields a sentinel entry so the scope check fails closed instead of skipping it.
 */
export function extractModifiedFilesFromDiff(diff: string): string[] {
  const modified = new Set<string>();
  const add = (p: string | undefined) => {
    if (p) modified.add(p);
  };
  // File headers (---/+++/rename) only appear before a file's first hunk; inside a hunk, a removed line such as
  // "-- note" is written "--- note" and must not be read as a path.
  let inHeader = true;
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A plain unified diff (no "diff --git" lines) starts each later file with a "---"/"+++" pair.
    if (!inHeader && line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) inHeader = true;
    if (line.startsWith("@@")) {
      inHeader = false;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      const rest = line.slice("diff --git ".length);
      if (rest.startsWith('"')) {
        const first = readGitPath(rest);
        const second = first && first.rest.startsWith(" ") ? first.rest.slice(1) : undefined;
        const b = second?.startsWith('"') ? readGitPath(second)?.path : second;
        if (!first || b === undefined) {
          add(`<unparseable diff header: ${line}>`);
          continue;
        }
        add(diffSidePath(first.path, "a/"));
        add(diffSidePath(b, "b/"));
      } else {
        // Bare: "a/<path> b/<path>". With identical sides the split point is the midpoint; otherwise the
        // ---/+++ or rename headers that follow carry the exact paths.
        const half = (rest.length - 1) / 2;
        if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) {
          add(diffSidePath(rest.slice(0, half), "a/"));
        } else {
          const quotedB = rest.indexOf(' "b/');
          const bareB = rest.lastIndexOf(" b/");
          const cut = quotedB >= 0 ? quotedB : bareB;
          if (cut < 0) {
            add(`<unparseable diff header: ${line}>`);
            continue;
          }
          add(diffSidePath(rest.slice(0, cut), "a/"));
          const bSide = rest.slice(cut + 1);
          add(diffSidePath(bSide.startsWith('"') ? readGitPath(bSide)?.path ?? `<unparseable diff header: ${line}>` : bSide, "b/"));
        }
      }
    } else if (!inHeader) {
      continue;
    } else if (line.startsWith("--- ")) {
      const p = headerPath(line.slice(4));
      add(p === undefined ? `<unparseable diff header: ${line}>` : diffSidePath(p, "a/"));
    } else if (line.startsWith("+++ ")) {
      const p = headerPath(line.slice(4));
      add(p === undefined ? `<unparseable diff header: ${line}>` : diffSidePath(p, "b/"));
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      const p = headerPath(line.replace(/^rename (?:from|to) /, ""));
      add(p ?? `<unparseable diff header: ${line}>`);
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
