/**
 * VR-1 slice 2: `nexus verify` with type-check evidence and the verification-file guard. Most cases call verifyChange
 * in this process (no model, no network, a throwaway HOME and temp directory per call); a few spawn the real CLI for
 * the command-line surface. The type-check cases run this repository's own TypeScript compiler from a PATH directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VERIFY_MAX_GUARD_FILE_BYTES, VERIFY_MAX_GUARD_FINDINGS, type VerifyOperatorContext } from "../src/core/verify.js";
import { verifyExitCode, type VerifyJsonResult } from "../src/verify_contract.js";
import {
  BAD, BASE_FILES, DELIVERABLE, GOOD, MATH_BROKEN, MATH_BUGGY, MATH_FIXED, PACKAGE, TEST_FILE, TEST_FULL, TEST_HEAD,
  commit, consumeResult, head, runCli, toolPath, verifyInProcess, withRepos,
} from "./helpers/verify_fixture.js";

const OPERATOR: VerifyOperatorContext = { approveDiscoveredVerifier: true, deliverables: ["src/math.js"], sandbox: { engine: "none" } };
/**
 * The operator's own verifier: the same tests without `npm` in front (a third of the time). Used where the case does
 * not turn on how the verifier was chosen: what the guard finds and whether it blocks is the same for both.
 */
const OWN_VERIFIER: VerifyOperatorContext = { verifierCommand: "node --test", deliverables: ["src/math.js"], sandbox: { engine: "none" } };
const phases = (result: VerifyJsonResult): string[] => result.runs.map((ran) => ran.phase);
const summary = (result: VerifyJsonResult) => [result.verdict, result.outcome, result.reason, result.exitCode];

/** Commits `files` on a fresh copy of `baseFiles` and verifies base against head in this process. */
async function verifyChangeTo(
  baseFiles: Record<string, string>,
  files: Record<string, string | null>,
  operator: VerifyOperatorContext = OPERATOR,
  options: Parameters<typeof verifyInProcess>[2] = {},
): Promise<VerifyJsonResult> {
  return withRepos([baseFiles], async (repo) => {
    const base = head(repo);
    const changed = commit(repo, files);
    const run = await verifyInProcess({ worktree: repo, base, head: changed }, operator, options);
    assert.deepEqual(run.leftovers, [], "no scratch directory, verifier output file or build directory is left behind");
    return run.result;
  });
}

// ---- Type-check evidence ----

// JavaScript checked by the compiler, so the product file the tests import is also the file the type-check reads.
const TSCONFIG = JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: false, target: "es2022", module: "nodenext", types: [] }, include: ["src/*.js"] });
const SCALE = "export const scale = 2;\n";
const CALLER = 'import { scale } from "./math.js";\nexport const quad = (/** @type {number} */ a) => a * scale * scale;\n';
const TYPED_BASE = { ...BASE_FILES, "tsconfig.json": TSCONFIG, "src/math.js": `${MATH_BUGGY}${SCALE}`, "src/caller.js": CALLER };
const TYPED_FIX = `${MATH_FIXED}${SCALE}`;
/** The fix, with a type error in the same (changed) file. */
const TYPE_ERROR_IN_CHANGED = `${TYPED_FIX}/** @type {number} */\nexport const limit = "ten";\n`;
/** The fix, with an export retyped so that the untouched caller no longer type-checks. */
const BREAKS_CALLER = `${MATH_FIXED}export const scale = "2";\n`;
const LEGACY = '/** @type {number} */\nexport const legacy = "old";\n';
const REAL_TSC = { tsc: "real" } as const;
const projects = (result: VerifyJsonResult) => result.verification?.typecheck?.projects ?? [];

test("type-check: a clean fix is VERIFIED with the project's evidence; an error in a changed file, and a caller broken in an untouched file, are UNVERIFIED (exit 1)", { timeout: 120_000 }, async () => {
  const [clean, inChanged, inCaller] = [
    await verifyChangeTo(TYPED_BASE, { "src/math.js": TYPED_FIX }, OPERATOR, REAL_TSC),
    await verifyChangeTo(TYPED_BASE, { "src/math.js": TYPE_ERROR_IN_CHANGED }, OPERATOR, REAL_TSC),
    await verifyChangeTo(TYPED_BASE, { "src/math.js": BREAKS_CALLER }, OPERATOR, REAL_TSC),
  ];

  assert.deepEqual(summary(clean), ["VERIFIED", "VERIFIED", undefined, 0], clean.detail);
  assert.deepEqual(clean.typecheck, { status: "PASSED", mode: "enforce", baseline: [{ tool: "tsc", configPath: "tsconfig.json", status: "PASSED", errorCount: 0 }] });
  assert.equal(projects(clean).length, 1);
  const project = projects(clean)[0];
  assert.deepEqual([project.status, project.enforced, project.tool, project.configPath, project.command, project.exitCode, project.baselineErrorCount, project.scope], ["PASSED", true, "tsc", "tsconfig.json", "tsc --noEmit --incremental false -p tsconfig.json", 0, 0, "under tsconfig.json"]);
  assert.match(project.configSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(project.toolSha256 ?? "", /^[0-9a-f]{64}$/, "the hash of the compiler that ran");
  assert.match(project.toolVersion ?? "", /\d+\.\d+/);
  assert.equal(clean.verification?.typecheck?.status, "PASSED");

  for (const [result, file, introduced] of [[inChanged, "src/math.js", 1], [inCaller, "src/caller.js", 2]] as const) {
    assert.deepEqual(summary(result), ["UNVERIFIED", "NOT_ESTABLISHED", "TYPECHECK_FAILED", verifyExitCode("failed")], result.detail);
    assert.equal(result.exitCode, 1);
    assert.equal(result.typecheck.status, "FAILED");
    assert.equal(result.runs.find((ran) => ran.phase === "head")?.passed, true, "the tests themselves pass");
    // spine_handlers.ts: the verifier's pass does not count, and independence is not judged.
    assert.deepEqual([result.verification?.status, result.verification?.exitSuccess, result.verification?.independent], ["FAILED", false, undefined]);
    assert.deepEqual(phases(result), ["base", "head"]);
    const failed = projects(result)[0];
    assert.deepEqual([failed.status, failed.introducedCount, failed.baselineErrorCount], ["FAILED", introduced, 0]);
    assert.ok(failed.firstDiagnostics?.every((line) => line.startsWith(`${file}(`)), `the evidence names ${file}: ${failed.firstDiagnostics}`);
    assert.match(result.detail ?? "", /tsc type-check failed under tsconfig\.json/);
    assert.ok(result.detail?.includes(file));
  }
  assert.deepEqual(inCaller.changedFiles, ["src/math.js"], "the caller was not touched: the error is new against the base");
});

test("type-check: an error the base already had is PREEXISTING and does not lower the verdict; NEXUS_TYPECHECK=off disables the check and is named", { timeout: 120_000 }, async () => {
  const preexisting = await verifyChangeTo({ ...TYPED_BASE, "src/legacy.js": LEGACY }, { "src/math.js": TYPED_FIX }, OPERATOR, REAL_TSC);
  assert.deepEqual(summary(preexisting), ["VERIFIED", "VERIFIED", undefined, 0], preexisting.detail);
  assert.deepEqual(preexisting.typecheck, { status: "PREEXISTING", mode: "enforce", baseline: [{ tool: "tsc", configPath: "tsconfig.json", status: "PREEXISTING", errorCount: 1 }] });
  assert.deepEqual([projects(preexisting)[0].errorCount, projects(preexisting)[0].introducedCount, projects(preexisting)[0].baselineErrorCount], [1, 0, 1]);

  // The same head that is UNVERIFIED above. Switching the check off is the launcher's decision, as it is for the agent.
  const off = await verifyChangeTo(TYPED_BASE, { "src/math.js": TYPE_ERROR_IN_CHANGED }, OPERATOR, { ...REAL_TSC, env: { NEXUS_TYPECHECK: "off" } });
  assert.deepEqual(summary(off), ["VERIFIED", "VERIFIED", undefined, 0], off.detail);
  assert.deepEqual(off.environment, ["NEXUS_TYPECHECK"]);
  assert.equal(off.typecheck.status, "NOT_APPLICABLE");
  assert.equal(off.typecheck.mode, "off");
  assert.match(off.typecheck.detail ?? "", /disabled by NEXUS_TYPECHECK/);
  assert.deepEqual([off.verification?.typecheck?.status, off.verification?.typecheck?.scope], ["NOT_APPLICABLE", "disabled by NEXUS_TYPECHECK / typecheck setting"]);
});

test("type-check: a missing compiler is UNAVAILABLE and, enforced, UNVERIFIED (exit 1), as the agent refuses it; a project the head removed withholds the result", { timeout: 120_000 }, async () => {
  const missing = await verifyChangeTo(TYPED_BASE, { "src/math.js": TYPED_FIX });
  assert.deepEqual(summary(missing), ["UNVERIFIED", "NOT_ESTABLISHED", "TYPECHECK_UNAVAILABLE", 1], missing.detail);
  assert.equal(missing.typecheck.status, "UNAVAILABLE");
  assert.deepEqual(missing.typecheck.baseline, [{ tool: "tsc", configPath: "tsconfig.json", status: "NOT_RUN" }]);
  assert.match(missing.detail ?? "", /tsc is not installed/);
  assert.equal(projects(missing)[0].scope, "tsc is not installed, so nothing was type-checked under tsconfig.json");

  // The residual case: type-checking is enforced, the base has a project, and the head has none to run. (For a
  // TypeScript project this is caught earlier: every tsconfig.json is part of the verifier's definition, so a head that
  // removes or edits one is VERIFIER_DEFINITION_CHANGED. A mypy, pyright, Cargo or Go project has no such binding.)
  const removed = await verifyChangeTo({ ...BASE_FILES, "mypy.ini": "[mypy]\nstrict = True\n" }, { ...GOOD, "mypy.ini": null });
  assert.deepEqual(summary(removed), ["UNVERIFIED", "UNVERIFIED", "TYPECHECK_NOT_RUN", verifyExitCode("unverified")], removed.detail);
  assert.deepEqual(removed.typecheck.missingFromHead, ["mypy under mypy.ini"]);
  assert.equal(removed.typecheck.status, "NOT_APPLICABLE");
  assert.match(removed.detail ?? "", /no type-check evidence exists for it/);
  assert.equal(removed.verification?.status, "PASSED", "the tests pass; the result is withheld, not failed");
});

test("type-check: with your own --verifier a failing check is recorded only, unless NEXUS_TYPECHECK=enforce", { timeout: 120_000 }, async () => {
  const recorded = await verifyChangeTo(TYPED_BASE, { "src/math.js": TYPE_ERROR_IN_CHANGED }, OWN_VERIFIER, REAL_TSC);
  assert.deepEqual(summary(recorded), ["VERIFIED", "VERIFIED", undefined, 0], recorded.detail);
  assert.deepEqual([recorded.typecheck.status, recorded.typecheck.mode, projects(recorded)[0].enforced], ["FAILED", "record", false]);
  const enforced = await verifyChangeTo(TYPED_BASE, { "src/math.js": TYPE_ERROR_IN_CHANGED }, OWN_VERIFIER, { ...REAL_TSC, env: { NEXUS_TYPECHECK: "enforce" } });
  assert.deepEqual(summary(enforced), ["UNVERIFIED", "NOT_ESTABLISHED", "TYPECHECK_FAILED", 1], enforced.detail);
  assert.deepEqual(enforced.environment, ["NEXUS_TYPECHECK"]);
});

test("the pristine-copy rule: a type-checker that rewrites the tree it runs in changes neither the guard findings, nor the changed-file set, nor what the head is judged on", { timeout: 120_000 }, async () => {
  // A stand-in compiler that puts the base's test file back and re-introduces the bug, then reports success. A verdict
  // read from its directory would find the tests unchanged (no rerun of the base's tests) or the product broken.
  const tamperingTsc = `#!/bin/sh
if [ "$1" = --version ]; then echo "Version 5.9.3"; exit 0; fi
cat > ${TEST_FILE} <<'NEXUS_EOF'
${TEST_FULL}NEXUS_EOF
cat > src/math.js <<'NEXUS_EOF'
${MATH_BUGGY}${SCALE}NEXUS_EOF
rm -f tsconfig.json
exit 0
`;
  const moreTests = `${TEST_FULL}test("double again", () => assert.equal(double(3), 6));\n`;
  const change = { "src/math.js": TYPED_FIX, [TEST_FILE]: moreTests };
  const result = await verifyChangeTo(TYPED_BASE, change, OPERATOR, { tsc: tamperingTsc });
  assert.deepEqual(summary(result), ["VERIFIED", "VERIFIED", undefined, 0], result.detail);
  assert.deepEqual(result.guard.findings, [{ path: TEST_FILE, class: "test_file", kind: "modified", requiresApproval: false, approved: false }]);
  assert.deepEqual(result.changedFiles, ["src/math.js", TEST_FILE]);
  assert.deepEqual(phases(result), ["base", "head", "base_tests_on_head"], "the head's test edit was seen, so the base's tests were rerun against the head's code");
  assert.equal(result.runs[2].passed, true, "against the head's code as committed, not as the stand-in compiler left it");
  assert.equal(result.verification?.independent, true);
  assert.deepEqual([result.typecheck.status, result.typecheck.missingFromHead], ["PASSED", undefined], "the project was discovered before the stand-in ran");
});

test("a Cargo type-check's build directory is removed with the scratch trees", { timeout: 60_000 }, async () => {
  const fakeCargo = '#!/bin/sh\nif [ "$1" = --version ]; then echo "cargo 1.90.0"; exit 0; fi\nmkdir -p "$CARGO_TARGET_DIR/debug" && echo built > "$CARGO_TARGET_DIR/debug/out"\nexit 0\n';
  await withRepos([{ ...BASE_FILES, "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\n' }], async (repo) => {
    const base = head(repo);
    const changed = commit(repo, GOOD);
    const tools = toolPath(undefined);
    fs.writeFileSync(path.join(tools.dir, "cargo"), fakeCargo, { mode: 0o755 });
    try {
      // The verifier is the operator's, so the base tree's Cargo project does not choose it.
      const run = await verifyInProcess({ worktree: repo, base, head: changed }, { verifierCommand: "node --test", deliverables: ["src/math.js"], sandbox: { engine: "none" } }, { env: { PATH: tools.PATH } });
      assert.equal(run.result.typecheck.status, "PASSED", run.result.detail);
      assert.equal(projects(run.result)[0].tool, "cargo");
      assert.match(projects(run.result)[0].command ?? "", /^CARGO_TARGET_DIR='[^']+nexus-typecheck-[0-9a-f]{16}' cargo check --offline --locked$/);
      assert.deepEqual(run.leftovers, [], "the build directories of both sides are gone");
    } finally {
      fs.rmSync(tools.dir, { recursive: true, force: true });
    }
  });
});

// ---- The verification-file guard ----

const SKIPPED = TEST_FULL.replace('test("double"', 'test.skip("double"');
const finding = (result: VerifyJsonResult, file: string) => result.guard.findings.find((item) => item.path === file);
const approving = (...files: string[]): VerifyOperatorContext => ({ ...OPERATOR, approvedVerificationEdits: files });

test("guard: a weakened test (assertion removed, .skip added, an early exit, the file deleted) is BLOCKED with the weakening named; approved, it is no longer BLOCKED and still not VERIFIED", { timeout: 120_000 }, async () => {
  const cases: Array<{ name: string; files: Record<string, string | null>; kind: string; weakening: string[] }> = [
    { name: "assertion removed", files: BAD, kind: "modified", weakening: ["fewer-assertions"] },
    { name: ".skip added", files: { ...GOOD, [TEST_FILE]: SKIPPED }, kind: "modified", weakening: ["skipped"] },
    { name: "early exit added", files: { ...GOOD, [TEST_FILE]: `${TEST_HEAD}process.exit(0);\ntest("add", () => assert.equal(add(2, 3), 5));\n` }, kind: "modified", weakening: ["neutered"] },
    { name: "test file deleted", files: { ...GOOD, [TEST_FILE]: null }, kind: "deleted", weakening: ["removed"] },
  ];
  for (const c of cases) {
    const blocked = await verifyChangeTo(BASE_FILES, c.files, OWN_VERIFIER);
    assert.deepEqual(summary(blocked), ["BLOCKED", "UNVERIFIED", "VERIFICATION_EDIT_BLOCKED", 3], `${c.name}: ${blocked.detail}`);
    assert.deepEqual(blocked.guard.status, "BLOCKED", c.name);
    assert.deepEqual(finding(blocked, TEST_FILE), { path: TEST_FILE, class: "test_file", kind: c.kind, weakening: c.weakening, requiresApproval: true, approved: false }, c.name);
    assert.ok(blocked.detail?.includes(`${TEST_FILE} (test_file, ${c.kind}: ${c.weakening.join(", ")})`), `${c.name}: ${blocked.detail}`);
    assert.match(blocked.detail ?? "", /--approve-verification-edit <path>/, c.name);
  }

  // Approved, with the verifier the base tree defines. The bug stays and the failing test goes: the verdict is what the
  // base's tests show.
  const bugLeftIn = await verifyChangeTo(BASE_FILES, BAD, approving(TEST_FILE));
  assert.deepEqual(summary(bugLeftIn), ["REGRESSION_FREE", "REGRESSION_FREE", "REGRESSION_FREE", 2], bugLeftIn.detail);
  assert.equal(bugLeftIn.guard.status, "CLEAR");
  assert.deepEqual(finding(bugLeftIn, TEST_FILE), { path: TEST_FILE, class: "test_file", kind: "modified", weakening: ["fewer-assertions"], requiresApproval: true, approved: true });
  assert.deepEqual(bugLeftIn.approvedVerificationEdits, [TEST_FILE]);
  assert.equal(bugLeftIn.verification?.independent, false);

  // A real fix beside the weakening is the case only the approval rule holds back: the base's tests, rerun against the
  // head, pass, so by the tests alone this is VERIFIED.
  const fixAndSkip = await verifyChangeTo(BASE_FILES, cases[1].files, approving(TEST_FILE));
  assert.deepEqual(summary(fixAndSkip), ["REGRESSION_FREE", "REGRESSION_FREE", "REGRESSION_FREE", 2], fixAndSkip.detail);
  assert.equal(fixAndSkip.verification?.independent, true);
  assert.equal(fixAndSkip.verification?.isDeliverableBound, true);
  assert.match(fixAndSkip.detail ?? "", /lets the result be reported; it does not make the change verified/);

  // A deleted test file, approved: the head runs no test at all.
  const deleted = await verifyChangeTo(BASE_FILES, cases[3].files, { ...OWN_VERIFIER, approvedVerificationEdits: [TEST_FILE] });
  assert.deepEqual(summary(deleted), ["UNVERIFIED", "UNVERIFIED", "NO_TESTS_EXECUTED", 2], deleted.detail);
});

test("guard: a plain edit of a test and a new test file are recorded and do not block; an edit to package.json outside its scripts is no finding", { timeout: 120_000 }, async () => {
  const extraTest = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { double } from "../src/math.js";\ntest("double of zero", () => assert.equal(double(0), 0));\n';
  const added = await verifyChangeTo(BASE_FILES, { ...GOOD, "test/extra.test.mjs": extraTest });
  assert.deepEqual(added.guard, { status: "CLEAR", mode: "approve", policySource: "default", findings: [{ path: "test/extra.test.mjs", class: "test_file", kind: "added", requiresApproval: false, approved: false }], complete: true });
  assert.deepEqual(summary(added), ["VERIFIED", "VERIFIED", undefined, 0], added.detail);

  // (That a plain edit of a test can still be VERIFIED is in the pristine-copy case above.)
  const edited = await verifyChangeTo(BASE_FILES, { ...GOOD, [TEST_FILE]: `${TEST_FULL}test("double of three", () => assert.equal(double(3), 6));\n` }, OWN_VERIFIER);
  assert.deepEqual(edited.guard, { status: "CLEAR", mode: "approve", policySource: "default", findings: [{ path: TEST_FILE, class: "test_file", kind: "modified", requiresApproval: false, approved: false }], complete: true });
  assert.notEqual(edited.verdict, "BLOCKED");

  const described = await verifyChangeTo(BASE_FILES, { ...GOOD, "package.json": JSON.stringify({ ...JSON.parse(PACKAGE), description: "a description" }) }, OWN_VERIFIER);
  assert.deepEqual(described.guard.findings, []);
  assert.notEqual(described.verdict, "BLOCKED");
});

test("guard: an edit to package.json's scripts or to a CI workflow is BLOCKED; approved, it is not BLOCKED and not VERIFIED", { timeout: 120_000 }, async () => {
  const rescripted = JSON.stringify({ ...JSON.parse(PACKAGE), scripts: { test: "echo 'ℹ tests 2' && echo 'ℹ pass 2' && echo 'ℹ fail 0'" } });
  const scripts = { ...GOOD, "package.json": rescripted };
  const blockedScripts = await verifyChangeTo(BASE_FILES, scripts);
  assert.deepEqual(summary(blockedScripts), ["BLOCKED", "UNVERIFIED", "VERIFICATION_EDIT_BLOCKED", 3], blockedScripts.detail);
  assert.deepEqual(blockedScripts.guard.findings, [{ path: "package.json", class: "package_scripts", kind: "modified", requiresApproval: true, approved: false }]);
  assert.deepEqual(phases(blockedScripts), ["base"], "the head's rewritten script was never run");
  // Approved: the verifier's own rules still apply. The definition changed, so the head is not run and nothing is established.
  const approvedScripts = await verifyChangeTo(BASE_FILES, scripts, approving("package.json"));
  assert.deepEqual(summary(approvedScripts), ["UNVERIFIED", "NOT_ESTABLISHED", "VERIFIER_DEFINITION_CHANGED", 1], approvedScripts.detail);
  assert.equal(approvedScripts.guard.status, "CLEAR");

  const workflow = { ...GOOD, ".github/workflows/ci.yml": "on: push\njobs: {}\n" };
  const blockedWorkflow = await verifyChangeTo(BASE_FILES, workflow, OWN_VERIFIER);
  assert.deepEqual(summary(blockedWorkflow), ["BLOCKED", "UNVERIFIED", "VERIFICATION_EDIT_BLOCKED", 3], blockedWorkflow.detail);
  assert.deepEqual(blockedWorkflow.guard.findings, [{ path: ".github/workflows/ci.yml", class: "ci", kind: "added", requiresApproval: true, approved: false }]);
  const approvedWorkflow = await verifyChangeTo(BASE_FILES, workflow, { ...OWN_VERIFIER, approvedVerificationEdits: [".github/workflows/ci.yml"] });
  assert.notEqual(approvedWorkflow.verdict, "BLOCKED");
  assert.notEqual(approvedWorkflow.verdict, "VERIFIED");
  assert.deepEqual(summary(approvedWorkflow), ["REGRESSION_FREE", "REGRESSION_FREE", "REGRESSION_FREE", 2], approvedWorkflow.detail);
  // An approval for another path approves nothing here.
  const wrongPath = await verifyChangeTo(BASE_FILES, workflow, { ...OWN_VERIFIER, approvedVerificationEdits: ["package.json"] });
  assert.equal(wrongPath.verdict, "BLOCKED");
});

test("guard: the policy is the base tree's, read as untrusted. The head's .nexus-security.json has no effect, NEXUS_TRUST_WORKSPACE=1 does not let a repository relax the guard, and a base policy can tighten it", { timeout: 120_000 }, async () => {
  const OFF = '{"verificationPaths":{"mode":"off","allow":["test/**"]}}\n';
  // The head ships a policy that switches the guard off and exempts the tests, and that would also claim more paths.
  // None of it is read: not the relaxing, and not the tightening either (the product file is no finding).
  const fromHead = await verifyChangeTo(BASE_FILES, { ...GOOD, ...BAD, ".nexus-security.json": '{"verificationPaths":{"mode":"off","allow":["test/**"],"extra":["src/**"]}}\n' }, OWN_VERIFIER);
  assert.deepEqual(summary(fromHead), ["BLOCKED", "UNVERIFIED", "VERIFICATION_EDIT_BLOCKED", 3], fromHead.detail);
  assert.deepEqual([fromHead.guard.mode, fromHead.guard.policySource], ["approve", "default"]);
  assert.deepEqual(fromHead.changedFiles, [".nexus-security.json", "src/math.js", TEST_FILE]);
  assert.deepEqual(fromHead.guard.findings, [
    { path: ".nexus-security.json", class: "policy", kind: "added", requiresApproval: true, approved: false },
    { path: TEST_FILE, class: "test_file", kind: "modified", weakening: ["fewer-assertions"], requiresApproval: true, approved: false },
  ]);
  // A head policy of mode "block" does not make the operator's approvals void, as the base's would.
  const headBlocks = await verifyChangeTo(BASE_FILES, { ...BAD, ".nexus-security.json": '{"verificationPaths":{"mode":"block"}}\n' }, { ...OWN_VERIFIER, approvedVerificationEdits: [TEST_FILE, ".nexus-security.json"] });
  assert.deepEqual([headBlocks.guard.mode, headBlocks.guard.status, headBlocks.verdict], ["approve", "CLEAR", "REGRESSION_FREE"], headBlocks.detail);

  // The same policy in the BASE tree, with the launcher's NEXUS_TRUST_WORKSPACE=1: for the agent that variable makes a
  // workspace trusted, and a trusted workspace's policy may relax the guard. Here it does not.
  const trusted = await verifyChangeTo({ ...BASE_FILES, ".nexus-security.json": OFF }, BAD, OWN_VERIFIER, { env: { NEXUS_TRUST_WORKSPACE: "1" } });
  assert.deepEqual(summary(trusted), ["BLOCKED", "UNVERIFIED", "VERIFICATION_EDIT_BLOCKED", 3], trusted.detail);
  assert.deepEqual([trusted.guard.mode, trusted.guard.policySource], ["approve", "base_tree"]);
  assert.deepEqual(trusted.environment, ["NEXUS_TRUST_WORKSPACE"]);
  assert.equal(finding(trusted, TEST_FILE)?.requiresApproval, true, "the base policy's allow list is not honoured either");

  // Tightening is honoured: mode "block" refuses the edit even when the operator approves it, and `extra` adds paths.
  const strict = { ...BASE_FILES, ".nexus-security.json": '{"verificationPaths":{"mode":"block","extra":["src/golden/**"]}}\n', "src/golden/a.txt": "1\n" };
  const refused = await verifyChangeTo(strict, { ...GOOD, [TEST_FILE]: SKIPPED, "src/golden/a.txt": "2\n" }, { ...OWN_VERIFIER, approvedVerificationEdits: [TEST_FILE, "src/golden/a.txt"] });
  assert.deepEqual(summary(refused), ["BLOCKED", "UNVERIFIED", "VERIFICATION_EDIT_BLOCKED", 3], refused.detail);
  assert.deepEqual([refused.guard.mode, refused.guard.policySource, refused.guard.status], ["block", "base_tree", "BLOCKED"]);
  assert.deepEqual(refused.guard.findings.map((item) => [item.path, item.class, item.approved]), [["src/golden/a.txt", "test_config", true], [TEST_FILE, "test_file", true]]);
  assert.match(refused.detail ?? "", /mode block\) refuses such edits/);
});

test("precedence: a head that fails (tests or an enforced type-check) keeps exit 1 over a guard finding; BLOCKED outranks every result that did not fail", { timeout: 120_000 }, async () => {
  // Tests fail and the test file is weakened: "it fails" is the verdict, and the finding is still listed.
  const failing = await verifyChangeTo(BASE_FILES, { "src/math.js": MATH_BROKEN, [TEST_FILE]: `${TEST_HEAD}test.skip("add", () => assert.equal(add(2, 3), 5));\n` }, OWN_VERIFIER);
  assert.deepEqual(summary(failing), ["UNVERIFIED", "NOT_ESTABLISHED", "VERIFIER_FAILED", 1], failing.detail);
  assert.equal(failing.guard.status, "BLOCKED");
  assert.deepEqual(finding(failing, TEST_FILE)?.weakening, ["skipped"]);

  // The weakened head passes its tests and fails the type-check.
  const typeError = await verifyChangeTo(TYPED_BASE, { ...BAD, "src/math.js": `${MATH_BUGGY}${SCALE}/** @type {number} */\nexport const limit = "ten";\n` }, OPERATOR, REAL_TSC);
  assert.deepEqual(summary(typeError), ["UNVERIFIED", "NOT_ESTABLISHED", "TYPECHECK_FAILED", 1], typeError.detail);
  assert.equal(typeError.guard.status, "BLOCKED");

  // Over REGRESSION_FREE and over an UNVERIFIED that exits 2 (covered above: assertion removed; test file deleted), and
  // over a head that was not run because it redefines the verifier (covered above: package.json scripts).
  // A discovered verifier that is not approved keeps its own reason: nothing was run, and the finding is listed.
  const unapprovedVerifier = await verifyChangeTo(BASE_FILES, BAD, { deliverables: ["src/math.js"] });
  assert.deepEqual(summary(unapprovedVerifier), ["BLOCKED", "UNVERIFIED", "VERIFIER_NOT_APPROVED", 3], unapprovedVerifier.detail);
  assert.equal(unapprovedVerifier.guard.status, "BLOCKED");
  assert.deepEqual(unapprovedVerifier.runs, []);
});

test("guard: a changed verification file that cannot be classified, or more findings than are listed, is BLOCKED as incomplete, approved or not", { timeout: 120_000 }, async () => {
  const huge = `${TEST_FULL}// ${"x".repeat(VERIFY_MAX_GUARD_FILE_BYTES)}\n`;
  for (const operator of [OWN_VERIFIER, { ...OWN_VERIFIER, approvedVerificationEdits: [TEST_FILE] }]) {
    const unread = await verifyChangeTo(BASE_FILES, { ...GOOD, [TEST_FILE]: huge }, operator);
    assert.deepEqual(summary(unread), ["BLOCKED", "UNVERIFIED", "GUARD_INCOMPLETE", 3], unread.detail);
    assert.equal(unread.guard.complete, false);
    assert.equal(unread.guard.status, "BLOCKED");
    assert.deepEqual(finding(unread, TEST_FILE)?.weakening, ["unverifiable-change"]);
    assert.match(unread.guard.detail ?? "", new RegExp(`larger than ${VERIFY_MAX_GUARD_FILE_BYTES} bytes\\): test/math\\.test\\.mjs`));
  }

  // One finding more than a result lists. Your own verifier that runs nothing keeps this quick: the guard has read the
  // change before any verifier runs.
  const many: Record<string, string> = {};
  for (let i = 0; i <= VERIFY_MAX_GUARD_FINDINGS; i++) many[`test/generated/t${i}.test.mjs`] = "\n";
  const overflow = await verifyChangeTo(BASE_FILES, many, { verifierCommand: "true", deliverables: ["src/math.js"] });
  assert.deepEqual(summary(overflow), ["BLOCKED", "UNVERIFIED", "GUARD_INCOMPLETE", 3], overflow.detail);
  assert.equal(overflow.guard.complete, false);
  assert.equal(overflow.guard.findings.length, VERIFY_MAX_GUARD_FINDINGS);
  assert.match(overflow.detail ?? "", /Without this the result was UNVERIFIED \(NO_TESTS_EXECUTED\)/);
});

// ---- The command line ----

test("CLI: the text verdicts for a type error and a weakened test, --approve-verification-edit, and its usage error", { timeout: 180_000 }, async () => {
  const tools = toolPath("real");
  try {
    await withRepos([TYPED_BASE, BASE_FILES], async (typed, plain) => {
      const typedBase = head(typed);
      const typedHead = commit(typed, { "src/math.js": TYPE_ERROR_IN_CHANGED });
      const plainBase = head(plain);
      const plainHead = commit(plain, BAD);
      const weakened = ["-w", plain, "--base", plainBase, "--head", plainHead, ...DELIVERABLE, "-y", "--sandbox", "none"];
      const [typeText, typeJson, weakText, approvedJson, usage] = await Promise.all([
        runCli(["-w", typed, "--base", typedBase, "--head", typedHead, ...DELIVERABLE, "-y", "--sandbox", "none"], { PATH: tools.PATH }),
        runCli(["-w", typed, "--base", typedBase, "--head", typedHead, ...DELIVERABLE, "-y", "--sandbox", "none", "--json"], { PATH: tools.PATH }),
        runCli(weakened),
        runCli([...weakened, "--json", "--approve-verification-edit", `./${TEST_FILE}`, "--approve-verification-edit", "package.json"]),
        runCli([...weakened, "--approve-verification-edit", "../outside.js"]),
      ]);
      assert.equal(typeText.code, 1, typeText.stderr);
      assert.match(typeText.stdout, /^nexus verify: UNVERIFIED \(TYPECHECK_FAILED\)$/m);
      assert.match(typeText.stdout, /^ {2}type-check +FAILED \(enforce\)$/m);
      assert.match(typeText.stdout, /^ {15}FAILED: tsc under tsconfig\.json, 1 error\(s\), 1 not on the base$/m);
      assert.match(typeText.stdout, /^ {4}\| src\/math\.js\(5,14\): error TS2322: /m);
      assert.match(typeText.stdout, /^ {2}exit code +1$/m);
      assert.deepEqual(typeText.leftovers, []);
      const typeDoc = consumeResult(typeJson);
      assert.deepEqual([typeDoc.verdict, typeDoc.reason, typeJson.code], ["UNVERIFIED", "TYPECHECK_FAILED", 1]);

      assert.equal(weakText.code, 3, weakText.stderr);
      assert.match(weakText.stdout, /^nexus verify: BLOCKED \(VERIFICATION_EDIT_BLOCKED\)$/m);
      assert.match(weakText.stdout, /^ {2}guard +BLOCKED \(mode approve, default policy\): 1 changed verification file\(s\)$/m);
      assert.match(weakText.stdout, /^ {15}test\/math\.test\.mjs: test_file, modified, weakening: fewer-assertions; NOT APPROVED$/m);
      assert.match(weakText.stdout, /^ {2}exit code +3$/m);
      assert.deepEqual(weakText.leftovers, []);

      const approved = consumeResult(approvedJson);
      assert.deepEqual([approved.verdict, approvedJson.code], ["REGRESSION_FREE", 2]);
      assert.deepEqual(approved.approvedVerificationEdits, [TEST_FILE, "package.json"], "normalised, in the order given");
      assert.equal(approved.guard.findings[0].approved, true);

      assert.equal(usage.code, verifyExitCode("usage"));
      assert.match(usage.stderr, /^error: --approve-verification-edit \.\.\/outside\.js is not a path inside the working tree$/m);
      assert.equal(usage.stdout, "");
    });
  } finally {
    fs.rmSync(tools.dir, { recursive: true, force: true });
  }
});
