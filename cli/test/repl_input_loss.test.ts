/**
 * D1 (legacy readline REPL, `harness --repl`): lines that arrive in the same chunk as a prompt are parsed before the next
 * `rl.question()` listener exists and used to be discarded silently. The legacy REPL keeps its one-line-at-a-time semantics,
 * but loss is never silent: the operator is told how many lines were ignored and how to submit multi-line input.
 * (The default live TUI has a real multi-line composer; this test does not touch it.)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gateway } from "./helpers/capacity_fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcIndex = path.resolve(here, "../src/index.ts");
const cliRoot = path.resolve(here, "..");

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-repl-loss-"));
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: dir, stdio: "ignore" });
  return dir;
}

/** Feeds `writes` to the REPL's piped stdin (each entry after `delayMs`), then EOF; resolves with stderr and the number of model requests seen. */
function runRepl(gwUrl: string, ws: string, home: string, writes: string[], delayMs: number): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", srcIndex, "repl", "-w", ws, "-e", gwUrl, "-m", "m"], {
      cwd: cliRoot, env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve({ stderr }));
    (async () => {
      await new Promise((r) => setTimeout(r, 2500));          // let the REPL start and install its first question
      for (const w of writes) { child.stdin.write(w); await new Promise((r) => setTimeout(r, delayMs)); }
      child.stdin.end();
    })();
  });
}

describe("D1 legacy REPL input loss is never silent", () => {
  test("a burst of lines: only the first is a prompt, and the operator is told how many were ignored", async () => {
    const gw = await gateway(() => ({ text: "ok" }));
    const ws = workspace(); const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
    try {
      const { stderr } = await runRepl(gw.url, ws, home, ["alpha objective\nbeta constraint\ngamma success\n"], 4000);
      assert.equal(gw.requests, 1, "one burst is one prompt in the line-at-a-time REPL");
      assert.match(stderr, /2 lines arrived while no prompt was waiting and were ignored/);
      assert.match(stderr, /beta constraint/, "the first ignored line is shown so the loss can be recognised");
      assert.match(stderr, /"""|TUI/, "the warning says how to submit multi-line input");
    } finally {
      await gw.close(); fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("lines that arrive one at a time are all prompts and produce no warning", async () => {
    const gw = await gateway(() => ({ text: "ok" }));
    const ws = workspace(); const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
    try {
      const { stderr } = await runRepl(gw.url, ws, home, ["first\n", "second\n", "third\n"], 3500);
      assert.equal(gw.requests, 3);
      assert.doesNotMatch(stderr, /ignored/);
    } finally {
      await gw.close(); fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
