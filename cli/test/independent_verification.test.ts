/**
 * VERIFIED needs evidence Nexus did not write (rule accepted 2026-10-13 after the eval pilot): an operator-configured
 * verifier, or tests that existed before the change, unmodified, failing before it and passing after it. The pilot's
 * false VERIFIED was a wrong deliverable "verified" by tests Nexus had added to match its own misreading.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, Reply } from "./helpers/fixtures.js";

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
  ...o,
});
const write = (name: string, content: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content, overwrite: true } }] });
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-independent-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: root, stdio: "ignore" });
  return root;
}

// NODE_TEST_CONTEXT is cleared: inherited from this suite's runner, it makes a nested `node --test` report to its parent
// instead of printing the report the verifier reads.
const PKG = JSON.stringify({ name: "x", version: "1.0.0", private: true, scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" } });
const SLUG = 'function slugify(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }\nmodule.exports = { slugify };\n';
const SLUG_TEST = 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { slugify } = require("../slugify.js");\ntest("basic", () => assert.equal(slugify("Hello, World!"), "hello-world"));\n';
// The pilot's misreading: a slug of exactly maxLength characters is cut back a word.
const SLUG_WRONG =
  'function slugify(t, o = {}) {\n  let s = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n' +
  '  if (o.maxLength !== undefined && s.length >= o.maxLength) { const cut = s.slice(0, o.maxLength).lastIndexOf("-"); s = cut > 0 ? s.slice(0, cut) : s.slice(0, o.maxLength); }\n' +
  "  return s;\n}\nmodule.exports = { slugify };\n";
const SLUG_TEST_WRONG = SLUG_TEST + 'test("maxLength", () => assert.equal(slugify("The quick brown fox", { maxLength: 15 }), "the-quick"));\n';

const ADD_BUGGY = "exports.add = (a, b) => a - b;\n";
const ADD_FIXED = "exports.add = (a, b) => a + b;\n";
const ADD_TEST = 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';

async function run(files: Record<string, string>, steps: Reply[], objective: string, extra: Partial<HarnessConfig> = {}) {
  const root = repo(files);
  const gw = await startGateway((n) => steps[n - 1] ?? { kind: "text", content: "done" });
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root, extra)));
  try {
    const turn = await agent.runTurn(objective);
    return { turn, root, leftovers: fs.existsSync(path.join(root, ".nexus/verify")) ? fs.readdirSync(path.join(root, ".nexus/verify")) : [] };
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("VERIFIED needs evidence Nexus did not write", () => {
  test("a new feature checked only by tests Nexus added is REGRESSION_FREE, not VERIFIED (pilot slugify)", { timeout: 60_000 }, async () => {
    const { turn } = await run(
      { "package.json": PKG, "slugify.js": SLUG, "test/slugify.test.js": SLUG_TEST },
      [write("slugify.js", SLUG_WRONG), write("test/slugify.test.js", SLUG_TEST_WRONG), done],
      "Add a maxLength option to slugify.",
    );
    assert.equal(turn.verification?.status, "PASSED", "npm test passes on the agent's own tests");
    assert.equal(turn.outcome, "REGRESSION_FREE", `${turn.outcome}: ${turn.detail}`);
    assert.match(turn.detail ?? "", /passed before the change too; the new behaviour is checked only by tests Nexus wrote/);
    assert.equal(turn.verification?.independent, false);
  });

  test("a bug fix that makes an existing failing test pass is VERIFIED (fail before, pass after)", { timeout: 60_000 }, async () => {
    const { turn } = await run({ "package.json": PKG, "math.js": ADD_BUGGY, "test/math.test.js": ADD_TEST }, [write("math.js", ADD_FIXED), done], "npm test fails; fix math.js.");
    assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.detail}`);
    assert.equal(turn.verification?.independent, true);
  });

  test("making the failing test pass by editing the test, not the code, is not VERIFIED", { timeout: 60_000 }, async () => {
    const weakened = ADD_TEST.replace("assert.equal(add(2, 3), 5)", "assert.equal(add(2, 3), -1)");
    const { turn, leftovers } = await run({ "package.json": PKG, "math.js": ADD_BUGGY, "test/math.test.js": ADD_TEST }, [write("test/math.test.js", weakened), done], "npm test fails; fix it.");
    assert.equal(turn.verification?.status, "PASSED");
    assert.equal(turn.outcome, "REGRESSION_FREE", `${turn.outcome}: ${turn.detail}`);
    assert.match(turn.detail ?? "", /passes only with tests Nexus wrote or edited; the tests as they were before the change still fail/);
    assert.deepEqual(leftovers, [], "the copy used for the pre-change tests is removed");
  });

  test("a fix plus a new test of Nexus's own is VERIFIED when the pre-change test passes without it", { timeout: 60_000 }, async () => {
    const extraTest = ADD_TEST.replace('test("adds"', 'test("adds negatives"').replace("add(2, 3), 5", "add(-2, -3), -5");
    const { turn } = await run(
      { "package.json": PKG, "math.js": ADD_BUGGY, "test/math.test.js": ADD_TEST },
      [write("math.js", ADD_FIXED), write("test/more.test.js", extraTest), done],
      "npm test fails; fix math.js and add a test.",
    );
    assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.detail}`);
    assert.match(turn.verification?.independenceDetail ?? "", /with Nexus's own test edits set aside/);
  });

  test("an operator-configured verifier is the operator's own check: VERIFIED without the pre-change run", { timeout: 60_000 }, async () => {
    const verifier = "env -u NODE_TEST_CONTEXT node --test test/*.test.js";
    const { turn } = await run(
      { "package.json": PKG, "slugify.js": SLUG, "test/slugify.test.js": SLUG_TEST },
      [write("slugify.js", SLUG_WRONG), done],
      "Add a maxLength option to slugify.",
      { authoritativeVerifierCommand: verifier },
    );
    assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.detail}`);
    assert.equal(turn.verification?.source, "configured");
  });
});
