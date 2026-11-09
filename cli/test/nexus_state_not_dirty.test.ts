/**
 * D-03 (docs/v1.1.4/TUI-AUDIT.md): Nexus's own state directory must not make a repository dirty.
 *
 * A real turn writes `.nexus/inference_receipts.jsonl` into the workspace. Every surface that reports "dirty" (the
 * session header via getGitInfo, the model's [Git Status] line, /git, /diff, /commit) must agree that a fresh
 * repository is clean, and the user's own `git status` must not list `.nexus/`. A real user change is counted once.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { getGitInfo } from "../src/git.js";
import { WORKSPACE_HANDLERS } from "../src/slash/workspace_commands.js";
import type { SlashContext, SlashReply } from "../src/slash/catalog.js";

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

async function gateway(): Promise<{ url: string; prompts: string[]; close(): Promise<void> }> {
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const users = (body.messages ?? []).filter((m: any) => m.role === "user");
      prompts.push(String(users.at(-1)?.content ?? ""));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse({ choices: [{ index: 0, delta: { content: "Hello." } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    prompts,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function freshRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-d03-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

function slash(command: "git" | "diff" | "commit", workspace: string): SlashReply {
  const ctx = { host: { app: { getConfig: () => ({ workspace }) } }, args: "", signal: new AbortController().signal } as unknown as SlashContext;
  return WORKSPACE_HANDLERS[command](ctx) as SlashReply;
}

const gitStatusLine = (prompt: string) => prompt.match(/\[Git Status: [^\]]*\((\d+) uncommitted dirty files\)\]/)?.[1];

/** Runs two real turns (the second carries the [Git Status] line computed after the first wrote its receipt). */
async function twoTurns(repo: string, between?: () => void): Promise<string[]> {
  const gw = await gateway();
  const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto" } as any);
  try {
    await agent.runTurn("hello");
    between?.();
    await agent.runTurn("hello again");
    return gw.prompts;
  } finally {
    agent.shutdown();
    await gw.close();
  }
}

describe("D-03: Nexus state is not a workspace change", () => {
  test("a fresh repository is clean on every surface after a turn writes its receipts", async () => {
    const repo = freshRepo();
    try {
      const prompts = await twoTurns(repo);
      assert.ok(fs.existsSync(path.join(repo, ".nexus", "inference_receipts.jsonl")), "the turn records its inference receipt in the workspace");
      assert.equal(getGitInfo(repo).dirtyCount, 0, "header (session.state git.dirty) counts Nexus state");
      assert.equal(gitStatusLine(prompts.at(-1)!), "0", "the model's [Git Status] line counts Nexus state");
      assert.equal(slash("git", repo).output, "Working tree clean.", "/git lists Nexus state");
      assert.match(slash("diff", repo).output, /^Working tree clean/);
      assert.match(slash("commit", repo).output, /nothing to commit/);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" }), "", "the user's own git status lists .nexus/");
      assert.equal(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf-8").includes(".nexus"), false, "recording a receipt must not write Git metadata");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("Nexus state left by an older version without its self-ignore is still not counted", () => {
    const repo = freshRepo();
    try {
      fs.mkdirSync(path.join(repo, ".nexus"));
      fs.writeFileSync(path.join(repo, ".nexus", "inference_receipts.jsonl"), "{}\n");
      assert.equal(getGitInfo(repo).dirtyCount, 0);
      assert.equal(slash("git", repo).output, "Working tree clean.");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a real user change is counted once, the same on every surface", async () => {
    const repo = freshRepo();
    try {
      const prompts = await twoTurns(repo, () => fs.writeFileSync(path.join(repo, "base.txt"), "changed\n"));
      assert.equal(getGitInfo(repo).dirtyCount, 1);
      assert.equal(gitStatusLine(prompts.at(-1)!), "1");
      assert.equal(slash("git", repo).output, " M base.txt");
      assert.match(slash("diff", repo).output, /^diff --git a\/base.txt b\/base.txt/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an untracked user file is counted once, and /diff does not call the tree clean", () => {
    const repo = freshRepo();
    try {
      fs.mkdirSync(path.join(repo, ".nexus"));
      fs.writeFileSync(path.join(repo, ".nexus", "inference_receipts.jsonl"), "{}\n");
      fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
      assert.equal(getGitInfo(repo).dirtyCount, 1);
      assert.equal(slash("git", repo).output, "?? new.txt");
      const diff = slash("diff", repo).output;
      assert.doesNotMatch(diff, /Working tree clean/);
      assert.match(diff, /1 untracked/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
