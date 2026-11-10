/** Opt-in LLM commit message for `worktree merge`: bounded, redacted input; validated, redacted output; any failure falls back. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommand, runWorktreeCommandAsync } from "../src/worktrunk/command.js";
import { mergeSeams } from "../src/worktrunk/merge.js";
import { lazyProviderCompleter } from "../src/worktrunk/provider.js";
import { buildConfig } from "../src/config.js";
import { startGateway } from "./helpers/fixtures.js";
import type { Completer } from "../src/worktrunk/ai_message.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wtai-")));
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
  const run = (cwd: string, args: string[], completer?: Completer, extra: { readOnly?: boolean; aiTimeoutMs?: number } = {}) =>
    runWorktreeCommandAsync(args, { cwd, home, readOnly: extra.readOnly ?? false }, { completer, aiTimeoutMs: extra.aiTimeoutMs });
  return { root, repo, home, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function featureWithWork(f: ReturnType<typeof fixture>, content = "b\n") {
  const made = await f.run(f.repo, ["switch", "-c", "feat/ai", "--no-copy"]);
  assert.equal(made.success, true, made.output);
  const dir = path.join(f.repo, ".nexus", "worktrees", "feat-ai");
  fs.writeFileSync(path.join(dir, "b.txt"), content);
  return dir;
}

const MERGE = ["merge", "--no-verify-receipt", "--reason", "test fixture", "--ai-message"];

test("--ai-message uses the model's message for the commit", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    let calls = 0;
    const r = await f.run(dir, MERGE, async () => { calls++; return "feat(b): add b.txt\n\nAdds the b file."; });
    assert.equal(r.success, true, r.output);
    assert.equal(calls, 1);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "feat(b): add b.txt");
    assert.match(git(f.repo, "log", "-1", "--format=%b"), /Adds the b file/);
  } finally { f.cleanup(); }
});

test("without --ai-message the model is never called", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const r = await f.run(dir, ["merge", "--no-verify-receipt", "--reason", "test fixture"], async () => { throw new Error("must not be called"); });
    assert.equal(r.success, true, r.output);
  } finally { f.cleanup(); }
});

test("the model sees a bounded, redacted diff and is told it is data", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f, `token=${SECRET}\n${"filler line\n".repeat(30_000)}`);
    let seen = "";
    await f.run(dir, MERGE, async (messages) => { seen = messages.map((m) => String(m.content)).join("\n"); return "feat: add b"; });
    assert.ok(seen.length > 0);
    assert.ok(seen.length < 40_000, `prompt is ${seen.length} bytes`);
    assert.doesNotMatch(seen, new RegExp(SECRET));
    assert.match(seen, /truncated/i);
    assert.match(seen, /b\.txt/);
    assert.match(seen, /untrusted|data, not instructions/i);
  } finally { f.cleanup(); }
});

test("model output is redacted and validated; any failure falls back to the deterministic message", async () => {
  const f = fixture();
  try {
    const bad: Array<[string, Completer | undefined]> = [
      ["throws", async () => { throw new Error("provider down"); }],
      ["empty", async () => "   "],
      ["too long", async () => "x".repeat(5000)],
      ["control characters", async () => "feat: ok\u001b[31m\u0007"],
      ["subject too long", async () => `feat: ${"y".repeat(300)}`],
      ["no provider", undefined],
    ];
    for (const [name, completer] of bad) {
      const g = fixture();
      try {
        const dir = await featureWithWork(g);
        const r = await g.run(dir, MERGE, completer);
        assert.equal(r.success, true, `${name}: ${r.output}`);
        assert.match(r.output, /deterministic|fallback/i, name);
        const subject = git(g.repo, "log", "-1", "--format=%s");
        assert.ok(subject.length > 0 && subject.length <= 100, `${name}: ${subject}`);
        assert.doesNotMatch(subject, /y{50}|x{50}/, name);
      } finally { g.cleanup(); }
    }
    const dir = await featureWithWork(f);
    const r = await f.run(dir, MERGE, async () => `fix: rotate ${SECRET}`);
    assert.equal(r.success, true, r.output);
    assert.doesNotMatch(git(f.repo, "log", "-1", "--format=%B"), new RegExp(SECRET));
  } finally { f.cleanup(); }
});

test("a model that never answers times out and the merge uses the deterministic message", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const started = Date.now();
    const r = await f.run(dir, MERGE, () => new Promise<string>(() => {}), { aiTimeoutMs: 100 });
    assert.equal(r.success, true, r.output);
    assert.ok(Date.now() - started < 20_000);
    assert.match(r.output, /deterministic|fallback/i);
  } finally { f.cleanup(); }
});

test("read-only mode refuses the merge before the model is asked", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    let calls = 0;
    const r = await f.run(dir, MERGE, async () => { calls++; return "feat: x"; }, { readOnly: true });
    assert.equal(r.success, false);
    assert.equal(calls, 0);
  } finally { f.cleanup(); }
});

test("an explicit -m wins and the model is not called", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const r = await f.run(dir, [...MERGE, "-m", "chore: mine"], async () => { throw new Error("must not be called"); });
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "chore: mine");
  } finally { f.cleanup(); }
});

test("precondition failures refuse merge before asking the model", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    let calls = 0;
    const completer = async () => { calls++; return "feat: bad"; };

    // 1. Receipt gate failure: merge without waiver or verification
    const rGate = await f.run(dir, ["merge", "--ai-message"], completer);
    assert.equal(rGate.success, false, rGate.output);
    assert.match(rGate.output, /no recorded passing verification/);
    assert.equal(calls, 0, "model must not be called when receipt gate fails");

    // 2. Dirty target worktree failure
    fs.writeFileSync(path.join(f.repo, "dirty.txt"), "uncommitted target work");
    const rTargetDirty = await f.run(dir, MERGE, completer);
    assert.equal(rTargetDirty.success, false, rTargetDirty.output);
    assert.match(rTargetDirty.output, /target worktree.*has uncommitted changes/);
    assert.equal(calls, 0, "model must not be called when target worktree is dirty");
  } finally { f.cleanup(); }
});

test("merge --ai-message succeeds when target is passed after the -- delimiter", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const r = await f.run(
      dir,
      ["merge", "--ai-message", "--no-verify-receipt", "--reason", "test fixture", "--", "main"],
      async () => "feat: message after delimiter",
    );
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "feat: message after delimiter");
  } finally { f.cleanup(); }
});

test("clean branch exactly one commit ahead applies generated message from --ai-message", async () => {
  const f = fixture();
  try {
    const made = await f.run(f.repo, ["switch", "-c", "feat/single", "--no-copy"]);
    assert.equal(made.success, true, made.output);
    const dir = path.join(f.repo, ".nexus", "worktrees", "feat-single");
    // Make one commit and leave the worktree clean
    fs.writeFileSync(path.join(dir, "single.txt"), "single\n");
    git(dir, "add", "single.txt");
    git(dir, "commit", "-m", "original single commit message");

    const r = await f.run(dir, MERGE, async () => "feat: updated single commit message");
    assert.equal(r.success, true, r.output);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "feat: updated single commit message");
  } finally { f.cleanup(); }
});

test("--no-squash on a dirty branch already ahead: the model sees only the uncommitted change", async () => {
  const f = fixture();
  try {
    const made = await f.run(f.repo, ["switch", "-c", "feat/dirty", "--no-copy"]);
    assert.equal(made.success, true, made.output);
    const dir = path.join(f.repo, ".nexus", "worktrees", "feat-dirty");
    fs.writeFileSync(path.join(dir, "earlier.txt"), "earlier\n");
    git(dir, "add", "earlier.txt");
    git(dir, "commit", "-m", "earlier commit");
    fs.writeFileSync(path.join(dir, "later.txt"), "later\n");
    let seen = "";
    const r = await f.run(dir, [...MERGE, "--no-squash"], async (messages) => { seen = messages.map((m) => String(m.content)).join("\n"); return "feat: add later"; });
    assert.equal(r.success, true, r.output);
    assert.match(seen, /later\.txt/);
    assert.doesNotMatch(seen, /earlier\.txt/);
  } finally { f.cleanup(); }
});

test("a dirty branch already ahead that will be squashed: the model sees the whole branch", async () => {
  const f = fixture();
  try {
    const made = await f.run(f.repo, ["switch", "-c", "feat/dirty2", "--no-copy"]);
    assert.equal(made.success, true, made.output);
    const dir = path.join(f.repo, ".nexus", "worktrees", "feat-dirty2");
    fs.writeFileSync(path.join(dir, "earlier.txt"), "earlier\n");
    git(dir, "add", "earlier.txt");
    git(dir, "commit", "-m", "earlier commit");
    fs.writeFileSync(path.join(dir, "later.txt"), "later\n");
    let seen = "";
    const r = await f.run(dir, MERGE, async (messages) => { seen = messages.map((m) => String(m.content)).join("\n"); return "feat: add both"; });
    assert.equal(r.success, true, r.output);
    assert.match(seen, /later\.txt/);
    assert.match(seen, /earlier\.txt/);
  } finally { f.cleanup(); }
});

test("reason option containing --ai-message as a value does not invoke the model", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    let called = false;
    const r = await f.run(
      dir,
      ["merge", "--no-verify-receipt", "--reason", "--ai-message", "main"],
      async () => { called = true; return "feat: ai commit"; },
    );
    assert.equal(r.success, true, r.output);
    assert.equal(called, false, "model should not have been called");
  } finally { f.cleanup(); }
});

test("extra positional arguments fail with usage error before calling the model", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    let called = false;
    const r = await f.run(
      dir,
      ["merge", "main", "extra", "--ai-message"],
      async () => { called = true; return "feat: ai commit"; },
    );
    assert.equal(r.success, false);
    assert.match(r.output, /usage: worktree merge/);
    assert.equal(called, false, "model should not have been called when usage is invalid");
  } finally { f.cleanup(); }
});

test("merge --no-squash with multiple clean commits does not call the model", async () => {
  const f = fixture();
  try {
    const made = await f.run(f.repo, ["switch", "-c", "feat/multi", "--no-copy"]);
    assert.equal(made.success, true, made.output);
    const dir = path.join(f.repo, ".nexus", "worktrees", "feat-multi");
    fs.writeFileSync(path.join(dir, "f1.txt"), "1\n");
    git(dir, "add", "f1.txt");
    git(dir, "commit", "-m", "commit one");
    fs.writeFileSync(path.join(dir, "f2.txt"), "2\n");
    git(dir, "add", "f2.txt");
    git(dir, "commit", "-m", "commit two");

    let called = false;
    const r = await f.run(
      dir,
      ["merge", "--no-squash", "--ai-message", "--no-verify-receipt", "--reason", "waiver"],
      async () => { called = true; return "feat: should not be used"; },
    );
    assert.equal(r.success, true, r.output);
    assert.equal(called, false, "model should not be called when --no-squash preserves multiple commits");
    assert.doesNotMatch(r.output, /commit message written by the configured model/);
  } finally { f.cleanup(); }
});

test("a cancel requested while the model is being asked stops the merge before anything changes", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const mainBefore = git(f.repo, "rev-parse", "refs/heads/main");
    const controller = new AbortController();
    const r = await runWorktreeCommandAsync(MERGE, { cwd: dir, home: f.home, readOnly: false }, {
      completer: async () => { controller.abort(); return "feat(b): never used"; },
      signal: controller.signal,
    });
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /cancel/i);
    assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), mainBefore, "the target is untouched");
    assert.ok(fs.existsSync(dir), "the worktree is kept");
    assert.equal(git(dir, "status", "--porcelain").includes("b.txt"), true, "the uncommitted work is still uncommitted");
  } finally { f.cleanup(); }
});

test("lazyProviderCompleter only guards building the configuration; a failing request surfaces as the model's failure note", async () => {
  assert.equal(await lazyProviderCompleter(() => { throw new Error("no provider configured"); })([], new AbortController().signal), undefined);
  const failing = lazyProviderCompleter(() => ({} as any), () => async () => { throw new Error("connection refused"); });
  await assert.rejects(() => failing([], new AbortController().signal), /connection refused/);
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const r = await f.run(dir, MERGE, failing);
    assert.equal(r.success, true, r.output);
    assert.match(r.output, /request failed/i, "the user is told the request failed, not that the reply was unusable");
    assert.doesNotMatch(r.output, /unusable/i);
  } finally { f.cleanup(); }
});

test("the merge usage is the same text whether or not --ai-message is given", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const sync = runWorktreeCommand(["merge", "a", "b", "--ai-message"], { cwd: dir, home: f.home, readOnly: false });
    const viaAsync = await f.run(dir, ["merge", "a", "b", "--ai-message"], async () => "x");
    assert.equal(sync.success, false);
    assert.equal(viaAsync.output, sync.output);
    assert.match(viaAsync.output, /--ai-message/);
  } finally { f.cleanup(); }
});

test("a plain -m on a clean one-commit branch keeps the original commit; only the model path rewrites it", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "original subject");
    const plain = await f.run(dir, ["merge", "--no-verify-receipt", "--reason", "test fixture", "--no-remove", "-m", "explicit message"]);
    assert.equal(plain.success, true, plain.output);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "original subject", "an explicit -m does not rewrite a lone clean commit");

    const second = await f.run(f.repo, ["switch", "-c", "feat/ai2", "--no-copy"]);
    assert.equal(second.success, true, second.output);
    const dir2 = path.join(f.repo, ".nexus", "worktrees", "feat-ai2");
    fs.writeFileSync(path.join(dir2, "c.txt"), "c\n");
    git(dir2, "add", "c.txt");
    git(dir2, "commit", "-q", "-m", "second original");
    const viaModel = await f.run(dir2, MERGE, async () => "feat(c): written by the model");
    assert.equal(viaModel.success, true, viaModel.output);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "feat(c): written by the model");
  } finally { f.cleanup(); }
});

test("the model is not asked, and no note claims it wrote the message, when the commits cancel each other out", async () => {
  const f = fixture();
  try {
    const made = await f.run(f.repo, ["switch", "-c", "feat/cancelled", "--no-copy"]);
    assert.equal(made.success, true, made.output);
    const dir = path.join(f.repo, ".nexus", "worktrees", "feat-cancelled");
    fs.writeFileSync(path.join(dir, "x.txt"), "x\n"); git(dir, "add", "x.txt"); git(dir, "commit", "-q", "-m", "add x");
    git(dir, "rm", "-q", "x.txt"); git(dir, "commit", "-q", "-m", "remove x");
    let calls = 0;
    const r = await f.run(dir, MERGE, async () => { calls++; return "feat: never used"; });
    assert.equal(r.success, true, r.output);
    assert.equal(calls, 0, "nothing to describe: the model is not asked");
    assert.doesNotMatch(r.output, /written by the configured model/);
  } finally { f.cleanup(); }
});

test("a state that changed while the model was writing the message is not merged under the old description", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const r = await f.run(dir, MERGE, async () => {
      fs.writeFileSync(path.join(dir, "late.txt"), "saved while the model was thinking\n");
      return "feat(b): add b.txt";
    });
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /changed while/i);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "init", "the target is untouched");
    assert.ok(fs.existsSync(dir));
  } finally { f.cleanup(); }
});

test("a branch switched in the source worktree while the model was writing is not merged, rewritten or removed", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const r = await f.run(dir, MERGE, async () => {
      git(dir, "switch", "-q", "-c", "next-task"); // same HEAD and same working tree, different branch
      return "feat(b): add b.txt";
    });
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /changed while/i);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "init", "the target is untouched");
    assert.ok(fs.existsSync(dir), "the worktree is kept");
    assert.equal(git(dir, "branch", "--show-current"), "next-task");
    assert.match(git(f.repo, "branch", "--list", "next-task"), /next-task/, "the new branch is not deleted");
  } finally { f.cleanup(); }
});

test("an already-aborted signal never sends the model request", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const stop = new AbortController();
    stop.abort();
    let calls = 0;
    const r = await runWorktreeCommandAsync(MERGE, { cwd: dir, home: f.home, readOnly: false }, { completer: async () => { calls++; return "feat: x"; }, signal: stop.signal });
    assert.equal(calls, 0, "no request is sent");
    assert.equal(r.success, false, r.output);
    assert.match(r.output, /Cancelled/);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "init");
  } finally { f.cleanup(); }
});

test("a `-` target is pinned to the branch it named when the merge began, not re-read after the model answers", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    const made = await f.run(f.repo, ["switch", "-c", "release", "--no-copy"]);
    assert.equal(made.success, true, made.output);
    const releaseDir = path.join(f.repo, ".nexus", "worktrees", "release");
    const releaseBefore = git(releaseDir, "rev-parse", "HEAD");
    const r = await f.run(dir, ["merge", "-", "--no-verify-receipt", "--reason", "test fixture", "--ai-message"], async () => {
      const moved = await f.run(releaseDir, ["switch", "main"]); // another terminal: the shared `-` shortcut now names `release`
      assert.equal(moved.success, true, moved.output);
      return "feat(b): add b.txt";
    });
    assert.equal(git(releaseDir, "rev-parse", "HEAD"), releaseBefore, `release was merged into: ${r.output}`);
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "feat(b): add b.txt", "main is where the merge was asked to go");
  } finally { f.cleanup(); }
});

test("content staged by another terminal after the state snapshot is not swept into the message-only amend", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "add b"); // a clean single commit: the AI path amends it to carry the model's message
    mergeSeams.preMerge = () => { // after the final state snapshot, before the amend
      fs.writeFileSync(path.join(dir, "staged-later.txt"), "unverified\n");
      git(dir, "add", "staged-later.txt");
    };
    try {
      await f.run(dir, MERGE, async () => "feat(b): add b.txt");
    } finally { delete mergeSeams.preMerge; }
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", "HEAD").includes("staged-later.txt"), false, "unverified staged content reached the target");
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "feat(b): add b.txt", "the message was still applied");
  } finally { f.cleanup(); }
});

test("content staged after the state snapshot is not swept into the squash commit either", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "add b");
    fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
    git(dir, "add", "c.txt");
    git(dir, "commit", "-q", "-m", "add c"); // two commits: the default squash
    mergeSeams.preMerge = () => {
      fs.writeFileSync(path.join(dir, "staged-later.txt"), "unverified\n");
      git(dir, "add", "staged-later.txt");
    };
    let r;
    try {
      r = runWorktreeCommand(["merge", "--no-verify-receipt", "--reason", "test fixture"], { cwd: dir, home: f.home, readOnly: false });
    } finally { delete mergeSeams.preMerge; }
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", "HEAD").includes("staged-later.txt"), false, `unverified staged content reached the target: ${r.output}`);
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", "HEAD").includes("c.txt"), true, "the verified commits were merged");
  } finally { f.cleanup(); }
});

test("the lazy provider completer resolves the local-model placeholder to the server's loaded model before asking", async () => {
  const gw = await startGateway(() => ({ kind: "text", content: "feat: message from the real model" }), { models: () => [{ id: "real-model" }] });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lazy-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const previousModel = process.env.LOCAL_LLM_MODEL;
  delete process.env.LOCAL_LLM_MODEL;
  try {
    const completer = lazyProviderCompleter(() => buildConfig({ endpoint: gw.url, workspace: home }));
    const reply = await completer([{ role: "user", content: "write a commit message" }] as any, new AbortController().signal);
    assert.match(String(reply), /real model/);
    const asked = (gw.requests as any[]).find((r) => Array.isArray(r?.messages));
    assert.equal(asked?.model, "real-model", "the request names the loaded model, not the placeholder");
  } finally {
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousModel !== undefined) process.env.LOCAL_LLM_MODEL = previousModel;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
