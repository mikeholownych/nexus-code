/**
 * VR-1: `nexus verify`, the verdict on a change Nexus did not necessarily make. The consumer tests spawn the real CLI
 * against small Git repositories: no model, no network. Contract: src/verify_contract.ts; core: src/core/verify.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { VERIFY_EXIT_CODES, VERIFY_REASONS, verifyExitCode, verifyExitNameFor, verifyVerdictFor, type VerifyReason } from "../src/verify_contract.js";
import { VERIFY_MAX_TREE_FILES, VERIFY_RECORDED_ENVIRONMENT, verifyChange } from "../src/core/verify.js";
import {
  BAD, BASE_FILES, BASE_VERIFIER_DIGEST, CLI_DIR, DELIVERABLE, GOOD, MATH_BROKEN, PACKAGE, TEST_FILE, TEST_FULL, TEST_WEAKENED,
  commit, consume, consumeResult, git, head, runCli, withRepos, writeFiles,
} from "./helpers/verify_fixture.js";

const MANUAL = path.resolve(CLI_DIR, "..", "docs", "USER_MANUAL.md");
/** The operator has read the weakened test and lets the result be reported; the verdict is then what the tests show. */
const APPROVE_TEST_EDIT = ["--approve-verification-edit", TEST_FILE];

/** A digest of everything under `root`: every file's bytes, every link's target, every directory, `.git` included. */
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      const name = path.relative(root, full);
      if (entry.isSymbolicLink()) hash.update(`L\0${name}\0${fs.readlinkSync(full)}\0`);
      else if (entry.isDirectory()) { hash.update(`D\0${name}\0`); walk(full); }
      else hash.update(`F\0${name}\0${fs.statSync(full).mode}\0`).update(fs.readFileSync(full)).update("\0");
    }
  };
  walk(root);
  return hash.digest("hex");
}

const phases = (doc: any): string[] => doc.runs.map((ran: any) => ran.phase);

// ---- The contract tables ----

test("the manual's verify exit-code table is the exported table", () => {
  const manual = fs.readFileSync(MANUAL, "utf8");
  const start = manual.indexOf("#### Exit codes of `nexus verify`");
  assert.ok(start >= 0, "the manual has the section");
  const rows = manual.slice(start).split("\n").slice(1);
  const first = rows.findIndex((line) => line.startsWith("|"));
  const table: string[] = [];
  for (let i = first; i < rows.length && rows[i].startsWith("|"); i++) table.push(rows[i]);
  const cells = table.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  assert.deepEqual(cells[0], ["Code", "Name", "When"]);
  assert.match(cells[1].join(""), /^[-: ]+$/);
  assert.deepEqual(
    cells.slice(2).map(([code, name, when]) => ({ code: Number(code), name: name.replace(/`/g, ""), when })),
    VERIFY_EXIT_CODES.map((row) => ({ ...row })),
  );
});

test("every reason has a verdict and an exit-code row; only VERIFIED exits 0", () => {
  assert.equal(new Set(VERIFY_EXIT_CODES.map((row) => row.name)).size, VERIFY_EXIT_CODES.length, "row names are unique");
  assert.deepEqual([...new Set(VERIFY_EXIT_CODES.map((row) => row.code))], [0, 1, 2, 3, 130]);
  assert.equal(verifyVerdictFor(undefined), "VERIFIED");
  assert.equal(verifyExitCode(verifyExitNameFor(undefined)), 0);
  for (const reason of Object.keys(VERIFY_REASONS) as VerifyReason[]) {
    const { verdict, exit } = VERIFY_REASONS[reason];
    assert.notEqual(verifyExitCode(exit), 0, reason);
    assert.equal(verifyExitCode(exit) === 3, verdict === "BLOCKED", `${reason}: exit 3 if and only if BLOCKED`);
    if (verdict === "REGRESSION_FREE") assert.equal(verifyExitCode(exit), 2, reason);
  }
  assert.deepEqual([...VERIFY_RECORDED_ENVIRONMENT], ["NEXUS_TRUST_WORKSPACE", "NEXUS_TYPECHECK", "NEXUS_VERIFIER_TIMEOUT_SECS", "NEXUS_VERIFIER_ENV_PASSTHROUGH"]);
});

// ---- The verdicts ----

test("a fix that makes the base's failing test pass is VERIFIED (exit 0); the text verdict and the receipt say what ran", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const good = commit(repo, GOOD);
    const receipt = path.join(repo, "..", `${path.basename(repo)}.receipt.json`);
    try {
      const [json, text] = await Promise.all([
        runCli(["-w", repo, "--base", base, "--head", good, ...DELIVERABLE, "-y", "--json", "--receipt", receipt]),
        runCli(["-w", repo, "--base", base, "--head", good, ...DELIVERABLE, "-y"]),
      ]);
      const doc = consumeResult(json);
      assert.equal(doc.verdict, "VERIFIED", `${doc.reason}: ${doc.detail}`);
      assert.equal(json.code, 0);
      assert.equal("reason" in doc, false);
      assert.deepEqual(doc.base, { ref: base, commit: base, tree: git(repo, "rev-parse", `${base}^{tree}`), workingTree: false });
      assert.deepEqual(doc.head, { ref: good, commit: good, tree: git(repo, "rev-parse", `${good}^{tree}`), workingTree: false });
      assert.deepEqual(doc.changedFiles, ["src/math.js"]);
      assert.deepEqual(doc.verifier, { command: "npm test", source: "discovered", evidence: "package.json:scripts.test", digest: BASE_VERIFIER_DIGEST, approval: "yes", script: "node --test" });
      assert.deepEqual(doc.deliverables, ["src/math.js"]);
      assert.deepEqual(phases(doc), ["base", "head"]);
      assert.deepEqual(doc.runs.map((ran: any) => [ran.passed, ran.executedTests, ran.timedOut]), [[false, true, false], [true, true, false]]);
      assert.ok(doc.runs.every((ran: any) => /^[0-9a-f]{64}$/.test(ran.outputSha256)));
      assert.deepEqual(doc.baseline, { failed: true, usable: true, testFiles: 1, verifierDefinitionBound: true });
      assert.equal(doc.verification.status, "PASSED");
      assert.equal(doc.verification.source, "discovered");
      assert.equal(doc.verification.independent, true);
      assert.equal(doc.verification.isDeliverableBound, true);
      assert.deepEqual(doc.environment, []);
      assert.deepEqual(doc.linkedDependencyDirs, []);
      assert.deepEqual(doc.typecheck, { status: "NOT_APPLICABLE", mode: "enforce", detail: "the head tree has no configured type-check project" });
      assert.deepEqual(doc.guard, { status: "CLEAR", mode: "approve", policySource: "default", findings: [], complete: true });
      assert.deepEqual(doc.approvedVerificationEdits, []);
      assert.equal(doc.review.status, "COMPLETE");
      assert.equal(doc.review.verdict, "ACCEPT");
      assert.deepEqual(doc.review.suspectedDefects, []);
      // --receipt writes the same document.
      assert.equal(fs.readFileSync(receipt, "utf8"), json.stdout);

      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /^nexus verify: VERIFIED$/m);
      assert.match(text.stdout, /^ {2}verifier +npm test \(discovered in the base tree: package\.json:scripts\.test; approved by --yes\)$/m);
      assert.match(text.stdout, /^ {2}base run +failed \(exit 1\); tests ran$/m);
      assert.match(text.stdout, /^ {2}head run +passed; tests ran$/m);
      assert.match(text.stdout, /^ {2}type-check +NOT_APPLICABLE \(enforce\): the head tree has no configured type-check project$/m);
      assert.match(text.stdout, /^ {2}guard +CLEAR \(mode approve, default policy\): 0 changed verification file\(s\)$/m);
      assert.match(text.stdout, /^ {2}review +ACCEPT: 0 suspected defect\(s\), 0 scope violation\(s\), 0 unproven criterion\/criteria$/m);
      assert.deepEqual(text.leftovers, []);
    } finally {
      fs.rmSync(receipt, { force: true });
    }
  });
});

test("the known-bad change (the failing test deleted, the bug left in) is NOT VERIFIED: BLOCKED until the test edit is approved, and then the base's tests still fail on the head", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const bad = commit(repo, BAD);
    const [unapproved, approved] = await Promise.all([
      runCli(["-w", repo, "--base", base, "--head", bad, ...DELIVERABLE, "-y", "--json"]),
      runCli(["-w", repo, "--base", base, "--head", bad, ...DELIVERABLE, "-y", "--json", ...APPROVE_TEST_EDIT]),
    ]);
    const blocked = consumeResult(unapproved);
    assert.equal(blocked.verdict, "BLOCKED");
    assert.equal(blocked.reason, "VERIFICATION_EDIT_BLOCKED");
    assert.equal(unapproved.code, verifyExitCode("blocked"));
    assert.deepEqual(blocked.guard.findings, [{ path: TEST_FILE, class: "test_file", kind: "modified", weakening: ["fewer-assertions"], requiresApproval: true, approved: false }]);
    const doc = consumeResult(approved);
    assert.deepEqual(doc.approvedVerificationEdits, [TEST_FILE]);
    assert.equal(doc.guard.findings[0].approved, true);
    assert.notEqual(doc.verdict, "VERIFIED");
    assert.equal(doc.verdict, "REGRESSION_FREE");
    assert.equal(doc.exitCode, 2);
    assert.equal(doc.verification.status, "PASSED", "the head's own (weakened) tests pass");
    assert.equal(doc.verification.independent, false);
    assert.match(doc.verification.independenceDetail, /passes only with tests the change added or edited/);
    assert.deepEqual(phases(doc), ["base", "head", "base_tests_on_head"]);
    assert.equal(doc.runs[2].passed, false, "the base's test files fail against the head's code");
    assert.equal(doc.review.status, "COMPLETE");
    assert.equal(doc.review.verdict, "REJECT", "the independent reviewer records the approved weakening as a defect");
    assert.deepEqual(doc.review.suspectedDefects, [{ path: TEST_FILE, description: `the change weakens ${TEST_FILE}: fewer-assertions` }]);
    assert.notEqual(doc.verdict, "VERIFIED", "a REJECT never promotes a pass");
  });
});

test("a head whose weakened test restores itself while it runs is still judged on the tree as committed", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    // The failing test is deleted, and the test file puts the base's content back when it runs, so a comparison made
    // after the run would find the tests "unchanged".
    const selfRestoring = `${TEST_WEAKENED}import fs from "node:fs";\nfs.writeFileSync(new URL(import.meta.url), ${JSON.stringify(TEST_FULL)});\n`;
    const bad = commit(repo, { "test/math.test.mjs": selfRestoring });
    const doc = consumeResult(await runCli(["-w", repo, "--base", base, "--head", bad, ...DELIVERABLE, "-y", "--json", ...APPROVE_TEST_EDIT]));
    assert.equal(doc.runs[1].passed, true, "the head's own run passes");
    assert.notEqual(doc.verdict, "VERIFIED");
    assert.equal(doc.verification.independent, false);
    assert.deepEqual(phases(doc), ["base", "head", "base_tests_on_head"]);
  });
});

test("the same fix without a declared deliverable, and a head that breaks the code, are not VERIFIED", async () => {
  await withRepos([BASE_FILES, BASE_FILES], async (undeclared, broken) => {
    const [noDeliverable, failing] = await Promise.all([
      (async () => { const base = head(undeclared); return runCli(["-w", undeclared, "--base", base, "--head", commit(undeclared, GOOD), "-y", "--json"]); })(),
      (async () => { const base = head(broken); return runCli(["-w", broken, "--base", base, "--head", commit(broken, { "src/math.js": MATH_BROKEN }), ...DELIVERABLE, "-y", "--json"]); })(),
    ]);
    const first = consumeResult(noDeliverable);
    assert.notEqual(first.verdict, "VERIFIED", "VERIFIED needs an operator-declared deliverable");
    assert.notEqual(noDeliverable.code, 0);
    const second = consumeResult(failing);
    assert.equal(second.verdict, "UNVERIFIED");
    assert.equal(second.outcome, "NOT_ESTABLISHED");
    assert.equal(second.reason, "VERIFIER_FAILED");
    assert.equal(failing.code, verifyExitCode("failed"));
    assert.equal(second.runs[1].phase, "head");
    assert.match(second.runs[1].outputTail, /double/);
  });
});

test("the head cannot choose its own verifier: a rewritten scripts.test is not run, and a verifier only the head defines is not discovered", async () => {
  const fake = JSON.stringify({ ...JSON.parse(PACKAGE), scripts: { test: "echo 'ℹ tests 2' && echo 'ℹ pass 2' && echo 'ℹ fail 0'" } });
  const noScript = JSON.stringify({ name: "verify-fixture", version: "1.0.0", private: true, type: "module" });
  await withRepos([BASE_FILES, { ...BASE_FILES, "package.json": noScript }], async (rewritten, added) => {
    const [first, second] = await Promise.all([
      // The edit to package.json's scripts is approved here, so the verdict is what the verifier rules give (test/verify_typecheck_guard.test.ts covers the unapproved edit).
      (async () => { const base = head(rewritten); return runCli(["-w", rewritten, "--base", base, "--head", commit(rewritten, { "package.json": fake }), ...DELIVERABLE, "-y", "--json", "--approve-verification-edit", "package.json"]); })(),
      (async () => { const base = head(added); return runCli(["-w", added, "--base", base, "--head", commit(added, { "package.json": fake }), ...DELIVERABLE, "-y", "--json", "--approve-verification-edit", "package.json"]); })(),
    ]);
    const doc = consumeResult(first);
    assert.notEqual(doc.verdict, "VERIFIED");
    assert.equal(doc.reason, "VERIFIER_DEFINITION_CHANGED");
    assert.equal(doc.outcome, "NOT_ESTABLISHED");
    assert.equal(first.code, verifyExitCode("failed"));
    // The verifier is the one the BASE tree defines: its script and digest, never the head's.
    assert.equal(doc.verifier.script, "node --test");
    assert.equal(doc.verifier.digest, BASE_VERIFIER_DIGEST);
    assert.deepEqual(phases(doc), ["base"], "the head's rewritten script was never run");

    const none = consumeResult(second);
    assert.equal(none.reason, "NO_APPLICABLE_VERIFIER");
    assert.equal(none.verdict, "UNVERIFIED");
    assert.equal(second.code, verifyExitCode("unverified"));
    assert.equal("verifier" in none, false);
    assert.deepEqual(none.runs, [], "nothing the head defines was run");
    assert.match(none.detail, /the head defines npm test, but the head is the change under test/);
  });
});

test("--verifier 'echo ok' executes no test: UNVERIFIED; base equal to head: NOTHING_TO_VERIFY; neither exits 0", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const good = commit(repo, GOOD);
    const [echo, same, sameTree] = await Promise.all([
      runCli(["-w", repo, "--base", base, "--head", good, ...DELIVERABLE, "--verifier", "echo ok", "--json"]),
      runCli(["-w", repo, "--base", good, "--head", good, ...DELIVERABLE, "-y", "--json"]),
      // The working tree is the head and is clean: the same tree as HEAD.
      runCli(["-w", repo, ...DELIVERABLE, "-y", "--json"]),
    ]);
    const echoed = consumeResult(echo);
    assert.equal(echoed.verdict, "UNVERIFIED");
    assert.equal(echoed.reason, "NO_TESTS_EXECUTED");
    assert.equal(echo.code, verifyExitCode("unverified"));
    assert.equal(echoed.verifier.source, "configured");
    assert.equal(echoed.verifier.approval, "operator_command");
    assert.equal(echoed.runs.at(-1).passed, true, "the command itself exited 0");
    for (const run of [same, sameTree]) {
      const doc = consumeResult(run);
      assert.equal(doc.verdict, "UNVERIFIED");
      assert.equal(doc.reason, "NOTHING_TO_VERIFY");
      assert.equal(run.code, verifyExitCode("unverified"));
      assert.deepEqual(doc.runs, []);
      assert.equal(doc.base.tree, doc.head.tree);
    }
  });
});

test("a discovered verifier needs approval: BLOCKED (exit 3) with the command and digest; the right digest proceeds, a wrong one stays BLOCKED", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    const good = commit(repo, GOOD);
    const args = ["-w", repo, "--base", base, "--head", good, ...DELIVERABLE];
    const [text, json, right, wrong] = await Promise.all([
      runCli(args),
      runCli([...args, "--json"]),
      runCli([...args, "--approve-verifier", BASE_VERIFIER_DIGEST, "--json"]),
      runCli([...args, "--approve-verifier", "0".repeat(64), "--json"]),
    ]);
    assert.equal(text.code, 3, text.stderr);
    assert.match(text.stdout, /^nexus verify: BLOCKED \(VERIFIER_NOT_APPROVED\)$/m);
    assert.ok(text.stdout.includes("npm test"), "the command is printed");
    assert.ok(text.stdout.includes("node --test"), "the script it runs is printed");
    assert.ok(text.stdout.includes(`--approve-verifier ${BASE_VERIFIER_DIGEST}`), "the digest to approve is printed");
    assert.deepEqual(text.leftovers, []);

    const blocked = consumeResult(json);
    assert.equal(blocked.verdict, "BLOCKED");
    assert.equal(blocked.reason, "VERIFIER_NOT_APPROVED");
    assert.equal(json.code, verifyExitCode("blocked"));
    assert.deepEqual(blocked.runs, [], "nothing was run");
    assert.equal(blocked.verifier.approval, "none");
    assert.equal(blocked.verifier.digest, BASE_VERIFIER_DIGEST);

    const approved = consumeResult(right);
    assert.equal(approved.verdict, "VERIFIED", `${approved.reason}: ${approved.detail}`);
    assert.equal(approved.verifier.approval, "digest");

    const refused = consumeResult(wrong);
    assert.equal(refused.verdict, "BLOCKED");
    assert.equal(wrong.code, 3);
    assert.deepEqual(refused.runs, []);
    assert.match(refused.detail, /does not match/);
  });
});

test("harness parity: the same bad bytes applied with git apply in a plain repository, and committed by someone else beside Nexus state, get the same verdict", async () => {
  const NEXUS_STATE = { ".nexus/state/task.json": '{"task":"t"}\n', ".nexus/verify/stale/x.txt": "stale\n" };
  await withRepos([BASE_FILES, BASE_FILES, BASE_FILES], async (plain, withState, appliedBesideState) => {
    // (B) committed by a different author, in a repository that holds (untracked) Nexus state.
    const stateBase = head(withState);
    const stateHead = commit(withState, BAD, "Someone Else <someone@else.invalid>");
    writeFiles(withState, NEXUS_STATE);
    // (A) the same change as a patch, applied to a working tree with no Nexus state and never committed.
    // (C) the same patch applied to a working tree that does hold Nexus state.
    const patch = path.join(plain, "..", `${path.basename(plain)}.patch`);
    fs.writeFileSync(patch, execFileSync("git", ["diff", stateBase, stateHead], { cwd: withState }));
    try {
      git(plain, "apply", patch);
      git(appliedBesideState, "apply", patch);
    } finally {
      fs.rmSync(patch, { force: true });
    }
    writeFiles(appliedBesideState, NEXUS_STATE);
    const [applied, committed, besideState] = await Promise.all([
      runCli(["-w", plain, ...DELIVERABLE, "-y", "--json", ...APPROVE_TEST_EDIT]),
      runCli(["-w", withState, "--base", stateBase, "--head", stateHead, ...DELIVERABLE, "-y", "--json", ...APPROVE_TEST_EDIT]),
      runCli(["-w", appliedBesideState, ...DELIVERABLE, "-y", "--json", ...APPROVE_TEST_EDIT]),
    ]);
    const a = consumeResult(applied);
    const b = consumeResult(committed);
    const c = consumeResult(besideState);
    assert.equal(a.head.workingTree, true);
    assert.equal(a.head.commit, null);
    assert.equal(b.head.workingTree, false);
    assert.equal(a.head.tree, b.head.tree, "the same bytes");
    assert.equal(c.head.tree, b.head.tree, "Nexus's own state is not part of the change");
    const verdict = (doc: any) => ({ verdict: doc.verdict, outcome: doc.outcome, reason: doc.reason, exitCode: doc.exitCode, independent: doc.verification.independent, detail: doc.detail, guard: doc.guard });
    assert.deepEqual(verdict(a), verdict(b));
    assert.deepEqual(verdict(c), verdict(b));
    assert.equal(a.verdict, "REGRESSION_FREE");
    assert.equal(a.verification.independent, false);
    assert.deepEqual(a.changedFiles, b.changedFiles);
    assert.deepEqual(c.changedFiles, b.changedFiles);
    assert.equal(fs.readFileSync(path.join(appliedBesideState, ".nexus/verify/stale/x.txt"), "utf8"), "stale\n", "existing Nexus state is left alone");
  });
});

test("the caller's checkout is byte-for-byte unchanged by a run on its working tree, and no scratch directory remains", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    // An uncommitted fix, an untracked file and an ignored one.
    writeFiles(repo, { ...GOOD, "notes.txt": "untracked\n", ".gitignore": "ignored.log\n", "ignored.log": "ignored\n" });
    const statusBefore = git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored");
    const digestBefore = treeDigest(repo);
    const run = await runCli(["-w", repo, "--deliverable-file", "src/math.js", "-y", "--json"]);
    const digestAfter = treeDigest(repo);
    const doc = consumeResult(run);
    assert.equal(doc.head.workingTree, true);
    assert.deepEqual(phases(doc), ["base", "head"], "the verifier did run on both sides");
    assert.deepEqual([...doc.changedFiles].sort(), [".gitignore", "notes.txt", "src/math.js"], "untracked files are part of the change; ignored ones are not");
    assert.equal(digestAfter, digestBefore, "every file, link and directory, .git included");
    assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored"), statusBefore);
    assert.equal(fs.existsSync(path.join(repo, ".nexus")), false, "no Nexus state was created in the checkout");
    assert.deepEqual(run.leftovers, []);
    // notes.txt and .gitignore are changed files outside the declared deliverable: the pass is regression evidence only.
    assert.equal(doc.verdict, "REGRESSION_FREE");
  });
});

test("a checkout with node_modules: it is linked into both scratch trees, the npm verifier cannot be bound, and the verdict is at most REGRESSION_FREE", async () => {
  await withRepos([{ ...BASE_FILES, ".gitignore": "node_modules/\n" }], async (repo) => {
    const base = head(repo);
    const good = commit(repo, GOOD);
    writeFiles(repo, { "node_modules/dep/index.js": "export default 1;\n" });
    const doc = consumeResult(await runCli(["-w", repo, "--base", base, "--head", good, ...DELIVERABLE, "-y", "--json"]));
    assert.deepEqual(doc.linkedDependencyDirs, ["node_modules"]);
    assert.equal(doc.verdict, "REGRESSION_FREE", `${doc.reason}: ${doc.detail}`);
    assert.equal(doc.verification.definitionBound, false);
    assert.equal(doc.baseline.verifierDefinitionBound, false);
    assert.match(doc.detail, /node_modules/);
    assert.equal(fs.readFileSync(path.join(repo, "node_modules/dep/index.js"), "utf8"), "export default 1;\n");
  });
});

test("verdict-affecting environment variables are recorded by name, never by value, and do not change the verdict", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    // The head also ships a policy file that would switch the guard off: it is repository content and decides nothing.
    const bad = commit(repo, { ...BAD, ".nexus-security.json": '{"verificationPaths":{"mode":"off"}}\n' });
    const args = ["-w", repo, "--base", base, "--head", bad, ...DELIVERABLE, "-y", "--json"];
    const [plain, withEnv] = await Promise.all([
      runCli(args),
      runCli(args, { NEXUS_TRUST_WORKSPACE: "value-that-must-not-appear", NEXUS_VERIFIER_TIMEOUT_SECS: "240" }),
    ]);
    const a = consumeResult(plain);
    const b = consumeResult(withEnv);
    assert.deepEqual(a.environment, []);
    assert.deepEqual(b.environment, ["NEXUS_TRUST_WORKSPACE", "NEXUS_VERIFIER_TIMEOUT_SECS"]);
    assert.equal(withEnv.stdout.includes("value-that-must-not-appear"), false);
    assert.equal(b.limits.timeoutSecs, 240);
    assert.equal(a.verdict, "BLOCKED", "the weakened test and the policy file are findings; neither the head's policy nor the variable lifts them");
    assert.deepEqual(a.guard.findings.map((finding: any) => [finding.path, finding.class]), [[".nexus-security.json", "policy"], [TEST_FILE, "test_file"]]);
    assert.deepEqual([b.verdict, b.outcome, b.reason, b.guard], [a.verdict, a.outcome, a.reason, a.guard]);
  });
});

// ---- Refusals, limits and errors ----

test("usage errors exit 2 with a message on stderr; with --json the error document carries the exit code", async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-not-a-repo-"));
  try {
    await withRepos([BASE_FILES], async (repo) => {
      const base = head(repo);
      const cases: Array<{ name: string; args: string[]; message: RegExp }> = [
        { name: "bad base", args: ["-w", repo, "--base", "no-such-ref"], message: /^error: --base no-such-ref does not name a commit in this repository$/m },
        { name: "bad head", args: ["-w", repo, "--head", "no-such-ref"], message: /^error: --head no-such-ref does not name a commit in this repository$/m },
        { name: "option-like ref", args: ["-w", repo, "--base=--upload-pack=x"], message: /^error: --base --upload-pack=x is not a valid revision name$/m },
        { name: "not a repository", args: ["-w", notRepo], message: /is not a Git working tree$/m },
        { name: "not the top", args: ["-w", path.join(repo, "src")], message: /is not its top/ },
        { name: "missing directory", args: ["-w", path.join(notRepo, "missing")], message: /is not a directory$/m },
        { name: "deliverable outside", args: ["-w", repo, "--deliverable-file", "../x.js"], message: /--deliverable-file \.\.\/x\.js is not a path inside the working tree/ },
        { name: "verifier with approval", args: ["-w", repo, "--base", base, "--verifier", "npm test", "-y"], message: /--verifier is your own command and needs no approval/ },
        { name: "bad digest", args: ["-w", repo, "--approve-verifier", "abc"], message: /--approve-verifier needs the 64-character sha256 digest/ },
        { name: "bad timeout", args: ["-w", repo, "--timeout-secs", "0"], message: /--timeout-secs must be a whole number of seconds/ },
      ];
      // Text mode for every case; the JSON error document for one error found by the command and one found by the core.
      const withJson = ["bad base", "bad timeout"];
      const [runs, documents] = await Promise.all([
        Promise.all(cases.map((c) => runCli(c.args))),
        Promise.all(cases.filter((c) => withJson.includes(c.name)).map((c) => runCli([...c.args, "--json"]))),
      ]);
      cases.forEach((c, index) => {
        assert.match(runs[index].stderr, c.message, c.name);
        assert.equal(runs[index].code, verifyExitCode("usage"), c.name);
        assert.equal(runs[index].stdout, "", c.name);
        assert.deepEqual(runs[index].leftovers, [], c.name);
      });
      assert.equal(documents.length, withJson.length);
      for (const json of documents) {
        const doc = consume(json);
        assert.deepEqual(Object.keys(doc), ["schema_version", "error", "exitCode"]);
        assert.equal(doc.exitCode, verifyExitCode("usage"));
        assert.match(json.stderr, /^error: /m, "the message is on stderr too");
      }
    });
  } finally {
    fs.rmSync(notRepo, { recursive: true, force: true });
  }
});

test("a tree with a submodule and a working tree over the file limit are BLOCKED with a named reason, and nothing is run", async () => {
  await withRepos([BASE_FILES, BASE_FILES], async (withSubmodule, large) => {
    const base = head(withSubmodule);
    git(withSubmodule, "update-index", "--add", "--cacheinfo", `160000,${base},vendored`);
    git(withSubmodule, "commit", "-q", "-m", "gitlink");
    for (let i = 0; i <= VERIFY_MAX_TREE_FILES; i++) fs.writeFileSync(path.join(large, `f${i}.txt`), "");
    const [submodule, tooLarge] = await Promise.all([
      runCli(["-w", withSubmodule, "--base", base, "--head", head(withSubmodule), "-y", "--json"]),
      runCli(["-w", large, "-y", "--json"]),
    ]);
    const first = consumeResult(submodule);
    assert.equal(first.verdict, "BLOCKED");
    assert.equal(first.reason, "UNSUPPORTED_TREE");
    assert.match(first.detail, /submodule \(vendored\)/);
    const second = consumeResult(tooLarge);
    assert.equal(second.verdict, "BLOCKED");
    assert.equal(second.reason, "TREE_LIMIT_EXCEEDED");
    assert.match(second.detail, new RegExp(`limit ${VERIFY_MAX_TREE_FILES}`));
    for (const [run, doc] of [[submodule, first], [tooLarge, second]] as const) {
      assert.equal(run.code, verifyExitCode("blocked"));
      assert.deepEqual(doc.runs, []);
    }
  });
});

test("a linked worktree is verified like any checkout; one with a repository planted inside it is BLOCKED as untrusted", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const linked = `${repo}-linked`;
    const planted = `${repo}-planted`;
    try {
      git(repo, "worktree", "add", "-q", "--detach", linked);
      git(repo, "worktree", "add", "-q", "--detach", planted);
      writeFiles(linked, GOOD);
      writeFiles(planted, GOOD);
      fs.mkdirSync(path.join(planted, "nested"));
      git(path.join(planted, "nested"), "init", "-q");
      const [fine, refused] = await Promise.all([
        runCli(["-w", linked, ...DELIVERABLE, "-y", "--json"]),
        runCli(["-w", planted, ...DELIVERABLE, "-y", "--json"]),
      ]);
      const ok = consumeResult(fine);
      assert.equal(ok.verdict, "VERIFIED", `${ok.reason}: ${ok.detail}`);
      const doc = consumeResult(refused);
      assert.equal(doc.verdict, "BLOCKED");
      assert.equal(doc.reason, "UNTRUSTED_CHECKOUT");
      assert.equal(refused.code, verifyExitCode("blocked"));
      assert.deepEqual(doc.runs, []);
      assert.equal("base" in doc || "head" in doc, false, "nothing was resolved in the refused checkout");
    } finally {
      fs.rmSync(linked, { recursive: true, force: true });
      fs.rmSync(planted, { recursive: true, force: true });
    }
  });
});

test("an internal failure lowers the verdict (UNVERIFIED, INTERNAL_ERROR, exit 1) and still removes the scratch trees", async () => {
  const savedTmp = process.env.TMPDIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-test-tmp-"));
  await withRepos([BASE_FILES], async (repo) => {
    writeFiles(repo, GOOD);
    process.env.TMPDIR = tmp;
    try {
      // The progress callback runs once both trees are about to be written: a failure there is a failure inside verify.
      const result = await verifyChange({ worktree: repo }, { approveDiscoveredVerifier: true, deliverables: ["src/math.js"], sandbox: { engine: "none" }, onProgress: () => { throw new Error("injected failure"); } });
      assert.equal(result.verdict, "UNVERIFIED");
      assert.equal(result.outcome, "UNVERIFIED");
      assert.equal(result.reason, "INTERNAL_ERROR");
      assert.equal(result.exitCode, verifyExitCode("error"));
      assert.match(result.detail ?? "", /could not finish, so nothing was established: injected failure/);
      assert.deepEqual(result.runs, []);
      assert.deepEqual(fs.readdirSync(tmp), [], "the scratch directory was removed");
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("an interrupt is acted on when the running verifier ends: exit 130, an error document, and the scratch trees are removed", async () => {
  await withRepos([BASE_FILES], async (repo) => {
    writeFiles(repo, GOOD);
    // The verifier signals the nexus process itself (its parent, or its grandparent when it runs under `timeout`), then
    // ends: nothing here waits for a deadline.
    const signalNexus = 'p=$PPID; if [ "$(ps -o comm= -p $p)" = timeout ]; then p=$(ps -o ppid= -p $p); fi; kill -INT $p';
    const run = await runCli(["-w", repo, "--verifier", signalNexus, "--sandbox", "none", "--json"]);
    assert.equal(run.code, verifyExitCode("interrupted"), run.stderr);
    const doc = consume(run);
    assert.deepEqual(Object.keys(doc), ["schema_version", "error", "exitCode"]);
    assert.equal(doc.exitCode, 130);
    assert.match(run.stderr, /interrupted: no verdict was reached/);
  });
});
