/**
 * Named worktrees regression and review test suite:
 * branch-qualified refs, conditional branch deletion, merge commits in patch-id check,
 * originating checkout for `nexus run --worktree`, single-entry prune, operator config reader,
 * machine output unredacted, case-insensitive subcommands, legacy predicates,
 * commander option merging (--read-only and --workspace), and serialization of switch and removal.
 * Every test runs against a real temporary repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand, isReadOnlyWorktreeArgs } from "../src/worktrunk/command.js";
import { integratedReason } from "../src/worktrunk/core.js";
import { openRepo } from "../src/worktrunk/repo.js";
import { readWorktreeSettings } from "../src/worktrunk/config.js";
import { WorktreeManager } from "../src/worktree.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lockSeams, lockSettings, withWorktreeLock } from "../src/worktrunk/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd: string, name: string, body: string, message: string): string {
  fs.writeFileSync(path.join(cwd, name), body);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

interface Fixture { root: string; repo: string; home: string; cleanup: () => void }

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtreview-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  commitFile(repo, "a.txt", "one\n", "init");
  return { root, repo, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function wt(f: Fixture, cwd: string, args: string[], extra: { readOnly?: boolean } = {}) {
  return runWorktreeCommand(args, { cwd, home: f.home, readOnly: extra.readOnly ?? false });
}

const named = (f: Fixture, branch: string) => path.join(f.repo, ".nexus", "worktrees", branch.replace(/\//g, "-"));

test("a tag named like the default branch never stands in for the branch", () => {
  const f = fixture();
  try {
    const mainSha = git(f.repo, "rev-parse", "HEAD");
    git(f.repo, "checkout", "-q", "-b", "topic");
    const topicSha = commitFile(f.repo, "b.txt", "two\n", "topic work");
    git(f.repo, "tag", "main", "topic"); // refs/tags/main != refs/heads/main
    git(f.repo, "checkout", "-q", "main");
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), mainSha);
    assert.equal(git(f.repo, "rev-parse", "refs/tags/main"), topicSha);

    // switch -c starts from the branch, not the tag
    const made = wt(f, f.repo, ["switch", "-c", "feat"]);
    assert.equal(made.success, true, made.output);
    assert.equal(git(named(f, "feat"), "rev-parse", "HEAD"), mainSha, "new worktree must start at refs/heads/main");

    // list compares against the branch: topic is ahead of main, so it is not integrated
    assert.equal(wt(f, f.repo, ["switch", "topic"]).success, true);
    const listed = JSON.parse(wt(f, f.repo, ["list", "--json"]).output);
    const topic = listed.items.find((i: any) => i.path === named(f, "topic"));
    assert.equal(topic.integrated, null, "topic must not count as integrated through the tag");
    assert.equal(topic.ahead, 1);

    // remove refuses the unmerged branch instead of deleting it through the tag
    const refused = wt(f, f.repo, ["remove", "topic"]);
    assert.equal(refused.success, false, refused.output);
    assert.match(refused.output, /not merged/);
    assert.equal(git(f.repo, "rev-parse", "refs/heads/topic"), topicSha);
  } finally { f.cleanup(); }
});

test("a commit that lands on a branch worktree between the check and the removal stops the removal", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    assert.equal(typeof core.removeSeams, "object", "core.ts must expose the removal test seam");
    assert.equal(wt(f, f.repo, ["switch", "-c", "racy"]).success, true);
    const dir = named(f, "racy");
    let newSha = "";
    core.removeSeams.beforeRemove = () => {
      // another session's /commit lands between the checks and the removal
      newSha = commitFile(dir, "late.txt", "late\n", "late commit");
    };
    let result;
    try {
      result = wt(f, f.repo, ["remove", "racy"]);
    } finally {
      delete core.removeSeams.beforeRemove;
    }
    assert.ok(newSha, "the seam must have run");
    assert.equal(result.success, false, result.output);
    assert.equal(fs.existsSync(dir), true, "nothing is removed");
    assert.equal(git(f.repo, "rev-parse", "--verify", "--quiet", "refs/heads/racy"), newSha);
  } finally { f.cleanup(); }
});

test("a branch that moved after its worktree was removed is kept, not force-deleted", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    assert.equal(wt(f, f.repo, ["switch", "-c", "racy2"]).success, true);
    let newSha = "";
    core.removeSeams.beforeBranchDeletion = () => {
      // the branch is advanced by plain ref plumbing after the worktree is gone
      newSha = git(f.repo, "commit-tree", "-p", "refs/heads/racy2", "-m", "late", "refs/heads/racy2^{tree}");
      git(f.repo, "update-ref", "refs/heads/racy2", newSha);
    };
    let result;
    try { result = wt(f, f.repo, ["remove", "racy2"]); } finally { delete core.removeSeams.beforeBranchDeletion; }
    assert.equal(result.success, true, result.output);
    assert.equal(git(f.repo, "rev-parse", "--verify", "--quiet", "refs/heads/racy2"), newSha, "the moved branch must survive");
    assert.match(result.output, /kept|moved/i);
  } finally { f.cleanup(); }
});

test("patch-id integration is rejected while unmatched merge commits remain", () => {
  const f = fixture();
  try {
    git(f.repo, "checkout", "-q", "-b", "topic");
    const aSha = commitFile(f.repo, "a-topic.txt", "A\n", "A");
    git(f.repo, "checkout", "-q", "main");
    commitFile(f.repo, "x.txt", "X\n", "X");
    git(f.repo, "checkout", "-q", "topic");
    git(f.repo, "merge", "-q", "--no-ff", "--no-edit", "main"); // merge main into topic
    // an "evil" merge: a resolution edit that exists in no ordinary commit
    fs.writeFileSync(path.join(f.repo, "resolution.txt"), "only in the merge\n");
    git(f.repo, "add", "resolution.txt");
    git(f.repo, "commit", "-q", "--amend", "--no-edit");
    const topicSha = git(f.repo, "rev-parse", "HEAD");
    git(f.repo, "checkout", "-q", "main");
    git(f.repo, "cherry-pick", aSha); // the ordinary commit is upstream now
    const mainSha = git(f.repo, "rev-parse", "HEAD");
    assert.equal(git(f.repo, "cherry", "main", "topic").split("\n").filter(Boolean).every((l) => l.startsWith("-")), true, "git cherry hides the merge");

    const repo = openRepo(f.repo);
    assert.equal(integratedReason(repo, topicSha, mainSha), null, "a merge with unique edits is not integrated");

    assert.equal(wt(f, f.repo, ["switch", "topic"]).success, true);
    const refused = wt(f, f.repo, ["remove", "topic"]);
    assert.equal(refused.success, false, refused.output);
    assert.equal(git(f.repo, "rev-parse", "refs/heads/topic"), topicSha);
  } finally { f.cleanup(); }
});

test("WorktreeManager in a linked checkout starts from and merges into that checkout", () => {
  const f = fixture();
  try {
    const mainSha = git(f.repo, "rev-parse", "HEAD");
    assert.equal(wt(f, f.repo, ["switch", "-c", "feature"]).success, true);
    const dir = named(f, "feature");
    const featureSha = commitFile(dir, "f.txt", "feature\n", "feature work");
    assert.notEqual(featureSha, mainSha);

    const mgr = new WorktreeManager(dir);
    // storage still anchors on the main checkout
    assert.equal(mgr.getWorktreesBaseDir(), path.join(f.repo, ".nexus", "worktrees"));
    const task = mgr.createWorktree("t1");
    assert.equal(git(task.worktreePath, "rev-parse", "HEAD"), featureSha, "task worktree must start from the originating checkout's HEAD");
    assert.equal(mgr.hasChanges("t1"), false);

    fs.writeFileSync(path.join(task.worktreePath, "task.txt"), "done\n");
    assert.equal(mgr.hasChanges("t1"), true);
    const merged = mgr.mergeWorktree("t1", "task result");
    assert.equal(merged.success, true, merged.error);
    assert.ok(fs.existsSync(path.join(dir, "task.txt")), "merged into the feature checkout");
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), mainSha, "main must be untouched");
    assert.equal(fs.existsSync(path.join(f.repo, "task.txt")), false);
    assert.notEqual(git(dir, "rev-parse", "refs/heads/feature"), featureSha, "feature received the merge");
  } finally { f.cleanup(); }
});

test("removing one prunable entry leaves other stale worktrees registered", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "gone-one"]).success, true);
    assert.equal(wt(f, f.repo, ["switch", "-c", "gone-two"]).success, true);
    fs.rmSync(named(f, "gone-one"), { recursive: true, force: true });
    fs.rmSync(named(f, "gone-two"), { recursive: true, force: true });
    const removed = wt(f, f.repo, ["remove", "gone-one"]);
    assert.equal(removed.success, true, removed.output);
    const porcelain = git(f.repo, "worktree", "list", "--porcelain");
    assert.doesNotMatch(porcelain, /gone-one/);
    assert.match(porcelain, /gone-two/, "the other stale worktree must still be registered with Git");
    const registry = JSON.parse(fs.readFileSync(path.join(f.repo, ".git", "nexus", "worktrees.json"), "utf8"));
    assert.deepEqual(registry.worktrees.map((w: any) => w.branch), ["gone-two"]);
    assert.equal(git(f.repo, "branch", "--list", "gone-one"), "");
  } finally { f.cleanup(); }
});

test("worktree settings come through the operator config reader", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.home, ".config", "nexus"), { recursive: true });
    const file = path.join(f.home, ".config", "nexus", "config.json");
    // the operator reader rejects unknown top-level fields; the worktree reader must not accept the same file
    fs.writeFileSync(file, JSON.stringify({ version: 1, bogus: true, worktree: { layout: "sibling" } }));
    assert.throws(() => readWorktreeSettings(f.home), /Unsupported Nexus config.json field 'bogus'/);
    fs.writeFileSync(file, JSON.stringify({ version: 1, worktree: { layout: "sibling" } }));
    assert.equal(readWorktreeSettings(f.home).layout, "sibling");
    fs.writeFileSync(file, JSON.stringify({ version: 1, worktree: { layout: "elsewhere" } }));
    assert.throws(() => readWorktreeSettings(f.home), /worktree\.layout/);
    // one operator home for every reader
    const core = await import("../src/worktrunk/core.js") as any;
    const config = await import("../src/config.js") as any;
    assert.equal(typeof config.operatorConfigHome, "function", "config.ts must export the operator home");
    assert.equal(core.homeDir(), config.operatorConfigHome());
  } finally { f.cleanup(); }
});

test("human output is redacted, machine output (`path`, `list --json`) is not", () => {
  const f = fixture();
  try {
    const branch = "feat/ghp_abcdefghijklmnopqrstuvwxyz0123";
    const made = wt(f, f.repo, ["switch", "-c", branch]);
    assert.equal(made.success, true, made.output);
    assert.match(made.output, /REDACTED/);
    const dir = named(f, branch);
    assert.equal(wt(f, f.repo, ["path", branch]).output, dir);
    const json = JSON.parse(wt(f, f.repo, ["list", "--json"]).output);
    assert.deepEqual(json.items.map((i: any) => i.branch).sort(), [branch, "main"]);
    assert.equal(json.items.find((i: any) => i.branch === branch).path, dir);
    const human = wt(f, f.repo, ["list"]).output;
    assert.match(human, /REDACTED/);
    assert.doesNotMatch(human, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  } finally { f.cleanup(); }
});

test("subcommands are matched case-insensitively", () => {
  const f = fixture();
  try {
    const upper = wt(f, f.repo, ["List"]);
    assert.equal(upper.success, true, upper.output);
    assert.equal(wt(f, f.repo, ["LS", "--json"]).success, true);
    assert.equal(isReadOnlyWorktreeArgs("LIST"), true);
    assert.equal(isReadOnlyWorktreeArgs("Remove x"), false);
    assert.equal(wt(f, f.repo, ["Remove", "nothing"], { readOnly: true }).success, false);
  } finally { f.cleanup(); }
});

test("one legacy predicate; `status` is never the named list", async () => {
  const command = await import("../src/worktrunk/command.js") as any;
  assert.equal(typeof command.isLegacyWorktreeArgs, "function", "command.ts must export the legacy predicate");
  for (const legacy of ["", "  ", "status", "STATUS", "merge", "discard", "Discard now"]) assert.equal(command.isLegacyWorktreeArgs(legacy), true, legacy);
  for (const named of ["list", "List --json", "switch -c x", "remove x", "path x", "bogus"]) assert.equal(command.isLegacyWorktreeArgs(named), false, named);
  assert.equal(isReadOnlyWorktreeArgs("status"), true);
  assert.equal(isReadOnlyWorktreeArgs("merge"), false);
  const f = fixture();
  try {
    const status = wt(f, f.repo, ["status"]);
    assert.equal(status.success, false, "the CLI must not list named worktrees for `status` while /worktree status shows the speculative one");
    assert.match(status.output, /unknown subcommand/);
  } finally { f.cleanup(); }
});

test("root-level --read-only and --workspace options are merged for the worktree command", async () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "feat"]).success, true);
    const dir = named(f, "feat");
    assert.equal(fs.existsSync(dir), true);

    const cliDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const tsx = path.join(cliDir, "node_modules", ".bin", "tsx");
    const indexTs = path.join(cliDir, "src", "index.ts");

    const env = { ...process.env, HOME: f.home, XDG_CONFIG_HOME: path.join(f.home, ".config") };
    // Run nexus with root-level --read-only and --workspace flags:
    // nexus --read-only --workspace <repo> worktree remove feat
    const res = execFileSync("node", [tsx, indexTs, "--read-only", "--workspace", f.repo, "worktree", "remove", "feat"], {
      cwd: f.root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail(`expected command to fail in read-only mode, got output: ${res}`);
  } catch (err: any) {
    if (err.name === "AssertionError") throw err;
    const combined = `${err.stdout ?? ""} ${err.stderr ?? ""}`;
    assert.match(combined, /read-only mode.*refused/i);
    assert.equal(fs.existsSync(named(f, "feat")), true, "worktree must not be removed in read-only mode");
  } finally {
    f.cleanup();
  }
});

test("removal re-reads which worktrees hold the branch after removing its own; a branch another worktree now holds is kept", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    assert.equal(typeof core.removeSeams, "object");

    assert.equal(wt(f, f.repo, ["switch", "-c", "target"]).success, true);
    const targetDir = named(f, "target");
    assert.equal(fs.existsSync(targetDir), true);

    let switched = false;
    core.removeSeams.beforeBranchDeletion = () => {
      const otherDir = path.join(f.repo, ".nexus", "worktrees", "target-second");
      git(f.repo, "worktree", "add", "--end-of-options", otherDir, "target");
      switched = true;
    };

    let result;
    try {
      result = wt(f, f.repo, ["remove", "target"]);
    } finally {
      delete core.removeSeams.beforeBranchDeletion;
    }

    assert.equal(switched, true, "seam must have run");
    assert.equal(fs.existsSync(targetDir), false, "the targeted worktree directory is removed");
    assert.equal(git(f.repo, "rev-parse", "--verify", "--quiet", "refs/heads/target").length > 0, true, "branch must be kept while checked out by another worktree");
    assert.match(result.output, /Removed worktree/);
    assert.doesNotMatch(result.output, /deleted its branch/);
  } finally {
    f.cleanup();
  }
});


test("a detached worktree whose directory was deleted is removable by its absolute path", () => {
  const f = fixture();
  try {
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-gone");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.match(git(f.repo, "worktree", "list", "--porcelain"), /prunable/);
    const removed = wt(f, f.repo, ["remove", dir]);
    assert.equal(removed.success, true, removed.output);
    assert.doesNotMatch(git(f.repo, "worktree", "list", "--porcelain"), /detached-gone/);
  } finally { f.cleanup(); }
});

test("a worktree whose .git file holds a relative gitdir pointer (worktree.useRelativePaths) is removable", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "relative"]).success, true);
    const dir = named(f, "relative");
    const dotGit = path.join(dir, ".git");
    const admin = fs.readFileSync(dotGit, "utf8").trim().replace(/^gitdir: /, "");
    fs.writeFileSync(dotGit, `gitdir: ${path.relative(dir, admin)}\n`); // what Git writes with worktree.useRelativePaths=true
    git(dir, "status", "--porcelain"); // Git still understands it
    const removed = wt(f, f.repo, ["remove", "relative", "--delete-unmerged"]);
    assert.equal(removed.success, true, removed.output);
    assert.equal(fs.existsSync(dir), false);
  } finally { f.cleanup(); }
});

test("removal takes the lock before it deletes anything; a lock it cannot get leaves the worktree, branch and registry alone", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "locked-out"]).success, true);
    const dir = named(f, "locked-out");
    const common = path.join(f.repo, ".git");
    const lock = path.join(common, "nexus", "worktrees.lock");
    fs.writeFileSync(lock, String(process.pid)); // held by a live process (this one, from the lock's point of view another holder)
    const before = lockSettings.waitMs;
    lockSettings.waitMs = 200;
    let removed;
    try { removed = wt(f, f.repo, ["remove", "locked-out", "--delete-unmerged"]); } finally { lockSettings.waitMs = before; fs.rmSync(lock, { force: true }); }
    assert.equal(removed.success, false);
    assert.match(removed.output, /locked by another process/);
    assert.equal(fs.existsSync(dir), true, "the worktree must not be deleted when the lock cannot be taken");
    assert.ok(git(f.repo, "branch", "--list", "locked-out").includes("locked-out"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(common, "nexus", "worktrees.json"), "utf8")).worktrees.map((w: any) => w.branch), ["locked-out"]);
  } finally { f.cleanup(); }
});

test("a live holder's lock is not stolen after 30 s; a dead holder's is taken at once", async () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    fs.mkdirSync(path.join(common, "nexus"), { recursive: true });
    const lock = path.join(common, "nexus", "worktrees.lock");
    const old = new Date(Date.now() - 40_000);

    fs.writeFileSync(lock, String(process.pid));
    fs.utimesSync(lock, old, old);
    const before = lockSettings.waitMs;
    lockSettings.waitMs = 300;
    try {
      assert.throws(() => withWorktreeLock(common, () => "ran"), /locked by another process/);
      assert.equal(fs.existsSync(lock), true, "a live holder's lock must survive");

      const dead = spawn(process.execPath, ["-e", ""]);
      await new Promise((resolve) => dead.on("exit", resolve));
      fs.writeFileSync(lock, String(dead.pid));
      fs.utimesSync(lock, old, old);
      assert.equal(withWorktreeLock(common, () => "ran"), "ran", "a lock whose holder is gone is taken");
    } finally { lockSettings.waitMs = before; fs.rmSync(lock, { force: true }); }
  } finally { f.cleanup(); }
});

test("the worktree lock excludes another process while it runs a long action, then lets go", async () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const script = path.join(f.root, "holder.ts");
    fs.writeFileSync(script, `import { withWorktreeLock } from ${JSON.stringify(path.join(cliRoot, "src", "worktrunk", "registry.ts"))};
withWorktreeLock(process.argv[2], () => { console.log("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); });
`);
    const child = spawn(path.join(cliRoot, "node_modules", ".bin", "tsx"), [script, common], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("held")) resolve(); });
      child.on("exit", () => reject(new Error("the holder exited before taking the lock")));
    });
    const before = lockSettings.waitMs;
    lockSettings.waitMs = 200;
    try {
      assert.throws(() => withWorktreeLock(common, () => "ran"), /locked by another process/, "the other process holds the lock");
    } finally { lockSettings.waitMs = before; }
    await exited;
    assert.equal(withWorktreeLock(common, () => "ran"), "ran", "after the holder finished the lock is free");
  } finally { f.cleanup(); }
});

test("a waiter that judged a lock stale does not delete a live lock another process took in the meantime", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    fs.mkdirSync(path.join(common, "nexus"), { recursive: true });
    const lock = path.join(common, "nexus", "worktrees.lock");
    const gone = 2_147_483_000; // not a live pid
    fs.writeFileSync(lock, String(gone)); // stale: its holder is gone
    const before = lockSettings.waitMs;
    lockSettings.waitMs = 300;
    lockSeams.afterStaleCheck = () => {
      // another process takes the stale lock over first and is now a live holder
      fs.rmSync(lock, { force: true });
      fs.writeFileSync(lock, String(process.pid));
      lockSeams.afterStaleCheck = undefined;
    };
    try {
      assert.throws(() => withWorktreeLock(common, () => "ran"), /locked by another process/);
      assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid), "the live lock must not be deleted by the late waiter");
    } finally { lockSeams.afterStaleCheck = undefined; lockSettings.waitMs = before; fs.rmSync(lock, { force: true }); }
  } finally { f.cleanup(); }
});

test("a live holder's lock is kept for ten minutes and taken over after that", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    fs.mkdirSync(path.join(common, "nexus"), { recursive: true });
    const lock = path.join(common, "nexus", "worktrees.lock");
    const before = lockSettings.waitMs;
    lockSettings.waitMs = 300;
    try {
      for (const [ageMs, takenOver] of [[9 * 60_000, false], [11 * 60_000, true]] as const) {
        fs.writeFileSync(lock, String(process.ppid)); // a live process that is not this one
        const old = new Date(Date.now() - ageMs);
        fs.utimesSync(lock, old, old);
        if (takenOver) assert.equal(withWorktreeLock(common, () => "ran"), "ran", "older than ten minutes: taken over");
        else assert.throws(() => withWorktreeLock(common, () => "ran"), /locked by another process/, "younger than ten minutes: kept");
        fs.rmSync(lock, { force: true });
      }
    } finally { lockSettings.waitMs = before; fs.rmSync(lock, { force: true }); }
  } finally { f.cleanup(); }
});

test("a commit that lands on a detached worktree between the check and the removal is not lost", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-race");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    let landed = "";
    core.removeSeams.beforeRemove = () => { landed = commitFile(dir, "late.txt", "late\n", "late commit"); };
    let result;
    try { result = wt(f, f.repo, ["remove", dir]); } finally { delete core.removeSeams.beforeRemove; }
    assert.ok(landed, "the seam must have run");
    assert.equal(result.success, false, result.output);
    assert.match(result.output, /changed|moved/i);
    assert.equal(fs.existsSync(dir), true, "the worktree with the new commit must be kept");
    assert.equal(git(dir, "rev-parse", "HEAD"), landed);
  } finally { f.cleanup(); }
});

test("a corrupt registry is set aside, not overwritten, by the next switch", () => {
  const f = fixture();
  try {
    const file = path.join(f.repo, ".git", "nexus", "worktrees.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const damaged = '{"version":1,"previous":"keep-me","worktrees":[{"branch":"x"';
    fs.writeFileSync(file, damaged);
    const made = wt(f, f.repo, ["switch", "-c", "after-corruption"]);
    assert.equal(made.success, true, made.output);
    const kept = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("worktrees.json.corrupt"));
    assert.equal(kept.length, 1, "the damaged file is kept for inspection");
    assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), "utf8"), damaged);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).worktrees.map((w: any) => w.branch), ["after-corruption"]);
  } finally { f.cleanup(); }
});

test("a recorded previous branch that is not a valid name is refused by the `-` shortcut", () => {
  const f = fixture();
  try {
    const file = path.join(f.repo, ".git", "nexus", "worktrees.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, previous: "--upload-pack=touch /tmp/x", worktrees: [] }));
    const r = wt(f, f.repo, ["path", "-"]);
    assert.equal(r.success, false);
    assert.match(r.output, /invalid branch name/);
  } finally { f.cleanup(); }
});

test("names that Git reads as something other than a local branch are refused", async () => {
  const { validateBranchName } = await import("../src/worktrunk/paths.js");
  for (const bad of ["refs/heads/main", "refs/tags/v1", "refs/anything", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "HEAD"]) {
    assert.notEqual(validateBranchName(bad), undefined, bad);
  }
  for (const ok of ["refsfoo", "feature/refs/x", "fetch-head", "heads/x"]) assert.equal(validateBranchName(ok), undefined, ok);
});

test("a worktree whose .git points at a sibling worktree's admin directory is not removed", () => {
  const f = fixture();
  try {
    assert.equal(wt(f, f.repo, ["switch", "-c", "wt-a"]).success, true);
    assert.equal(wt(f, f.repo, ["switch", "-c", "wt-b"]).success, true);
    const a = named(f, "wt-a"), b = named(f, "wt-b");
    const adminB = fs.readFileSync(path.join(b, ".git"), "utf8").trim().replace(/^gitdir: /, "");
    fs.writeFileSync(path.join(a, ".git"), `gitdir: ${adminB}\n`); // still inside <common>/worktrees/, but not a's own
    const r = wt(f, f.repo, ["remove", "wt-a", "--delete-unmerged", "--force"]);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /does not belong|refusing/);
    assert.equal(fs.existsSync(a), true);
    assert.equal(fs.existsSync(b), true);
  } finally { f.cleanup(); }
});

test("a repository whose git directory is not <checkout>/.git is refused by `nexus worktree`, and WorktreeManager anchors on the checkout it runs in", () => {
  const f = fixture();
  try {
    const main = path.join(f.root, "sep");
    fs.mkdirSync(main);
    git(main, "init", "-q", "-b", "main", "--separate-git-dir", path.join(f.root, "gitdata"));
    git(main, "config", "user.email", "t@example.com");
    git(main, "config", "user.name", "T");
    git(main, "config", "commit.gpgsign", "false");
    commitFile(main, "a.txt", "one\n", "init");
    const refused = wt(f, main, ["list"]);
    assert.equal(refused.success, false);
    assert.match(refused.output, /not supported/);
    const linked = path.join(f.root, "linked");
    git(main, "worktree", "add", "-q", "-b", "side", linked);
    // Git records no way back to the main checkout, so the documented limit is the checkout itself, never the git directory
    assert.equal(new WorktreeManager(linked).getWorktreesBaseDir(), path.join(linked, ".nexus", "worktrees"));
  } finally { f.cleanup(); }
});

test("a stale registration that was recreated while the remover waited for the lock is not force-deleted", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    assert.equal(wt(f, f.repo, ["switch", "-c", "recycled"]).success, true);
    const dir = named(f, "recycled");
    fs.rmSync(dir, { recursive: true, force: true }); // Git lists it as prunable
    core.removeSeams.beforeLock = () => {
      // another remover pruned the registration and `switch` recreated the same path with new work in it
      git(f.repo, "worktree", "prune");
      git(f.repo, "worktree", "add", "-q", dir, "recycled");
      fs.writeFileSync(path.join(dir, "new-work.txt"), "precious\n");
    };
    let result;
    try { result = wt(f, f.repo, ["remove", "recycled"]); } finally { delete core.removeSeams.beforeLock; }
    assert.equal(result.success, false, result.output);
    assert.equal(fs.readFileSync(path.join(dir, "new-work.txt"), "utf8"), "precious\n", "the recreated checkout must not be deleted");
  } finally { f.cleanup(); }
});

test("a commit that lands on a detached worktree after the HEAD re-check is kept on a branch, not lost", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-late");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    let landed = "";
    core.removeSeams.beforeGitRemove = () => { landed = commitFile(dir, "late.txt", "late\n", "late commit"); };
    let result;
    try { result = wt(f, f.repo, ["remove", dir]); } finally { delete core.removeSeams.beforeGitRemove; }
    assert.ok(landed, "the seam must have run");
    assert.equal(result.success, true, result.output);
    assert.equal(fs.existsSync(dir), false);
    const saved = git(f.repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/nexus-removed").split("\n").filter(Boolean);
    assert.equal(saved.length, 1, `the late commit must be reachable from a branch: ${saved.join(";")}`);
    assert.ok(saved[0].endsWith(landed));
    assert.match(result.output, /nexus-removed/);
    // an uneventful detached removal leaves no branch behind
    const quiet = path.join(f.repo, ".nexus", "worktrees", "detached-quiet");
    git(f.repo, "worktree", "add", "-q", "--detach", quiet);
    assert.equal(wt(f, f.repo, ["remove", quiet]).success, true);
    assert.equal(git(f.repo, "for-each-ref", "refs/heads/nexus-removed").split("\n").filter(Boolean).length, 1);
  } finally { f.cleanup(); }
});

test("two processes that both find a stale lock do not reclaim it at the same time", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    fs.mkdirSync(path.join(common, "nexus"), { recursive: true });
    const lock = path.join(common, "nexus", "worktrees.lock");
    fs.writeFileSync(lock, "2147483000"); // a crashed holder
    const before = lockSettings.waitMs;
    let rival = "did not run";
    lockSeams.afterStaleCheck = () => {
      lockSeams.afterStaleCheck = undefined;
      // a second reclaimer starts while the first is between judging the lock stale and removing it
      lockSettings.waitMs = 150;
      try { withWorktreeLock(common, () => { rival = "reclaimed concurrently"; }); rival = rival === "did not run" ? "ran" : rival; }
      catch (err) { rival = (err as Error).message; }
    };
    try {
      assert.equal(withWorktreeLock(common, () => "first"), "first");
    } finally { lockSeams.afterStaleCheck = undefined; lockSettings.waitMs = before; fs.rmSync(lock, { force: true }); }
    assert.match(rival, /locked by another process/, "the rival must wait out the first reclaimer, not reclaim alongside it");
  } finally { f.cleanup(); }
});

test("a detached worktree whose removal Git refuses is put back on its detached HEAD and leaves no guard branch", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-refused");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    const head = git(dir, "rev-parse", "HEAD");
    // Git's own check refuses a worktree with an untracked file when no --force is given
    core.removeSeams.beforeGitRemove = () => { fs.writeFileSync(path.join(dir, "appeared.txt"), "x\n"); };
    let refused;
    try { refused = wt(f, f.repo, ["remove", dir]); } finally { delete core.removeSeams.beforeGitRemove; }
    assert.equal(refused.success, false, refused.output);
    assert.equal(fs.existsSync(dir), true);
    assert.throws(() => git(dir, "symbolic-ref", "-q", "HEAD"), undefined, "the worktree must be detached again");
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.equal(git(f.repo, "for-each-ref", "refs/heads/nexus-removed"), "", "no guard branch is left behind");
    fs.rmSync(path.join(dir, "appeared.txt"));
    assert.equal(wt(f, f.repo, ["remove", dir]).success, true, "a retry works");
  } finally { f.cleanup(); }
});

test("a commit that lands between creating the guard branch and reading its head is kept on the branch and nothing is removed", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-between");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    let landed = "";
    core.removeSeams.afterGuardSwitch = () => { landed = commitFile(dir, "between.txt", "x\n", "lands right after the guard switch"); };
    let result;
    try { result = wt(f, f.repo, ["remove", dir]); } finally { delete core.removeSeams.afterGuardSwitch; }
    assert.ok(landed, "the seam must have run");
    assert.equal(result.success, false, result.output);
    assert.equal(fs.existsSync(dir), true, "nothing is removed");
    const branches = git(f.repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/nexus-removed").split("\n").filter(Boolean);
    assert.equal(branches.length, 1, branches.join(";"));
    assert.ok(branches[0].endsWith(landed), "the guard branch holds the new commit");
    assert.match(result.output, /nexus-removed\//);
  } finally { f.cleanup(); }
});

test("when the detached HEAD cannot be restored after a refused removal the message names the branch the worktree is left on", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-stuck");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    core.removeSeams.beforeGitRemove = () => {
      fs.writeFileSync(path.join(dir, "appeared.txt"), "x\n"); // makes Git refuse the removal
      const guard = git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/nexus-removed");
      git(f.repo, "update-ref", "-d", guard); // and makes the rollback fail: the branch it would switch to is gone
    };
    let r;
    try { r = wt(f, f.repo, ["remove", dir]); } finally { delete core.removeSeams.beforeGitRemove; }
    assert.equal(r.success, false);
    assert.match(r.output, /could not restore the detached HEAD/);
    assert.match(r.output, /nexus-removed\//);
    assert.match(r.output, /switch --detach/);
    assert.doesNotMatch(r.output, /reuses it/, "a retry no longer reuses a guard branch");
    assert.match(r.output, /git branch -D/);
  } finally { f.cleanup(); }
});

test("a lock whose holder died before writing its pid is taken over after a short grace, not after ten minutes", () => {
  const f = fixture();
  try {
    const common = path.join(f.repo, ".git");
    fs.mkdirSync(path.join(common, "nexus"), { recursive: true });
    const lock = path.join(common, "nexus", "worktrees.lock");
    const before = lockSettings.waitMs;
    lockSettings.waitMs = 300;
    try {
      fs.writeFileSync(lock, ""); // created, but the holder died before writing its pid
      assert.throws(() => withWorktreeLock(common, () => "ran"), /locked by another process/, "fresh: the writer may still be about to write");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);
      assert.equal(withWorktreeLock(common, () => "ran"), "ran", "older than the grace: taken over");
    } finally { lockSettings.waitMs = before; fs.rmSync(lock, { force: true }); }
  } finally { f.cleanup(); }
});

const guardNameFor = (dir: string, head: string) => `nexus-removed/${crypto.createHash("sha1").update(fs.realpathSync(dir)).digest("hex").slice(0, 10)}-${head.slice(0, 8)}`;

test("a leaked guard branch makes removal refuse before anything changes, naming the branch, its commit and the commands to inspect it", () => {
  const f = fixture();
  try {
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-leaked");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    const head = git(dir, "rev-parse", "HEAD");
    const name = guardNameFor(dir, head);
    git(f.repo, "branch", name, head); // what an interrupted removal leaves behind
    const r = wt(f, f.repo, ["remove", dir]);
    assert.equal(r.success, false, r.output);
    assert.equal(fs.existsSync(dir), true, "nothing is removed");
    assert.throws(() => git(dir, "symbolic-ref", "-q", "HEAD"), undefined, "the worktree stays detached");
    assert.equal(git(f.repo, "rev-parse", `refs/heads/${name}`), head, "the leaked branch is untouched");
    assert.ok(r.output.includes(name) && r.output.includes(head.slice(0, 12)), r.output);
    assert.match(r.output, /git log/);
    assert.match(r.output, /git branch -D/);
    assert.equal(git(f.repo, "for-each-ref", "refs/heads/nexus-removed").split("\n").filter(Boolean).length, 1, "no other branch was created");
  } finally { f.cleanup(); }
});

test("a guard-named branch checked out in another worktree is refused and that worktree is left intact", () => {
  const f = fixture();
  try {
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-elsewhere");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    const head = git(dir, "rev-parse", "HEAD");
    const name = guardNameFor(dir, head);
    const other = path.join(f.repo, ".nexus", "worktrees", "on-the-guard");
    git(f.repo, "worktree", "add", "-q", "-b", name, other, head);
    const r = wt(f, f.repo, ["remove", dir, "--delete-unmerged"]);
    assert.equal(r.success, false, r.output);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(git(other, "rev-parse", "HEAD"), head, "the other worktree still has its branch and commit");
    assert.equal(git(f.repo, "rev-parse", `refs/heads/${name}`), head);
  } finally { f.cleanup(); }
});

test("a commit that lands on a fresh detached worktree before the guard switch is kept on the guard branch and nothing is removed", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-before-switch");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    let landed = "";
    core.removeSeams.beforeGuardSwitch = () => { landed = commitFile(dir, "b.txt", "B\n", "B lands before the guard switch"); };
    let r;
    try { r = wt(f, f.repo, ["remove", dir]); } finally { delete core.removeSeams.beforeGuardSwitch; }
    assert.ok(landed);
    assert.equal(r.success, false, r.output);
    assert.equal(fs.existsSync(dir), true);
    assert.ok(git(f.repo, "for-each-ref", "--format=%(objectname)", "refs/heads/nexus-removed").includes(landed));
  } finally { f.cleanup(); }
});

test("a commit that only survives in the HEAD reflog after the guard switch is kept, not deleted with the worktree", async () => {
  const f = fixture();
  try {
    const core = await import("../src/worktrunk/core.js") as any;
    const dir = path.join(f.repo, ".nexus", "worktrees", "detached-reflog");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(f.repo, "worktree", "add", "-q", "--detach", dir);
    let lost = "";
    // what a commit that raced the switch leaves behind: HEAD is back at the checked commit, the new commit is in the reflog only
    core.removeSeams.afterGuardSwitch = () => { lost = commitFile(dir, "raced.txt", "x\n", "raced the switch"); git(dir, "reset", "-q", "--hard", "HEAD~1"); };
    let r;
    try { r = wt(f, f.repo, ["remove", dir]); } finally { delete core.removeSeams.afterGuardSwitch; }
    assert.ok(lost);
    assert.equal(r.success, false, r.output);
    assert.equal(fs.existsSync(dir), true, "the worktree and its reflog are kept");
    assert.match(r.output, /reflog|nexus-removed\//);
    assert.equal(git(dir, "rev-parse", "HEAD@{1}"), lost);
  } finally { f.cleanup(); }
});
