/** VC-1: the independent-review gate enforces operator-declared boundary rules; a model ACCEPT cannot override a violation. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewEvidencePackage, formatIndependentReviewPrompt, parseIndependentReviewVerdict } from "../src/core/independent_review.js";
import type { BoundaryRules } from "../src/core/boundary_rules.js";

const diff = (file: string, added: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,${1 + added.length} @@\n keep\n${added.map((l) => `+${l}`).join("\n")}\n`;
const ACCEPT = '```json\n{"verdict":"ACCEPT","verifiedObservations":["ok"],"suspectedDefects":[],"unprovenCriteria":[],"scopeViolations":[],"reviewerConfidenceNote":"high"}\n```';
const RULES: BoundaryRules = { imports: [{ name: "ui-not-db", from: ["src/ui/**"], deny: ["src/db/**"], allow: ["src/ui/**", "react"] }], protected: ["src/api/public.ts"] };

const pkg = (unifiedDiff: string, boundaries?: BoundaryRules, authorizedScope?: string[]) =>
  buildReviewEvidencePackage({ unitId: "rev", objective: "obj", baselineCommit: "base", unifiedDiff, verifierExitCode: 0, ...(boundaries ? { boundaries } : {}), ...(authorizedScope ? { authorizedScope } : {}) });

test("a boundary violation is REJECTed even when the verifier passed and the model says ACCEPT, and the report names it", () => {
  const verdict = parseIndependentReviewVerdict(ACCEPT, pkg(diff("src/ui/a.ts", ["import c from '../db/client';"]), RULES));
  assert.equal(verdict.verdict, "REJECT");
  assert.match(verdict.unprovenCriteria.join("\n"), /Boundary rule violated \[ui-not-db\] src\/ui\/a\.ts: imports src\/db\/client, which this rule denies/);
  assert.equal(verdict.boundaryReport?.violations.length, 1);
  assert.ok(verdict.boundaryReport!.coverage.limits.length >= 5, "coverage limits travel with the verdict");
});

test("a protected public file changed outside the authorised scope is a violation; inside it, accepted", () => {
  const change = diff("src/api/public.ts", ["export const v = 2;"]);
  assert.equal(parseIndependentReviewVerdict(ACCEPT, pkg(change, RULES, ["src/api"])).verdict, "ACCEPT");
  assert.equal(parseIndependentReviewVerdict(ACCEPT, pkg(change, RULES, ["src/other"])).verdict, "REJECT");
});

test("with no scope declared, a protected file change is rejected by the boundary check alone", () => {
  const verdict = parseIndependentReviewVerdict(ACCEPT, pkg(diff("src/api/public.ts", ["export const v = 2;"]), RULES));
  assert.equal(verdict.verdict, "REJECT");
  assert.deepEqual(verdict.scopeViolations, [], "the scope gate did not run: nothing but the boundary rule can have rejected it");
  assert.deepEqual(verdict.boundaryReport!.violations.map((v) => v.rule), ["protected"]);
});

test("an undeclared dependency is an advisory only: still ACCEPT, with the advisory in the report", () => {
  const verdict = parseIndependentReviewVerdict(ACCEPT, pkg(diff("src/ui/a.ts", ["import l from 'left-pad';"]), RULES));
  assert.equal(verdict.verdict, "ACCEPT");
  assert.deepEqual(verdict.boundaryReport?.violations, []);
  assert.match(verdict.boundaryReport!.advisories[0].detail, /undeclared dependency/);
});

test("with no rules declared nothing changes: no report on the verdict, no boundary text in the prompt", () => {
  const plain = pkg(diff("src/ui/a.ts", ["import c from '../db/client';"]));
  const verdict = parseIndependentReviewVerdict(ACCEPT, plain);
  assert.equal(verdict.verdict, "ACCEPT");
  assert.equal("boundaryReport" in verdict, false);
  assert.doesNotMatch(formatIndependentReviewPrompt(plain), /AUTOMATED BOUNDARY CHECK/);
});

test("the reviewer is told, in the prompt, what the deterministic check found", () => {
  const prompt = formatIndependentReviewPrompt(pkg(diff("src/ui/a.ts", ["import c from '../db/client';"]), RULES));
  assert.match(prompt, /\[AUTOMATED BOUNDARY CHECK\].*rejected regardless of your verdict/s);
  assert.match(prompt, /VIOLATION \[ui-not-db\] src\/ui\/a\.ts/);
});

test("an unreadable model answer still fails closed and carries no boundary claim", () => {
  const verdict = parseIndependentReviewVerdict("no json here", pkg(diff("src/ui/a.ts", ["const x = 1;"]), RULES));
  assert.equal(verdict.verdict, "REJECT");
});
