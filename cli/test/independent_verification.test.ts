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
import {
  judgeWithoutCopy,
  npmDependencyBoundaryChangedSince,
  prepareBaselineTestsCopy,
  requiresWorkspaceVerifierDefinitionBinding,
  snapshotTests,
  snapshotVerifierDefinition,
  verifierDefinitionChangedSince,
} from "../src/core/independent_check.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, Reply } from "./helpers/fixtures.js";
import { isWorkspaceTestSupportFile } from "../src/tester.js";

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (
  endpoint: string,
  workspace: string,
  o: Partial<HarnessConfig> = {},
): HarnessConfig => ({
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
const write = (name: string, content: string): Reply => ({
  kind: "tools",
  calls: [
    { name: "write_file", args: { path: name, content, overwrite: true } },
  ],
});
const done: Reply = {
  kind: "tools",
  calls: [{ name: "task_completed", args: { summary: "done" } }],
};

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-independent-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  execSync(
    "git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base",
    { cwd: root, stdio: "ignore" },
  );
  return root;
}

// NODE_TEST_CONTEXT is cleared: inherited from this suite's runner, it makes a nested `node --test` report to its parent
// instead of printing the report the verifier reads.
const PKG = JSON.stringify({
  name: "x",
  version: "1.0.0",
  private: true,
  main: "./math.js",
  scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" },
});
const SLUG_PKG = JSON.stringify({
  name: "x",
  version: "1.0.0",
  private: true,
  main: "./slugify.js",
  scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" },
});
const SLUG =
  'function slugify(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }\nmodule.exports = { slugify };\n';
const SLUG_TEST =
  'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { slugify } = require("../slugify.js");\ntest("basic", () => assert.equal(slugify("Hello, World!"), "hello-world"));\n';
// The pilot's misreading: a slug of exactly maxLength characters is cut back a word.
const SLUG_WRONG =
  'function slugify(t, o = {}) {\n  let s = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n' +
  '  if (o.maxLength !== undefined && s.length >= o.maxLength) { const cut = s.slice(0, o.maxLength).lastIndexOf("-"); s = cut > 0 ? s.slice(0, cut) : s.slice(0, o.maxLength); }\n' +
  "  return s;\n}\nmodule.exports = { slugify };\n";
const SLUG_TEST_WRONG =
  SLUG_TEST +
  'test("maxLength", () => assert.equal(slugify("The quick brown fox", { maxLength: 15 }), "the-quick"));\n';

const ADD_BUGGY = "exports.add = (a, b) => a - b;\n";
const ADD_FIXED = "exports.add = (a, b) => a + b;\n";
const ADD_TEST =
  'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';

async function run(
  files: Record<string, string>,
  steps: Reply[],
  objective: string,
  extra: Partial<HarnessConfig> = {},
  beforeTurn?: (agent: AutonomousAgent, root: string) => void,
) {
  const root = repo(files);
  const gw = await startGateway(
    (n) => steps[n - 1] ?? { kind: "text", content: "done" },
  );
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root, extra)));
  try {
    beforeTurn?.(agent, root);
    const turn = await agent.runTurn(objective);
    return {
      turn,
      root,
      agent,
      leftovers: fs.existsSync(path.join(root, ".nexus/verify"))
        ? fs.readdirSync(path.join(root, ".nexus/verify"))
        : [],
    };
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("VERIFIED needs evidence Nexus did not write", () => {
  test("only explicit test execution supports current-task regression evidence", async () => {
    const { agent } = await run(
      {
        "package.json": PKG,
        "math.js": ADD_FIXED,
        "test/math.test.js": ADD_TEST,
      },
      [{ kind: "text", content: "done" }],
      "read only",
    );
    const build = (hasExecutedTests: boolean | undefined, invalidated: boolean) => {
      (agent as any).hasPendingModifications = true;
      (agent as any).verificationBaselineInvalidated = invalidated;
      (agent as any).verificationEvidence = {
        status: "PASSED",
        command: "npm test",
        exitSuccess: true,
        ...(hasExecutedTests === undefined ? {} : { hasExecutedTests }),
        isDeliverableBound: false,
      };
      return (agent as any).buildTurnResult({
        modelStop: "NONE",
        finalOutputComplete: true,
        inferenceFailure: null,
        interruption: null,
        limitReached: false,
        stepsUsed: 1,
      });
    };

    const executed = build(true, false);
    assert.equal(executed.outcome, "REGRESSION_FREE");
    assert.equal(executed.unverifiedChangesPending, true);

    for (const missingExecutionEvidence of [false, undefined]) {
      const result = build(missingExecutionEvidence, false);
      assert.equal(result.outcome, "UNVERIFIED");
      assert.equal(result.unverifiedChangesPending, true);
    }

    const recovered = build(true, true);
    assert.equal(recovered.outcome, "UNVERIFIED");
    assert.equal(recovered.unverifiedChangesPending, true);

    (agent as any).objective = {
      requirements: [{ id: "R1", source: "operator", status: "open", text: "complete the requested work" }],
      verification: [],
    };
    const incomplete = build(true, false);
    assert.equal(incomplete.outcome, "NOT_ESTABLISHED");
    assert.equal(incomplete.reason, "REQUIREMENTS_INCOMPLETE");
    assert.equal(incomplete.unverifiedChangesPending, true);
  });

  test("runtime package entrypoints resolve compiled JavaScript paths to TypeScript product dependencies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runtime-typescript-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "./dist/index.js" }));
      fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "./src", outDir: "./dist" } }));
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/index.ts"), 'import { add } from "./math.js"; export { add };\n');
      fs.writeFileSync(path.join(root, "src/math.ts"), "export const add = (a: number, b: number) => a + b;\n");
      fs.writeFileSync(path.join(root, "src/assertions.ts"), "export const assert = () => {};\n");
      assert.equal(isWorkspaceTestSupportFile(root, "src/math.ts"), false);
      assert.equal(isWorkspaceTestSupportFile(root, "src/assertions.ts"), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("TypeScript test-support imports using .js specifiers are frozen in the verifier baseline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-typescript-test-support-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "./dist/index.js", scripts: { test: "node test.js" } }));
      fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "./src", outDir: "./dist" } }));
      fs.writeFileSync(path.join(root, "test.js"), "process.exit(1);\n");
      fs.mkdirSync(path.join(root, "src"));
      fs.mkdirSync(path.join(root, "test"));
      fs.writeFileSync(path.join(root, "src/index.ts"), 'import { add } from "./math.js"; export { add };\n');
      fs.writeFileSync(path.join(root, "src/math.ts"), "export const add = 1;\n");
      fs.writeFileSync(path.join(root, "src/assertions.ts"), "export const assert = () => {};\n");
      fs.writeFileSync(path.join(root, "test/math.test.ts"), 'import { assert } from "../src/assertions.js"; void assert;\n');
      const verifier = snapshotVerifierDefinition(root, "npm test");
      assert.ok(verifier);
      assert.ok(verifier.has("src/assertions.ts"));
      const baseline = { command: "npm test", failed: true, tests: new Map(), verifier, at: new Date().toISOString() };
      fs.writeFileSync(path.join(root, "src/assertions.ts"), "export const assert = () => true;\n");
      assert.equal(verifierDefinitionChangedSince(root, baseline), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(
    "a new feature checked only by tests Nexus added is REGRESSION_FREE, not VERIFIED (pilot slugify)",
    { timeout: 60_000 },
    async () => {
      const { turn } = await run(
        {
          "package.json": SLUG_PKG,
          "slugify.js": SLUG,
          "test/slugify.test.js": SLUG_TEST,
        },
        [
          write("slugify.js", SLUG_WRONG),
          write("test/slugify.test.js", SLUG_TEST_WRONG),
          done,
        ],
        "Add a maxLength option to slugify.",
      );
      assert.equal(
        turn.verification?.status,
        "PASSED",
        "npm test passes on the agent's own tests",
      );
      assert.equal(
        turn.outcome,
        "REGRESSION_FREE",
        `${turn.outcome}: ${turn.detail}`,
      );
      assert.match(
        turn.detail ?? "",
        /did not cover the modified deliverables/,
      );
      assert.notEqual(turn.verification?.independent, true);
    },
  );

  test(
    "a bug fix that makes an existing failing test pass is VERIFIED (fail before, pass after)",
    { timeout: 60_000 },
    async () => {
      const { turn } = await run(
        {
          "package.json": PKG,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [write("math.js", ADD_FIXED), done],
        "npm test fails; fix math.js.",
        { trustedDeliverableFiles: ["math.js"] },
      );
      assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.detail}`);
      assert.equal(turn.verification?.independent, true);
    },
  );

  test(
    "making the failing test pass by editing the test, not the code, is not VERIFIED",
    { timeout: 60_000 },
    async () => {
      const weakened = ADD_TEST.replace(
        "assert.equal(add(2, 3), 5)",
        "assert.equal(add(2, 3), -1)",
      );
      const { turn, leftovers } = await run(
        {
          "package.json": PKG,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [write("test/math.test.js", weakened), done],
        "npm test fails; fix it.",
      );
      assert.equal(turn.verification?.status, "PASSED");
      assert.equal(
        turn.outcome,
        "REGRESSION_FREE",
        `${turn.outcome}: ${turn.detail}`,
      );
      assert.match(
        turn.detail ?? "",
        /did not cover the modified deliverables/,
      );
      assert.deepEqual(
        leftovers,
        [],
        "the copy used for the pre-change tests is removed",
      );
    },
  );

  test(
    "changing the npm verifier to print a fake TAP footer cannot produce VERIFIED",
    { timeout: 60_000 },
    async () => {
      const fakeTap =
        "node -e \"console.log('# tests 1\\n# suites 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1')\"";
      const packageWithFakeVerifier = JSON.stringify({
        name: "x",
        version: "1.0.0",
        private: true,
        scripts: { test: fakeTap },
      });
      const { turn, agent } = await run(
        {
          "package.json": PKG,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [
          write("package.json", packageWithFakeVerifier),
          done,
          {
            kind: "text",
            content:
              "The verifier definition changed; I cannot claim this as verified.",
          },
        ],
        "Fix math.js and preserve a trustworthy test result.",
      );
      assert.equal(
        turn.outcome,
        "NOT_ESTABLISHED",
        `${turn.outcome}: ${turn.detail}`,
      );
      assert.equal(turn.reason, "VERIFIER_FAILED");
      assert.equal(turn.verification?.status, "FAILED");
      assert.equal(turn.verification?.hasExecutedTests, false);
      assert.match(
        turn.verification?.independenceDetail ?? "",
        /verifier definition changed/,
      );
      const completionRefusal = (agent as any).messages.find(
        (message: any) =>
          message.role === "tool" &&
          message.name === "task_completed" &&
          /workspace-resolved verifier definition changed/.test(
            String(message.content),
          ),
      );
      assert.ok(
        completionRefusal,
        "task_completed reports why the candidate verifier was not run",
      );
    },
  );

  test("baseline-copy verification restores npm verifier configuration and its direct runner", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-verifier-definition-"),
    );
    try {
      const originalPackage = JSON.stringify({
        scripts: { test: "node scripts/run_tests.mjs" },
      });
      const originalRunner = "console.log('baseline runner');\n";
      fs.mkdirSync(path.join(root, "scripts"));
      fs.writeFileSync(path.join(root, "package.json"), originalPackage);
      fs.writeFileSync(
        path.join(root, "scripts/run_tests.mjs"),
        originalRunner,
      );
      fs.mkdirSync(path.join(root, "test"));
      fs.writeFileSync(
        path.join(root, "test/check.test.js"),
        "test('baseline', () => {});\n",
      );
      const tests = snapshotTests(root);
      const verifier = snapshotVerifierDefinition(root, "npm test");
      assert.ok(tests);
      assert.ok(verifier);
      const baseline = {
        command: "npm test",
        failed: true,
        tests,
        verifier,
        at: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          scripts: { test: "node -e console.log('fake TAP')" },
        }),
      );
      fs.writeFileSync(
        path.join(root, "scripts/run_tests.mjs"),
        "console.log('fake TAP');\n",
      );
      assert.equal(verifierDefinitionChangedSince(root, baseline), true);
      assert.equal(judgeWithoutCopy(root, "npm test", baseline), "needs-copy");
      const copy = prepareBaselineTestsCopy(root, tests!, verifier!);
      assert.ok(copy);
      try {
        assert.equal(
          fs.readFileSync(path.join(copy!, "package.json"), "utf8"),
          originalPackage,
        );
        assert.equal(
          fs.readFileSync(path.join(copy!, "scripts/run_tests.mjs"), "utf8"),
          originalRunner,
        );
      } finally {
        fs.rmSync(copy!, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Node test membership is task evidence, not mutable verifier configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-node-tests-"));
    try {
      fs.mkdirSync(path.join(root, "test"));
      fs.writeFileSync(path.join(root, "test/one.test.js"), "test('one');\n");
      const verifier = snapshotVerifierDefinition(
        root,
        "env -u NODE_TEST_CONTEXT node --test test/*.test.js",
      );
      assert.ok(verifier);
      const baseline = {
        command: "env -u NODE_TEST_CONTEXT node --test test/*.test.js",
        failed: false,
        tests: null,
        verifier,
        at: new Date().toISOString(),
      };
      assert.equal(verifierDefinitionChangedSince(root, baseline), false);
      fs.writeFileSync(path.join(root, "test/two.test.js"), "test('two');\n");
      assert.equal(verifierDefinitionChangedSince(root, baseline), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("extensionless local verifier scripts are bound from package and Makefile definitions", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-extensionless-verifier-"),
    );
    try {
      fs.mkdirSync(path.join(root, "scripts"));
      fs.mkdirSync(path.join(root, "ci"));
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "./scripts/verify" } }),
      );
      fs.writeFileSync(path.join(root, "scripts/verify"), "exit 1\n");
      fs.writeFileSync(path.join(root, "Makefile"), "test:\n\tsh ci/test\n");
      fs.writeFileSync(path.join(root, "ci/test"), "exit 1\n");

      const packageVerifier = snapshotVerifierDefinition(root, "npm test");
      const makeVerifier = snapshotVerifierDefinition(root, "make test");
      assert.ok(packageVerifier);
      assert.ok(makeVerifier);
      assert.ok(packageVerifier.has("scripts/verify"));
      assert.ok(makeVerifier.has("ci/test"));

      const packageBaseline = {
        command: "npm test",
        failed: true,
        tests: null,
        verifier: packageVerifier,
        at: new Date().toISOString(),
      };
      const makeBaseline = {
        command: "make test",
        failed: true,
        tests: null,
        verifier: makeVerifier,
        at: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(root, "scripts/verify"), "echo fake TAP\n");
      fs.writeFileSync(path.join(root, "ci/test"), "echo fake TAP\n");
      assert.equal(verifierDefinitionChangedSince(root, packageBaseline), true);
      assert.equal(verifierDefinitionChangedSince(root, makeBaseline), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("all shell command wrappers enter the fail-closed verifier binding guard", () => {
    for (const command of [
      "bash -c './verify.sh'",
      "bash -lc 'npm test'",
      "env sh -c 'printf fake TAP'",
      "zsh -c 'node --test'",
      "bash --command='./verify.sh'",
    ]) {
      assert.equal(
        requiresWorkspaceVerifierDefinitionBinding(command),
        true,
        command,
      );
      assert.equal(
        snapshotVerifierDefinition(process.cwd(), command),
        null,
        `${command} is deliberately unsupported by the bounded snapshot grammar`,
      );
    }
  });

  test("direct bare interpreter scripts require verifier-definition binding", () => {
    for (const command of ["node verify", "python check", "sh ci-check"]) {
      assert.equal(
        requiresWorkspaceVerifierDefinitionBinding(command),
        true,
        command,
      );
    }
    assert.equal(
      requiresWorkspaceVerifierDefinitionBinding("node -e 'process.exit(0)'"),
      false,
      "an inline interpreter expression is not a workspace script",
    );
  });

  test("Makefile baseline captures nested npm verifier manifests and runners", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-nested-verifier-"),
    );
    try {
      fs.writeFileSync(
        path.join(root, "Makefile"),
        "test:\n\tnpm --prefix cli test\n",
      );
      fs.mkdirSync(path.join(root, "cli/scripts"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "cli/package.json"),
        JSON.stringify({ scripts: { test: "node scripts/run_tests.mjs" } }),
      );
      fs.writeFileSync(
        path.join(root, "cli/scripts/run_tests.mjs"),
        "console.log('real runner');\n",
      );
      const baseline = snapshotVerifierDefinition(root, "make test");
      assert.ok(baseline);
      assert.ok(baseline!.has("Makefile"));
      assert.ok(baseline!.has("cli/package.json"));
      assert.ok(baseline!.has("cli/scripts/run_tests.mjs"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("npm verifier baseline fails closed when workspace dependencies already exist", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-verifier-dependencies-"),
    );
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      fs.mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "node_modules/.bin/vitest"),
        "#!/bin/sh\necho fake\n",
      );
      assert.equal(snapshotVerifierDefinition(root, "npm test"), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a local dependency tree appearing after baseline cannot establish independence", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-verifier-new-dependencies-"),
    );
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "node test.js" } }),
      );
      fs.writeFileSync(
        path.join(root, "test.js"),
        "throw new Error('baseline failure');\n",
      );
      fs.mkdirSync(path.join(root, "test"));
      fs.writeFileSync(
        path.join(root, "test/check.test.js"),
        "test('baseline', () => {});\n",
      );
      const tests = snapshotTests(root);
      const verifier = snapshotVerifierDefinition(root, "npm test");
      assert.ok(tests);
      assert.ok(verifier);
      const baseline = {
        command: "npm test",
        failed: true,
        tests,
        verifier,
        at: new Date().toISOString(),
      };
      fs.mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "node_modules/.bin/node"),
        "#!/bin/sh\necho fake\n",
      );
      assert.equal(npmDependencyBoundaryChangedSince(root, baseline), true);
      assert.deepEqual(judgeWithoutCopy(root, "npm test", baseline), {
        independent: false,
        detail:
          "a workspace-local npm dependency tree appeared after the baseline; its executable and package contents are not independently bound",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("npm project configuration is captured or removed in a baseline copy", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-verifier-npmrc-"),
    );
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "node test.js" } }),
      );
      fs.writeFileSync(
        path.join(root, "test.js"),
        "throw new Error('baseline failure');\n",
      );
      fs.mkdirSync(path.join(root, "test"));
      fs.writeFileSync(
        path.join(root, "test/check.test.js"),
        "test('baseline', () => {});\n",
      );
      const tests = snapshotTests(root);
      const verifier = snapshotVerifierDefinition(root, "npm test");
      assert.ok(tests);
      assert.ok(verifier);
      const baseline = {
        command: "npm test",
        failed: true,
        tests,
        verifier,
        at: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(root, ".npmrc"),
        "script-shell=/tmp/fake-shell\n",
      );
      assert.equal(verifierDefinitionChangedSince(root, baseline), true);
      const copy = prepareBaselineTestsCopy(root, tests!, verifier!);
      assert.ok(copy);
      try {
        assert.equal(fs.existsSync(path.join(copy!, ".npmrc")), false);
      } finally {
        fs.rmSync(copy!, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("credential-bearing npmrc fails closed without retaining short auth values", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-verifier-npmrc-secret-"),
    );
    const canaries = ["shortcred", "tiny-token", "commentpass", "comment-user"];
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "node test.js" } }),
      );
      fs.writeFileSync(path.join(root, "test.js"), "throw new Error('baseline failure');\n");
      fs.mkdirSync(path.join(root, "test"));
      fs.writeFileSync(path.join(root, "test/check.test.js"), "test('baseline', () => {});\n");
      fs.writeFileSync(
        path.join(root, ".npmrc"),
        `//registry.example/:_auth=${canaries[0]}\n_authToken=${canaries[1]}\n` +
          `# //registry.example/:_password=${canaries[2]}\n` +
          `; username=${canaries[3]}\n`,
      );

      const verifier = snapshotVerifierDefinition(root, "npm test");
      assert.equal(verifier, null);
      const durableBaseline = JSON.stringify({ changeBaseline: { verifier } });
      for (const canary of canaries) assert.equal(durableBaseline.includes(canary), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a new nested package entrypoint cannot reclassify a test helper after baseline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runtime-entrypoint-set-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ main: "./src/math.js", scripts: { test: "node test.js" } }));
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/math.js"), ADD_BUGGY);
      fs.writeFileSync(path.join(root, "test.js"), "throw new Error('baseline failure');\n");
      fs.mkdirSync(path.join(root, "test"));
      fs.writeFileSync(path.join(root, "test/check.test.js"), "test('baseline', () => {});\n");
      const verifier = snapshotVerifierDefinition(root, "npm test");
      assert.ok(verifier);
      const baseline = { command: "npm test", failed: true, tests: new Map(), verifier, at: new Date().toISOString() };
      fs.mkdirSync(path.join(root, "helpers"));
      fs.writeFileSync(path.join(root, "helpers/package.json"), JSON.stringify({ main: "../src/assertions.js" }));
      assert.equal(verifierDefinitionChangedSince(root, baseline), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an internal absolute symlink in the baseline copy resolves inside the copy", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-verifier-symlink-"),
    );
    try {
      fs.mkdirSync(path.join(root, "scripts"));
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "node scripts/run.js" } }),
      );
      fs.writeFileSync(
        path.join(root, "scripts/run.js"),
        "console.log('baseline runner');\n",
      );
      fs.symlinkSync(
        path.join(root, "scripts/run.js"),
        path.join(root, "runner.js"),
      );
      fs.mkdirSync(path.join(root, "test"));
      fs.writeFileSync(
        path.join(root, "test/check.test.js"),
        "test('baseline', () => {});\n",
      );
      const tests = snapshotTests(root);
      const verifier = snapshotVerifierDefinition(root, "npm test");
      assert.ok(tests);
      assert.ok(verifier);
      fs.writeFileSync(
        path.join(root, "scripts/run.js"),
        "console.log('candidate runner');\n",
      );
      const copy = prepareBaselineTestsCopy(root, tests!, verifier!);
      assert.ok(copy);
      try {
        const copiedLink = path.join(copy!, "runner.js");
        assert.equal(
          fs.realpathSync(copiedLink),
          path.join(copy!, "scripts/run.js"),
        );
        assert.equal(
          fs.readFileSync(copiedLink, "utf8"),
          "console.log('baseline runner');\n",
        );
      } finally {
        fs.rmSync(copy!, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Makefile include definitions are bound and unresolved include expansion fails closed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-make-include-"));
    try {
      fs.writeFileSync(path.join(root, "Makefile"), "include checks/test.mk\n");
      fs.mkdirSync(path.join(root, "checks"));
      fs.writeFileSync(
        path.join(root, "checks/test.mk"),
        "test:\n\tnode test.js\n",
      );
      fs.writeFileSync(
        path.join(root, "test.js"),
        "throw new Error('baseline failure');\n",
      );
      const baseline = snapshotVerifierDefinition(root, "make test");
      assert.ok(baseline);
      assert.ok(baseline.has("checks/test.mk"));
      fs.writeFileSync(
        path.join(root, "checks/test.mk"),
        "test:\n\techo fake\n",
      );
      assert.equal(
        verifierDefinitionChangedSince(root, {
          command: "make test",
          failed: true,
          tests: new Map(),
          verifier: baseline,
          trustedDeliverables: [],
          at: new Date().toISOString(),
        }),
        true,
      );
      fs.writeFileSync(path.join(root, "Makefile"), "include $(CHECKS)\n");
      assert.equal(snapshotVerifierDefinition(root, "make test"), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(
    "a fix plus a new test of Nexus's own is VERIFIED when the pre-change test passes without it",
    { timeout: 60_000 },
    async () => {
      const extraTest = ADD_TEST.replace(
        'test("adds"',
        'test("adds negatives"',
      ).replace("add(2, 3), 5", "add(-2, -3), -5");
      const { turn } = await run(
        {
          "package.json": PKG,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [
          write("math.js", ADD_FIXED),
          write("test/more.test.js", extraTest),
          done,
        ],
        "npm test fails; fix math.js and add a test.",
        { trustedDeliverableFiles: ["math.js"] },
      );
      assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.detail}`);
      assert.match(
        turn.verification?.independenceDetail ?? "",
        /with Nexus's own test edits set aside/,
      );
    },
  );

  test(
    "an operator-configured verifier is the operator's own check: VERIFIED without the pre-change run",
    { timeout: 60_000 },
    async () => {
      const verifier = "env -u NODE_TEST_CONTEXT node --test test/*.test.js";
      const { turn } = await run(
        {
          "package.json": SLUG_PKG,
          "slugify.js": SLUG,
          "test/slugify.test.js": SLUG_TEST,
        },
        [write("slugify.js", SLUG_WRONG), done],
        "Add a maxLength option to slugify.",
        { authoritativeVerifierCommand: verifier, trustedDeliverableFiles: ["slugify.js"] },
      );
      assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.detail}`);
      assert.equal(turn.verification?.source, "configured");
    },
  );

  test(
    "an operator-configured workspace verifier cannot be replaced with candidate-controlled TAP",
    { timeout: 60_000 },
    async () => {
      const fakeTap =
        "node -e \"console.log('# tests 1\\n# suites 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1')\"";
      const packageWithFakeVerifier = JSON.stringify({
        name: "x",
        version: "1.0.0",
        private: true,
        scripts: { test: fakeTap },
      });
      const { turn, agent } = await run(
        {
          "package.json": PKG,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [
          write("package.json", packageWithFakeVerifier),
          done,
          {
            kind: "text",
            content:
              "The configured verifier definition changed; I cannot claim this as verified.",
          },
        ],
        "Fix math.js and keep the operator verifier intact.",
        { authoritativeVerifierCommand: "npm test" },
      );
      assert.equal(
        turn.outcome,
        "NOT_ESTABLISHED",
        `${turn.outcome}: ${turn.detail}`,
      );
      assert.equal(turn.reason, "VERIFIER_FAILED");
      assert.equal(turn.verification?.status, "FAILED");
      assert.equal(turn.verification?.hasExecutedTests, false);
      assert.match(
        turn.verification?.independenceDetail ?? "",
        /workspace-resolved verifier definition changed/,
      );
      const refusal = (agent as any).messages.find(
        (message: any) =>
          message.role === "tool" &&
          message.name === "task_completed" &&
          /workspace-resolved verifier definition changed/.test(
            String(message.content),
          ),
      );
      assert.ok(
        refusal,
        "task_completed refuses the candidate-replaced operator verifier",
      );
    },
  );

  test(
    "a shell-wrapped package verifier without a supported snapshot fails closed",
    { timeout: 60_000 },
    async () => {
      const fakeTap =
        "node -e \"console.log('# tests 1\\n# suites 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1')\"";
      const packageWithFakeVerifier = JSON.stringify({
        name: "x",
        version: "1.0.0",
        private: true,
        scripts: { test: fakeTap },
      });
      const command = "bash -c 'npm test'";
      const { turn, agent } = await run(
        {
          "package.json": PKG,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [write("package.json", packageWithFakeVerifier), done],
        "Fix math.js while preserving the configured verifier.",
        { authoritativeVerifierCommand: command },
      );

      assert.equal(
        turn.outcome,
        "NOT_ESTABLISHED",
        `${turn.outcome}: ${turn.detail}`,
      );
      assert.equal(turn.reason, "VERIFIER_FAILED");
      assert.equal(turn.verification?.status, "FAILED");
      assert.equal(turn.verification?.hasExecutedTests, false);
      assert.match(
        turn.verification?.independenceDetail ?? "",
        /verifier definition was not captured/,
      );
      const refusal = (agent as any).messages.find(
        (message: any) =>
          message.role === "tool" &&
          message.name === "task_completed" &&
          /verifier definition was not captured/.test(String(message.content)),
      );
      assert.ok(refusal, "task_completed refuses the unsnapshotted wrapper");
    },
  );

  test(
    "a shell wrapper cannot accept a candidate-replaced extensionless local verifier",
    { timeout: 60_000 },
    async () => {
      const tap = "printf '# tests 1\\n# pass 1\\n# fail 0\\n'\n";
      const { turn } = await run(
        {
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
          verify: "exit 1\n",
        },
        [write("verify", tap), done],
        "Fix math.js and keep the configured verifier trustworthy.",
        { authoritativeVerifierCommand: "bash -c './verify'" },
      );
      assert.equal(
        turn.outcome,
        "NOT_ESTABLISHED",
        `${turn.outcome}: ${turn.detail}`,
      );
      assert.equal(turn.reason, "VERIFIER_FAILED");
      assert.equal(turn.verification?.hasExecutedTests, false);
      assert.match(
        turn.verification?.independenceDetail ?? "",
        /verifier definition was not captured/,
      );
    },
  );

  test(
    "a missing local runner cannot be created after its verifier baseline",
    { timeout: 60_000 },
    async () => {
      const packageWithMissingRunner = JSON.stringify({
        name: "x",
        version: "1.0.0",
        private: true,
        scripts: { test: "node verify" },
      });
      const { turn } = await run(
        {
          "package.json": packageWithMissingRunner,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [
          write("verify", "console.log('# tests 1\\n# pass 1\\n# fail 0');\n"),
          done,
        ],
        "Fix math.js without changing the verifier's effective behavior.",
        { authoritativeVerifierCommand: "npm test" },
      );
      assert.equal(
        turn.outcome,
        "NOT_ESTABLISHED",
        `${turn.outcome}: ${turn.detail}`,
      );
      assert.equal(turn.reason, "VERIFIER_FAILED");
      assert.equal(turn.verification?.hasExecutedTests, false);
      assert.match(
        turn.verification?.independenceDetail ?? "",
        /verifier definition changed/,
      );
    },
  );

  test(
    "a stale recovered baseline for a different command cannot authorize the configured verifier",
    { timeout: 60_000 },
    async () => {
      const fakeTap =
        "node -e \"console.log('# tests 1\\n# suites 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1')\"";
      const packageWithFakeVerifier = JSON.stringify({
        name: "x",
        version: "1.0.0",
        private: true,
        scripts: { test: fakeTap },
      });
      const { turn } = await run(
        {
          "package.json": PKG,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [write("package.json", packageWithFakeVerifier), done],
        "Fix math.js while preserving the configured verifier.",
        { authoritativeVerifierCommand: "npm test" },
        (agent) => {
          (agent as any).changeBaseline = {
            command: "npm run test:unit",
            failed: false,
            tests: null,
            verifier: new Map([
              [
                "package.json",
                JSON.stringify({ scripts: { "test:unit": "node --test" } }),
              ],
            ]),
            trustedDeliverables: [],
            at: new Date().toISOString(),
          };
        },
      );
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.verification?.status, "FAILED");
      assert.equal(turn.verification?.hasExecutedTests, false);
      assert.match(
        turn.verification?.independenceDetail ?? "",
        /no matching pre-change baseline/,
      );
    },
  );

  test(
    "a direct bare interpreter script is bound before execution",
    { timeout: 60_000 },
    async () => {
      const { turn } = await run(
        {
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
          verify: "process.exit(1);\n",
        },
        [
          write("verify", "console.log('# tests 1\\n# pass 1\\n# fail 0');\n"),
          done,
        ],
        "Fix math.js without changing the verifier.",
        { authoritativeVerifierCommand: "node verify" },
      );
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.verification?.status, "FAILED");
      assert.equal(turn.verification?.hasExecutedTests, false);
      assert.match(
        turn.verification?.independenceDetail ?? "",
        /verifier definition changed/,
      );
    },
  );

  test(
    "a changed root-level assertion helper cannot make unchanged tests VERIFIED",
    { timeout: 60_000 },
    async () => {
      const helper =
        'const assert = require("node:assert/strict");\nexports.mustBeFive = (value) => assert.equal(value, 5);\n';
      const testFile =
        'const test = require("node:test");\nconst { add } = require("../src/math.js");\nconst { mustBeFive } = require("../test_helpers.js");\ntest("adds", () => mustBeFive(add(2, 3)));\n';
      const { turn } = await run(
        {
          "package.json": JSON.stringify({
            name: "x",
            version: "1.0.0",
            private: true,
            main: "./src/math.js",
            scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" },
          }),
          "src/math.js": ADD_BUGGY,
          "test_helpers.js": helper,
          "test/math.test.js": testFile,
        },
        [
          write("test_helpers.js", "exports.mustBeFive = () => {};\n"),
          done,
          {
            kind: "text",
            content:
              "The test assertion was changed, so this cannot establish the implementation.",
          },
        ],
        "Correct the addition implementation.",
      );
      assert.notEqual(
        turn.outcome,
        "VERIFIED",
        "changing imported test support must not bless the still-broken src/math.js",
      );
      assert.ok(
        turn.verification?.independent === false ||
          turn.verification?.status === "FAILED",
        JSON.stringify(turn.verification),
      );
    },
  );

  test(
    "an unexported assertion helper under src cannot establish VERIFIED",
    { timeout: 60_000 },
    async () => {
      const testFile =
        'const test = require("node:test");\nconst { add } = require("../src/math.js");\nconst { mustBeFive } = require("../src/assertions.js");\ntest("adds", () => mustBeFive(add(2, 3)));\n';
      const { turn } = await run(
        {
          "package.json": JSON.stringify({
            name: "x",
            version: "1.0.0",
            private: true,
            main: "./src/math.js",
            scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" },
          }),
          "src/math.js": ADD_BUGGY,
          "src/assertions.js": 'exports.mustBeFive = (value) => require("node:assert/strict").equal(value, 5);\n',
          "test/math.test.js": testFile,
        },
        [write("src/assertions.js", "exports.mustBeFive = () => {};\n"), done],
        "Correct the addition implementation.",
      );
      assert.notEqual(turn.outcome, "VERIFIED");
      assert.ok(turn.verification?.independent === false || turn.verification?.status === "FAILED");
    },
  );

  test(
    "candidate source edits cannot promote a test helper into the baseline product graph",
    { timeout: 60_000 },
    async () => {
      const testFile =
        'const test = require("node:test");\nconst { add } = require("../src/math.js");\nconst { mustBeFive } = require("../src/assertions.js");\ntest("adds", () => mustBeFive(add(2, 3)));\n';
      const { turn } = await run(
        {
          "package.json": JSON.stringify({
            name: "x",
            version: "1.0.0",
            private: true,
            main: "./src/index.js",
            scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" },
          }),
          "src/index.js": 'const { add } = require("./math.js");\nexports.add = add;\n',
          "src/math.js": ADD_BUGGY,
          "src/assertions.js": 'exports.mustBeFive = (value) => require("node:assert/strict").equal(value, 5);\n',
          "test/math.test.js": testFile,
        },
        [
          write("src/assertions.js", "exports.mustBeFive = () => {};\n"),
          write("src/index.js", 'require("./assertions.js");\nconst { add } = require("./math.js");\nexports.add = add;\n'),
          done,
          { kind: "text", content: "This test-support edit cannot establish the broken math change." },
        ],
        "Correct the addition implementation.",
      );
      assert.notEqual(turn.outcome, "VERIFIED");
      assert.ok(turn.verification?.independent === false || turn.verification?.status === "FAILED");
    },
  );

  test(
    "a dual-use assertion module already in the product graph cannot repair a broken product outside operator scope",
    { timeout: 60_000 },
    async () => {
      const { turn } = await run(
        {
          "package.json": JSON.stringify({
            name: "x", version: "1.0.0", private: true,
            main: "./src/index.js",
            scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" },
          }),
          "src/index.js": 'exports.add = require("./math.js").add; exports.mustBeFive = require("./assertions.js").mustBeFive;\n',
          "src/math.js": "exports.add = (a, b) => a - b;\n",
          "src/assertions.js": "exports.mustBeFive = (value) => { if (value !== 5) throw new Error('expected five'); };\n",
          "test/math.test.js": 'const test = require("node:test"); const { add } = require("../src/math.js"); const { mustBeFive } = require("../src/assertions.js"); test("sum", () => mustBeFive(add(2, 3)));\n',
        },
        [write("src/assertions.js", "exports.mustBeFive = () => {};\n"), done],
        "Fix the addition implementation in src/math.js.",
        { trustedDeliverableFiles: ["src/math.js"] },
      );
      assert.notEqual(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.detail}`);
      assert.equal(turn.verification?.isDeliverableBound, false);
    },
  );

  test(
    "a package entrypoint and its reachable root module can bind a real product fix",
    { timeout: 60_000 },
    async () => {
      const { turn } = await run(
        {
          "package.json": PKG,
          "math.js": ADD_BUGGY,
          "test/math.test.js": ADD_TEST,
        },
        [write("math.js", ADD_FIXED), done],
        "npm test fails; fix math.js.",
        { trustedDeliverableFiles: ["math.js"] },
      );
      assert.equal(turn.outcome, "VERIFIED", `${turn.outcome}: ${turn.detail}`);
    },
  );
});
