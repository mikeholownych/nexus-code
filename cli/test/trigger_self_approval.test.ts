/**
 * BG-3: the agent must not be able to approve a trigger for itself. The trust store (~/.config/nexus/trigger_trust.json)
 * is a protected path: its write, edit, patch and delete tools cannot create or modify it, even when the workspace is
 * the home directory (the route a review used to forge an approval).
 */
import "./helpers/leak_guard.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutonomousAgent } from "../src/agent.js";
import { readTriggerTrustStore, triggerTrustStorePath } from "../src/core/trigger_trust.js";
import { makeRepo } from "./helpers/fixtures.js";
import { dispatch, hookAgent } from "./helpers/hooks_fixture.js";

let home = "", previousHome: string | undefined, stateDir = "";
let agents: AutonomousAgent[] = [];

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bg3-self-home-")));
  process.env.HOME = home;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bg3-self-state-"));
});
afterEach(() => {
  for (const agent of agents) agent.shutdown();
  agents = [];
  for (const dir of [home, stateDir]) fs.rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});

const forged = JSON.stringify({ version: 1, entries: [] });

test("the trigger trust store is a protected path, wherever the agent names it", () => {
  const repo = fs.realpathSync(makeRepo({ "a.txt": "hello\n" }));
  const agent = hookAgent({ repo, stateDir, mode: "auto", fullAccess: true });
  agents.push(agent);
  const security = (agent as any).bridge.getSecurityManager();
  assert.equal(security.isPathProtected(path.join(home, ".config", "nexus", "trigger_trust.json")).protected, true);
  assert.equal(security.isPathProtected(".config/nexus/trigger_trust.json").protected, true);
  assert.equal(security.isPathProtected("sub/trigger_trust.json").protected, true);
  assert.match(security.isPathProtected("trigger_trust.json").reason ?? "", /is protected under security policy/);
  // A repository's own trigger spec is repository content: it runs only once approved.
  assert.equal(security.isPathProtected(".nexus/triggers.json").protected, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("with the home directory as the workspace, no file tool can create, change or delete the trigger trust store", async () => {
  const storePath = triggerTrustStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const original = `${JSON.stringify({ version: 1, entries: [] })}\n`;
  fs.writeFileSync(storePath, original, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "a.txt"), "hello\n");
  const agent = hookAgent({ repo: home, stateDir, mode: "auto", fullAccess: true });
  agents.push(agent);
  const target = ".config/nexus/trigger_trust.json";

  const attempts: Array<[string, Record<string, unknown>]> = [
    ["write_file", { path: target, content: forged }],
    ["edit_file", { path: target, old_content: original.trim(), new_content: forged }],
    ["patch_file", { path: target, patch: `--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-${original.trim()}\n+${forged}\n` }],
    ["delete_file", { path: target }],
  ];
  for (const [tool, args] of attempts) {
    const receipt = await dispatch(agent, tool, args);
    assert.equal(receipt.success, false, `${tool}: ${JSON.stringify(receipt).slice(0, 300)}`);
    assert.match(receipt.error ?? "", /protected/, tool);
    assert.equal(fs.readFileSync(storePath, "utf8"), original, `${tool} left the store untouched`);
  }

  // Creating it where it does not exist is refused as well.
  fs.rmSync(storePath);
  const created = await dispatch(agent, "write_file", { path: target, content: forged });
  assert.equal(created.success, false);
  assert.equal(fs.existsSync(storePath), false);
  assert.deepEqual(readTriggerTrustStore().entries, []);
});
