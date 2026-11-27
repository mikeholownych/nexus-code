import "./helpers/leak_guard.js";
/**
 * PA-2: verified merge arbitration at the Git primitive (`OperationGit.integrate`). Real temporary repositories, real
 * verifier processes, no model. Every case asserts what the integration branch looks like afterwards: a refused merge
 * leaves the tip and the worktree exactly as they were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  MAX_INTEGRATION_CHECKS,
  OperationGit,
  ensureIntegrationWorktree,
  newOperationGitState,
  planOperationGit,
  type IntegrateResult,
} from "../src/core/operation_git.js";
import type { IntegrationReceipt, OperationGitState, UnitRunResult, WorkUnit } from "../src/core/operation.js";
import { isSandboxAvailable } from "../src/sandbox.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

/** base: `fmt(n)` appends the unit from config.js. */
function repo(base = os.tmpdir()): string {
  const root = fs.mkdtempSync(path.join(base, "nexus-pa2-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.invalid"]);
  git(root, ["config", "user.name", "t"]);
  write(root, "config.js", 'module.exports.UNIT = "m";\n');
  write(root, "fmt.js", 'const { UNIT } = require("./config.js");\nmodule.exports.fmt = (n) => n + UNIT;\n');
  write(root, "file.txt", "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

function unit(id: string): WorkUnit {
  return { id, title: id, prompt: id, dependsOn: [], requires: {}, status: "RUNNABLE", reroutes: [], runs: 0, unknownResumes: 0, modelsUsed: [] };
}

type Completed = Extract<UnitRunResult, { kind: "completed" }>;
function completed(command?: string): Completed {
  return {
    kind: "completed", summary: "done", outcome: "VERIFIED",
    ...(command ? { verification: { command, status: "PASSED", hasExecutedTests: true } } : {}),
  };
}

interface Fixture {
  root: string;
  state: OperationGitState;
  ops: OperationGit;
  integrationWorktree: string;
  receipts: IntegrationReceipt[];
  /** A directory outside the repository, for markers a verifier leaves. */
  outside: string;
  prepare(id: string): string;
  /** Integrates as the runner does: the receipts so far go in, a new receipt is appended. */
  integrate(id: string, command?: string): Promise<IntegrateResult>;
}

function fixture(options: { sandbox?: boolean | string; base?: string } = {}): Fixture {
  const root = repo(options.base);
  const p = planOperationGit(root, "op-pa2");
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state, { verifyTimeoutSecs: 60, sandbox: options.sandbox });
  const receipts: IntegrationReceipt[] = [];
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pa2-outside-"));
  return {
    root, state, ops, receipts, outside,
    integrationWorktree: p.integrationWorktree,
    prepare: (id) => ops.prepareUnit(unit(id)).workspace,
    integrate: async (id, command) => {
      const result = completed(command);
      const outcome = await ops.integrate(unit(id), result, {
        sequence: receipts.length + 1,
        integrated: receipts,
        ...(result.verification ? { tests: result.verification } : {}),
      });
      if (outcome.kind === "integrated" || outcome.kind === "nothing") receipts.push(outcome.receipt);
      return outcome;
    },
  };
}

const B_TEST = 'const assert = require("node:assert");\nconst { label } = require("../label.js");\nassert.equal(label(3), "3m");\nconsole.log("b ok");\n';
const A_TEST = 'const assert = require("node:assert");\nconst { fmt } = require("../fmt.js");\nassert.equal(fmt(3), "3km");\nconsole.log("a ok");\n';

/** Unit B: a label that relies on the base's unit, and the test that says so. */
function writeB(worktree: string): void {
  write(worktree, "label.js", 'const { fmt } = require("./fmt.js");\nmodule.exports.label = (n) => fmt(n);\n');
  write(worktree, "test/b.test.js", B_TEST);
}

/** Unit A: changes the unit. Textually disjoint from B, and B's test fails with it. */
function writeA(worktree: string): void {
  write(worktree, "config.js", 'module.exports.UNIT = "km";\n');
  write(worktree, "test/a.test.js", A_TEST);
}

function shell(cwd: string, command: string): boolean {
  try {
    execFileSync("bash", ["-c", command], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The integration branch is where it was, with nothing left over from a refused merge. */
function assertUntouched(f: Fixture, tip: string): void {
  assert.equal(f.ops.currentTip(), tip, "a refused merge must not move the integration tip");
  assert.equal(git(f.integrationWorktree, ["status", "--porcelain"]), "", "the integration worktree is clean");
  assert.equal(git(f.root, ["rev-parse", "--abbrev-ref", "HEAD"]), "main", "the operator's checkout is untouched");
}

test("two units that each pass alone and conflict semantically: the first integrates verified, the second is refused naming both", async () => {
  const f = fixture();
  const b = f.prepare("B");
  const a = f.prepare("A");
  writeB(b);
  writeA(a);
  // Each passes alone, on the base plus its own change.
  assert.equal(shell(b, "node test/b.test.js"), true);
  assert.equal(shell(a, "node test/a.test.js"), true);

  const first = await f.integrate("B", "node test/b.test.js");
  assert.equal(first.kind, "integrated");
  assert.ok(first.kind === "integrated");
  assert.equal(first.receipt.verification, "PASSED");
  assert.deepEqual(first.receipt.mergedChecks, [{ command: "node test/b.test.js", owners: ["B"], status: "PASSED" }]);
  const tip = f.ops.currentTip();

  const second = await f.integrate("A", "node test/a.test.js");
  assert.equal(second.kind, "failed", "the merge is textually clean, and still refused");
  assert.ok(second.kind === "failed");
  assert.deepEqual(second.conflictWith, ["B"]);
  assert.match(second.reason, /merging A breaks the verifier of B \(`node test\/b\.test\.js`\) on the merged tree; it passes without A/);
  assert.deepEqual(second.checks, [
    { command: "node test/a.test.js", owners: ["A"], status: "PASSED" },
    { command: "node test/b.test.js", owners: ["B"], status: "FAILED", baseline: "PASSED" },
  ]);
  assertUntouched(f, tip);
  assert.match(fs.readFileSync(path.join(f.integrationWorktree, "config.js"), "utf8"), /"m"/);
  assert.equal(f.state.units.A.integratedCommit, undefined, "the refused unit is not recorded as integrated");
  assert.equal(f.receipts.length, 1);
  assert.ok(git(f.root, ["rev-parse", "--verify", `refs/heads/${f.state.units.A.branch}`]), "the refused unit's branch is kept");
});

test("the same two units in the other order: the unit whose own verifier breaks on the merged tree is refused naming the unit it had not seen", async () => {
  const f = fixture();
  const b = f.prepare("B");
  const a = f.prepare("A");
  writeB(b);
  writeA(a);
  assert.equal((await f.integrate("A", "node test/a.test.js")).kind, "integrated");
  const tip = f.ops.currentTip();

  const second = await f.integrate("B", "node test/b.test.js");
  assert.ok(second.kind === "failed");
  assert.deepEqual(second.conflictWith, ["A"]);
  assert.match(second.reason, /^integration verification failed on the merged tree: node test\/b\.test\.js; it passed in B's own worktree, which lacks the integrated work of A\n/);
  assert.deepEqual(second.checks, [{ command: "node test/b.test.js", owners: ["B"], status: "FAILED" }]);
  assertUntouched(f, tip);

  // A unit that starts from the tip has seen everything: its failing verifier is its own, and nobody else is named.
  write(f.prepare("C"), "c.txt", "c\n");
  const own = await f.integrate("C", "test -f missing");
  assert.ok(own.kind === "failed");
  assert.equal(own.conflictWith, undefined);
  assertUntouched(f, tip);
});

test("a textual conflict names the integrated unit it collides with and leaves the branch as it was", async () => {
  const f = fixture();
  const one = f.prepare("u1");
  const two = f.prepare("u2");
  write(one, "file.txt", "from u1\n");
  write(two, "file.txt", "from u2\n");
  assert.equal((await f.integrate("u1", "grep -q u1 file.txt")).kind, "integrated");
  const tip = f.ops.currentTip();

  const second = await f.integrate("u2", "grep -q u2 file.txt");
  assert.equal(second.kind, "conflict");
  assert.ok(second.kind === "conflict");
  assert.deepEqual(second.files, ["file.txt"]);
  assert.deepEqual(second.conflictWith, ["u1"]);
  assertUntouched(f, tip);
  assert.equal(fs.readFileSync(path.join(f.integrationWorktree, "file.txt"), "utf8"), "from u1\n");
});

test("the operator's pinned verifier runs on every merge, and a unit that breaks it is refused", async () => {
  const f = fixture();
  f.state.integrationVerifiers = ["test -f file.txt"];
  write(f.prepare("u1"), "u1.txt", "one\n");
  const first = await f.integrate("u1");
  assert.ok(first.kind === "integrated");
  assert.equal(first.receipt.verification, "PASSED", "a unit without a verifier of its own is still checked");
  assert.deepEqual(first.receipt.mergedChecks, [{ command: "test -f file.txt", owners: ["operator"], status: "PASSED" }]);
  const tip = f.ops.currentTip();

  fs.rmSync(path.join(f.prepare("u2"), "file.txt"));
  const second = await f.integrate("u2", "true");
  assert.ok(second.kind === "failed");
  assert.match(second.reason, /merging u2 breaks the verifier of the operator \(`test -f file\.txt`\)/);
  assert.equal(second.conflictWith, undefined, "the operator is not a unit");
  assert.equal(second.checks?.[0]?.baseline, "PASSED");
  assertUntouched(f, tip);
});

test("a no-change unit still requires the operator verifier on the current integration candidate", async () => {
  const f = fixture();
  f.state.integrationVerifiers = ["test -f expected.txt"];
  f.prepare("u1");
  const tip = f.ops.currentTip();

  const outcome = await f.integrate("u1");
  assert.ok(outcome.kind === "failed");
  assert.match(outcome.reason, /integration verification failed/);
  assertUntouched(f, tip);
});

test("a successful merged check records the exact candidate and bounded execution evidence", async () => {
  const f = fixture();
  const command = "test -f file.txt && printf 'accepted output\\n'";
  f.state.integrationVerifiers = [command];
  f.prepare("u1");
  const tip = f.ops.currentTip();

  const outcome = await f.integrate("u1");
  assert.ok(outcome.kind === "nothing");
  const { verificationBinding } = outcome.receipt;
  assert.equal(verificationBinding?.commit, tip);
  assert.equal(verificationBinding?.worktree, f.integrationWorktree);
  assert.deepEqual(verificationBinding?.runs.map((run) => [run.command, run.exitCode]), [[command, 0]]);
  assert.equal(verificationBinding?.runs[0].outputPreview, "accepted output");
  assert.ok(verificationBinding?.runs.every((run) => /^[a-f0-9]{64}$/.test(run.outputSha256)));
});

test("typed required checks gate no-change completion and advisory failures remain visible", async () => {
  const f = fixture();
  f.prepare("u1");
  f.state.verificationChecks = [
    { id: "advisory", purpose: "optional smoke", command: "false", requirement: "advisory", cwd: ".", timeoutMs: 1000 },
    { id: "required", purpose: "expected input", command: "test -f expected.txt", requirement: "required", cwd: ".", timeoutMs: 1000 },
  ];
  const tip = f.ops.currentTip();
  const result = await f.integrate("u1");
  assert.ok(result.kind === "failed");
  assert.match(result.reason, /required/);
  assertUntouched(f, tip);
});

test("typed receipts bind alternate cwd, conditional applicability and unit ownership to the exact tree", async () => {
  const f = fixture();
  const tree = f.prepare("u1");
  write(tree, "checks/marker.txt", "included\n");
  f.state.verificationChecks = [
    { id: "skip", purpose: "only edited docs", command: "false", requirement: "conditional", cwd: ".", timeoutMs: 1000, when: { changedPaths: ["docs"] } },
    { id: "unit", unitId: "u1", purpose: "verify marker", command: "test -f marker.txt", requirement: "conditional", cwd: "checks", timeoutMs: 1000, when: { changedPaths: ["checks"] } },
    { id: "note", purpose: "record advisory failure", command: "false", requirement: "advisory", cwd: ".", timeoutMs: 1000 },
  ];
  const result = await f.integrate("u1");
  assert.ok(result.kind === "integrated");
  const binding = result.receipt.verificationBinding;
  assert.equal(binding?.commit, result.receipt.integratedCommit);
  assert.deepEqual(binding?.typedChecks?.map((check) => [check.id, check.status]), [["skip", "SKIPPED"], ["unit", "PASSED"], ["note", "FAILED"]]);
  assert.equal(f.ops.completionVerificationProblem(f.receipts), undefined);

  f.state.verificationChecks[1] = { ...f.state.verificationChecks[1], timeoutMs: 2000 };
  assert.match(f.ops.completionVerificationProblem(f.receipts) ?? "", /required checks/);
});

test("a later integration reruns required checks from previously accepted units", async () => {
  const f = fixture();
  f.state.verificationChecks = [{
    id: "first-check", unitId: "u1", purpose: "keep the created marker",
    command: "test -f marker.txt", requirement: "required", cwd: ".", timeoutMs: 1000,
  }];
  write(f.prepare("u1"), "marker.txt", "required\n");
  const first = await f.integrate("u1");
  assert.ok(first.kind === "integrated");
  const tip = f.ops.currentTip();
  fs.rmSync(path.join(f.prepare("u2"), "marker.txt"));

  const second = await f.integrate("u2");
  assert.ok(second.kind === "failed");
  assert.match(second.reason, /first-check/);
  assert.equal(second.verificationBinding?.typedChecks?.[0].status, "FAILED");
  assertUntouched(f, tip);
});

test("typed verification does not execute in aliased check directories", async () => {
  const f = fixture();
  const tree = f.prepare("u1");
  write(tree, "checks/marker.txt", "required\n");
  fs.symlinkSync("checks", path.join(tree, "alias"), "dir");
  f.state.verificationChecks = [{
    id: "alias-check", purpose: "check from specified directory",
    command: "test -f marker.txt", requirement: "required", cwd: "alias", timeoutMs: 1000,
  }];
  const tip = f.ops.currentTip();

  const result = await f.integrate("u1");
  assert.ok(result.kind === "failed");
  assert.match(result.reason, /cwd is unavailable or resolves through a symlink/);
  assert.equal(result.verificationBinding?.typedChecks?.[0].run, undefined);
  assertUntouched(f, tip);
});

test("integration distinguishes elapsed deadlines from a verifier's exit 124", async () => {
  const cases = [
    { command: "sleep 1", timeoutMs: 60, status: "TIMED_OUT" },
    { command: "exit 124", timeoutMs: 1000, status: "FAILED" },
  ];
  for (const { command, timeoutMs, status } of cases) {
    const f = fixture();
    f.prepare("u1");
    f.state.verificationChecks = [{
      id: "test", purpose: "record verifier status", command, requirement: "required", cwd: ".", timeoutMs,
    }];
    const tip = f.ops.currentTip();
    const result = await f.integrate("u1");
    assert.ok(result.kind === "failed");
    assert.equal(result.verificationBinding?.typedChecks?.[0]?.status, status);
    assertUntouched(f, tip);
  }
});

test("integration requires complete verifier output even when the command exits successfully", async () => {
  const f = fixture();
  f.state.integrationVerifiers = ["node -e 'process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 10))'"];
  write(f.prepare("u1"), "u1.txt", "one\n");
  const tip = f.ops.currentTip();

  const outcome = await f.integrate("u1");
  assert.ok(outcome.kind === "failed");
  assert.match(outcome.reason, /output truncated/);
  assert.equal(outcome.checks?.[0]?.status, "ENVIRONMENT");
  assert.equal(outcome.checks?.[0]?.outputTruncated, true);
  assertUntouched(f, tip);
});

test("a check that already fails before the merge is reported and not attributed to the new unit", async () => {
  const f = fixture();
  const marker = path.join(f.outside, "broken");
  const unstable = `test ! -e '${marker}'`;
  write(f.prepare("B"), "b.txt", "b\n");
  assert.equal((await f.integrate("B", unstable)).kind, "integrated");
  const tip = f.ops.currentTip();

  // B's verifier now fails whatever is merged: nothing A did.
  fs.writeFileSync(marker, "");
  write(f.prepare("A"), "a.txt", "a\n");
  const second = await f.integrate("A", "test -f a.txt");
  assert.ok(second.kind === "failed", "a tree that cannot be verified is still not integrated");
  assert.match(second.reason, /the integration branch already fails `test ! -e .*` before A was merged \(environment or unstable verifier\); not attributed to A/);
  assert.equal(second.conflictWith, undefined);
  assert.deepEqual(second.checks?.map((check) => [check.owners, check.status, check.baseline]), [
    [["A"], "PASSED", undefined],
    [["B"], "FAILED", "FAILED"],
  ]);
  assertUntouched(f, tip);
});

test("a failure of the unit's own verifier is its own: no baseline run, today's message", async () => {
  const f = fixture();
  const counter = path.join(f.outside, "runs");
  write(f.prepare("u1"), "u1.txt", "one\n");
  const tip = f.ops.currentTip();
  const failed = await f.integrate("u1", `echo x >> '${counter}'; test -f does-not-exist`);
  assert.ok(failed.kind === "failed");
  assert.match(failed.reason, /^integration verification failed on the merged tree: /);
  assert.equal(failed.checks?.[0]?.baseline, undefined);
  assert.equal(fs.readFileSync(counter, "utf8"), "x\n", "run once: the pre-merge tree does not hold the unit's tests");
  assertUntouched(f, tip);
});

test("the same command from two units runs once, with both owners", async () => {
  const f = fixture();
  const counter = path.join(f.outside, "runs");
  const command = `echo x >> '${counter}'`;
  write(f.prepare("u1"), "u1.txt", "one\n");
  write(f.prepare("u2"), "u2.txt", "two\n");
  assert.equal((await f.integrate("u1", command)).kind, "integrated");
  assert.equal(fs.readFileSync(counter, "utf8"), "x\n");
  const second = await f.integrate("u2", command);
  assert.ok(second.kind === "integrated");
  assert.deepEqual(second.receipt.mergedChecks, [{ command, owners: ["u2", "u1"], status: "PASSED" }]);
  assert.equal(fs.readFileSync(counter, "utf8"), "x\nx\n", "one more run, not two");
});

/** Receipts of units that integrated earlier, each with its own verifier, which leaves a marker when it runs. */
function earlierReceipts(count: number, outside: string): IntegrationReceipt[] {
  return Array.from({ length: count }, (_, i) => ({
    unitId: `e${i}`, branch: `b${i}`, commit: "c", integratedCommit: "c", mergedAt: "2026-01-01T00:00:00.000Z", files: [],
    outcome: "VERIFIED", summary: "", verification: "PASSED" as const, sequence: i + 1,
    tests: { command: `touch '${path.join(outside, `ran-${i}`)}'`, status: "PASSED", hasExecutedTests: true },
  }));
}

test(`${MAX_INTEGRATION_CHECKS} distinct checks all run; one more is refused before the merge, with none run or skipped`, async () => {
  assert.equal(MAX_INTEGRATION_CHECKS, 16);
  const f = fixture();
  write(f.prepare("u1"), "u1.txt", "one\n");
  const tip = f.ops.currentTip();

  const over = await f.ops.integrate(unit("u1"), completed("test -f u1.txt"), { integrated: earlierReceipts(16, f.outside) });
  assert.ok(over.kind === "failed");
  assert.match(over.reason, /would need 17 distinct verifier commands \(the limit is 16\) and none may be skipped/);
  assert.match(over.reason, /nothing was merged/);
  assert.deepEqual(fs.readdirSync(f.outside), [], "no check ran");
  assertUntouched(f, tip);
  assert.equal(f.state.units.u1.integratedCommit, undefined);

  const at = await f.ops.integrate(unit("u1"), completed("test -f u1.txt"), { integrated: earlierReceipts(15, f.outside) });
  assert.ok(at.kind === "integrated");
  assert.equal(at.receipt.mergedChecks?.length, 16);
  assert.equal(at.receipt.mergedChecks?.every((check) => check.status === "PASSED"), true);
  assert.equal(fs.readdirSync(f.outside).length, 15, "every earlier verifier ran");
});

test("hostile: a unit that edits an integrated unit's test file is refused before any check runs", async () => {
  const f = fixture();
  const counter = path.join(f.outside, "runs");
  const verifyB = `echo x >> '${counter}'; node test/b.test.js`;
  const b = f.prepare("B");
  const a = f.prepare("A");
  writeB(b);
  assert.equal((await f.integrate("B", verifyB)).kind, "integrated");
  const tip = f.ops.currentTip();

  // A breaks B's behaviour and rewrites B's test (identical path, added by both: here A starts from B's file) so it passes.
  git(a, ["merge", "-q", "--no-edit", git(f.integrationWorktree, ["rev-parse", "HEAD"])]);
  writeA(a);
  write(a, "test/b.test.js", 'console.log("b ok");\n');
  assert.equal(shell(a, "node test/b.test.js && node test/a.test.js"), true, "with the weakened test everything passes in A's tree");

  const refused = await f.integrate("A", "node test/a.test.js");
  assert.ok(refused.kind === "failed");
  assert.match(refused.reason, /^A changes verification files integrated by B: test\/b\.test\.js/);
  assert.deepEqual(refused.conflictWith, ["B"]);
  assert.equal(refused.checks, undefined, "no check ran on the merged tree");
  assert.equal(fs.readFileSync(counter, "utf8"), "x\n", "B's verifier ran once, at B's own integration");
  assertUntouched(f, tip);
  assert.equal(fs.readFileSync(path.join(f.integrationWorktree, "test/b.test.js"), "utf8"), B_TEST);
});

test("hostile: verifier configuration and oddly named tests an earlier unit integrated are protected too; its other files are not", async () => {
  const f = fixture();
  const b = f.prepare("B");
  write(b, "jest.config.js", "module.exports = {};\n");
  write(b, "test/ü \"q\".test.js", "// b\n");
  write(b, "label.js", "module.exports.label = () => 1;\n");
  assert.equal((await f.integrate("B", "test -f label.js")).kind, "integrated");
  const tip = f.ops.currentTip();
  const onTip = (id: string) => {
    const worktree = f.prepare(id);
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), tip);
    return worktree;
  };

  write(onTip("config"), "jest.config.js", "module.exports = { testMatch: [] };\n");
  const config = await f.integrate("config");
  assert.ok(config.kind === "failed");
  assert.match(config.reason, /changes verification files integrated by B: jest\.config\.js/);
  assertUntouched(f, tip);

  // Git quotes this name in its default listing; the rule reads the exact name.
  fs.rmSync(path.join(onTip("odd"), "test/ü \"q\".test.js"));
  const odd = await f.integrate("odd");
  assert.ok(odd.kind === "failed");
  assert.match(odd.reason, /changes verification files integrated by .*: test\/ü "q"\.test\.js/);
  assertUntouched(f, tip);

  write(onTip("plain"), "label.js", "module.exports.label = () => 2;\n");
  const plain = await f.integrate("plain");
  assert.equal(plain.kind, "integrated", "an ordinary file of an earlier unit may be changed; the checks decide");
});

test("hostile: a unit's own trivially passing verifier does not mask an earlier unit's failing check", async () => {
  const f = fixture();
  const b = f.prepare("B");
  const a = f.prepare("A");
  writeB(b);
  writeA(a);
  assert.equal((await f.integrate("B", "node test/b.test.js")).kind, "integrated");
  const tip = f.ops.currentTip();
  const refused = await f.integrate("A", "true");
  assert.ok(refused.kind === "failed");
  assert.deepEqual(refused.conflictWith, ["B"]);
  assertUntouched(f, tip);
});

test("hostile: a passing verifier that changes the merged tree is rejected and the merge is restored", async () => {
  const f = fixture();
  write(f.prepare("u1"), "u1.txt", "one\n");
  const tip = f.ops.currentTip();

  const outcome = await f.integrate("u1", "printf 'changed\\n' > file.txt; exit 0");

  assert.ok(outcome.kind === "failed");
  if (outcome.kind === "failed") {
    assert.match(outcome.reason, /integration verification changed the integration worktree/);
    assert.equal(outcome.checks?.at(-1)?.status, "PASSED", "the command returned success, but its modified tree was rejected");
  }
  assertUntouched(f, tip);
  assert.equal(fs.readFileSync(path.join(f.integrationWorktree, "file.txt"), "utf8"), "base\n");
  assert.equal(f.state.units.u1.integratedCommit, undefined);
  assert.deepEqual(f.receipts, []);
});

test("hostile: a later verifier cannot erase an earlier verifier's tree mutation", async () => {
  const f = fixture();
  write(f.prepare("u1"), "u1.txt", "one\n");
  assert.equal((await f.integrate("u1", "test -f file.txt")).kind, "integrated");
  const tip = f.ops.currentTip();
  write(f.prepare("u2"), "u2.txt", "two\n");

  const outcome = await f.integrate("u2", "printf 'changed\\n' > file.txt");

  assert.ok(outcome.kind === "failed");
  if (outcome.kind === "failed") {
    assert.match(outcome.reason, /integration verification changed the integration worktree/);
    assert.deepEqual(outcome.checks?.map((check) => check.status), ["PASSED"], "stop after the first command changes the tree");
  }
  assertUntouched(f, tip);
  assert.equal(fs.readFileSync(path.join(f.integrationWorktree, "file.txt"), "utf8"), "base\n");
  assert.equal(f.state.units.u2.integratedCommit, undefined);
  assert.equal(f.receipts.length, 1, "the previous unit's receipt remains, but u2 is not accepted");
});

test("hostile: nothing a unit reports marks a merge verified: checks on a receipt are the ones that ran", async () => {
  const f = fixture();
  write(f.prepare("u1"), "u1.txt", "one\n");
  const forged = [{ command: "all good", owners: ["operator"], status: "PASSED" }];
  // A result that claims a pass without executed tests, and forged check records beside the evidence.
  const claimed: Completed = { kind: "completed", summary: "merge verified", outcome: "VERIFIED", verification: { command: "false", status: "PASSED", hasExecutedTests: false } };
  const outcome = await f.ops.integrate(unit("u1"), claimed, { integrated: [], mergedChecks: forged } as any);
  assert.ok(outcome.kind === "integrated");
  assert.equal(outcome.receipt.verification, "NOT_RUN", "an unexecuted claim is not a check");
  assert.equal("mergedChecks" in outcome.receipt, false);
  assert.equal("integrated" in outcome.receipt, false);
});

test("an empty check set is NOT_RUN, as before", async () => {
  const f = fixture();
  write(f.prepare("u1"), "u1.txt", "one\n");
  const outcome = await f.integrate("u1");
  assert.ok(outcome.kind === "integrated");
  assert.equal(outcome.receipt.verification, "NOT_RUN");
  assert.equal(outcome.receipt.mergedChecks, undefined);
});

test("the crash-after-merge path runs the full set and does not record a unit whose merge breaks an earlier check", async () => {
  const f = fixture();
  const b = f.prepare("B");
  const a = f.prepare("A");
  const c = f.prepare("C");
  writeB(b);
  writeA(a);
  write(c, "c.txt", "c\n");
  assert.equal((await f.integrate("B", "node test/b.test.js")).kind, "integrated");
  // Commit and merge by hand, as a crash between the merge and the persisted transition leaves it.
  const mergeByHand = (worktree: string, branch: string) => {
    git(worktree, ["add", "-A"]);
    git(worktree, ["-c", "user.name=N", "-c", "user.email=n@l", "commit", "-qm", "work"]);
    git(f.integrationWorktree, ["-c", "user.name=N", "-c", "user.email=n@l", "merge", "--no-ff", "-m", "integrate", branch]);
  };

  mergeByHand(c, f.state.units.C.branch);
  const ok = await f.integrate("C", "test -f c.txt");
  assert.ok(ok.kind === "nothing");
  assert.equal(ok.receipt.verification, "PASSED_POSTHOC");
  assert.deepEqual(ok.receipt.mergedChecks?.map((check) => check.owners), [["C"], ["B"]]);

  mergeByHand(a, f.state.units.A.branch);
  const tip = f.ops.currentTip();
  const broken = await f.integrate("A", "node test/a.test.js");
  assert.ok(broken.kind === "failed");
  assert.match(broken.reason, /integration verification failed on the merged tree: node test\/b\.test\.js/);
  assert.match(broken.reason, /the merge is already in place/);
  assert.equal(broken.checks?.at(-1)?.status, "FAILED");
  assert.equal(f.state.units.A.integratedCommit, undefined);
  assert.equal(f.ops.currentTip(), tip, "the post-hoc path does not rewrite a merge it did not make");
});

test("the crash-after-merge path also refuses a merge that rewrote an integrated unit's test", async () => {
  const f = fixture();
  writeB(f.prepare("B"));
  assert.equal((await f.integrate("B", "node test/b.test.js")).kind, "integrated");
  const d = f.prepare("D");
  write(d, "test/b.test.js", 'console.log("b ok");\n');
  git(d, ["add", "-A"]);
  git(d, ["-c", "user.name=N", "-c", "user.email=n@l", "commit", "-qm", "work"]);
  git(f.integrationWorktree, ["-c", "user.name=N", "-c", "user.email=n@l", "merge", "--no-ff", "-m", "integrate", f.state.units.D.branch]);
  const refused = await f.integrate("D", "true");
  assert.ok(refused.kind === "failed");
  assert.match(refused.reason, /^D changes verification files integrated by B: test\/b\.test\.js \(the merge is already in place/);
  assert.equal(refused.checks, undefined);
  assert.equal(f.state.units.D.integratedCommit, undefined);
});

test("hostile: a check that plants a repository in the integration worktree does not get its Git configuration run", async () => {
  const f = fixture();
  const fired = path.join(f.outside, "fsmonitor-fired");
  // Replace the worktree's .git pointer by a repository whose fsmonitor is a command, then fail.
  const plant = `rm -f .git && git init -q . && git config core.fsmonitor "touch '${fired}'; false" && exit 1`;
  write(f.prepare("u1"), "u1.txt", "one\n");
  const tip = f.ops.currentTip();
  const failed = await f.integrate("u1", plant);
  assert.ok(failed.kind === "failed");
  assert.equal(fs.existsSync(fired), false, "host-side Git must not read the planted repository");
  assert.equal(git(f.root, ["rev-parse", `refs/heads/${f.state.integrationBranch}`]), tip, "the merge was undone in the real repository");
  assert.equal(git(f.root, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");

  // The worktree is no longer a checkout Nexus created: later integrations stop instead of trusting it.
  const next = await f.integrate("u1", "true");
  assert.ok(next.kind === "failed");
  assert.match(next.reason, /the integration worktree cannot be used: refusing to run Git/);
  assert.equal(fs.existsSync(fired), false);
});

test("hostile: a unit worktree whose .git was replaced is refused, and its Git configuration is not run", async () => {
  const f = fixture();
  const fired = path.join(f.outside, "fsmonitor-fired");
  const worktree = f.prepare("u1");
  write(worktree, "u1.txt", "one\n");
  shell(worktree, `rm -f .git && git init -q . && git config core.fsmonitor "touch '${fired}'; false"`);
  const tip = f.ops.currentTip();
  const refused = await f.integrate("u1", "true");
  assert.ok(refused.kind === "failed");
  assert.match(refused.reason, /unit u1's worktree cannot be integrated: refusing to run Git/);
  assert.equal(fs.existsSync(fired), false);
  assertUntouched(f, tip);
});

test("a configured sandbox that cannot confine the check fails the integration without running it on the host", async () => {
  const f = fixture({ sandbox: "no-such-engine" });
  const ran = path.join(f.outside, "ran");
  write(f.prepare("u1"), "u1.txt", "one\n");
  const tip = f.ops.currentTip();
  const refused = await f.integrate("u1", `touch '${ran}'`);
  assert.ok(refused.kind === "failed");
  assert.match(refused.reason, /could not run on the merged tree: .*\n.*sandbox \(no-such-engine\) cannot confine a command on this host, so the check was not run/);
  assert.deepEqual(refused.checks?.map((check) => check.status), ["ENVIRONMENT"]);
  assert.equal(fs.existsSync(ran), false, "never run outside the sandbox the session asked for");
  assertUntouched(f, tip);
});

test("with the session's sandbox, a merged-tree check is confined: no write outside the worktree, no sight of a sibling unit", {
  skip: isSandboxAvailable("bwrap") ? false : "Bubblewrap cannot confine a command on this host (bwrap is missing, or user namespaces are not permitted)",
}, async () => {
  // Not under /tmp, /dev/shm or HOME: the box hides those anyway, which would make this pass whatever the profile is.
  const f = fixture({ sandbox: "bwrap", base: "/var/tmp" });
  try {
    const escaped = path.join(f.root, "escaped");
    const sibling = f.prepare("u2");
    write(sibling, "secret.txt", "sibling\n");
    write(f.prepare("u1"), "u1.txt", "one\n");
    // The repository itself stays readable (as for the session's own commands); the sibling unit's worktree does not.
    // Leave the worktree clean: a passing verifier that dirties it is refused (hostile tree-mutation cases cover that).
    const command = `touch '${escaped}' 2>/dev/null; test -f '${path.join(f.root, "file.txt")}' && test ! -e '${path.join(sibling, "secret.txt")}' && test -f u1.txt`;
    const outcome = await f.integrate("u1", command);
    assert.ok(outcome.kind === "integrated", outcome.kind === "failed" ? outcome.reason : "");
    assert.deepEqual(outcome.receipt.mergedChecks, [{ command, owners: ["u1"], status: "PASSED", sandbox: "bwrap" }]);
    assert.equal(fs.existsSync(escaped), false, "the host outside the integration worktree is read-only");
    assert.equal(fs.existsSync(path.join(sibling, "secret.txt")), true);
    assert.equal(git(f.integrationWorktree, ["status", "--porcelain"]), "", "the worktree stays clean after a confined check");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
