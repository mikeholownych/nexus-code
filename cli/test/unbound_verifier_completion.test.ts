/**
 * A verifier whose workspace definition cannot be bound before the work (e.g. `npm test` under a node_modules tree)
 * must not block completion. It can never be independent evidence: the turn is REGRESSION_FREE, never VERIFIED.
 * A bindable definition that has no baseline, or that drifted, still blocks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { isInlineProgramVerifier, snapshotVerifierDefinition, snapshotVerifierDefinitionWithReason } from "../src/core/independent_check.js";
import { applyRequirementUpdates } from "../src/core/objective.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, Reply } from "./helpers/fixtures.js";

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, extra: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
  ...extra,
});
const write = (name: string, content: string): Reply => ({
  kind: "tools",
  calls: [{ name: "write_file", args: { path: name, content, overwrite: true } }],
});
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };

const PKG = JSON.stringify({
  name: "x",
  version: "1.0.0",
  private: true,
  main: "./math.js",
  scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" },
});
const ADD_BUGGY = "exports.add = (a, b) => a - b;\n";
const ADD_FIXED = "exports.add = (a, b) => a + b;\n";
const ADD_TEST =
  'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-unbound-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

const withModules = { "package.json": PKG, "test/math.test.js": ADD_TEST, "node_modules/.bin/.keep": "" };
const withoutModules = { "package.json": PKG, "test/math.test.js": ADD_TEST };

const manyRefs = Array.from({ length: 140 }, (_, i) => `scripts/s${i}.js`);
const bigMakefile =
  ".PHONY: test\ntest:\n\tenv -u NODE_TEST_CONTEXT node --test test/*.test.js\n\n" + manyRefs.map((f) => `# ${f}`).join("\n") + "\n";
const withBigMakefile = {
  Makefile: bigMakefile,
  "test/math.test.js": ADD_TEST,
  ...Object.fromEntries(manyRefs.map((f) => [f, "\n"])),
};

async function run(
  files: Record<string, string>,
  steps: Reply[],
  beforeTurn?: (agent: AutonomousAgent) => void,
  extra: Partial<HarnessConfig> = {},
  afterTurn?: (agent: AutonomousAgent) => void,
) {
  const root = repo(files);
  const gw = await startGateway((n) => steps[n - 1] ?? { kind: "text", content: "done" });
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root, extra)));
  const savedHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-unbound-home-"));
  try {
    beforeTurn?.(agent);
    const turn = extra.worktree ? await agent.run("Fix math.js.") : await agent.runTurn("Fix math.js.");
    afterTurn?.(agent);
    return { turn, root };
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(process.env.HOME!, { recursive: true, force: true });
    process.env.HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("verifier whose definition cannot be bound", () => {
  test("snapshotVerifierDefinition is null with node_modules and a Map without", () => {
    const without = repo(withoutModules);
    const withNm = repo(withModules);
    try {
      const bound = snapshotVerifierDefinition(without, "npm test", []);
      assert.ok(bound instanceof Map && bound.size > 0);
      assert.equal(snapshotVerifierDefinition(withNm, "npm test", []), null);
    } finally {
      fs.rmSync(without, { recursive: true, force: true });
      fs.rmSync(withNm, { recursive: true, force: true });
    }
  });

  test("completion is not blocked and is REGRESSION_FREE, never VERIFIED", { timeout: 60_000 }, async () => {
    const { turn } = await run({ ...withModules, "math.js": ADD_BUGGY }, [write("math.js", ADD_FIXED), done]);
    assert.notEqual(turn.outcome, "VERIFIED");
    assert.equal(turn.outcome, "REGRESSION_FREE");
    assert.equal(turn.verification?.status, "PASSED");
    assert.equal(turn.verification?.definitionBound, false);
    assert.equal(turn.verification?.independent, false);
    assert.match(turn.detail ?? "", /^Tests pass, but the verifier's definition could not be bound \(.*node_modules.*\), so the pass cannot be independent evidence\.$/);
    assert.doesNotMatch(turn.detail ?? "", /fresh task/);
  });

  test("a make test verifier referencing more than 128 files is REGRESSION_FREE with the real reason", { timeout: 60_000 }, async () => {
    const ws = repo(withBigMakefile);
    try {
      assert.equal(snapshotVerifierDefinition(ws, "make test", []), null);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
    const { turn } = await run({ ...withBigMakefile, "math.js": ADD_BUGGY }, [write("math.js", ADD_FIXED), done]);
    assert.equal(turn.outcome, "REGRESSION_FREE");
    assert.equal(turn.verification?.command, "make test");
    assert.equal(turn.verification?.definitionBound, false);
    assert.match(turn.detail ?? "", /more than 128 files/);
    assert.doesNotMatch(turn.detail ?? "", /node_modules/);
  });

  test("a failing test is still FAILED", { timeout: 60_000 }, async () => {
    const { turn } = await run({ ...withModules, "math.js": ADD_BUGGY }, [write("math.js", "exports.add = (a, b) => a - b - 0;\n"), done]);
    assert.notEqual(turn.outcome, "VERIFIED");
    assert.notEqual(turn.outcome, "REGRESSION_FREE");
    assert.equal(turn.verification?.status, "FAILED");
  });

  test("a bindable verifier with no baseline is still a hard error", { timeout: 60_000 }, async () => {
    const { turn } = await run({ ...withoutModules, "math.js": ADD_BUGGY }, [write("math.js", ADD_FIXED), done], (agent) => {
      (agent as any).changeBaseline = null;
    });
    assert.equal(turn.outcome, "NOT_ESTABLISHED");
    assert.equal(turn.verification?.status, "FAILED");
    assert.match(turn.verification?.independenceDetail ?? "", /no matching pre-change baseline/);
    assert.equal(turn.verification?.definitionBound, undefined);
  });

  test("a bindable verifier whose definition drifted is still a hard error", { timeout: 60_000 }, async () => {
    const drifted = JSON.stringify({ ...JSON.parse(PKG), scripts: { test: "node --test" } });
    const { turn } = await run({ ...withoutModules, "math.js": ADD_BUGGY }, [write("package.json", drifted), done]);
    assert.equal(turn.outcome, "NOT_ESTABLISHED");
    assert.equal(turn.verification?.status, "FAILED");
    assert.match(turn.verification?.independenceDetail ?? "", /verifier definition changed/);
  });
  test("an unbound configured verifier earns no receipt and no worktree merge", { timeout: 90_000 }, async () => {
    let receipt: unknown = "unset";
    let retained: unknown;
    const { turn } = await run(
      { ...withModules, "math.js": ADD_BUGGY },
      [write("math.js", ADD_FIXED), done],
      undefined,
      { worktree: true, authoritativeVerifierCommand: "npm test" },
      (agent) => {
        receipt = (agent as any).activeValidationReceipt;
        retained = agent.getActiveWorktree();
        if (retained) agent.discardActiveWorktree();
      },
    );
    assert.equal(turn.outcome, "REGRESSION_FREE");
    assert.equal(turn.verification?.definitionBound, false);
    assert.equal(receipt, undefined);
    assert.ok(retained, "the worktree is retained, not merged");
  });

  test("no baseline plus an unbindable definition now is still a hard error", { timeout: 60_000 }, async () => {
    const { turn } = await run({ ...withModules, "math.js": ADD_BUGGY }, [write("math.js", ADD_FIXED), done], (agent) => {
      (agent as any).changeBaseline = null;
    });
    assert.equal(turn.outcome, "NOT_ESTABLISHED");
    assert.match(turn.verification?.independenceDetail ?? "", /no matching pre-change baseline/);
    assert.equal(turn.verification?.definitionBound, undefined);
  });

  test("shell -c program verifiers in every flag shape are detected", () => {
    for (const command of ["bash -c 'npm test'", "bash -x -c 'npm test'", "bash --norc -c 'npm test'", "bash -ce 'npm test'", "sh -c ./verify", "zsh -c ./verify", "env FOO=1 bash -c ./verify", "python -c 'import verify'", "python3 -c 'x'", "node -e 'require(\"./verify\")'", "node --eval 'x'", "node -p 1", "perl -e 'x'", "ruby -e 'x'"]) {
      assert.equal(isInlineProgramVerifier(command), true, command);
    }
    for (const command of ["npm test", "make test", "node --test", "bash verify.sh", "python -m pytest", "node --import tsx --test test/a.test.js", "env -u NODE_TEST_CONTEXT node --test"]) assert.equal(isInlineProgramVerifier(command), false, command);
  });

  test("an unbound shell -c configured verifier still hard-fails", { timeout: 60_000 }, async () => {
    const { turn } = await run(
      { ...withModules, "math.js": ADD_BUGGY },
      [write("math.js", ADD_FIXED), done],
      undefined,
      { authoritativeVerifierCommand: "bash -x -c 'env -u NODE_TEST_CONTEXT npm test'" },
    );
    assert.equal(turn.outcome, "NOT_ESTABLISHED");
    assert.equal(turn.verification?.status, "FAILED");
    assert.equal(turn.verification?.definitionBound, undefined);
  });

  test("a verified requirement is rejected for the unbound attempt", { timeout: 60_000 }, async () => {
    let rejected: string[] = [];
    let attemptIndependent: boolean | undefined;
    await run({ ...withModules, "math.js": ADD_BUGGY }, [write("math.js", ADD_FIXED), done], undefined, {}, (agent) => {
      const ledger = agent.getObjective()!;
      const attempt = ledger.verification.at(-1)!;
      attemptIndependent = attempt.independent;
      rejected = applyRequirementUpdates(ledger, [{ id: ledger.requirements[0].id, status: "verified", evidence: ["tests ran"] }], undefined, undefined, attempt).errors;
    });
    assert.equal(attemptIndependent, false);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0], /verified requires/);
  });

  test("an unbound pass keeps the pending obligation and the baseline", { timeout: 60_000 }, async () => {
    let pending: boolean | undefined;
    let baseline: any;
    let modified = 0;
    const { turn } = await run({ ...withModules, "math.js": ADD_BUGGY }, [write("math.js", ADD_FIXED), done], undefined, {}, (agent) => {
      pending = agent.hasUnverifiedChanges();
      baseline = (agent as any).changeBaseline;
      modified = (agent as any).modifiedFiles.size;
    });
    assert.equal(turn.outcome, "REGRESSION_FREE");
    assert.equal(turn.unverifiedChangesPending, true);
    assert.equal(pending, true);
    assert.ok(baseline?.verifierUnbindableReason);
    assert.ok(modified > 0);
  });

  test("a bound verifier clears the obligation and the baseline as before", { timeout: 60_000 }, async () => {
    let pending: boolean | undefined;
    let baseline: unknown = "unset";
    const { turn } = await run({ ...withoutModules, "math.js": ADD_BUGGY }, [write("math.js", ADD_FIXED), done], undefined, { authoritativeVerifierCommand: "npm test", trustedDeliverableFiles: ["math.js"] }, (agent) => {
      pending = agent.hasUnverifiedChanges();
      baseline = (agent as any).changeBaseline;
    });
    assert.equal(turn.verification?.status, "PASSED");
    assert.equal(turn.verification?.definitionBound, undefined);
    assert.equal(pending, false);
    assert.equal(baseline, undefined);
  });

  test("a resumed task with a recovered baseline and an unbindable definition is still a hard error", { timeout: 60_000 }, async () => {
    const { turn } = await run({ ...withModules, "math.js": ADD_BUGGY }, [write("math.js", ADD_FIXED), done], (agent) => {
      (agent as any).untrustedRecoveredBaseline = { command: "npm test", failed: true, tests: {}, verifier: null, trustedDeliverables: [], at: "x" };
      (agent as any).hasPendingModifications = true;
      (agent as any).verificationBaselineInvalidated = true;
      (agent as any).changeBaseline = null;
    });
    assert.equal(turn.outcome, "NOT_ESTABLISHED");
    assert.match(turn.verification?.independenceDetail ?? "", /no matching pre-change baseline/);
    assert.equal(turn.verification?.definitionBound, undefined);
  });

  test("each unbindable shape names its own reason, never the generic one", () => {
    const cases: Array<[Record<string, string>, string, RegExp]> = [
      [{ "package.json": JSON.stringify({ name: "x" }) }, "npm test", /no test script/],
      [{ "package.json": PKG, ".npmrc": "//r/:_authToken=abc\n" }, "npm test", /credentials/],
      [{ "package.json": "{" }, "npm test", /not valid JSON/],
      [{ "a.txt": "x" }, "go test ./...", /go\.mod/],
      [{ "a.txt": "x" }, "cargo test", /Cargo\.toml/],
      [{ "a.txt": "x" }, "pytest", /pytest configuration/],
      [{ "a.txt": "x" }, "node --test", /no existing test files/],
      [{ "Makefile": "all:\n" }, "make test", /no test target/],
    ];
    for (const [files, command, expected] of cases) {
      const ws = repo(files);
      try {
        const result = snapshotVerifierDefinitionWithReason(ws, command, []);
        assert.equal(result.verifier, null, command);
        assert.match((result as { reason: string }).reason, expected, command);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    }
  });
});
