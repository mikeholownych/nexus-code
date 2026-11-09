/** Opt-in LLM commit message for `worktree merge`: bounded, redacted input; validated, redacted output; any failure falls back. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runWorktreeCommandAsync } from "../src/worktrunk/command.js";
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

test("sibling worktree merge with --ai-message does not stage .nexus receipts", async () => {
  const f = fixture();
  try {
    const configDir = path.join(f.home, ".config", "nexus");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ version: 1, worktree: { layout: "sibling" } }));

    const made = await f.run(f.repo, ["switch", "-c", "feat/sibling", "--no-copy"]);
    assert.equal(made.success, true, made.output);
    const siblingDir = path.join(f.root, "proj.feat-sibling");
    assert.ok(fs.existsSync(siblingDir));

    // Simulate an inference receipt written during completer execution or diagnostics
    fs.mkdirSync(path.join(siblingDir, ".nexus"), { recursive: true });
    fs.writeFileSync(path.join(siblingDir, ".nexus", "inference_receipts.jsonl"), '{"requestId":"test"}\n');
    fs.writeFileSync(path.join(siblingDir, "file.txt"), "hello\n");

    const r = await f.run(siblingDir, MERGE, async () => "feat: add sibling file");
    assert.equal(r.success, true, r.output);

    const committed = git(f.repo, "show", "--name-only", "--pretty=format:", "HEAD").split("\n").filter(Boolean);
    assert.deepEqual(committed, ["file.txt"]);
  } finally { f.cleanup(); }
});

test("invalid configuration during completion falls back gracefully to deterministic message", async () => {
  const f = fixture();
  try {
    const dir = await featureWithWork(f);
    // Completer simulates buildConfigOrThrow throwing on invalid config
    const failingCompleter: Completer = async () => {
      try {
        throw new Error("Provider 'compatible' requires a base URL.");
      } catch {
        return undefined as any;
      }
    };
    const r = await f.run(dir, MERGE, failingCompleter);
    assert.equal(r.success, true, r.output);
    assert.match(r.output, /deterministic|fallback/i);
    assert.ok(git(f.repo, "log", "-1", "--format=%s").length > 0);
  } finally { f.cleanup(); }
});
