import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { discoverTypecheck, runTypecheck } from "../src/tester.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, Reply } from "./helpers/fixtures.js";

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
  trustedDeliverableFiles: ["math.js"],
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
});
const write = (name: string, content: string): Reply => ({
  kind: "tools",
  calls: [{ name: "write_file", args: { path: name, content, overwrite: true } }],
});
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2020", module: "commonjs", types: [] }, include: ["types.ts"] });
const PKG = JSON.stringify({ name: "x", version: "1.0.0", private: true, scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" } });
const ADD_TEST =
  'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';
const ADD_BUGGY = "exports.add = (a, b) => a - b;\n";
const ADD_FIXED = "exports.add = (a, b) => a + b;\n";
const TYPES_OK = "export const n: number = 1;\n";
const TYPES_BAD = 'export const n: number = "one";\n';
const TSC_BIN = path.resolve("node_modules/typescript/bin/tsc");

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-"));
  for (const [name, content] of Object.entries({ "package.json": PKG, "test/math.test.js": ADD_TEST, "math.js": ADD_BUGGY, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: root, stdio: "ignore" });
  return root;
}

async function run(files: Record<string, string>, withTsc = true) {
  const root = repo(files);
  const savedPath = process.env.PATH;
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-bin-"));
  if (withTsc) {
    fs.symlinkSync(TSC_BIN, path.join(toolDir, "tsc"));
    process.env.PATH = `${toolDir}:${savedPath}`;
  }
  const steps = [write("math.js", ADD_FIXED), done];
  const gw = await startGateway((n) => steps[n - 1] ?? { kind: "text", content: "done" });
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root)));
  const savedHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-home-"));
  try {
    const turn = await agent.runTurn("npm test fails; fix math.js.");
    return { turn, root };
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(process.env.HOME!, { recursive: true, force: true });
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    fs.rmSync(toolDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("type-check as verifier evidence", () => {
  test("a type error with passing unit tests is not VERIFIED and names the configuration", { timeout: 120_000 }, async () => {
    const { turn } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_BAD });
    assert.notEqual(turn.outcome, "VERIFIED");
    assert.equal(turn.verification?.status, "FAILED");
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "FAILED");
    assert.equal(tc?.configPath, "tsconfig.json");
    assert.equal(tc?.configSha256, createHash("sha256").update(TSCONFIG).digest("hex"));
    assert.match(tc?.toolVersion ?? "", /^Version \d+\.\d+/);
    assert.equal(tc?.tool, "tsc");
    assert.notEqual(tc?.exitCode, 0);
    assert.match(tc?.excerpt ?? "", /TS2322/);
    assert.equal(tc?.scope, "under tsconfig.json");
  });

  test("a clean TS project records a passing type-check under its tsconfig and is VERIFIED", { timeout: 120_000 }, async () => {
    const { turn } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK });
    assert.equal(turn.outcome, "VERIFIED");
    assert.equal(turn.verification?.typecheck?.status, "PASSED");
    assert.equal(turn.verification?.typecheck?.scope, "under tsconfig.json");
    assert.equal(turn.verification?.typecheck?.exitCode, 0);
    assert.doesNotMatch(JSON.stringify(turn.verification?.typecheck), /everywhere|universal/i);
  });

  test("no tsconfig: not applicable and the outcome is unchanged", { timeout: 120_000 }, async () => {
    const { turn } = await run({}, false);
    assert.equal(turn.outcome, "VERIFIED");
    assert.equal(turn.verification?.typecheck?.status, "NOT_APPLICABLE");
  });

  const hasGlobalTsc = (() => {
    try {
      execSync("command -v tsc", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  test("tsc not installed is an environment condition, recorded, not a candidate failure", { timeout: 120_000, skip: hasGlobalTsc }, async () => {
    const { turn } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_BAD }, false);
    assert.equal(turn.verification?.typecheck?.status, "ENVIRONMENT");
    assert.equal(turn.verification?.status, "PASSED");
    assert.equal(turn.outcome, "VERIFIED");
  });

  test("runTypecheck classifies exit codes", async () => {
    const check = { tool: "tsc" as const, command: "x", configPath: "tsconfig.json", configSha256: "" };
    const exec = (exit: number | null, stdout = "") => async () => ({ success: true, output: JSON.stringify({ exit_code: exit, stdout, stderr: "" }) });
    assert.equal((await runTypecheck(check, exec(127))).status, "ENVIRONMENT");
    assert.equal((await runTypecheck(check, exec(126))).status, "ENVIRONMENT");
    assert.equal((await runTypecheck(check, exec(2, "Version 5.9.3\nerror"))).status, "FAILED");
    const ok = await runTypecheck(check, exec(0, "Version 5.9.3\n"));
    assert.equal(ok.status, "PASSED");
    assert.equal(ok.version, "Version 5.9.3");
    assert.equal((await runTypecheck(check, async () => { throw new Error("boom"); })).status, "ENVIRONMENT");
  });

  test("discovery: tsconfig, Cargo.toml, core/Cargo.toml, none", () => {
    const mk = (files: Record<string, string>) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-disc-"));
      for (const [n, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
        fs.writeFileSync(path.join(d, n), c);
      }
      return d;
    };
    const dirs = [mk({}), mk({ "Cargo.toml": "[package]\n" }), mk({ "core/Cargo.toml": "[package]\n" }), mk({ "tsconfig.json": "{}" })];
    try {
      assert.equal(discoverTypecheck(dirs[0]), null);
      const root = discoverTypecheck(dirs[1]);
      assert.equal(root?.tool, "cargo");
      assert.equal(root?.command, "cargo --version && cargo check");
      assert.equal(root?.configPath, "Cargo.toml");
      const nested = discoverTypecheck(dirs[2]);
      assert.equal(nested?.command, "cargo --version && cargo check --manifest-path core/Cargo.toml");
      assert.equal(nested?.configPath, "core/Cargo.toml");
      assert.equal(discoverTypecheck(dirs[3])?.tool, "tsc");
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
