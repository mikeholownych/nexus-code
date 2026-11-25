import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCommandEnvironment } from "../src/command_env.js";
import { sandboxHomeMounts, wrapSandboxedCommand } from "../src/sandbox.js";
import { spawnSync } from "node:child_process";

const cleanup: string[] = [];
const savedHome = process.env.HOME;
const savedState = process.env.NEXUS_STATE_DIR;

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedState === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = savedState;
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

test("a workspace nested under an external custom state root keeps task state masked", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pa3-custom-state-"));
  cleanup.push(base);
  const home = path.join(base, "home");
  const state = path.join(base, "external-state");
  const workspace = path.join(state, "worktrees", "job-1");
  const sentinel = path.join(state, "tasks", "goal.json");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, "SENTINEL-GOAL-STATE");
  process.env.HOME = home;
  process.env.NEXUS_STATE_DIR = state;

  const wrapped = wrapSandboxedCommand(`cat ${sentinel} 2>&1 || true; echo WORKSPACE_WRITABLE`, workspace, { mode: "bwrap" });
  assert.equal(wrapped.sandboxed, true, wrapped.warning);
  const result = spawnSync(wrapped.argv![0], wrapped.argv!.slice(1), { encoding: "utf8", env: buildCommandEnvironment(), timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WORKSPACE_WRITABLE/);
  assert.doesNotMatch(result.stdout + result.stderr, /SENTINEL-GOAL-STATE/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "SENTINEL-GOAL-STATE", "host state stays intact");
});

test("an unresolvable state root fails closed instead of running without its mask", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pa3-state-error-"));
  cleanup.push(base);
  const home = path.join(base, "home");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, ".nexus"), "blocks directory creation");
  process.env.HOME = home;
  process.env.NEXUS_STATE_DIR = path.join(workspace, ".nexus", "state");

  const wrapped = wrapSandboxedCommand("true", workspace, { mode: "bwrap" });
  assert.equal(wrapped.sandboxed, false);
  assert.equal(wrapped.denial?.category, "policy");
  assert.match(wrapped.warning ?? "", /could not be created or resolved for sandbox protection/);
});

test("an operator HOME mount cannot re-expose state beside a worktree nested below the default root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pa3-home-mount-"));
  cleanup.push(base);
  const home = path.join(base, "home");
  const state = path.join(home, ".nexus");
  const workspace = path.join(state, "worktrees", "job-1");
  const sentinel = path.join(state, "tasks", "goal.json");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, "SENTINEL-GOAL-STATE");
  process.env.HOME = home;
  delete process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_SANDBOX_HOME_READONLY = state;

  const mounts = sandboxHomeMounts();
  assert.ok(mounts.refused.some((entry) => entry.path === state && /overlaps the Nexus state directory/.test(entry.reason)));
  assert.ok(!mounts.mounts.some((entry) => entry.path === state));

  const wrapped = wrapSandboxedCommand(`cat ${sentinel} 2>&1 || true; echo COMMAND_DONE`, workspace, { mode: "bwrap" });
  assert.equal(wrapped.sandboxed, true, wrapped.warning);
  const result = spawnSync(wrapped.argv![0], wrapped.argv!.slice(1), { encoding: "utf8", env: buildCommandEnvironment(), timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /COMMAND_DONE/);
  assert.doesNotMatch(result.stdout + result.stderr, /SENTINEL-GOAL-STATE/);
});
