// The supported domain of the candidate diff and the debugger snapshot (WP-1316): a repository state is either inside
// the predicate (a correct result) or refused with a reason. Never a silently wrong snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AgentWorkUnitExecutor } from "../src/core/operation_runner_execution.js";
import { candidateDiff, plainCandidateDiff, snapshotSupport } from "../src/core/specialist_inputs.js";
import { OperationGit, ensureIntegrationWorktree, newOperationGitState, planOperationGit } from "../src/core/operation_git.js";
import type { WorkUnit } from "../src/core/operation.js";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });
const put = (d: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
const unit = (id: string, role = "implementer"): WorkUnit => ({ id, title: id, prompt: "p", dependsOn: [], requires: {}, status: "RUNNABLE", reroutes: [], runs: 0, unknownResumes: 0, modelsUsed: [], role } as any);

function repo(files: Record<string, string> = { "in/a.txt": "a\n", "out/b.txt": "b\n", "run.sh": "echo\n" }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-domain-"));
  sh(d, "init", "-q", "-b", "main"); sh(d, "config", "user.email", "a@b"); sh(d, "config", "user.name", "t");
  for (const [f, t] of Object.entries(files)) put(d, f, t);
  sh(d, "add", "-A"); sh(d, "commit", "-qm", "base");
  return d;
}

/** The unit's worktree (as the tester left it) and a function that snapshots it for a debugger. */
function tester(files?: Record<string, string>) {
  const root = repo(files);
  const p = planOperationGit(root, `op-${path.basename(root)}`);
  const state = newOperationGitState(p);
  ensureIntegrationWorktree(p, state);
  const ops = new OperationGit(p, state);
  const wt = ops.prepareUnit(unit("verify", "tester")).workspace;
  const snapshotRun = (run: string) => ops.prepareUnit(unit("debug", "failure_debugger"), { snapshotOf: "verify", snapshotRun: run }).workspace;
  return { wt, snapshot: () => snapshotRun("t1"), snapshotRun };
}

type Setup = (d: string) => void;
const REFUSED = [
  ["sparse checkout (cone, out-of-cone path absent)", (d) => { sh(d, "sparse-checkout", "init", "--no-cone"); sh(d, "sparse-checkout", "set", "/in/"); put(d, "in/a.txt", "edited\n"); }, /sparse/],
  ["skip-worktree on a tracked file", (d) => { sh(d, "update-index", "--skip-worktree", "in/a.txt"); put(d, "in/a.txt", "edited\n"); }, /skip-worktree/],
  ["skip-worktree on a path absent from disk", (d) => { sh(d, "update-index", "--skip-worktree", "out/b.txt"); fs.rmSync(path.join(d, "out"), { recursive: true }); }, /skip-worktree/],
  ["assume-unchanged on a tracked file", (d) => { sh(d, "update-index", "--assume-unchanged", "in/a.txt"); put(d, "in/a.txt", "edited\n"); }, /assume-unchanged/],
  ["assume-unchanged with chmod +x", (d) => { sh(d, "update-index", "--assume-unchanged", "run.sh"); fs.chmodSync(path.join(d, "run.sh"), 0o755); }, /assume-unchanged/],
  ["core.filemode=false with a staged --chmod=+x", (d) => { sh(d, "config", "core.filemode", "false"); sh(d, "update-index", "--chmod=+x", "run.sh"); }, /core\.filemode/],
  ["core.symlinks=false", (d) => { sh(d, "config", "core.symlinks", "false"); }, /core\.symlinks/],
  ["core.ignorecase=true", (d) => { sh(d, "config", "core.ignorecase", "true"); }, /core\.ignorecase/],
  ["a submodule (gitlink) entry", (d) => {
    const sub = repo({ "s.txt": "s\n" });
    sh(d, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"); sh(d, "commit", "-qm", "sub");
  }, /submodule/],
  ["a clean/smudge filter assigned in .gitattributes", (d) => { put(d, ".gitattributes", "*.txt filter=lfs\n"); sh(d, "add", ".gitattributes"); sh(d, "commit", "-qm", "attrs"); }, /filter/],
  ["an unresolved merge conflict", (d) => {
    const cur = sh(d, "rev-parse", "--abbrev-ref", "HEAD").trim();
    sh(d, "checkout", "-q", "-b", "side"); put(d, "in/a.txt", "side\n"); sh(d, "commit", "-qam", "side");
    sh(d, "checkout", "-q", cur); put(d, "in/a.txt", "main\n"); sh(d, "commit", "-qam", "main");
    try { sh(d, "merge", "side"); } catch { /* conflict expected */ }
  }, /merge conflicts/],
] as Array<[string, Setup, RegExp]>;

for (const [name, setup, why] of REFUSED) {
  test(`refused with a reason, never a wrong diff: ${name}`, () => {
    const d = repo();
    setup(d);
    const r = candidateDiff(d, undefined);
    assert.ok("error" in r, `expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`);
    assert.match(r.error, /automatic inputs are not available/);
    assert.ok((r as { unsupported?: string }).unsupported, "marked as a domain refusal with its reason");
    assert.match(r.error, why);
  });
}

for (const [name, setup, why] of REFUSED) {
  test(`the debugger snapshot refuses too: ${name}`, () => {
    const t = tester();
    setup(t.wt);
    assert.throws(() => t.snapshot(), (e: Error) => /cannot be snapshotted/.test(e.message) && why.test(e.message));
  });
}

test("a workspace that is a subdirectory of its repository is refused", () => {
  const d = repo();
  const r = candidateDiff(path.join(d, "in"), undefined);
  assert.ok("error" in r && /subdirectory/.test(r.error), JSON.stringify(r));
});

test("a SHA-256 repository is refused with a reason", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-domain-sha256-"));
  try { sh(d, "init", "-q", "--object-format=sha256"); } catch { return; } // git without SHA-256 support: nothing to test
  sh(d, "config", "user.email", "a@b"); sh(d, "config", "user.name", "t"); put(d, "a.txt", "a\n"); sh(d, "add", "-A"); sh(d, "commit", "-qm", "base");
  const r = candidateDiff(d, undefined);
  assert.ok("error" in r && /sha256/.test(r.error), JSON.stringify(r));
});

test("sparse checkout with an out-of-cone path committed after the recorded base is refused, not shown as a deletion", () => {
  const d = repo();
  sh(d, "sparse-checkout", "init", "--no-cone"); sh(d, "sparse-checkout", "set", "/in/");
  const r = candidateDiff(d, sh(d, "rev-parse", "HEAD").trim());
  assert.ok("error" in r && /sparse/.test(r.error));
});

test("in-domain path is unchanged: edits, untracked files, a staged copy and an executable bit all appear", () => {
  const d = repo();
  put(d, "in/a.txt", "edited VISIBLE_EDIT\n"); put(d, "new.txt", "NEW_FILE\n"); fs.chmodSync(path.join(d, "run.sh"), 0o755);
  sh(d, "rm", "-q", "--cached", "out/b.txt");
  const r = candidateDiff(d, undefined);
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.match(r.diff, /VISIBLE_EDIT/);
  assert.match(r.diff, /NEW_FILE/);
  assert.match(r.diff, /new mode 100755/);
  assert.match(r.diff, /deleted file mode[\s\S]*out\/b\.txt|out\/b\.txt[\s\S]*deleted file mode/);
});

test("in-domain snapshot is unchanged: tracked edit, untracked file and deletion are all in it", () => {
  const t = tester();
  put(t.wt, "in/a.txt", "edited\n"); put(t.wt, "fresh.txt", "fresh\n"); fs.rmSync(path.join(t.wt, "out"), { recursive: true });
  const debug = t.snapshot();
  assert.equal(sh(debug, "cat-file", "-p", "HEAD:in/a.txt"), "edited\n");
  assert.equal(sh(debug, "cat-file", "-p", "HEAD:fresh.txt"), "fresh\n");
  assert.throws(() => sh(debug, "cat-file", "-e", "HEAD:out/b.txt"));
});

// Sweep: for every repository state in the table the result is either correct against an independent oracle (the
// worktree's own `git diff HEAD`-equivalent content) or an explicit refusal; a wrong diff fails the test.
const MARK = "SWEEP_EDIT_MARKER";
const SWEEP: Array<[string, Setup]> = [
  ["clean edit", (d) => put(d, "in/a.txt", `a ${MARK}\n`)],
  ["detached HEAD", (d) => { sh(d, "checkout", "-q", "--detach"); put(d, "in/a.txt", `a ${MARK}\n`); }],
  ["intent-to-add new file", (d) => { put(d, "in/a.txt", `a ${MARK}\n`); put(d, "n.txt", "n\n"); sh(d, "add", "-N", "n.txt"); }],
  ["staged edit then further edit", (d) => { put(d, "in/a.txt", "staged\n"); sh(d, "add", "in/a.txt"); put(d, "in/a.txt", `a ${MARK}\n`); }],
  ["rename", (d) => { put(d, "in/a.txt", `a ${MARK}\n`); sh(d, "mv", "out/b.txt", "out/c.txt"); }],
  ["symlink", (d) => { fs.symlinkSync("in/a.txt", path.join(d, "link")); put(d, "in/a.txt", `a ${MARK}\n`); }],
  ["ignored file", (d) => { put(d, ".gitignore", "ign\n"); put(d, "ign", "x\n"); put(d, "in/a.txt", `a ${MARK}\n`); }],
  ["untracked nested repo", (d) => { fs.mkdirSync(path.join(d, "v")); sh(path.join(d, "v"), "init", "-q"); put(d, "in/a.txt", `a ${MARK}\n`); }],
  ["rebase-like: HEAD behind an extra commit", (d) => { put(d, "x.txt", "x\n"); sh(d, "add", "x.txt"); sh(d, "commit", "-qm", "x"); put(d, "in/a.txt", `a ${MARK}\n`); }],
  ["merge in progress, resolved in the index", (d) => {
    const cur = sh(d, "rev-parse", "--abbrev-ref", "HEAD").trim();
    sh(d, "checkout", "-q", "-b", "side"); put(d, "in/a.txt", "side\n"); sh(d, "commit", "-qam", "side");
    sh(d, "checkout", "-q", cur); put(d, "in/a.txt", "main\n"); sh(d, "commit", "-qam", "main");
    try { sh(d, "merge", "side"); } catch { /* conflict expected */ }
    put(d, "in/a.txt", `a ${MARK}\n`); sh(d, "add", "in/a.txt");
  }],
  ["cherry-pick in progress, resolved in the index", (d) => {
    const cur = sh(d, "rev-parse", "--abbrev-ref", "HEAD").trim();
    sh(d, "checkout", "-q", "-b", "side"); put(d, "in/a.txt", "side\n"); sh(d, "commit", "-qam", "side");
    sh(d, "checkout", "-q", cur); put(d, "in/a.txt", "main\n"); sh(d, "commit", "-qam", "main");
    try { sh(d, "cherry-pick", "side"); } catch { /* conflict expected */ }
    put(d, "in/a.txt", `a ${MARK}\n`); sh(d, "add", "in/a.txt");
  }],
  ...REFUSED.map(([n, s]) => [n, (d: string) => { s(d); try { put(d, "in/a.txt", `a ${MARK}\n`); } catch { /* path may be unwritable */ } }] as [string, Setup]),
];
for (const [name, setup] of SWEEP) {
  test(`sweep: ${name} gives a correct diff or an explicit unsupported reason`, () => {
    const d = repo();
    setup(d);
    const r = candidateDiff(d, undefined);
    if ("error" in r) { assert.match(r.error, /automatic inputs are not available/, `only a stated refusal is acceptable, got: ${r.error}`); return; }
    // Oracle: git's own view of the change (tracked changes against HEAD plus untracked files).
    const lines = (...args: string[]) => sh(d, ...args).split("\n").filter((l) => l && !l.endsWith("/"));
    const expected = new Set([...lines("diff", "HEAD", "--name-only", "--no-renames"), ...lines("ls-files", "--others", "--exclude-standard")]);
    const shown = new Set([...r.diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]));
    assert.deepEqual([...shown].sort(), [...expected].sort());
  });
}

// ------------------------------------------------ checkout trust: the unit's model owns its worktree
const linkedUnit = () => tester();
test("a worktree whose .git pointer was replaced by another repository is refused (diff and snapshot), and nothing of it is read", () => {
  const evil = repo({ "evil.txt": "EVIL\n" });
  const marker = path.join(evil, "fsmonitor-ran");
  fs.writeFileSync(path.join(evil, "mon.sh"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  sh(evil, "config", "core.fsmonitor", path.join(evil, "mon.sh"));
  const t = linkedUnit();
  fs.writeFileSync(path.join(t.wt, ".git"), `gitdir: ${path.join(evil, ".git")}\n`);
  const r = candidateDiff(t.wt, undefined);
  assert.ok("error" in r && !(r as { unsupported?: string }).unsupported && /point back|could not be verified|not a plain/i.test(r.error), JSON.stringify(r));
  assert.throws(() => t.snapshot(), /point back|could not be verified|not a plain/i);
  assert.equal(fs.existsSync(marker), false);
});

test("a repository planted inside the unit worktree is refused by the diff and the snapshot", () => {
  const t = linkedUnit();
  const nested = path.join(t.wt, "vendor"); fs.mkdirSync(nested);
  sh(nested, "init", "-q");
  const r = candidateDiff(t.wt, undefined);
  assert.ok("error" in r && /nested|planted|repository/i.test(r.error), JSON.stringify(r));
  assert.throws(() => t.snapshot(), /nested|planted|repository/i);
});

// ------------------------------------------------ gaps closed in the final round
test("a path that is not valid UTF-8 is refused instead of being mangled into another name", () => {
  const d = repo();
  fs.writeFileSync(Buffer.concat([Buffer.from(d + "/"), Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74])]), "x\n");
  const r = candidateDiff(d, undefined);
  assert.ok("error" in r && /not valid UTF-8/.test(r.error), JSON.stringify(r));
});

test("a .gitattributes too large to apply is refused, not silently dropped", () => {
  const d = repo();
  put(d, ".gitattributes", "*.txt text\n" + "# pad\n".repeat(200_000));
  const r = candidateDiff(d, undefined);
  assert.ok("error" in r && /larger than/.test(r.error), JSON.stringify(r));
});

test("a failed stale-snapshot restart leaves the old debugger worktree and branch in place", () => {
  const t = tester();
  put(t.wt, "in/a.txt", "edited\n");
  const first = t.snapshot();
  sh(t.wt, "update-index", "--skip-worktree", "in/a.txt"); // the candidate is now outside the domain
  assert.ok(fs.existsSync(first));
  assert.throws(() => t.snapshotRun("t2"), /cannot be snapshotted/);
  assert.ok(fs.existsSync(first), "the old worktree survives a failed rebuild");
});

// ------------------------------------------------ reviewers: a refused state still gets a (plain) diff
const reviewerEvidence = (d: string, workspace = d) => (new AgentWorkUnitExecutor({ baseConfig: { workspace: d } as any }) as any)
  .reviewEvidence({ ...unit("rv", "reviewer") }, { objective: "o", workspace, dependencies: [] }, workspace) as { unifiedDiff: string; diffError?: string };
for (const [name, setup] of [...REFUSED.map(([n, s]) => [n, s] as [string, Setup]), ["a subdirectory workspace", () => {}] as [string, Setup]]) {
  test(`a reviewer still gets a diff, with the reason, when the repository is ${name}`, () => {
    const d = repo();
    setup(d);
    put(d, "in/a.txt", `a ${MARK}\n`);
    const ev = reviewerEvidence(d, name === "a subdirectory workspace" ? path.join(d, "in") : d);
    assert.equal(ev.diffError, undefined, ev.diffError);
    assert.match(ev.unifiedDiff, /plain git diff/);
    assert.match(ev.unifiedDiff, new RegExp(MARK));
  });
}

test("the plain diff leaves protected files out, including a moved one, and refuses a replaced .git", () => {
  const d = repo({ "in/a.txt": "a\n", ".env": "SECRET_TOKEN_VALUE_1234\n" });
  put(d, ".env", "SECRET_TOKEN_VALUE_5678\n"); put(d, "in/a.txt", `a ${MARK}\n`);
  const r = plainCandidateDiff(d, undefined);
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.doesNotMatch(r.diff, /SECRET_TOKEN/);
  assert.match(r.diff, new RegExp(MARK));
  assert.ok(r.omitted >= 1);
  sh(d, "checkout", "--", ".env"); fs.renameSync(path.join(d, ".env"), path.join(d, "notes.txt"));
  const moved = plainCandidateDiff(d, undefined);
  assert.ok(!("error" in moved), JSON.stringify(moved));
  assert.doesNotMatch(moved.diff, /SECRET_TOKEN/, "a protected file moved to a new name is not shown");
  const t = tester();
  fs.writeFileSync(path.join(t.wt, ".git"), `gitdir: ${path.join(d, ".git")}\n`);
  assert.ok("error" in plainCandidateDiff(t.wt, undefined));
});

test("a deleted tracked .gitattributes does not refuse the candidate", () => {
  const d = repo({ "in/a.txt": "a\n", ".gitattributes": "*.txt text\n" });
  fs.rmSync(path.join(d, ".gitattributes"));
  const r = candidateDiff(d, undefined);
  assert.ok(!("error" in r), JSON.stringify(r));
});

test("the plain diff does not silently drop a changed path that is not valid UTF-8", () => {
  const d = repo();
  const bad = Buffer.concat([Buffer.from(d + "/"), Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74])]);
  fs.writeFileSync(bad, "x\n");
  const r = plainCandidateDiff(d, undefined);
  assert.ok("error" in r && /not valid UTF-8/.test(r.error), JSON.stringify(r));
});

test("an object-format answer that is neither sha1 nor sha256 (git before 2.38 echoes the flag) is refused as too old", () => {
  const d = repo();
  const real = (args: string[]) => execFileSync("git", args, { cwd: d, encoding: "utf8" });
  const r = snapshotSupport((args) => (args.includes("--show-object-format") ? "--show-object-format\n" : real(args)), d);
  assert.ok("unsupported" in r && /too old/.test(r.unsupported), JSON.stringify(r));
  assert.deepEqual(snapshotSupport((args) => (args.includes("--show-object-format") ? "sha1\n" : real(args)), d), { ok: true });
});
