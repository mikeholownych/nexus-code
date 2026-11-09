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
import { lockSettings, withWorktreeLock } from "../src/worktrunk/registry.js";

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

test("a branch that moved after the integration check is kept, not force-deleted", async () => {
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
    assert.equal(fs.existsSync(dir), false, "the clean worktree directory is removed");
    assert.equal(git(f.repo, "rev-parse", "--verify", "--quiet", "refs/heads/racy"), newSha, "the moved branch must survive");
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
