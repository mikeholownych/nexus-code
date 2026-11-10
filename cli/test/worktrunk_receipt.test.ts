/** Receipt gate for named-worktree merges: a recorded passing verification for the exact state, or an explicit recorded waiver. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand } from "../src/worktrunk/command.js";
import { recordVerification, captureVerificationState, recordVerificationIfEligible } from "../src/worktrunk/verification.js";
import { readRegistry, writeRegistry } from "../src/worktrunk/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtreceipt-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = (cwd: string, args: string[]) => runWorktreeCommand(args, { cwd, home, readOnly: false });
  const made = wt(repo, ["switch", "-c", "feat/r", "--no-copy"]);
  assert.equal(made.success, true, made.output);
  const dir = path.join(repo, ".nexus", "worktrees", "feat-r");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-q", "-m", "add b");
  return { root, repo, home, dir, wt, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("merge without a recorded verification or a waiver is refused and changes nothing", () => {
  const f = fixture();
  try {
    const before = git(f.repo, "rev-parse", "HEAD");
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, false);
    assert.match(r.output, /verification|receipt/i);
    assert.match(r.output, /--no-verify-receipt/);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), before);
    assert.ok(fs.existsSync(f.dir));
    assert.equal(git(f.repo, "for-each-ref", "refs/nexus-backup"), "");
  } finally { f.cleanup(); }
});

test("a recorded passing verification for the exact head lets the merge through", () => {
  const f = fixture();
  try {
    assert.equal(recordVerification(f.dir, "npm test"), true);
    const reg = readRegistry(path.join(f.repo, ".git")).registry;
    assert.equal(reg.verifications?.[0].branch, "feat/r");
    assert.equal(reg.verifications?.[0].head, git(f.dir, "rev-parse", "HEAD"));
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.ok(fs.existsSync(path.join(f.repo, "b.txt")));
  } finally { f.cleanup(); }
});

test("a verification does not cover a later commit or later uncommitted edits", () => {
  const f = fixture();
  try {
    recordVerification(f.dir, "npm test");
    fs.writeFileSync(path.join(f.dir, "c.txt"), "c\n");
    git(f.dir, "add", "c.txt");
    git(f.dir, "commit", "-q", "-m", "add c");
    assert.equal(f.wt(f.dir, ["merge"]).success, false);
    recordVerification(f.dir, "npm test");
    fs.writeFileSync(path.join(f.dir, "d.txt"), "unverified\n");
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, false);
    assert.equal(fs.existsSync(path.join(f.repo, "c.txt")), false);
  } finally { f.cleanup(); }
});

test("a verification recorded over uncommitted work covers exactly that work", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, "d.txt"), "verified while dirty\n");
    recordVerification(f.dir, "npm test");
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, true, r.output);
    assert.ok(fs.existsSync(path.join(f.repo, "d.txt")));
  } finally { f.cleanup(); }
});

test("recording is a no-op for the main checkout and for a directory outside a repository", () => {
  const f = fixture();
  try {
    assert.equal(recordVerification(f.repo, "npm test"), false);
    assert.equal(recordVerification(f.root, "npm test"), false);
    assert.equal(readRegistry(path.join(f.repo, ".git")).registry.verifications?.length ?? 0, 0);
  } finally { f.cleanup(); }
});

test("--no-verify-receipt needs a reason, records it, and redacts secrets in it", () => {
  const f = fixture();
  try {
    const noReason = f.wt(f.dir, ["merge", "--no-verify-receipt"]);
    assert.equal(noReason.success, false);
    assert.match(noReason.output, /--reason/);
    assert.ok(fs.existsSync(f.dir));
    const r = f.wt(f.dir, ["merge", "--no-verify-receipt", "--reason", "docs only token=abcdef1234567890"]);
    assert.equal(r.success, true, r.output);
    const reg = readRegistry(path.join(f.repo, ".git")).registry;
    assert.equal(reg.waivers?.length, 1);
    assert.equal(reg.waivers?.[0].branch, "feat/r");
    assert.match(reg.waivers?.[0].reason ?? "", /docs only/);
    assert.doesNotMatch(reg.waivers?.[0].reason ?? "", /abcdef1234567890/);
    assert.match(reg.waivers?.[0].head ?? "", /^[0-9a-f]{40}/);
  } finally { f.cleanup(); }
});

test("the registry rejects malformed verification and waiver records", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    const base = { version: 1 as const, worktrees: [] };
    fs.writeFileSync(path.join(common, "nexus", "worktrees.json"), JSON.stringify({ ...base, verifications: [{ branch: "x" }] }));
    assert.match(readRegistry(common).warning ?? "", /invalid/i);
    fs.writeFileSync(path.join(common, "nexus", "worktrees.json"), JSON.stringify({ ...base, waivers: [{ branch: "x", head: "h", reason: "r", recordedAt: "t", extra: 1 }] }));
    assert.match(readRegistry(common).warning ?? "", /invalid/i);
    assert.doesNotThrow(() => writeRegistry(common, { ...base, verifications: [], waivers: [] }));
  } finally { f.cleanup(); }
});

test("staged ignored file with git add -f is preserved in working state and invalidates earlier receipt", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, ".gitignore"), "ignored.txt\n");
    git(f.dir, "add", ".gitignore");
    git(f.dir, "commit", "-q", "-m", "ignore file");
    // Verify current clean state
    recordVerification(f.dir, "npm test");
    // Now stage an ignored file using git add -f
    fs.writeFileSync(path.join(f.dir, "ignored.txt"), "secret edit\n");
    git(f.dir, "add", "-f", "ignored.txt");
    // The earlier verification receipt must no longer cover this state
    const r = f.wt(f.dir, ["merge"]);
    assert.equal(r.success, false, "merge should refuse because staged ignored file changed working state");
    assert.match(r.output, /no recorded passing verification/);
  } finally { f.cleanup(); }
});

test("waiver is not recorded in the registry when merge fails", () => {
  const f = fixture();
  try {
    // Commit a divergent change on main (target) so fast-forward fails under --no-rebase
    fs.writeFileSync(path.join(f.repo, "diverged.txt"), "diverged\n");
    git(f.repo, "add", "diverged.txt");
    git(f.repo, "commit", "-m", "divergent commit on main");

    const r = f.wt(f.dir, ["merge", "--no-rebase", "--no-verify-receipt", "--reason", "waiver on failing merge"]);
    assert.equal(r.success, false);
    assert.match(r.output, /could not fast-forward/);
    const reg = readRegistry(path.join(f.repo, ".git")).registry;
    assert.equal(reg.waivers?.length ?? 0, 0, "waiver should not be recorded if merge failed");
  } finally { f.cleanup(); }
});

test("registry evicts oldest records when history approaches byte budget", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    const verifications = [];
    const waivers = [];
    const payload = "v".repeat(350);
    for (let i = 0; i < 100; i++) {
      const time = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
      verifications.push({
        branch: `feat-${i}`,
        head: "a".repeat(40),
        tree: "b".repeat(40),
        verifier: `${i}-${payload}`,
        recordedAt: time,
      });
    }
    for (let i = 0; i < 50; i++) {
      const time = new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString();
      waivers.push({
        branch: `waiver-${i}`,
        head: "a".repeat(40),
        reason: `${i}-${payload}`,
        recordedAt: time,
      });
    }
    const raw = JSON.stringify({ version: 1, worktrees: [], verifications, waivers }, null, 1);
    assert.ok(Buffer.byteLength(raw) > 64 * 1024, `raw registry size ${Buffer.byteLength(raw)} should exceed 64 KiB`);

    writeRegistry(common, { version: 1, worktrees: [], verifications, waivers });

    const file = path.join(common, "nexus", "worktrees.json");
    const stat = fs.statSync(file);
    assert.ok(stat.size <= 64 * 1024, `registry file size ${stat.size} exceeds 64 KiB`);

    const read = readRegistry(common).registry;
    assert.equal(read.verifications?.some((v) => v.branch === "feat-0"), false, "oldest verification should have been evicted");
    assert.equal(read.verifications?.some((v) => v.branch === "feat-99"), true, "newest verification should be retained");
    assert.ok((read.verifications?.length ?? 0) < 100, "some verifications should have been evicted");
  } finally { f.cleanup(); }
});

const eligible = { activeWorktree: false, dryRun: false, verifierSucceeded: true, hasExecuted: true, deliverableBound: true, verified: true, verifier: "npm test" };

test("the agent's recording step writes a receipt only for a passing, deliverable-bound, configured-or-independent run in a linked worktree", () => {
  const f = fixture();
  try {
    const made = runWorktreeCommand(["switch", "-c", "feat/hook", "--no-copy"], { cwd: f.repo, home: f.home, readOnly: false });
    assert.equal(made.success, true, made.output);
    const dir = path.join(f.repo, ".nexus", "worktrees", "feat-hook");
    const common = path.join(f.repo, ".git");
    const count = () => (readRegistry(common).registry.verifications ?? []).length;
    const before = captureVerificationState(dir);
    assert.ok(before, "a linked worktree has a state to capture");

    for (const [name, override] of Object.entries({
      activeWorktree: { activeWorktree: true }, dryRun: { dryRun: true }, failed: { verifierSucceeded: false },
      noTests: { hasExecuted: false }, notDeliverableBound: { deliverableBound: false }, notConfiguredOrIndependent: { verified: false },
    })) {
      assert.equal(recordVerificationIfEligible(dir, { ...eligible, ...override, before }), false, name);
      assert.equal(count(), 0, `${name}: nothing recorded`);
    }
    assert.equal(recordVerificationIfEligible(f.repo, { ...eligible, before: captureVerificationState(f.repo) }), false, "the main checkout is never recorded");
    assert.equal(count(), 0);

    assert.equal(recordVerificationIfEligible(dir, { ...eligible, before }), true);
    const [record] = readRegistry(common).registry.verifications ?? [];
    assert.equal(record.branch, "feat/hook");
    assert.equal(record.head, git(dir, "rev-parse", "HEAD"));
    assert.equal(record.verifier, "npm test");
  } finally { f.cleanup(); }
});

test("an operator edit made while the verifier ran is not covered by the receipt", () => {
  const f = fixture();
  try {
    runWorktreeCommand(["switch", "-c", "feat/race", "--no-copy"], { cwd: f.repo, home: f.home, readOnly: false });
    const dir = path.join(f.repo, ".nexus", "worktrees", "feat-race");
    const common = path.join(f.repo, ".git");
    fs.writeFileSync(path.join(dir, "tested.txt"), "what the verifier saw\n");
    const before = captureVerificationState(dir); // taken before the verifier starts
    fs.writeFileSync(path.join(dir, "tested.txt"), "edited by the operator while the verifier ran\n");
    assert.equal(recordVerificationIfEligible(dir, { ...eligible, before }), false, "the state changed: no receipt");
    assert.equal((readRegistry(common).registry.verifications ?? []).length, 0);
    // an unchanged state still records
    const again = captureVerificationState(dir);
    assert.equal(recordVerificationIfEligible(dir, { ...eligible, before: again }), true);
  } finally { f.cleanup(); }
});

test("an edit saved after the receipt check but before the commit is not merged on the strength of that receipt", async () => {
  const f = fixture();
  try {
    const { mergeSeams } = await import("../src/worktrunk/merge.js") as any;
    fs.writeFileSync(path.join(f.dir, "c.txt"), "verified content\n"); // dirty source
    assert.equal(recordVerification(f.dir, "npm test"), true);
    const mainBefore = git(f.repo, "rev-parse", "refs/heads/main");
    mergeSeams.preMerge = () => { fs.writeFileSync(path.join(f.dir, "c.txt"), "an unverified edit saved by an editor\n"); };
    let r;
    try { r = f.wt(f.dir, ["merge"]); } finally { delete mergeSeams.preMerge; }
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /changed after|verification/i);
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), mainBefore, "the target is untouched");
    assert.ok(fs.existsSync(f.dir), "the worktree and the edit are kept");
    assert.equal(fs.readFileSync(path.join(f.dir, "c.txt"), "utf8"), "an unverified edit saved by an editor\n");
    assert.equal(git(f.dir, "diff", "--cached", "--name-only"), "", "nothing is left staged");
  } finally { f.cleanup(); }
});

test("a worktree with a branch name longer than 400 chars does not corrupt the registry", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    const longBranch = "feat/" + Array.from({ length: 45 }, (_, i) => `subpath${i}`).join("/") + "/branch";
    assert.ok(longBranch.length > 400, `branch length ${longBranch.length} should be > 400`);
    git(f.dir, "checkout", "-b", longBranch);
    assert.equal(recordVerification(f.dir, "npm test"), true);
    const reg = readRegistry(common);
    assert.equal(reg.warning, undefined);
    assert.equal(reg.registry.verifications?.length, 1);
    assert.equal(reg.registry.verifications?.[0].branch, longBranch);
  } finally { f.cleanup(); }
});

test("a branch name exceeding MAX_BRANCH_LENGTH is rejected before writing to registry", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    // 120 path components of length 9 = ~1080 chars (> 1024)
    const tooLongBranch = "feat/" + Array.from({ length: 120 }, (_, i) => `subpath${i}`).join("/") + "/branch";
    assert.ok(tooLongBranch.length > 1024, `branch length ${tooLongBranch.length} should be > 1024`);
    git(f.dir, "checkout", "-b", tooLongBranch);
    assert.equal(recordVerification(f.dir, "npm test"), false, "recordVerification must reject branch > MAX_BRANCH_LENGTH");
    const reg = readRegistry(common);
    assert.equal(reg.warning, undefined);
    assert.equal(reg.registry.verifications, undefined);
  } finally { f.cleanup(); }
});

test("no receipt is captured or recorded while a submodule (nested too) holds uncommitted content", () => {
  const f = fixture();
  try {
    const mk = (name: string) => {
      const d = path.join(f.root, name);
      fs.mkdirSync(d);
      git(d, "init", "-q", "-b", "main");
      git(d, "config", "user.email", "t@example.com");
      git(d, "config", "user.name", "T");
      git(d, "config", "commit.gpgsign", "false");
      return d;
    };
    const inner = mk("inner");
    fs.writeFileSync(path.join(inner, "i.txt"), "i\n");
    git(inner, "add", "."); git(inner, "commit", "-q", "-m", "inner");
    const outer = mk("outer");
    fs.writeFileSync(path.join(outer, "o.txt"), "o\n");
    git(outer, "add", "."); git(outer, "commit", "-q", "-m", "outer");
    git(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "inner");
    git(outer, "commit", "-q", "-m", "add inner");
    git(f.dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", outer, "sub");
    git(f.dir, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "-q");
    git(f.dir, "commit", "-q", "-m", "add sub");

    assert.ok(captureVerificationState(f.dir), "a clean submodule tree can be captured");
    fs.writeFileSync(path.join(f.dir, "sub", "inner", "i.txt"), "uncommitted fix inside a nested submodule\n");
    assert.equal(captureVerificationState(f.dir), undefined, "dirty nested submodule: no state to record");
    assert.equal(recordVerification(f.dir, "npm test"), false, "dirty nested submodule: no receipt");
    git(path.join(f.dir, "sub", "inner"), "checkout", "--", "i.txt");
    fs.writeFileSync(path.join(f.dir, "sub", "untracked.txt"), "x\n");
    assert.equal(recordVerification(f.dir, "npm test"), false, "an untracked file in a submodule is untested content too");
  } finally { f.cleanup(); }
});
