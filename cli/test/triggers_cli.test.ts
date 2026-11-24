/**
 * HK-style test for `nexus triggers list | approve | revoke | status`. Approving is the act of a person at a
 * terminal, so the CLI is tested with an injected `confirm`/`interactive` and never approves without one.
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { registerTriggerCommands } from "../src/triggers_cli.js";

let home = "", previousHome: string | undefined, workspace = "";
beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-triggers-cli-home-"));
  process.env.HOME = home;
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-triggers-cli-ws-")));
  fs.mkdirSync(path.join(workspace, ".nexus"), { recursive: true });
  // trust the workspace so approve can succeed
  const trustDir = path.join(home, ".config", "nexus");
  fs.mkdirSync(trustDir, { recursive: true });
  fs.writeFileSync(path.join(trustDir, "trusted_workspaces.json"), JSON.stringify({ trustedPaths: [workspace] }));
});
afterEach(() => {
  for (const dir of [home, workspace]) fs.rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

interface Run { out: string; exitCode: number; asked: string[]; shownBeforeAsking: string }
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

function writeTriggerFile(contents: unknown): string {
  const file = path.join(workspace, ".nexus", "triggers.json");
  fs.writeFileSync(file, JSON.stringify(contents, null, 2), { mode: 0o600 });
  return file;
}

const validSpec = {
  format: "nexus-trigger",
  version: 1,
  id: "lint-on-save",
  event: { kind: "file-change", paths: ["src/**/*.ts"] },
  action: { prompt: "run lint", policy: "read-only" },
  rate: { maxPerMinute: 5, maxPerHour: 60, maxPerDay: 500 },
  bounds: { maxToolInvocations: 200, maxRounds: 5, maxTurnMinutes: 30 },
};

/** One `nexus triggers ...` invocation in this process. `answer` undefined: no terminal to ask on. */
async function nexusTriggers(args: string[], answer?: boolean): Promise<Run> {
  const lines: string[] = [];
  const asked: string[] = [];
  let shownBeforeAsking = "";
  const previous = { log: console.log, error: console.error, exitCode: process.exitCode };
  console.log = (...values: unknown[]) => { lines.push(values.join(" ")); };
  console.error = (...values: unknown[]) => { lines.push(values.join(" ")); };
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: (text) => { lines.push(text); }, writeErr: (text) => { lines.push(text); } });
    registerTriggerCommands(program, {
      interactive: () => answer !== undefined,
      confirm: async (question) => { asked.push(question); shownBeforeAsking = lines.join("\n"); return Boolean(answer); },
    });
    await program.parseAsync(["node", "nexus", "triggers", ...args]);
    return { out: stripAnsi(lines.join("\n")), exitCode: Number(process.exitCode ?? 0), asked, shownBeforeAsking: stripAnsi(shownBeforeAsking) };
  } finally {
    console.log = previous.log;
    console.error = previous.error;
    process.exitCode = previous.exitCode;
  }
}

test("list: no trigger specs reports none", async () => {
  const { out, exitCode } = await nexusTriggers(["list", "-w", workspace]);
  assert.equal(exitCode, 0);
  assert.ok(out.includes("no trigger specs"));
  assert.ok(out.includes("Trusted for triggers: yes"));
});

test("list: shows each spec with status not_approved", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  const { out } = await nexusTriggers(["list", "-w", workspace]);
  assert.ok(out.includes("lint-on-save"));
  assert.ok(out.includes("file-change"));
  assert.ok(out.includes("read-only"));
  assert.ok(out.includes("not_approved"));
});

test("list: json output", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  const { out, exitCode } = await nexusTriggers(["list", "-w", workspace, "--json"]);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.trusted, true);
  assert.equal(parsed.triggers.length, 1);
  assert.equal(parsed.triggers[0].id, "lint-on-save");
  assert.equal(parsed.triggers[0].status, "not_approved");
});

test("approve: records the approval and changes status to approved", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  const before = await nexusTriggers(["list", "-w", workspace]);
  assert.ok(before.out.includes("not_approved"));

  const run = await nexusTriggers(["approve", "-w", workspace], true);
  assert.equal(run.exitCode, 0);
  assert.ok(run.asked.length === 1);
  assert.ok(run.out.includes("Approved 1 trigger"));

  const after = await nexusTriggers(["list", "-w", workspace]);
  assert.ok(after.out.includes("approved"));
});

test("approve: without a terminal refuses (no --yes)", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  const run = await nexusTriggers(["approve", "-w", workspace]);
  assert.equal(run.exitCode, 2);
  assert.ok(run.out.includes("not a terminal") || run.out.includes("terminal"));
});

test("approve: --sha256 mismatch refuses", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  const run = await nexusTriggers(["approve", "-w", workspace, "--sha256", "0000000000000000000000000000000000000000000000000000000000000000"], true);
  assert.equal(run.exitCode, 2);
  assert.ok(run.out.includes("does not match"));
});

test("approve: declining refuses", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  const run = await nexusTriggers(["approve", "-w", workspace], false);
  assert.equal(run.exitCode, 0);
  assert.ok(run.out.includes("Not approved."));
});

test("approve: untrusted workspace refuses", async () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-triggers-untrusted-")));
  fs.mkdirSync(path.join(other, ".nexus"), { recursive: true });
  fs.writeFileSync(path.join(other, ".nexus", "triggers.json"), JSON.stringify({ version: 1, triggers: [validSpec] }), { mode: 0o600 });
  const run = await nexusTriggers(["approve", "-w", other], true);
  assert.equal(run.exitCode, 2);
  fs.rmSync(other, { recursive: true, force: true });
});

test("revoke: removes an approval", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  await nexusTriggers(["approve", "-w", workspace], true);
  const run = await nexusTriggers(["revoke", "lint-on-save", "-w", workspace]);
  assert.equal(run.exitCode, 0);
  assert.ok(run.out.includes("No longer approved"));
  const run2 = await nexusTriggers(["revoke", "lint-on-save", "-w", workspace]);
  assert.ok(run2.out.includes("There was no approval"));
});

test("status: MATCH => may run exit 0", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  await nexusTriggers(["approve", "-w", workspace], true);
  const run = await nexusTriggers(["status", "lint-on-save", "-w", workspace]);
  assert.equal(run.exitCode, 0);
  assert.ok(run.out.includes("MATCH"));
  assert.ok(run.out.includes("may run: yes"));
});

test("status: not_approved => may not run exit 1", async () => {
  writeTriggerFile({ version: 1, triggers: [validSpec] });
  const run = await nexusTriggers(["status", "lint-on-save", "-w", workspace]);
  assert.equal(run.exitCode, 1);
  assert.ok(run.out.includes("NEW"));
  assert.ok(run.out.includes("may run: no"));
});
