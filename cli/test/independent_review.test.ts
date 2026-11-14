import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewEvidencePackage,
  detectScopeViolations,
  extractModifiedFilesFromDiff,
  formatIndependentReviewPrompt,
  parseIndependentReviewVerdict,
  type ReviewEvidencePackage,
} from "../src/core/independent_review.js";

const SAMPLE_DIFF = `diff --git a/cli/src/feature.ts b/cli/src/feature.ts
index 1111111..2222222 100644
--- a/cli/src/feature.ts
+++ b/cli/src/feature.ts
@@ -10,3 +10,4 @@ export function run() {
+  return true;
 }
diff --git a/cli/src/extra.ts b/cli/src/extra.ts
index 3333333..4444444 100644
--- a/cli/src/extra.ts
+++ b/cli/src/extra.ts
@@ -1,2 +1,3 @@
+export const leaked = 1;
`;

test("extractModifiedFilesFromDiff accurately extracts paths from git unified diff including deletions and renames", () => {
  const files = extractModifiedFilesFromDiff(SAMPLE_DIFF);
  assert.deepEqual(files.sort(), ["cli/src/extra.ts", "cli/src/feature.ts"]);

  const deleteDiff = `diff --git a/deleted.ts b/dev/null
--- a/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
`;
  assert.deepEqual(extractModifiedFilesFromDiff(deleteDiff), ["deleted.ts"]);

  const renameDiff = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;
  assert.deepEqual(extractModifiedFilesFromDiff(renameDiff).sort(), ["new.ts", "old.ts"]);
});

test("detectScopeViolations flags files modified outside authorized scope", () => {
  const authorized = ["cli/src/feature.ts"];
  const violations = detectScopeViolations(SAMPLE_DIFF, authorized);
  assert.deepEqual(violations, ["cli/src/extra.ts"]);

  const allAuthorized = ["cli/src"];
  assert.deepEqual(detectScopeViolations(SAMPLE_DIFF, allAuthorized), []);
});

test("buildReviewEvidencePackage strips implementer narrative and freezes scope", () => {
  const pkg = buildReviewEvidencePackage({
    operationId: "op-test-1",
    unitId: "unit-impl",
    objective: "Implement Feature X",
    authorizedScope: ["cli/src/feature.ts"],
    baselineCommit: "sha-base-123",
    candidateCommit: "sha-candidate-456",
    unifiedDiff: SAMPLE_DIFF,
    verifierCommand: "npm test",
    verifierOutput: "All 10 tests passed",
    verifierExitCode: 0,
  });

  assert.equal(pkg.operationId, "op-test-1");
  assert.equal(pkg.objective, "Implement Feature X");
  assert.equal(pkg.verifierExitCode, 0);
  assert.deepEqual(pkg.authorizedScope, ["cli/src/feature.ts"]);

  // Package should not contain any implementer narrative fields
  assert.equal((pkg as Record<string, unknown>).implementerSummary, undefined);
  assert.equal((pkg as Record<string, unknown>).confidenceClaim, undefined);
});

test("formatIndependentReviewPrompt warns about scope violations and formats prompt", () => {
  const pkg: ReviewEvidencePackage = {
    operationId: "op-test-2",
    unitId: "unit-rev",
    objective: "Strict Scope Objective",
    authorizedScope: ["cli/src/feature.ts"],
    baselineCommit: "abc1234",
    unifiedDiff: SAMPLE_DIFF,
    verifierCommand: "cargo test",
    verifierExitCode: 0,
    verifierOutput: "ok",
  };

  const prompt = formatIndependentReviewPrompt(pkg);
  assert.match(prompt, /\[AUTOMATED SCOPE WARNING\]/);
  assert.match(prompt, /cli\/src\/extra\.ts/);
  assert.match(prompt, /The implementer's self-assessed narrative has been excluded/);
  assert.match(prompt, /"verdict": "ACCEPT" \| "REJECT"/);
});

test("parseIndependentReviewVerdict handles valid ACCEPT and enforces fail-closed gates", () => {
  const cleanPackage: ReviewEvidencePackage = {
    operationId: "op-clean",
    unitId: "rev",
    objective: "All Good",
    authorizedScope: ["cli/src/feature.ts", "cli/src/extra.ts"],
    baselineCommit: "base",
    unifiedDiff: SAMPLE_DIFF,
    verifierExitCode: 0,
  };

  // 1. Valid ACCEPT when verifier passed and no scope violations
  const validOutput = `
Here is my review:
\`\`\`json
{
  "verdict": "ACCEPT",
  "verifiedObservations": ["Correct return type", "Clean syntax"],
  "suspectedDefects": [],
  "unprovenCriteria": [],
  "scopeViolations": [],
  "reviewerConfidenceNote": "High confidence"
}
\`\`\`
`;
  const res1 = parseIndependentReviewVerdict(validOutput, cleanPackage);
  assert.equal(res1.verdict, "ACCEPT");
  assert.equal(res1.verifiedObservations.length, 2);

  // 2. Deterministic gate override: Verifier failed (exitCode 1) forces REJECT even if model said ACCEPT
  const failedVerifierPkg = { ...cleanPackage, verifierExitCode: 1 };
  const res2 = parseIndependentReviewVerdict(validOutput, failedVerifierPkg);
  assert.equal(res2.verdict, "REJECT");
  assert.match(res2.unprovenCriteria[0], /Deterministic verifier failed with exit code 1/);

  // 3. Deterministic gate override: Scope violation forces REJECT
  const restrictedScopePkg = { ...cleanPackage, authorizedScope: ["cli/src/feature.ts"] };
  const res3 = parseIndependentReviewVerdict(validOutput, restrictedScopePkg);
  assert.equal(res3.verdict, "REJECT");
  assert.deepEqual(res3.scopeViolations, ["cli/src/extra.ts"]);

  // 4. Suspected defects in payload forces REJECT
  const defectOutput = `
\`\`\`json
{
  "verdict": "ACCEPT",
  "verifiedObservations": [],
  "suspectedDefects": [{"path": "cli/src/feature.ts", "line": 10, "description": "Null pointer risk"}],
  "unprovenCriteria": [],
  "scopeViolations": []
}
\`\`\`
`;
  const res4 = parseIndependentReviewVerdict(defectOutput, cleanPackage);
  assert.equal(res4.verdict, "REJECT");
  assert.equal(res4.suspectedDefects.length, 1);

  // 5. Malformed JSON fails closed as REJECT
  const malformed = `Not valid JSON at all`;
  const res5 = parseIndependentReviewVerdict(malformed, cleanPackage);
  assert.equal(res5.verdict, "REJECT");
  assert.match(res5.suspectedDefects[0].description, /Failed to parse structured review verdict/);

  // 6. Truncated diff without passing verifier fails-closed as REJECT
  const hugeDiff = "a".repeat(25000);
  const truncatedPkg: ReviewEvidencePackage = {
    ...cleanPackage,
    unifiedDiff: hugeDiff,
    verifierExitCode: undefined, // Untested!
  };
  const res6 = parseIndependentReviewVerdict(validOutput, truncatedPkg);
  assert.equal(res6.verdict, "REJECT");
  assert.match(res6.unprovenCriteria.join("\n"), /Unified diff was truncated/);
});

// Headers exactly as `git diff` writes them (captured from git 2.x): non-ASCII and tab characters are C-quoted
// with octal escapes, and a bare path containing a space gets a trailing tab on ---/+++ lines.
const QUOTED_PATH_DIFF = [
  'diff --git a/cli/src/with space.ts "b/cli/src/moved \\303\\251.ts"',
  "rename from cli/src/with space.ts",
  'rename to "cli/src/moved \\303\\251.ts"',
  "--- a/cli/src/with space.ts\t",
  '+++ "b/cli/src/moved \\303\\251.ts"\t',
  "@@ -1 +1,2 @@",
  " b",
  "+d",
  'diff --git "a/cli/src/tab\\tname.ts" "b/cli/src/tab\\tname.ts"',
  '--- "a/cli/src/tab\\tname.ts"',
  '+++ "b/cli/src/tab\\tname.ts"',
  "@@ -1 +1,2 @@",
  " x",
  "+y",
  'diff --git "a/outside/\\303\\251.ts" "b/outside/\\303\\251.ts"',
  '--- "a/outside/\\303\\251.ts"',
  '+++ "b/outside/\\303\\251.ts"',
  "@@ -1,2 +1 @@",
  " a",
  "--- removed line that starts with two dashes",
  "",
].join("\n");

test("extractModifiedFilesFromDiff decodes Git-quoted paths, keeps bare paths with spaces, and ignores hunk lines", () => {
  assert.deepEqual(extractModifiedFilesFromDiff(QUOTED_PATH_DIFF).sort(), [
    "cli/src/moved é.ts",
    "cli/src/tab\tname.ts",
    "cli/src/with space.ts",
    "outside/é.ts",
  ]);
  assert.deepEqual(detectScopeViolations(QUOTED_PATH_DIFF, ["cli/src"]), ["outside/é.ts"]);
  assert.deepEqual(
    detectScopeViolations('diff --git "a/outside/\\303\\251.ts\n', ["cli/src"]).map((v) => v.startsWith("<unparseable diff header")),
    [true],
    "an unparseable header must surface as a violation, not disappear"
  );
});

test("parseIndependentReviewVerdict rejects missing or malformed schema fields instead of coercing them away", () => {
  const pkg = buildReviewEvidencePackage({
    operationId: "op",
    unitId: "u",
    objective: "o",
    authorizedScope: ["cli/src/feature.ts"],
    baselineCommit: "b",
    unifiedDiff: "diff --git a/cli/src/feature.ts b/cli/src/feature.ts\n--- a/cli/src/feature.ts\n+++ b/cli/src/feature.ts\n@@ -1 +1 @@\n-a\n+b\n",
    verifierOutput: "ok",
    verifierExitCode: 0,
  });
  const valid = { verdict: "ACCEPT", verifiedObservations: [], suspectedDefects: [], unprovenCriteria: [], scopeViolations: [], reviewerConfidenceNote: "n" };
  assert.equal(parseIndependentReviewVerdict(JSON.stringify(valid), pkg).verdict, "ACCEPT");

  const malformed: Array<[string, Record<string, unknown>]> = [
    ["string defects", { ...valid, suspectedDefects: "found a bug" }],
    ["defect entry without description", { ...valid, suspectedDefects: [{ path: "x.ts" }] }],
    ["non-object defect entry", { ...valid, suspectedDefects: ["bug"] }],
    ["missing suspectedDefects", { ...valid, suspectedDefects: undefined }],
    ["missing scopeViolations", { ...valid, scopeViolations: undefined }],
    ["non-string observation", { ...valid, verifiedObservations: [1] }],
    ["lower-case verdict", { ...valid, verdict: "accept" }],
    ["missing confidence note", { ...valid, reviewerConfidenceNote: undefined }],
  ];
  for (const [label, body] of malformed) {
    assert.equal(parseIndependentReviewVerdict(JSON.stringify(body), pkg).verdict, "REJECT", label);
  }
});

// ---------------------------------------------------------------- hunk-aware file extraction

test("a removed '-- before' line and an added '++ after' line inside a hunk are not file headers", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
--- before
+++ after
 tail
`;
  assert.deepEqual(extractModifiedFilesFromDiff(diff), ["src/a.ts"]);
  assert.deepEqual(detectScopeViolations(diff, ["src/a.ts"]), []);
});

test("hunk counts are consumed across several files and hunks, with omitted counts meaning 1", () => {
  const diff = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1,2 +1,2 @@
--- gone
+++ here
 same
@@ -10 +10 @@
--- second gone
+++ second here
\\ No newline at end of file
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -5 +5,2 @@
 ctx
+added
`;
  assert.deepEqual(extractModifiedFilesFromDiff(diff).sort(), ["one.ts", "two.ts"]);
});

test("a plain unified diff with several files and hunks is still parsed, including hunk content that looks like headers", () => {
  const diff = `--- a/one.ts\t2024-01-01
+++ b/one.ts\t2024-01-02
@@ -1,2 +1,2 @@
--- gone
+++ here
 same
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-old
+new
`;
  assert.deepEqual(extractModifiedFilesFromDiff(diff).sort(), ["one.ts", "two.ts"]);
});

test("a header that cannot be parsed after a completed hunk still fails closed", () => {
  const diff = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
diff --git "a/bad
`;
  assert.ok(extractModifiedFilesFromDiff(diff).some((f) => f.startsWith("<unparseable diff header")));
});

test("a plain-diff hunk whose counts overstate its body cannot swallow the next file's headers", () => {
  const diff = `--- a/x.txt
+++ b/x.txt
@@ -1,50 +1,50 @@
-old
+new
--- a/secret.txt
+++ b/secret.txt
@@ -1 +1 @@
-a
+b
`;
  assert.deepEqual(extractModifiedFilesFromDiff(diff).sort(), ["secret.txt", "x.txt"]);
  assert.deepEqual(detectScopeViolations(diff, ["x.txt"]), ["secret.txt"]);
  // Content that merely looks like a header pair is still content when no hunk header follows it.
  const content = `--- a/x.txt
+++ b/x.txt
@@ -1,4 +1,4 @@
 keep
--- before
+++ after
 tail
 end
`;
  assert.deepEqual(extractModifiedFilesFromDiff(content), ["x.txt"]);
});

test("F04: an ACCEPT that lists an unproven criterion is a REJECT that keeps the criterion", () => {
  const raw = JSON.stringify({ verdict: "ACCEPT", verifiedObservations: ["tests pass"], suspectedDefects: [], unprovenCriteria: ["Required crash recovery has not been demonstrated"], scopeViolations: [], reviewerConfidenceNote: "n" });
  const result = parseIndependentReviewVerdict(raw);
  assert.equal(result.verdict, "REJECT");
  assert.deepEqual(result.unprovenCriteria, ["Required crash recovery has not been demonstrated"]);
  assert.deepEqual(result.verifiedObservations, ["tests pass"], "the structured verdict is kept whole");
  const clean = parseIndependentReviewVerdict(JSON.stringify({ verdict: "ACCEPT", verifiedObservations: [], suspectedDefects: [], unprovenCriteria: [], scopeViolations: [], reviewerConfidenceNote: "n" }));
  assert.equal(clean.verdict, "ACCEPT");
});

test("a model ACCEPT with no deterministic verifier evidence is REJECT (missing evidence is not success)", () => {
  const accept = JSON.stringify({
    verdict: "ACCEPT",
    verifiedObservations: ["looks right"],
    suspectedDefects: [],
    unprovenCriteria: [],
    scopeViolations: [],
    reviewerConfidenceNote: "High confidence",
  });
  const untested: ReviewEvidencePackage = {
    operationId: "op-untested",
    unitId: "rev",
    objective: "All Good",
    baselineCommit: "base",
    unifiedDiff: SAMPLE_DIFF,
  };
  const res = parseIndependentReviewVerdict(accept, untested);
  assert.equal(res.verdict, "REJECT");
  assert.match(res.unprovenCriteria.join("\n"), /No deterministic verifier evidence/);
  // Same package with a passing run is still accepted: the gate keys on evidence, not on the reviewer.
  assert.equal(parseIndependentReviewVerdict(accept, { ...untested, verifierExitCode: 0 }).verdict, "ACCEPT");
});
