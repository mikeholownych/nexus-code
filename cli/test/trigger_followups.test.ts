/** BG-3 re-review follow-ups on the trust model: literal `yes`, end of input, limiter capacity, real-path keys. */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { confirmOnTerminal, NoAnswerError, registerTriggerCommands } from "../src/triggers_cli.js";
import { WorkspaceRateLimiter } from "../src/core/trigger_rate_limit.js";

const rate = { maxPerMinute: 1, maxPerHour: 1, maxPerDay: 1 };
const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);

async function ask(text: string | undefined): Promise<boolean> {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = confirmOnTerminal("q? ", { input, output });
  if (text !== undefined) input.write(text);
  else input.end();
  return pending.finally(() => { input.destroy(); output.destroy(); });
}

test("the confirmation is the literal word yes: no case folding, no trimming", async () => {
  assert.equal(await ask("yes\n"), true);
  for (const wrong of ["YES\n", "Yes\n", " yes \n", "yes \n", "y\n", "\n"]) assert.equal(await ask(wrong), false, JSON.stringify(wrong));
});

test("end of input is a refusal with a clear error, not an unhandled AbortError", async () => {
  await assert.rejects(ask(undefined), NoAnswerError);
});

test("approve prints a refusal and exits 2 when the input ends, and escapes the file path it prints", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-followup-home-"));
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-followup-ws-")));
  const workspace = path.join(base, "w‮s");
  fs.mkdirSync(path.join(workspace, ".nexus"), { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "nexus", "trusted_workspaces.json"), JSON.stringify({ trustedPaths: [workspace] }));
  fs.writeFileSync(path.join(workspace, ".nexus", "triggers.json"), JSON.stringify({ version: 1, triggers: [{ format: "nexus-trigger", version: 1, id: "t", event: { kind: "file-change", paths: ["src/**"] }, action: { prompt: "p", policy: "read-only" }, rate: { maxPerMinute: 1, maxPerHour: 2, maxPerDay: 3 }, bounds: { maxToolInvocations: 1, maxRounds: 1, maxTurnMinutes: 1 } }] }), { mode: 0o600 });
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, exitCode: process.exitCode };
  console.log = (...v: unknown[]) => { lines.push(v.join(" ")); };
  console.error = (...v: unknown[]) => { lines.push(v.join(" ")); };
  try {
    const program = new Command();
    program.exitOverride();
    registerTriggerCommands(program, { interactive: () => true, confirm: () => ask(undefined) });
    await program.parseAsync(["node", "nexus", "triggers", "approve", "-w", workspace]);
    const out = lines.join("\n");
    assert.equal(process.exitCode, 2);
    assert.match(out, /Not approved: t: no answer was given/);
    assert.doesNotMatch(out, /AbortError|\n\s+at /);
    assert.equal(out.includes("‮"), false, "the file path is printed escaped");
    assert.match(out, /\\u202e/);
  } finally {
    console.log = saved.log; console.error = saved.error; process.exitCode = saved.exitCode;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("recordFailure respects the quarantine cap: 1,000 distinct ids make at most the cap", () => {
  const limiter = new WorkspaceRateLimiter(undefined, { maxQuarantines: 3 });
  const ws = fs.realpathSync(os.tmpdir());
  for (let i = 0; i < 1000; i++) for (let n = 0; n < 3; n++) limiter.recordFailure(ws, `t-${i}`, rate, at(n), "boom");
  assert.ok(limiter.snapshot().quarantines.length <= 3, `${limiter.snapshot().quarantines.length} quarantines`);
});

test("evicting a limiter never resets a live window: at capacity a new trigger is refused instead", () => {
  const limiter = new WorkspaceRateLimiter(undefined, { maxLimiters: 1 });
  const ws = fs.realpathSync(os.tmpdir());
  assert.equal(limiter.checkAndRecord(ws, "a", rate, at(0)).admitted, true);
  assert.equal(limiter.checkAndRecord(ws, "b", rate, at(1)).admitted, false, "b is refused, a is not evicted");
  assert.equal(limiter.checkAndRecord(ws, "a", rate, at(2)).admitted, false, "a's window is still live");
  assert.equal(limiter.checkAndRecord(ws, "b", rate, at(25 * 3_600_000)).admitted, true, "a day later a's window is idle and b may take its place");
  assert.equal(limiter.size(), 1);
});

test("rotating workspaces never resets a live workspace window", () => {
  const limiter = new WorkspaceRateLimiter({ maxPerMinute: 1, maxPerHour: 1, maxPerDay: 1 }, { maxWorkspaces: 1 });
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wsa-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wsb-"));
  try {
    const big = { maxPerMinute: 9, maxPerHour: 9, maxPerDay: 9 };
    assert.equal(limiter.checkAndRecord(fs.realpathSync(a), "t", big, at(0)).admitted, true);
    assert.equal(limiter.checkAndRecord(fs.realpathSync(b), "t", big, at(1)).admitted, false, "no room without discarding a live window");
    assert.equal(limiter.checkAndRecord(fs.realpathSync(a), "u", big, at(2)).admitted, false, "a's workspace cap still holds");
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("the limiter key is the real path: a symlink to the workspace shares its window", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-keyreal-")));
  const link = `${dir}-link`;
  fs.symlinkSync(dir, link);
  try {
    const limiter = new WorkspaceRateLimiter();
    assert.equal(limiter.checkAndRecord(dir, "t", rate, at(0)).admitted, true);
    assert.equal(limiter.checkAndRecord(link, "t", rate, at(1)).admitted, false, "same directory, same window");
    assert.equal(limiter.size(), 1);
  } finally {
    fs.unlinkSync(link);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
