/**
 * Host-side Git on a worktree the sandboxed agent can write to. The agent can rewrite the worktree's `.git` pointer (or
 * plant a nested repository); Git would then read the planted repository's configuration on the host, where a
 * `filter.*.clean` or `gpg.program` setting is a command. Every host-side call must refuse such a worktree first.
 * Also: merge races that another terminal can win between the checks and the mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand } from "../src/worktrunk/command.js";
import { mergeSeams } from "../src/worktrunk/merge.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(name = "feat/t") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wttrust-")));
  const repo = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const made = runWorktreeCommand(["switch", "-c", name, "--no-copy"], { cwd: repo, home, readOnly: false });
  assert.equal(made.success, true, made.output);
  const dir = path.join(repo, ".nexus", "worktrees", name.replace("/", "-"));
  return { root, repo, home, dir, merge: (extra: string[] = []) => runWorktreeCommand(["merge", "--no-verify-receipt", "--reason", "trust fixture", ...extra], { cwd: dir, home, readOnly: false }), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Rewrites the worktree's `.git` pointer to a repository planted INSIDE the worktree whose config runs `marker`-writing commands. */
function plantRepository(f: ReturnType<typeof fixture>, branch: string, config: string[]): string {
  const marker = path.join(f.root, "MARKER");
  const plant = path.join(f.dir, "plant");
  fs.mkdirSync(plant);
  git(plant, "init", "-q", "-b", "main");
  git(plant, "config", "user.email", "t@example.com");
  git(plant, "config", "user.name", "T");
  fs.writeFileSync(path.join(plant, "seed"), "seed\n");
  git(plant, "add", "seed");
  git(plant, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed");
  git(plant, "branch", branch);
  git(plant, "worktree", "add", "-q", "-b", `${branch}-wt`, path.join(f.root, "planted-wt"));
  const admin = path.join(plant, ".git", "worktrees", "planted-wt");
  fs.writeFileSync(path.join(admin, "gitdir"), path.join(f.dir, ".git") + "\n");
  fs.writeFileSync(path.join(admin, "HEAD"), `ref: refs/heads/${branch}\n`);
  for (const line of config) git(plant, "config", ...line.replace("@MARKER@", marker).split("\u0000"));
  fs.writeFileSync(path.join(f.dir, ".git"), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(f.dir, ".gitattributes"), "* filter=plant\n");
  fs.writeFileSync(path.join(f.dir, "a.txt"), "edited by the agent\n");
  return marker;
}

test("a worktree whose .git pointer leads into a repository planted inside it is refused before any filter or program runs", () => {
  const f = fixture();
  try {
    const marker = plantRepository(f, "feat/t", [
      `filter.plant.clean\u0000sh -c 'echo ran > @MARKER@; cat'`,
      `commit.gpgsign\u0000true`,
      `gpg.program\u0000sh -c 'echo gpg > @MARKER@'`,
    ]);
    const r = f.merge();
    assert.equal(fs.existsSync(marker), false, `a planted configuration command ran on the host: ${r.output}`);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /not a trusted worktree/i);
  } finally { f.cleanup(); }
});

test("a clean multi-commit source: content force-added after the snapshot refuses the merge and keeps the worktree", () => {
  const f = fixture("feat/two");
  try {
    for (const n of ["x", "y"]) { fs.writeFileSync(path.join(f.dir, n), n); git(f.dir, "add", n); git(f.dir, "commit", "-q", "-m", n); }
    mergeSeams.preMerge = () => { fs.writeFileSync(path.join(f.dir, "ignored.log"), "staged on purpose\n"); git(f.dir, "add", "-f", "ignored.log"); };
    let r;
    try { r = f.merge(); } finally { delete mergeSeams.preMerge; }
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /index changed|staged/i);
    assert.equal(fs.existsSync(path.join(f.dir, "ignored.log")), true, "the worktree and the file are kept");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes("x"), false, "nothing was merged");
  } finally { f.cleanup(); }
});

test("a target checkout switched to another branch at the same commit is refused, not fast-forwarded under main's name", () => {
  const f = fixture("feat/tgt");
  try {
    fs.writeFileSync(path.join(f.dir, "w.txt"), "w\n");
    git(f.dir, "add", "w.txt");
    git(f.dir, "commit", "-q", "-m", "work");
    mergeSeams.preMerge = () => git(f.repo, "switch", "-q", "-c", "other"); // same commit as main
    let r;
    try { r = f.merge(); } finally { delete mergeSeams.preMerge; }
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /no longer on/);
    assert.equal(git(f.repo, "rev-parse", "other"), git(f.repo, "rev-parse", "main"), "the switched-to branch was not advanced");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", "HEAD").includes("w.txt"), false);
  } finally { f.cleanup(); }
});

test("trust table: legitimate layouts pass, planted ones are refused", async () => {
  const { untrustedCheckoutReason } = await import("../src/worktrunk/git.js");
  const f = fixture("feat/table");
  try {
    assert.equal(untrustedCheckoutReason(f.repo), undefined, "the main checkout");
    assert.equal(untrustedCheckoutReason(f.dir), undefined, "a linked worktree");
    fs.mkdirSync(path.join(f.dir, "sub", "deeper"), { recursive: true });
    assert.equal(untrustedCheckoutReason(path.join(f.dir, "sub", "deeper")), undefined, "a subdirectory of a linked worktree");
    assert.equal(untrustedCheckoutReason(path.join(f.root, "not-a-repo-at-all")), undefined, "a path that does not exist");
    // a repository (with its own configuration) planted as a directory inside the worktree
    git(path.join(f.dir, "sub"), "init", "-q");
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /nested inside the linked worktree/);
    fs.rmSync(path.join(f.dir, "sub", ".git"), { recursive: true });
    // a pointer to a directory inside the worktree, and a symlinked .git
    fs.mkdirSync(path.join(f.dir, "fake", "worktrees", "w"), { recursive: true });
    fs.writeFileSync(path.join(f.dir, "sub", ".git"), `gitdir: ${path.join(f.dir, "fake", "worktrees", "w")}\n`);
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /inside the worktree itself/);
    fs.rmSync(path.join(f.dir, "sub", ".git"));
    fs.symlinkSync(path.join(f.repo, ".git"), path.join(f.dir, "sub", ".git"));
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /plain pointer/);
    // a pointer to a different linked worktree's administrative directory, which does not point back at this .git
    fs.unlinkSync(path.join(f.dir, "sub", ".git"));
    git(f.repo, "worktree", "add", "-q", "-b", "feat/sibling", path.join(f.root, "sibling"));
    fs.writeFileSync(path.join(f.dir, "sub", ".git"), `gitdir: ${path.join(f.repo, ".git", "worktrees", "sibling")}\n`);
    assert.match(String(untrustedCheckoutReason(path.join(f.dir, "sub"))), /does not point back/);
  } finally { f.cleanup(); }
});

test("a pointer padded with whitespace cannot show the guard a different directory than Git reads", () => {
  const f = fixture("feat/pad");
  try {
    const marker = path.join(f.root, "MARKER");
    const realAdmin = fs.readFileSync(path.join(f.dir, ".git"), "utf8").replace(/^gitdir: /, "").trim();
    const planted = path.join(f.dir, "plant", "adm "); // a directory whose name ends in a space: a Git directory with a filter
    fs.mkdirSync(path.join(planted, "objects"), { recursive: true });
    fs.mkdirSync(path.join(planted, "refs"), { recursive: true });
    fs.writeFileSync(path.join(planted, "HEAD"), "ref: refs/heads/feat/pad\n");
    fs.writeFileSync(path.join(planted, "config"), `[core]\n\trepositoryformatversion = 0\n[filter "plant"]\n\tclean = sh -c 'echo ran > ${marker}; cat'\n`);
    fs.symlinkSync(realAdmin, path.join(f.dir, "plant", "adm")); // what a trimming guard would resolve to: the genuine admin directory
    fs.writeFileSync(path.join(f.dir, ".git"), "gitdir: plant/adm \n");
    fs.writeFileSync(path.join(f.dir, ".gitattributes"), "* filter=plant\n");
    fs.writeFileSync(path.join(f.dir, "a.txt"), "edited by the agent\n");
    const r = f.merge();
    assert.equal(fs.existsSync(marker), false, `the planted filter ran: ${r.output}`);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /not a well-formed gitdir pointer/, "refused by the pointer rule itself, not by an accident further on");
  } finally { f.cleanup(); }
});

test("a pointer to the main repository's own Git directory, and a repository planted in an untracked directory, are refused", () => {
  const f = fixture("feat/nest");
  try {
    const marker = path.join(f.root, "MARKER");
    // an untracked directory holding a complete repository with a filter: Git would read it when it descends for status
    const nested = path.join(f.dir, "vendor");
    fs.mkdirSync(nested);
    git(nested, "init", "-q");
    fs.writeFileSync(path.join(nested, "f.txt"), "x\n");
    git(nested, "add", "-A");
    git(nested, "-c", "commit.gpgsign=false", "-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "p");
    git(nested, "config", "filter.plant.clean", `sh -c 'echo ran > ${marker}; cat'`); // armed only now
    fs.writeFileSync(path.join(nested, ".gitattributes"), "* filter=plant\n");
    fs.writeFileSync(path.join(nested, "f.txt"), "dirty\n");
    fs.writeFileSync(path.join(f.dir, "w.txt"), "w\n");
    const r = f.merge();
    assert.equal(fs.existsSync(marker), false, `the nested repository's filter ran: ${r.output}`);
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /nested inside the linked worktree/);
  } finally { f.cleanup(); }

  const g = fixture("feat/main-ptr");
  try {
    fs.writeFileSync(path.join(g.dir, ".git"), `gitdir: ${path.join(g.repo, ".git")}\n`);
    fs.writeFileSync(path.join(g.dir, "w.txt"), "w\n");
    const before = git(g.repo, "rev-parse", "main");
    const r = g.merge();
    assert.equal(r.success, false, r.output);
    assert.equal(git(g.repo, "rev-parse", "main"), before, "the main branch was not advanced through the rewritten pointer");
    assert.match(r.output, /not a trusted worktree|does not point back/);
  } finally { g.cleanup(); }
});

test("submodule status lines are parsed with their whole path, spaces included", async () => {
  const { parseSubmoduleStatus } = await import("../src/worktrunk/git.js");
  const sha = "a".repeat(40);
  assert.deepEqual(parseSubmoduleStatus(` ${sha} my sub (heads/main)\n-${sha} other\n+${sha} nested/dir (v1-2-gabc)`), [
    { path: "my sub", initialised: true }, { path: "other", initialised: false }, { path: "nested/dir", initialised: true },
  ]);
});

test("the session's own Git helpers and the checkpoint manager refuse a worktree whose .git pointer was planted", async () => {
  const { getGitInfo, commitChanges } = await import("../src/git.js");
  const { CheckpointManager } = await import("../src/checkpoint.js");
  const f = fixture("feat/session");
  const previousHome = process.env.HOME;
  process.env.HOME = f.home; // checkpoints live under HOME
  try {
    const manager = new CheckpointManager(f.dir);
    const earlier = manager.createCheckpoint("before the pointer was rewritten"); // a real checkpoint, so a refusal is the guard's and not "not found"
    const marker = plantRepository(f, "feat/session", [`filter.plant.clean\u0000sh -c 'echo ran > @MARKER@; cat'`, `core.fsmonitor\u0000sh -c 'echo fsm > @MARKER@'`]);
    const info = getGitInfo(f.dir);
    assert.equal(info.isRepo, false, "no branch badge from a planted repository");
    assert.match(String(info.refusal), /not a trusted worktree/, "the cause is reported, not \"not a repository\"");
    const committed = commitChanges(f.dir, "chore: x");
    assert.equal(committed.success, false);
    assert.match(String(committed.error), /not a trusted worktree/);
    assert.throws(() => manager.createCheckpoint("turn"), /not a trusted worktree/);
    const restored = manager.restore(earlier.id);
    assert.equal(restored.success, false);
    assert.match(restored.message, /not a trusted worktree/);
    const diff = manager.getDiff(earlier.id);
    assert.equal(diff.success, false);
    assert.match(String(diff.error), /not a trusted worktree/);
    assert.equal(fs.existsSync(marker), false, "a planted configuration command ran on the host");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    f.cleanup();
  }
});

test("session Git helpers also refuse a repository planted below the worktree", async () => {
  const { getGitInfo } = await import("../src/git.js");
  const f = fixture("feat/below");
  try {
    const marker = path.join(f.root, "MARKER");
    const nested = path.join(f.dir, "vendor");
    fs.mkdirSync(nested);
    git(nested, "init", "-q");
    git(nested, "config", "core.fsmonitor", `sh -c 'echo fsm > ${marker}'`);
    assert.equal(getGitInfo(f.dir).isRepo, false);
    assert.equal(fs.existsSync(marker), false, "a nested repository's configuration ran on the host");
    assert.equal(getGitInfo(f.repo).isRepo, true, "the main checkout is unaffected");
  } finally { f.cleanup(); }
});

test("a bare-repository layout (project/.git -> .bare, worktrees beside it) is trusted", async () => {
  const { untrustedCheckoutReason } = await import("../src/worktrunk/git.js");
  const { getGitInfo } = await import("../src/git.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtbare-")));
  try {
    const seed = path.join(root, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "a"), "a\n");
    git(seed, "add", ".");
    git(seed, "-c", "commit.gpgsign=false", "-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "i");
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    git(root, "clone", "-q", "--bare", seed, path.join(project, ".bare"));
    fs.writeFileSync(path.join(project, ".git"), "gitdir: ./.bare\n");
    git(project, "worktree", "add", "-q", "feature");
    assert.equal(untrustedCheckoutReason(path.join(project, "feature")), undefined);
    assert.equal(getGitInfo(path.join(project, "feature")).isRepo, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a linked worktree whose .git file was replaced by a repository is refused everywhere, not taken for a plain repository", async () => {
  const { getGitInfo } = await import("../src/git.js");
  const { CheckpointManager } = await import("../src/checkpoint.js");
  const { statusOf } = await import("../src/worktrunk/core.js");
  const f = fixture("feat/replaced");
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  try {
    const marker = path.join(f.root, "MARKER");
    fs.rmSync(path.join(f.dir, ".git")); // the agent can: `rm .git && git init`
    git(f.dir, "init", "-q", "-b", "main");
    git(f.dir, "config", "filter.plant.clean", `sh -c 'echo ran > ${marker}; cat'`);
    git(f.dir, "config", "core.fsmonitor", `sh -c 'echo fsm > ${marker}'`);
    fs.writeFileSync(path.join(f.dir, ".gitattributes"), "* filter=plant\n");
    fs.writeFileSync(path.join(f.dir, "a.txt"), "edited\n");
    assert.throws(() => statusOf(f.dir), /not a trusted worktree/);
    assert.equal(getGitInfo(f.dir).isRepo, false);
    assert.throws(() => new CheckpointManager(f.dir).createCheckpoint("turn"), /not a trusted worktree/);
    assert.equal(f.merge().success, false);
    assert.equal(fs.existsSync(marker), false, "a planted repository's configuration ran on the host");
    assert.equal(getGitInfo(f.repo).isRepo, true, "the main checkout is a plain repository and still works");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    f.cleanup();
  }
});

test("a file name with control characters never forges a trailer in the deterministic commit message", async () => {
  const { conventionalCommitMessage } = await import("../src/git.js");
  assert.equal(conventionalCommitMessage(["a\n\nSigned-off-by: x"]), "feat(core): update workspace files");
  assert.equal(conventionalCommitMessage(["src/plain.ts"]), "feat(core): update plain.ts");
});

test("a repository planted two levels below an untracked directory is found, and a replaced .git is found through an opened repository's registry", async () => {
  const { getGitInfo } = await import("../src/git.js");
  const { verifyCheckout } = await import("../src/core/checkout_trust.js");
  const f = fixture("feat/deep");
  try {
    const marker = path.join(f.root, "MARKER");
    const deep = path.join(f.dir, "vendor", "lib");
    fs.mkdirSync(deep, { recursive: true });
    git(deep, "init", "-q");
    git(deep, "config", "core.fsmonitor", `sh -c 'echo fsm > ${marker}'`);
    assert.equal(getGitInfo(f.dir).isRepo, false, "depth two");
    assert.equal(fs.existsSync(marker), false);

    // a worktree outside the main repository's directory tree (sibling layout), registered through `worktree add`
    const sibling = path.join(f.root, "sibling-wt");
    git(f.repo, "worktree", "add", "-q", "-b", "feat/sibling", sibling);
    assert.equal(runWorktreeCommand(["list"], { cwd: f.repo, home: f.home, readOnly: true }).success, true); // opens the repository: its registry becomes known
    assert.equal(verifyCheckout(sibling).reason, undefined, "intact");
    fs.rmSync(path.join(sibling, ".git"));
    git(sibling, "init", "-q");
    assert.match(String(verifyCheckout(sibling).reason), /whose \.git file was replaced/);

    // a stale registry entry (directory deleted by hand) sorted before the agent's worktree does not hide it; this
    // worktree was made with plain Git, so only the registry scan (not the opened-repository set) can recognise it
    git(f.repo, "worktree", "add", "-q", "-b", "feat/a-old", path.join(f.root, "a-old-wt"));
    fs.rmSync(path.join(f.root, "a-old-wt"), { recursive: true, force: true });
    assert.ok(fs.existsSync(path.join(f.repo, ".git", "worktrees", "a-old-wt")), "precondition: the stale entry is still registered");
    const fresh = path.join(f.repo, ".nexus", "worktrees", "zz-fresh");
    git(f.repo, "worktree", "add", "-q", "-b", "feat/zz-fresh", fresh);
    assert.equal(verifyCheckout(fresh).reason, undefined, "intact");
    fs.rmSync(path.join(fresh, ".git"));
    git(fresh, "init", "-q", "-b", "main");
    assert.match(String(verifyCheckout(fresh).reason), /whose \.git file was replaced/);
  } finally { f.cleanup(); }
});

test("an ignored directory below an untracked one is neither scanned nor a reason to refuse", async () => {
  const { nestedRepositoryReason } = await import("../src/worktrunk/git.js");
  const f = fixture("feat/ignored");
  try {
    fs.writeFileSync(path.join(f.dir, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(f.dir, "apps", "new", "node_modules", "pkg"), { recursive: true });
    git(path.join(f.dir, "apps", "new", "node_modules", "pkg"), "init", "-q"); // Git never reads this one for status
    fs.writeFileSync(path.join(f.dir, "apps", "new", "index.js"), "x\n");
    assert.equal(nestedRepositoryReason(f.dir), undefined);
    fs.mkdirSync(path.join(f.dir, "apps", "new", "src", "vendored"), { recursive: true });
    git(path.join(f.dir, "apps", "new", "src", "vendored"), "init", "-q"); // not ignored: still found
    assert.match(String(nestedRepositoryReason(f.dir)), /nested inside the linked worktree/);
  } finally { f.cleanup(); }
});

test("a .git that is a FIFO, a link to /dev/zero or an oversized file is refused without blocking or reading it", async () => {
  const { verifyCheckout } = await import("../src/core/checkout_trust.js");
  const f = fixture("feat/special");
  try {
    fs.rmSync(path.join(f.dir, ".git"));
    execFileSync("mkfifo", [path.join(f.dir, ".git")]); // a synchronous read of this would never return
    assert.match(String(verifyCheckout(f.dir).reason), /not a plain pointer file/);
    fs.rmSync(path.join(f.dir, ".git"));
    fs.symlinkSync("/dev/zero", path.join(f.dir, ".git"));
    assert.match(String(verifyCheckout(f.dir).reason), /not a plain pointer file/);
    fs.rmSync(path.join(f.dir, ".git"));
    fs.writeFileSync(path.join(f.dir, ".git"), "gitdir: " + "x".repeat(10_000));
    assert.match(String(verifyCheckout(f.dir).reason), /not a plain pointer file/);
  } finally { f.cleanup(); }
});

test("a gitlink whose path contains a newline is still checked for a planted repository", async () => {
  const { nestedRepositoryReason } = await import("../src/worktrunk/git.js");
  const f = fixture("feat/newline");
  try {
    const odd = "x\ny";
    const sha = git(f.dir, "rev-parse", "HEAD");
    git(f.dir, "update-index", "--add", "--cacheinfo", `160000,${sha},${odd}`);
    const planted = path.join(f.dir, odd);
    fs.mkdirSync(planted);
    git(planted, "init", "-q");
    assert.match(String(nestedRepositoryReason(f.dir)), /nested inside the linked worktree/);
  } finally { f.cleanup(); }
});

test("a path that is not valid UTF-8 cannot hide a planted repository: it is refused, not skipped", async () => {
  const { nestedRepositoryReason } = await import("../src/worktrunk/git.js");
  const f = fixture("feat/bytes");
  try {
    const odd = Buffer.concat([Buffer.from(path.join(f.dir, "d")), Buffer.from([0xff])]);
    fs.mkdirSync(odd);
    fs.mkdirSync(Buffer.concat([odd, Buffer.from("/.git")]));
    assert.match(String(nestedRepositoryReason(f.dir)), /not valid UTF-8/);
    const deep = Buffer.concat([Buffer.from(path.join(f.dir, "ok")), Buffer.from("/"), Buffer.from([0xfe])]);
    fs.rmSync(odd, { recursive: true });
    fs.mkdirSync(path.join(f.dir, "ok"));
    fs.mkdirSync(deep);
    assert.match(String(nestedRepositoryReason(f.dir)), /not valid UTF-8/);
  } finally { f.cleanup(); }
});

test("ordinary files with names that are not valid UTF-8 do not make a worktree unusable; a gitlink or directory with such a name is still refused", async () => {
  const { nestedRepositoryReason } = await import("../src/worktrunk/git.js");
  const f = fixture("feat/latin1");
  try {
    const latin = Buffer.concat([Buffer.from(path.join(f.dir, "r")), Buffer.from([0xe9]), Buffer.from("sum")]);
    fs.writeFileSync(latin, "resume\n"); // an untracked file named in latin-1
    fs.mkdirSync(path.join(f.dir, "docs"));
    fs.writeFileSync(Buffer.concat([Buffer.from(path.join(f.dir, "docs", "n")), Buffer.from([0xe9])]), "x\n"); // inside an untracked directory
    assert.equal(nestedRepositoryReason(f.dir), undefined);
    git(f.dir, "add", "-A");
    git(f.dir, "-c", "commit.gpgsign=false", "-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "latin-1 names");
    assert.equal(nestedRepositoryReason(f.dir), undefined, "tracked too");
    const sha = git(f.dir, "rev-parse", "HEAD");
    execFileSync("git", ["update-index", "--index-info"], { cwd: f.dir, input: Buffer.concat([Buffer.from(`160000 ${sha}\tsub-`), Buffer.from([0xff]), Buffer.from("\n")]) });
    assert.match(String(nestedRepositoryReason(f.dir)), /not valid UTF-8/);
  } finally { f.cleanup(); }
});

test("refusal text shows control bytes from agent-controlled paths escaped, never raw", async () => {
  const { UntrustedCheckoutError } = await import("../src/worktrunk/git.js");
  const error = new UntrustedCheckoutError("/w/\u001b]52;c;x\u0007", "/w/\u001b[2K/.git is a repository nested inside the linked worktree /w", ["status"]);
  assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(error.message, /\\x1b\]52;c;x\\x07/);
});

test("a project .env that is a FIFO is ignored without blocking the host", async () => {
  const { loadEnvironment } = await import("../src/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-envfifo-"));
  const previous = process.cwd();
  try {
    execFileSync("mkfifo", [path.join(dir, ".env")]);
    process.chdir(dir);
    assert.doesNotThrow(() => loadEnvironment()); // a blocking read would hang this test until it times out
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
