/**
 * VR-1 slice 3, gate G-3: `nexus verify` attacked as an untrusted repository or caller would attack it. One test per
 * attack; each says in its name what was attempted and asserts that the verdict is not raised. A comment on each says
 * how it ends:
 *   PREVENTED  the attack has no effect on the verdict, and where a program was to run, it did not;
 *   LOWERED    the attack is noticed and the verdict is one that says so (never VERIFIED);
 *   LIMIT      a documented limit: the test pins exactly what is and is not protected, so a change shows up here.
 * Attacks already covered by the first two slices are not repeated (the table is in docs/VERIFY_IN_CI.md):
 * test/verify_command.test.ts (a rewritten scripts.test, a verifier only the head defines, `echo ok`, base equal to
 * head, the self-restoring test, a submodule, a repository planted in a linked worktree, the recorded environment) and
 * test/verify_typecheck_guard.test.ts (the head's policy file, NEXUS_TRUST_WORKSPACE, weakened tests, a type-checker
 * that rewrites its tree). The sandbox itself is test/verify_sandbox.test.ts.
 *
 * Nearly every case calls verifyChange in this process (a throwaway HOME and temp directory per call; no model, no
 * network); the two that are about the command line and the printed output spawn the CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { isSandboxAvailable } from "../src/sandbox.js";
import { VERIFY_MAX_TREE_FILES, VERIFY_RECORDED_ENVIRONMENT, VerifyUsageError, renderVerifyText, verifyChange, type VerifyOperatorContext } from "../src/core/verify.js";
import type { VerifyJsonResult } from "../src/verify_contract.js";
import {
  BASE_FILES, GOOD, MATH_BUGGY, MATH_FIXED, PACKAGE, TEST_FILE, TEST_FULL, TEST_HEAD,
  commit, consume, consumeResult, git, head, runCli, verifyInProcess, withRepos, writeFiles,
} from "./helpers/verify_fixture.js";

const OPERATOR: VerifyOperatorContext = { approveDiscoveredVerifier: true, deliverables: ["src/math.js"], sandbox: { engine: "none" } };
const OWN_VERIFIER: VerifyOperatorContext = { verifierCommand: "node --test", deliverables: ["src/math.js"], sandbox: { engine: "none" } };
/** The bug stays, and the declared deliverable still counts as changed. */
const STILL_BUGGY = `${MATH_BUGGY}// touched\n`;
/** The failing assertion rewritten to expect the bug: the same number of tests and assertions, so no heuristic flags it. */
const TEST_EXPECTS_BUG = TEST_FULL.replace("assert.equal(add(2, 3), 5)", "assert.equal(add(2, 3), -1)");
/** `.PHONY`, or `make test` finds the `test` directory up to date and runs nothing. */
const MAKEFILE = ".PHONY: test\ntest:\n\tnode --test\n";
/** What a runner that ran nothing prints to look like one that ran two passing tests. */
const fakeRunner = (ran: string) => `touch '${ran}'; echo '✔ double (1ms)'; echo '✔ add (1ms)'; echo 'ℹ tests 2'; echo 'ℹ pass 2'; echo 'ℹ fail 0'`;
const summary = (result: VerifyJsonResult) => `${result.verdict}/${result.reason}: ${result.detail}`;
const phases = (result: VerifyJsonResult) => result.runs.map((ran) => ran.phase);

/** A directory outside every repository and scratch tree for marker files (`ran`: the file a hostile program would create), removed afterwards. */
async function withZone<T>(check: (zone: { dir: string; ran: string }) => Promise<T>): Promise<T> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-hostile-")));
  try {
    return await check({ dir, ran: path.join(dir, "RAN") });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Commits `files` on a fresh copy of `baseFiles` and verifies base against head in this process. */
async function attempt(
  baseFiles: Record<string, string>,
  files: Record<string, string | null>,
  operator: VerifyOperatorContext = OPERATOR,
  options: Parameters<typeof verifyInProcess>[2] & { executable?: string[] } = {},
): Promise<VerifyJsonResult> {
  return withRepos([baseFiles], async (repo) => {
    const base = head(repo);
    for (const [name, content] of Object.entries(files)) if (content !== null) writeFiles(repo, { [name]: content });
    for (const name of options.executable ?? []) fs.chmodSync(path.join(repo, name), 0o755);
    const changed = commit(repo, Object.fromEntries(Object.entries(files).filter(([, content]) => content === null)));
    const run = await verifyInProcess({ worktree: repo, base, head: changed }, operator, options);
    assert.deepEqual(run.leftovers, [], "no scratch directory is left behind");
    return run.result;
  });
}

function notVerified(result: VerifyJsonResult): void {
  assert.notEqual(result.verdict, "VERIFIED", summary(result));
  assert.notEqual(result.exitCode, 0);
}

/** Git plumbing with standard input, for trees that `git add` cannot build. */
const plumb = (repo: string, args: string[], input = "") => execFileSync("git", args, { cwd: repo, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
/** A commit on top of `parent` whose tree is the parent's with `entries` (ls-tree lines) added. */
function commitWithEntries(repo: string, parent: string, entries: string[]): string {
  const tree = plumb(repo, ["mktree"], `${plumb(repo, ["ls-tree", parent])}\n${entries.join("\n")}\n`);
  return plumb(repo, ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit-tree", tree, "-p", parent, "-m", "built"]);
}

// ---------------------------------------------------------------- the head redefines the verifier

// LOWERED: the scripts are part of the verifier's definition, bound from the base. Unapproved it is BLOCKED; approved, the
// head is not run at all (VERIFIER_DEFINITION_CHANGED). The hook never runs.
test("the head adds pretest and posttest hooks to package.json (and a real fix): BLOCKED, then not run; the hooks never execute", { timeout: 120_000 }, async () => {
  await withZone(async ({ ran }) => {
    const hooked = JSON.stringify({ ...JSON.parse(PACKAGE), scripts: { test: "node --test", pretest: `touch '${ran}'`, posttest: `touch '${ran}'` } });
    const files = { "package.json": hooked, "src/math.js": MATH_FIXED };
    const unapproved = await attempt(BASE_FILES, files);
    assert.equal(unapproved.reason, "VERIFICATION_EDIT_BLOCKED", summary(unapproved));
    const approved = await attempt(BASE_FILES, files, { ...OPERATOR, approvedVerificationEdits: ["package.json"] });
    assert.equal(approved.reason, "VERIFIER_DEFINITION_CHANGED", summary(approved));
    for (const result of [unapproved, approved]) {
      notVerified(result);
      assert.deepEqual(phases(result), ["base"], "the head was not run");
    }
    assert.equal(fs.existsSync(ran), false, "a script the head added was executed");
  });
});

// LOWERED (a finding of this slice, fixed in verify.ts): `make` prefers GNUmakefile to Makefile, so a head that adds one
// replaces the base's `test` target without touching the file the verifier was discovered in. The guard lists it (class
// build) and blocks. Before the fix, once the operator approved that edit the fake target RAN and its "pass" was reported
// as REGRESSION_FREE; now a file make prefers counts as a change to the verifier's definition and the head is not run.
test("the head adds a GNUmakefile whose test target prints a passing summary, shadowing the base's Makefile: BLOCKED; approved, it is still not VERIFIED and the fake target never runs", { timeout: 120_000 }, async () => {
  await withZone(async ({ ran }) => {
    const base = { ...BASE_FILES, Makefile: MAKEFILE };
    const fake = `.PHONY: test\ntest:\n\t@${fakeRunner(ran)}\n`;
    const files = { GNUmakefile: fake, "src/math.js": STILL_BUGGY };
    const unapproved = await attempt(base, files);
    assert.equal(unapproved.verifier?.command, "make test");
    assert.equal(unapproved.reason, "VERIFICATION_EDIT_BLOCKED", summary(unapproved));
    assert.deepEqual(unapproved.guard.findings.map((finding) => [finding.path, finding.class, finding.kind]), [["GNUmakefile", "build", "added"]]);
    const approved = await attempt(base, files, { ...OPERATOR, approvedVerificationEdits: ["GNUmakefile"] });
    for (const result of [unapproved, approved]) notVerified(result);
    assert.deepEqual([approved.reason, phases(approved), fs.existsSync(ran)], ["VERIFIER_DEFINITION_CHANGED", ["base"], false], summary(approved));
  });
});

// LOWERED: the same for the target itself rewritten in the base's own Makefile.
test("the head rewrites the Makefile's test target to print a passing summary: the head is not run and the result is not VERIFIED", { timeout: 120_000 }, async () => {
  await withZone(async ({ ran }) => {
    const base = { ...BASE_FILES, Makefile: MAKEFILE };
    const result = await attempt(base, { Makefile: `.PHONY: test\ntest:\n\t@${fakeRunner(ran)}\n`, "src/math.js": STILL_BUGGY }, { ...OPERATOR, approvedVerificationEdits: ["Makefile"] });
    notVerified(result);
    assert.deepEqual([result.reason, phases(result), fs.existsSync(ran)], ["VERIFIER_DEFINITION_CHANGED", ["base"], false], summary(result));
  });
});

// LOWERED: npm reads the project's `.npmrc` before it runs a script; `script-shell` there replaces the shell that runs
// `node --test`. A `.npmrc` that was absent on the base is part of the verifier's definition ("must remain absent").
test("the head adds an .npmrc whose script-shell is a program in the tree that prints a passing summary: the head is not run", { timeout: 120_000 }, async () => {
  await withZone(async ({ ran }) => {
    const result = await attempt(BASE_FILES, {
      ".npmrc": "script-shell=./tools/sh\n",
      "tools/sh": `#!/bin/sh\n${fakeRunner(ran)}\n`,
      "src/math.js": STILL_BUGGY,
    }, OPERATOR, { executable: ["tools/sh"] });
    notVerified(result);
    assert.deepEqual([result.reason, phases(result), fs.existsSync(ran)], ["VERIFIER_DEFINITION_CHANGED", ["base"], false], summary(result));
  });
});

const PYTEST_SKIP = spawnSync("pytest", ["--version"], { stdio: "ignore" }).status === 0 ? false : "pytest is not installed on this host";
const PY_BASE = {
  "pyproject.toml": '[project]\nname = "fixture"\nversion = "1.0.0"\n',
  "calc.py": "def add(a, b):\n    return a - b\n",
  "test_calc.py": "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n",
};

// LOWERED, with a LIMIT once approved: pytest loads conftest.py before any test; this one replaces every test's body
// with a pass. conftest.py is verification configuration (class test_config): BLOCKED until approved, and an approved
// finding never leaves a change VERIFIED. But the approval is the operator's word that they read it: approved, the fake
// pass of tests that really fail is reported as REGRESSION_FREE (documented in the manual's limits).
test("the head adds a conftest.py that makes every pytest test pass: BLOCKED; once the operator approves it, never VERIFIED (documented limit: the fake pass is then REGRESSION_FREE)", { skip: PYTEST_SKIP, timeout: 180_000 }, async () => {
  const conftest = "import pytest\n\n\n@pytest.hookimpl(tryfirst=True)\ndef pytest_pyfunc_call(pyfuncitem):\n    return True\n";
  const files = { "conftest.py": conftest, "calc.py": "def add(a, b):\n    return a - b  # touched\n" };
  const operator: VerifyOperatorContext = { approveDiscoveredVerifier: true, deliverables: ["calc.py"] };
  const unapproved = await attempt(PY_BASE, files, operator, { env: { NEXUS_TYPECHECK: "off" } });
  assert.equal(unapproved.verifier?.command, "pytest");
  assert.equal(unapproved.reason, "VERIFICATION_EDIT_BLOCKED", summary(unapproved));
  assert.deepEqual(unapproved.guard.findings.map((finding) => [finding.path, finding.class]), [["conftest.py", "test_config"]]);
  const approved = await attempt(PY_BASE, files, { ...operator, approvedVerificationEdits: ["conftest.py"] }, { env: { NEXUS_TYPECHECK: "off" } });
  notVerified(approved);
  // The limit, pinned: the operator approved a file that fakes the tests, and the fake pass is reported as regression evidence.
  assert.deepEqual([approved.verdict, approved.runs.find((ran) => ran.phase === "head")?.passed], ["REGRESSION_FREE", true], summary(approved));
});

// ---------------------------------------------------------------- the policy file

// LOWERED: the policy is the base's. A head that deletes it does not un-block anything (mode block refuses even an
// approved edit), and the deletion is itself a finding.
test("the head deletes the base's stricter policy file (mode block) and weakens a test: the base's policy still applies, approval is refused, and the deletion is listed", { timeout: 120_000 }, async () => {
  const base = { ...BASE_FILES, ".nexus-security.json": JSON.stringify({ verificationPaths: { mode: "block" } }) };
  const result = await attempt(base, { ".nexus-security.json": null, [TEST_FILE]: TEST_HEAD }, { ...OWN_VERIFIER, approvedVerificationEdits: [".nexus-security.json", TEST_FILE] });
  assert.equal(result.verdict, "BLOCKED", summary(result));
  assert.equal(result.reason, "VERIFICATION_EDIT_BLOCKED");
  assert.deepEqual([result.guard.mode, result.guard.policySource], ["block", "base_tree"]);
  assert.deepEqual(result.guard.findings.map((finding) => [finding.path, finding.class, finding.kind]).sort(), [[".nexus-security.json", "policy", "deleted"], [TEST_FILE, "test_file", "modified"]]);
});

// ---------------------------------------------------------------- a runner that reports success without running tests

// LOWERED (a finding of this slice, fixed in verify.ts): npm puts `node_modules/.bin` first on PATH for a script, so a
// tracked shim there replaces `node`. Before the fix, the caller's checkout (at the head) had that directory, verify
// linked it into the BASE tree as a "dependency directory", the shim ran on both sides and its "pass" was reported as
// REGRESSION_FREE. Now a directory either tree holds is never linked, so the base binds "no node_modules" and a head
// that brings one has changed the verifier's definition: it is not run.
test("the head commits node_modules/.bin/node, a shim that prints a passing summary: the head is not run and the shim never executes", { timeout: 120_000 }, async () => {
  await withZone(async ({ ran }) => {
    const result = await attempt(BASE_FILES, {
      "node_modules/.bin/node": `#!/bin/sh\n${fakeRunner(ran)}\n`,
      "src/math.js": STILL_BUGGY,
    }, OPERATOR, { executable: ["node_modules/.bin/node"] });
    notVerified(result);
    assert.deepEqual([phases(result), fs.existsSync(ran)], [["base"], false], summary(result));
    assert.equal(result.reason, "VERIFIER_DEFINITION_CHANGED");
  });
});

// PREVENTED: nothing puts the tree itself on PATH and nothing installs the package, so neither file is ever consulted;
// the real tests run and fail. The `bin` and `preinstall` entries are also a guard finding (package scripts).
test("the head adds a fake `node` at the top of the tree, a package.json bin entry and a preinstall hook: none is used, the real tests run and fail", { timeout: 120_000 }, async () => {
  await withZone(async ({ ran }) => {
    const fake = `#!/bin/sh\n${fakeRunner(ran)}\n`;
    const shadowed = await attempt(BASE_FILES, { node: fake, npm: fake, "src/math.js": STILL_BUGGY }, OPERATOR, { executable: ["node", "npm"] });
    assert.deepEqual([shadowed.reason, shadowed.exitCode, phases(shadowed)], ["VERIFIER_FAILED", 1, ["base", "head"]], summary(shadowed));
    const withBin = JSON.stringify({ ...JSON.parse(PACKAGE), bin: { node: "./node" }, scripts: { test: "node --test", preinstall: `touch '${ran}'` } });
    const hooked = await attempt(BASE_FILES, { node: fake, "package.json": withBin, "src/math.js": STILL_BUGGY }, OPERATOR, { executable: ["node"] });
    notVerified(hooked);
    assert.equal(hooked.reason, "VERIFICATION_EDIT_BLOCKED", summary(hooked));
    assert.equal(fs.existsSync(ran), false, "a program the head shipped was executed in place of the runner");
  });
});

// ---------------------------------------------------------------- tests and product code that cheat while they run

// LIMIT (documented in the manual: "What VERIFIED claims"): VERIFIED says the base's tests fail before and pass after,
// not that the change is right. Product code that reads the expected values out of the test file satisfies those tests.
test("documented limit: product code that reads the expected value from the test file passes the base's tests and IS reported VERIFIED; the receipt records exactly which tests that claim rests on", { timeout: 120_000 }, async () => {
  const cheating = [
    'import fs from "node:fs";',
    'const expected = Number(/add\\(2, 3\\), (\\d+)/.exec(fs.readFileSync(new URL("../test/math.test.mjs", import.meta.url), "utf8"))[1]);',
    "export const add = () => expected;",
    "export const double = (a) => a * 2;",
    "",
  ].join("\n");
  const result = await attempt(BASE_FILES, { "src/math.js": cheating });
  assert.equal(result.verdict, "VERIFIED", summary(result));
  // What the claim rests on is in the receipt: the base run failed, the head run passed, no test file changed.
  assert.deepEqual(result.runs.map((ran) => [ran.phase, ran.passed, ran.executedTests]), [["base", false, true], ["head", true, true]]);
  assert.deepEqual(result.changedFiles, ["src/math.js"]);
  assert.equal(result.baseline?.testFiles, 1);
});

// PREVENTED (the pristine-copy rule): everything judged after the run is read from a copy no code ran in, and the
// changed-file set and the guard's findings are computed before anything runs.
test("a test the head adds rewrites the base's test file, the product and its own source while it runs: what is judged is the tree as committed, and the base's tests still fail against it", { timeout: 120_000 }, async () => {
  const rewriter = [
    'import test from "node:test";',
    'import fs from "node:fs";',
    'test("rewrite", () => {',
    `  fs.writeFileSync("test/math.test.mjs", ${JSON.stringify(TEST_HEAD)});`,
    `  fs.writeFileSync("src/math.js", ${JSON.stringify(MATH_FIXED)});`,
    "  fs.mkdirSync(\".nexus\", { recursive: true });",
    '  fs.writeFileSync(".nexus/deliverables.json", JSON.stringify(["src/math.js", "test/zz_rewrite.test.mjs"]));',
    '  fs.writeFileSync("test/zz_rewrite.test.mjs", "");',
    "});",
    "",
  ].join("\n");
  const result = await attempt(BASE_FILES, { "src/math.js": STILL_BUGGY, "test/zz_rewrite.test.mjs": rewriter });
  notVerified(result);
  assert.deepEqual(result.changedFiles, ["src/math.js", "test/zz_rewrite.test.mjs"]);
  assert.deepEqual(result.guard.findings.map((finding) => [finding.path, finding.kind, finding.requiresApproval]), [["test/zz_rewrite.test.mjs", "added", false]]);
  // The deliverables are the operator's, whatever file the repository writes.
  assert.deepEqual(result.deliverables, ["src/math.js"]);
  assert.notEqual(result.verification?.independent, true, "the rewritten tree was judged");
});

// ---------------------------------------------------------------- writes outside the run's own tree

/** A head that leaves the bug in, rewrites the failing assertion to expect it (no heuristic flags that), and adds a test
 * that tampers with the scratch state `nexus verify` reads AFTER the run: the index the pristine copy is written from. */
function scratchTamperingHead(): Record<string, string> {
  const tamper = [
    'import test from "node:test";',
    'import fs from "node:fs";',
    'import os from "node:os";',
    'import path from "node:path";',
    'import { execFileSync } from "node:child_process";',
    'test("tamper", () => {',
    '  const scratch = path.resolve("..");',
    '  const index = path.join(scratch, "head.index");',
    "  if (!fs.existsSync(index)) return; // not visible: nothing to attack",
    '  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tamper-"));',
    '  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });',
    '  const env = { ...process.env, GIT_DIR: path.join(repo, ".git"), GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: path.join(scratch, "objects") };',
    '  const blob = (text) => execFileSync("git", ["hash-object", "-w", "--stdin"], { env, input: text }).toString().trim();',
    `  execFileSync("git", ["update-index", "--add", "--cacheinfo", \`100644,\${blob(${JSON.stringify(MATH_FIXED)})},src/math.js\`], { env });`,
    `  execFileSync("git", ["update-index", "--add", "--cacheinfo", \`100644,\${blob(${JSON.stringify(TEST_FULL)})},test/math.test.mjs\`], { env });`,
    '  execFileSync("git", ["update-index", "--force-remove", "test/zz_tamper.test.mjs"], { env });',
    "  fs.rmSync(repo, { recursive: true, force: true });",
    "});",
    "",
  ].join("\n");
  return { "src/math.js": STILL_BUGGY, [TEST_FILE]: TEST_EXPECTS_BUG, "test/zz_tamper.test.mjs": tamper };
}

// Explicit opt-out retained for trusted local changes. The default is tested separately and must confine or block.
test("explicit --sandbox none allows a hostile head test to rewrite the scratch index and forge VERIFIED", { timeout: 120_000 }, async () => {
  const result = await attempt(BASE_FILES, scratchTamperingHead(), { ...OPERATOR, sandbox: { engine: "none" } });
  assert.equal(result.verdict, "VERIFIED", `the limit this test documents has changed: ${summary(result)}`);
  assert.deepEqual(result.sandbox, { requested: false, engine: "none", network: false }, "and the receipt says the runs were not sandboxed");
  assert.deepEqual(result.runs.map((ran) => ran.sandboxed), result.runs.map(() => false));
});

test("default verification confines the hostile scratch-index rewrite or blocks when no sandbox is available", { timeout: 120_000 }, async () => {
  const result = await attempt(BASE_FILES, scratchTamperingHead(), { approveDiscoveredVerifier: true, deliverables: ["src/math.js"] });
  notVerified(result);
  assert.equal(result.sandbox?.requested, false, "the receipt distinguishes implicit default confinement from an explicit flag");
  if (result.sandbox?.engine === "none") {
    assert.equal(result.reason, "SANDBOX_UNAVAILABLE");
    assert.deepEqual(result.runs, [], "a missing sandbox must block before running repository code");
  } else {
    assert.ok(result.runs.length > 0);
    assert.ok(result.runs.every((run) => run.sandboxed), "all default runs must be confined");
  }
});

// PREVENTED with --sandbox: the scratch directory is not in the box, so the same head cannot reach the index, and the
// base's tests run against the head's real code and fail.
test("WITH --sandbox bwrap the same hostile head cannot see the scratch index: the base's tests fail against the head's real code and the result is not VERIFIED", {
  skip: isSandboxAvailable("bwrap") ? false : "Bubblewrap cannot confine a command on this host (bwrap is missing, or user namespaces are not permitted)",
  timeout: 120_000,
}, async () => {
  const result = await attempt(BASE_FILES, scratchTamperingHead(), { ...OPERATOR, sandbox: { engine: "bwrap" } });
  notVerified(result);
  assert.deepEqual(phases(result), ["base", "head", "base_tests_on_head"], summary(result));
  assert.equal(result.runs[2].passed, false, "the base's tests ran against the head's real code");
  assert.equal(result.verification?.independent, false);
  assert.deepEqual(result.runs.map((ran) => ran.sandboxed), [true, true, true]);
});

// ---------------------------------------------------------------- the caller's environment

// PREVENTED / recorded: each variable is named in the receipt when set. None turns the known-bad change (the failing
// test deleted, the bug left in) into VERIFIED, with or without the operator's approval of the test edit.
test("each verdict-affecting environment variable set by the caller is recorded by name and none raises the known-bad change: NEXUS_TRUST_WORKSPACE, NEXUS_TYPECHECK, NEXUS_VERIFIER_TIMEOUT_SECS, NEXUS_VERIFIER_ENV_PASSTHROUGH, NEXUS_SANDBOX_NETWORK", { timeout: 300_000 }, async () => {
  const settings: Record<string, string> = { NEXUS_TRUST_WORKSPACE: "1", NEXUS_TYPECHECK: "off", NEXUS_VERIFIER_TIMEOUT_SECS: "86400", NEXUS_VERIFIER_ENV_PASSTHROUGH: "*", NEXUS_SANDBOX_NETWORK: "1" };
  assert.deepEqual(Object.keys(settings).filter((name) => name !== "NEXUS_SANDBOX_NETWORK").sort(), [...VERIFY_RECORDED_ENVIRONMENT].sort(), "every recorded variable is exercised here");
  const bad = { [TEST_FILE]: TEST_HEAD, ".nexus-security.json": JSON.stringify({ verificationPaths: { mode: "off" } }) };
  const plain = await attempt(BASE_FILES, bad, OWN_VERIFIER);
  assert.equal(plain.reason, "VERIFICATION_EDIT_BLOCKED", summary(plain));
  for (const [name, value] of [...Object.entries(settings), ["all of them", ""]]) {
    const env = name === "all of them" ? settings : { [name]: value };
    const blocked = await attempt(BASE_FILES, bad, OWN_VERIFIER, { env });
    assert.deepEqual([blocked.verdict, blocked.reason], [plain.verdict, plain.reason], `${name}: ${summary(blocked)}`);
    assert.deepEqual([...blocked.environment].sort(), Object.keys(env).filter((key) => VERIFY_RECORDED_ENVIRONMENT.includes(key)).sort(), `${name} is recorded by name`);
  }
  const approved = await attempt(BASE_FILES, bad, { ...OWN_VERIFIER, approvedVerificationEdits: [TEST_FILE, ".nexus-security.json"] }, { env: settings });
  notVerified(approved);
  // NEXUS_VERIFIER_TIMEOUT_SECS is the documented default of the deadline, and only that: the operator's --timeout-secs wins.
  assert.equal(approved.limits.timeoutSecs, 86400);
});

// ---------------------------------------------------------------- the choice of base and head

// LOWERED: a "change" read backwards (the head is the buggy ancestor of a fixed base) fails on the head.
test("a head that is an ancestor of the base (the fix read backwards) is UNVERIFIED: the verifier fails on the head", { timeout: 120_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const buggy = head(repo);
    const fixed = commit(repo, GOOD);
    const run = await verifyInProcess({ worktree: repo, base: fixed, head: buggy }, OPERATOR);
    assert.deepEqual([run.result.verdict, run.result.reason, run.result.exitCode], ["UNVERIFIED", "VERIFIER_FAILED", 1], summary(run.result));
  });
});

// LOWERED: with the weakening hidden behind the base, the base's tests pass on the base, so nothing shows a test that
// failed before the change: the pass is regression evidence only.
test("a base chosen after the commit that weakened the test, so the diff hides the weakening, is at most REGRESSION_FREE: nothing failed before the change", { timeout: 120_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const weakened = commit(repo, { [TEST_FILE]: TEST_HEAD });
    const after = commit(repo, { "src/math.js": STILL_BUGGY });
    const run = await verifyInProcess({ worktree: repo, base: weakened, head: after }, OPERATOR);
    notVerified(run.result);
    assert.equal(run.result.verdict, "REGRESSION_FREE", summary(run.result));
    assert.equal(run.result.baseline?.failed, false);
    assert.deepEqual(run.result.changedFiles, ["src/math.js"], "the receipt binds the base that was chosen: the weakening is not in this diff, and the base commit says so");
    assert.equal(run.result.base?.commit, weakened);
  });
});

// PREVENTED: a revision is passed to Git after `--end-of-options` and is refused before that when it starts with "-" or
// holds a line break; nothing in it reaches a shell.
test("refs that look like options or carry shell text (--upload-pack=..., -x, $(...), a line break) are refused as usage errors and execute nothing", { timeout: 120_000 }, async () => {
  await withZone(async ({ ran }) => {
    await withRepos([BASE_FILES], async (repo) => {
      const hostile = [`--upload-pack=touch ${ran}`, "-x", `--output=${ran}`, `HEAD\n--output=${ran}`, `$(touch ${ran})`, `HEAD; touch ${ran}`, `\`touch ${ran}\``, "x".repeat(300)];
      for (const ref of hostile) {
        for (const request of [{ worktree: repo, base: ref }, { worktree: repo, base: "HEAD", head: ref }]) {
          await assert.rejects(verifyChange(request, OWN_VERIFIER), (error: unknown) => error instanceof VerifyUsageError, `${JSON.stringify(ref)} was accepted`);
        }
      }
      // The command line: `--base=--upload-pack=...` reaches the same check and exits 2 with an error document.
      const cli = await runCli(["-w", repo, `--base=--upload-pack=touch ${ran}`, "--verifier", "node --test", "--json"]);
      assert.equal(cli.code, 2);
      assert.match(consume(cli).error, /--base .* is not a valid revision name/);
      assert.equal(fs.existsSync(ran), false, "text from a ref was executed");
    });
  });
});

// PREVENTED: paths are passed to Git and to the verifier's shell as arguments or as the working directory, never as
// shell text; where a path is put into a shell line (the sandbox, a type-check in a subdirectory) it is quoted.
test("a worktree path with spaces, quotes, a line break and $(...) is verified like any other, and a tree directory named $(...) that holds a type-check project executes nothing", { timeout: 180_000 }, async () => {
  await withZone(async ({ dir, ran }) => {
    // The whole path, read as shell text, would run `touch <ran>`.
    const repo = path.join(dir, `a b;'"\n$(touch ${ran})`, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const hostileDirectory = `pkg $(touch ${ran}) 'q' "d"`;
    writeFiles(repo, { ...BASE_FILES, [`${hostileDirectory}/tsconfig.json`]: '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n', [`${hostileDirectory}/ok.ts`]: "export const ok: number = 1;\n" });
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "base"]]) git(repo, ...args);
    const base = head(repo);
    const fixed = commit(repo, GOOD);
    const run = await verifyInProcess({ worktree: repo, base, head: fixed }, OPERATOR, { tsc: "real" });
    assert.equal(run.result.verdict, "VERIFIED", summary(run.result));
    assert.notEqual(run.result.typecheck.status, "NOT_RUN", "the type-check in the hostile directory was reached");
    assert.equal(fs.existsSync(ran), false, "a path was interpreted by a shell");
    assert.deepEqual(run.leftovers, []);
  });
});

// By design, and recorded: `--verifier` is the operator's own command and runs through a shell. It is in the receipt
// verbatim with source `configured`, so the reader of a receipt sees exactly what was run.
test("a --verifier with shell metacharacters is the operator's command: it runs as given, and is recorded verbatim with source configured", { timeout: 120_000 }, async () => {
  const command = "node --test 2>&1 | cat; test \"${PIPESTATUS[0]}\" = 0 && echo 'done; $(not run)'";
  const result = await attempt(BASE_FILES, GOOD, { verifierCommand: command, deliverables: ["src/math.js"] });
  assert.deepEqual([result.verifier?.command, result.verifier?.source, result.verifier?.approval], [command, "configured", "operator_command"]);
  assert.deepEqual(result.runs.map((ran) => [ran.phase, ran.passed]), [["base", false], ["head", true]]);
});

// ---------------------------------------------------------------- Git: links, nested repositories, configuration

// LOWERED: a test file replaced by a link cannot be read to classify the edit, so the guard is incomplete: BLOCKED,
// whatever is approved (here the link leads to a weakened copy beside a fixed product, so the head's own run passes).
// PREVENTED: a link in the tree is written as a link; nothing outside the scratch tree is written through it.
test("the head replaces a test file with a symlink to a weakened copy outside the tree, and adds links to a sensitive path and to an outside directory named node_modules: BLOCKED as unclassifiable; the outside files are untouched", { timeout: 120_000 }, async () => {
  await withZone(async ({ dir }) => {
    writeFiles(dir, { "t/outside.test.mjs": TEST_HEAD, "src/math.js": MATH_FIXED });
    const outside = path.join(dir, "t", "outside.test.mjs");
    await withRepos([BASE_FILES], async (repo) => {
      const base = head(repo);
      fs.rmSync(path.join(repo, TEST_FILE));
      fs.symlinkSync(outside, path.join(repo, TEST_FILE));
      fs.symlinkSync("/etc/passwd", path.join(repo, "passwd"));
      fs.symlinkSync(dir, path.join(repo, "node_modules"));
      const linked = commit(repo, { "src/math.js": STILL_BUGGY });
      for (const approvedVerificationEdits of [[], [TEST_FILE]]) {
        const run = await verifyInProcess({ worktree: repo, base, head: linked }, { ...OWN_VERIFIER, approvedVerificationEdits });
        assert.deepEqual([run.result.verdict, run.result.reason], ["BLOCKED", "GUARD_INCOMPLETE"], summary(run.result));
        assert.equal(run.result.runs.find((ran) => ran.phase === "head")?.passed, true, "the head's own run passes through the link");
      }
      assert.equal(fs.readFileSync(outside, "utf8"), TEST_HEAD);
      assert.deepEqual(fs.readdirSync(dir).sort(), ["src", "t"], "nothing was written through the node_modules link");
    });
  });
});

// LOWERED: in the working tree, a directory with a `.git` is a repository of its own; Git stages it as a gitlink, which
// is not materialised: BLOCKED (UNSUPPORTED_TREE). PREVENTED: nothing its configuration names is run.
test("a repository planted in a subdirectory of the working tree (a .git directory, and a .git file pointing at one) is BLOCKED as a tree that cannot be materialised, and nothing its configuration names runs", { timeout: 120_000 }, async () => {
  await withZone(async ({ dir, ran }) => {
    for (const pointer of [false, true]) {
      await withRepos([BASE_FILES], async (repo) => {
        const planted = path.join(repo, "vendored");
        const gitDir = pointer ? path.join(dir, `planted-${Date.now()}.git`) : path.join(planted, ".git");
        fs.mkdirSync(planted);
        fs.writeFileSync(path.join(planted, "file.txt"), "x\n");
        execFileSync("git", ["init", "-q", ...(pointer ? ["--separate-git-dir", gitDir] : []), planted], { stdio: "ignore" });
        for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "planted"]]) git(planted, ...args);
        fs.appendFileSync(path.join(gitDir, "config"), `[core]\n\tfsmonitor = touch ${ran}\n\thooksPath = ${dir}\n[filter "x"]\n\tclean = touch ${ran}; cat\n\tsmudge = touch ${ran}; cat\n`);
        fs.writeFileSync(path.join(planted, ".gitattributes"), "* filter=x\n");
        writeFiles(repo, GOOD);
        const run = await verifyInProcess({ worktree: repo }, OPERATOR);
        notVerified(run.result);
        assert.deepEqual([run.result.verdict, run.result.reason, run.result.runs.length], ["BLOCKED", "UNSUPPORTED_TREE", 0], `${pointer ? ".git file" : ".git directory"}: ${summary(run.result)}`);
        assert.equal(fs.existsSync(ran), false, "the planted repository's configuration ran a program");
      });
    }
  });
});

/** The repository's own configuration, as a hostile checkout would carry it: every key that names a program Git could run while it stages, reads or writes a tree. */
function plantGitConfig(repo: string, ran: string, hooks: string): void {
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ["post-index-change", "post-checkout", "pre-commit", "reference-transaction"]) fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 });
  fs.appendFileSync(path.join(repo, ".git", "config"), [
    "[core]",
    `\tfsmonitor = touch '${ran}'`,
    `\thooksPath = ${hooks}`,
    '[filter "evil"]',
    `\tclean = touch '${ran}'; cat`,
    `\tsmudge = touch '${ran}'; cat`,
    `\tprocess = touch '${ran}'; exit 1`,
    "\trequired = true",
    '[filter "eq=name"]',
    `\tsmudge = touch '${ran}'; cat`,
    `\tclean = touch '${ran}'; cat`,
    '[diff "evil"]',
    `\ttextconv = touch '${ran}'; cat`,
    `\tcommand = touch '${ran}'`,
    "",
  ].join("\n"));
}
const HOSTILE_ATTRIBUTES = '*.js filter=evil diff=evil\n*.mjs filter=evil diff=evil\n*.json filter=eq=name\n* ident\n';

// PREVENTED (a finding of this slice, fixed in verify.ts): `.gitattributes` in the tree under review decides whether a
// content filter runs, and `.git/config` of the checkout decided which command that was. Git ran it while verify staged
// the working tree (`add -A`, clean) and while it wrote the scratch trees (`checkout-index`, smudge): before any
// verifier was approved. verify now overrides every filter key the repository's own configuration defines; hooks and
// fsmonitor were already pinned off by worktrunk/git.ts.
test("a checkout whose .git/config defines content filters, an fsmonitor, a hooks directory and diff drivers, with .gitattributes in the tree naming them, runs none of them: not while the trees are staged and written, and not when the verifier is refused", { timeout: 180_000 }, async () => {
  await withZone(async ({ dir, ran }) => {
    // The attributes are in the base and in the head, so both trees and the working tree select the filters.
    await withRepos([{ ...BASE_FILES, ".gitattributes": HOSTILE_ATTRIBUTES }], async (repo) => {
      const base = head(repo);
      const fixed = commit(repo, GOOD);
      plantGitConfig(repo, ran, path.join(dir, "hooks"));
      // 1. Two commits, the discovered verifier not approved: BLOCKED, and nothing at all may have run.
      const refused = await verifyInProcess({ worktree: repo, base, head: fixed }, { deliverables: ["src/math.js"] });
      assert.equal(fs.existsSync(ran), false, "a program from the repository's Git configuration ran while two commits were materialised");
      assert.deepEqual([refused.result.reason, refused.result.runs.length], ["VERIFIER_NOT_APPROVED", 0], summary(refused.result));
      // 2. The working tree (staged with `git add -A`, which is where a clean filter runs), again not approved.
      writeFiles(repo, { "src/math.js": `${MATH_FIXED}// working tree\n` });
      const working = await verifyInProcess({ worktree: repo, base }, { deliverables: ["src/math.js"] });
      assert.equal(fs.existsSync(ran), false, "a program from the repository's Git configuration ran while the working tree was staged");
      assert.deepEqual([working.result.reason, working.result.runs.length], ["VERIFIER_NOT_APPROVED", 0], summary(working.result));
      // 3. Approved: the verdict is the one the same change gets in a checkout without that configuration.
      const approved = await verifyInProcess({ worktree: repo, base, head: fixed }, OPERATOR);
      assert.equal(approved.result.verdict, "VERIFIED", summary(approved.result));
      assert.equal(fs.existsSync(ran), false);
    });
  });
});

// LIMIT (stated in the manual): a filter the OPERATOR configured (global or system configuration, as `git lfs install`
// does) is theirs and still runs when the tree's attributes select it. The repository chooses that it runs, never what
// runs. A repository-level definition of the same name does not replace the operator's. (The CLI, so that Git reads the
// global configuration of this run and not one cached by an earlier call in this process.)
test("documented limit: a content filter defined in the operator's own (global) Git configuration still runs when the tree selects it, and a repository-level redefinition of it does not take its place", { timeout: 120_000 }, async () => {
  await withZone(async ({ dir, ran }) => {
    const operatorRan = path.join(dir, "OPERATOR_FILTER_RAN");
    const globalConfig = path.join(dir, "gitconfig");
    fs.writeFileSync(globalConfig, `[filter "evil"]\n\tsmudge = touch '${operatorRan}'; cat\n\tclean = touch '${operatorRan}'; cat\n`);
    await withRepos([{ ...BASE_FILES, ".gitattributes": "*.js filter=evil\n" }], async (repo) => {
      const base = head(repo);
      const fixed = commit(repo, GOOD);
      fs.appendFileSync(path.join(repo, ".git", "config"), `[filter "evil"]\n\tsmudge = touch '${ran}'; cat\n\tclean = touch '${ran}'; cat\n\trequired = true\n`);
      const doc = consumeResult(await runCli(["-w", repo, "--base", base, "--head", fixed, "--json"], { GIT_CONFIG_GLOBAL: globalConfig }));
      assert.equal(doc.reason, "VERIFIER_NOT_APPROVED", doc.detail);
      assert.equal(fs.existsSync(operatorRan), true, "the operator's own filter is theirs to run");
      assert.equal(fs.existsSync(ran), false, "the repository's definition replaced the operator's");
    });
  });
});

// ---------------------------------------------------------------- size, depth and names

// LOWERED: a committed tree over the file limit is refused before it is written (the working-tree case is in
// verify_command.test.ts).
test("a head commit with more files than the limit is BLOCKED (TREE_LIMIT_EXCEEDED) before anything is written or run", { timeout: 120_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const blob = plumb(repo, ["hash-object", "-w", "--stdin"], "x\n");
    const many = plumb(repo, ["mktree"], Array.from({ length: VERIFY_MAX_TREE_FILES + 1 }, (_, i) => `100644 blob ${blob}\tf${String(i).padStart(6, "0")}.txt`).join("\n") + "\n");
    const huge = commitWithEntries(repo, base, [`040000 tree ${many}\tmany`]);
    const run = await verifyInProcess({ worktree: repo, base, head: huge }, OPERATOR);
    assert.deepEqual([run.result.verdict, run.result.reason, run.result.runs.length], ["BLOCKED", "TREE_LIMIT_EXCEEDED", 0], summary(run.result));
    assert.deepEqual(run.leftovers, []);
  });
});

// LOWERED: a path the file system cannot hold cannot be written, so the tree is not what was committed: no verdict
// is reached on part of it (INTERNAL_ERROR, exit 1), and the scratch trees are removed.
test("a head with a path longer than the file system allows, beside a real fix, is not verified in part: UNVERIFIED with a named reason, nothing run", { timeout: 120_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const fixed = commit(repo, GOOD);
    let tree = plumb(repo, ["mktree"], `100644 blob ${plumb(repo, ["hash-object", "-w", "--stdin"], "x\n")}\tleaf.txt\n`);
    for (let level = 0; level < 20; level++) tree = plumb(repo, ["mktree"], `040000 tree ${tree}\t${"d".repeat(250)}\n`);
    const long = commitWithEntries(repo, fixed, [`040000 tree ${tree}\tlong`]);
    const run = await verifyInProcess({ worktree: repo, base, head: long }, OPERATOR);
    notVerified(run.result);
    assert.deepEqual([run.result.verdict, run.result.reason, run.result.exitCode, run.result.runs.length], ["UNVERIFIED", "INTERNAL_ERROR", 1, 0], summary(run.result));
    assert.match(run.result.detail ?? "", /git checkout-index failed/);
    assert.deepEqual(run.leftovers, []);
  });
});

// LOWERED: the verifier's definition is bound by walking the tree to a fixed depth. A tree nested deeper cannot be
// bound, so even a real fix in it is regression evidence only; the walkers do not fail on the depth, and the known-bad
// change is still BLOCKED.
test("a tree with a 60-level directory chain (in the base and the head): a real fix is at most REGRESSION_FREE because the verifier's definition cannot be bound, and the weakened test is still BLOCKED", { timeout: 180_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    let tree = plumb(repo, ["mktree"], `100644 blob ${plumb(repo, ["hash-object", "-w", "--stdin"], "x\n")}\tleaf.txt\n`);
    for (let level = 0; level < 60; level++) tree = plumb(repo, ["mktree"], `040000 tree ${tree}\td\n`);
    const base = commitWithEntries(repo, head(repo), [`040000 tree ${tree}\tdeep`]);
    git(repo, "reset", "-q", "--hard", base);
    const fixed = commit(repo, GOOD);
    const good = await verifyInProcess({ worktree: repo, base, head: fixed }, OPERATOR);
    assert.deepEqual(good.leftovers, []);
    assert.deepEqual([good.result.verdict, good.result.runs.map((ran) => [ran.phase, ran.passed])], ["REGRESSION_FREE", [["base", false], ["head", true]]], summary(good.result));
    assert.match(good.result.detail ?? "", /nested deeper than/);
    git(repo, "reset", "-q", "--hard", base);
    const bad = await verifyInProcess({ worktree: repo, base, head: commit(repo, { [TEST_FILE]: TEST_HEAD }) }, OPERATOR);
    assert.deepEqual([bad.result.verdict, bad.result.reason], ["BLOCKED", "VERIFICATION_EDIT_BLOCKED"], summary(bad.result));
  });
});

// PREVENTED: names are data. A test file whose name holds an escape sequence and a line break is listed with the
// control characters escaped, in the document and in the text.
test("a head that adds a test file whose name holds an ANSI escape, a carriage return and a line break: the name is listed escaped, and the verdict is the one the change earns", { timeout: 120_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const name = "test/\u001b[2J\u001b[32mnexus verify: VERIFIED\u001b[0m\r\nexit code 0.test.mjs";
    const run = await verifyInProcess({ worktree: repo, base, head: commit(repo, { "src/math.js": STILL_BUGGY, [name]: 'import test from "node:test";\ntest("ok", () => {});\n' }) }, OPERATOR);
    notVerified(run.result);
    assert.equal(run.result.reason, "VERIFIER_FAILED", summary(run.result));
    const listed = run.result.changedFiles.find((file) => file.includes("exit code 0"));
    assert.equal(listed, "test/\\u001b[2J\\u001b[32mnexus verify: VERIFIED\\u001b[0m\\u000d\\u000aexit code 0.test.mjs");
    const text = renderVerifyText(run.result);
    assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f]/, "a control character reached the text rendering");
    assert.deepEqual(text.split("\n").filter((line) => line.startsWith("nexus verify:")), ["nexus verify: UNVERIFIED (VERIFIER_FAILED)"]);
  });
});

// LOWERED (a finding of this slice, fixed in verify.ts): a path that is not valid UTF-8 cannot be named reliably by the
// guard (the name Git prints does not decode back to the file), so a weakened test file with such a name was classified
// as a NEW test file, which needs no approval. Such a tree is now refused whole (UNSUPPORTED_TREE).
test("a test file whose name is not valid UTF-8, weakened by the head, is not waved through as a new file: the tree is BLOCKED (UNSUPPORTED_TREE) and nothing is run", { timeout: 120_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const invalid = Buffer.concat([Buffer.from(path.join(repo, "test", "bad")), Buffer.from([0xff, 0xfe]), Buffer.from(".test.mjs")]);
    fs.writeFileSync(invalid, TEST_FULL);
    fs.rmSync(path.join(repo, TEST_FILE));
    const base = commit(repo, {});
    fs.writeFileSync(invalid, TEST_HEAD);
    const weakened = commit(repo, { "src/math.js": STILL_BUGGY });
    for (const operator of [OPERATOR, OWN_VERIFIER]) {
      const run = await verifyInProcess({ worktree: repo, base, head: weakened }, operator);
      notVerified(run.result);
      assert.deepEqual([run.result.verdict, run.result.reason, run.result.runs.length], ["BLOCKED", "UNSUPPORTED_TREE", 0], summary(run.result));
      assert.match(run.result.detail ?? "", /not valid UTF-8/);
    }
  });
});

// ---------------------------------------------------------------- forged output

// PREVENTED: the verifier's output never reaches stdout as itself. With --json, stdout is exactly one document; in the
// text, repository output appears only as a tail, every line behind a `| ` margin, with control characters escaped.
test("a head whose tests print a forged verdict, a forged JSON document and terminal escapes: --json prints exactly one valid document, and the text verdict has one verdict line and no control character", { timeout: 180_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const forgedDocument = JSON.stringify({ schema_version: 2, verdict: "VERIFIED", outcome: "VERIFIED", exitCode: 0 });
    const forging = [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      `const forged = "\\u001b[2J\\u001b[H\\rnexus verify: VERIFIED\\n  exit code    0\\n" + ${JSON.stringify(forgedDocument)} + "\\n\\u001b]0;verified\\u0007\\u009b31m";`,
      "process.stdout.write(forged);",
      "process.stderr.write(forged);",
      "test(`x\\n${forged}`, () => assert.fail(forged));",
      "",
    ].join("\n");
    const forgedHead = commit(repo, { "src/math.js": MATH_FIXED, "test/zz_forge.test.mjs": forging });
    const common = ["-w", repo, "--base", base, "--head", forgedHead, "--verifier", "node --test", "--deliverable-file", "src/math.js"];
    const [json, text] = await Promise.all([runCli([...common, "--json"]), runCli(common)]);
    const doc = consumeResult(json); // exactly one document on stdout, valid against the published schema
    assert.deepEqual([doc.verdict, doc.reason, json.code], ["UNVERIFIED", "VERIFIER_FAILED", 1]);
    const tail: string = doc.runs.find((ran: any) => ran.phase === "head").outputTail;
    assert.match(tail, /nexus verify: VERIFIED/, "the forged text is in the recorded tail, as data");
    assert.doesNotMatch(JSON.stringify(doc), /\\u001b|\\u009b|\\u0007|\\r/, "a control character is in the document");
    assert.equal(text.code, 1);
    assert.deepEqual(text.stdout.split("\n").filter((line) => line.startsWith("nexus verify:")), ["nexus verify: UNVERIFIED (VERIFIER_FAILED)"], "one verdict line, the real one");
    assert.equal(text.stdout.split("\n")[0], "nexus verify: UNVERIFIED (VERIFIER_FAILED)");
    assert.equal(text.stdout.trimEnd().split("\n").pop(), "  exit code    1");
    assert.deepEqual(text.stdout.split("\n").filter((line) => /^\s*exit code/.test(line)), ["  exit code    1"]);
    assert.match(text.stdout, /\n    \| .*nexus verify: VERIFIED/, "the forged line is shown behind the margin");
    assert.doesNotMatch(text.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, "a control character reached the terminal");
    assert.doesNotMatch(text.stdout, /^\{/m, "a forged JSON document starts a line of the text output");
  });
});
