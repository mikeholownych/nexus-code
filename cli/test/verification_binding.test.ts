import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  hasExecutedTests,
  isVerifierDeliverableBound,
  discoverVerifier,
  extractPathTokens,
} from "../src/tester.js";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome, Reply } from "./helpers/fixtures.js";

test("ACC-VER-04: multi-runner hasExecutedTests recognizes real runs and rejects spoof / all-skipped", () => {
  // node:test
  assert.equal(
    hasExecutedTests("ℹ tests 5\nℹ suites 0\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 5\nℹ todo 0"),
    false,
    "node:test all skipped should be false"
  );
  assert.equal(hasExecutedTests("ℹ tests 1\nℹ pass 1"), true, "node:test 1 pass should be true");
  assert.equal(hasExecutedTests("ℹ tests 1"), true, "node:test 1 test without pass line should be true");
  assert.equal(
    hasExecutedTests("# tests 2\n# suites 1\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12.3"),
    true,
    "Node 20 node:test TAP summary should count executed tests"
  );
  assert.equal(
    hasExecutedTests("# tests 3\n# suites 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 3\n# todo 0\n# duration_ms 2.1"),
    false,
    "Node 20 node:test TAP summary with only skipped tests should be false"
  );
  assert.equal(
    hasExecutedTests("# tests 2\n# suites 1\n# pass 0\n# fail 0\n# cancelled 2\n# skipped 0\n# todo 0\n# duration_ms 2.1"),
    false,
    "Node 20 node:test TAP summary with only cancelled tests should be false"
  );
  assert.equal(
    hasExecutedTests("# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.0"),
    false,
    "Node 20 node:test TAP summary with zero tests should be false"
  );

  // jest
  assert.equal(
    hasExecutedTests("Tests:       5 skipped, 5 total\nTest Suites: 1 skipped, 0 of 1 total"),
    false,
    "jest all skipped should be false"
  );
  assert.equal(hasExecutedTests("Tests:       3 passed, 3 total"), true, "jest 3 passed should be true");
  assert.equal(hasExecutedTests("Tests:       1 failed, 2 passed, 3 total"), true, "jest with failures should be true");

  // vitest
  assert.equal(
    hasExecutedTests(" Test Files  1 skipped (1)\n      Tests  5 skipped (5)"),
    false,
    "vitest all skipped should be false"
  );
  assert.equal(
    hasExecutedTests(" Test Files  1 passed (1)\n      Tests  3 passed (3)"),
    true,
    "vitest 3 passed should be true"
  );

  // pytest
  assert.equal(hasExecutedTests("============ 5 skipped in 0.01s ============"), false, "pytest all skipped should be false");
  assert.equal(hasExecutedTests("======= no tests ran in 0.01s ======="), false, "pytest no tests ran should be false");
  assert.equal(hasExecutedTests("======= 1 passed in 0.01s ======="), true, "pytest 1 passed should be true");

  // go test
  assert.equal(hasExecutedTests("?   \texample.com/m\t[no test files]"), false, "go no test files should be false");
  assert.equal(hasExecutedTests("ok  \texample.com/m\t(cached)"), true, "go ok cached should be true");
  assert.equal(hasExecutedTests("ok  \texample.com/m\t0.001s [no tests to run]"), false, "go ok [no tests to run] should be false");
  assert.equal(hasExecutedTests("ok all good"), false, "echo spoof 'ok all good' should be false");
  assert.equal(hasExecutedTests("ok  generated docs"), false, "make printing 'ok  generated docs' should be false");
  assert.equal(hasExecutedTests("--- PASS: TestAdd (0.00s)"), true, "go verbose pass should be true");

  // cargo test
  assert.equal(
    hasExecutedTests("test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out"),
    false,
    "cargo 0 passed 3 ignored should be false"
  );
  assert.equal(
    hasExecutedTests("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"),
    true,
    "cargo 1 passed should be true"
  );

  // mocha
  assert.equal(hasExecutedTests("  3 passing (10ms)"), true, "mocha 3 passing should be true");
  assert.equal(hasExecutedTests("  0 passing (10ms)"), false, "mocha 0 passing should be false");
});

test("ACC-VER-03: VERIFIED binding requires operator scope and an executed unchanged import", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "a2tester-"));
  try {
    fs.mkdirSync(path.join(d, "src"));
    fs.writeFileSync(path.join(d, "src/a.ts"), "export const a = 1;\n");
    fs.mkdirSync(path.join(d, "test"));
    fs.writeFileSync(path.join(d, "test/a.test.ts"), 'import { a } from "../src/a.ts"; test("a", () => assert.equal(a, 1));\n');
    const out = "ℹ tests 3\nℹ pass 3\n✔ loads src/data.ts fixtures";

    // 1. Coincidental substring: src/a.ts vs src/data.ts
    const boundCoincidence = isVerifierDeliverableBound(d, [path.join(d, "src/a.ts")], "npm test", out);
    assert.equal(boundCoincidence, false, "changed src/a.ts mentioning src/data.ts must not bind");

    // 2. Basename-only match: README.md mentioned as 'see README.md'
    fs.writeFileSync(path.join(d, "README.md"), "# Hello\n");
    const boundReadme = isVerifierDeliverableBound(d, [path.join(d, "README.md")], "npm test", "ℹ tests 1\nℹ pass 1\nsee README.md");
    assert.equal(boundReadme, false, "changed README.md with 'see README.md' in output must not bind");

    // 3. Exact workspace-relative path in output binds
    const boundExact = isVerifierDeliverableBound(d, [path.join(d, "src/a.ts")], "npm test", "ℹ tests 1\nℹ pass 1\nPASS src/a.ts:10:2");
    assert.equal(boundExact, false, "candidate-visible path text cannot declare deliverable scope");
    const originalTest = fs.readFileSync(path.join(d, "test/a.test.ts"), "utf8");
    const baselineTests = new Map([["test/a.test.ts", originalTest]]);
    const boundScopedImport = isVerifierDeliverableBound(d, [path.join(d, "src/a.ts")], "npm test", "ℹ tests 1\nℹ pass 1", new Set(["src/a.ts"]), baselineTests);
    assert.equal(boundScopedImport, true, "a predeclared product file imported by an executed test binds");
    fs.mkdirSync(path.join(d, "other"));
    fs.writeFileSync(path.join(d, "other/a.ts"), "export const a = 0;\n");
    const wrongSameBasename = new Map([["test/a.test.ts", 'import { a } from "../other/a.ts"; test("a", () => assert.equal(a, 1));\n']]);
    assert.equal(
      isVerifierDeliverableBound(d, [path.join(d, "src/a.ts")], "npm test", "ℹ tests 1\nℹ pass 1", new Set(["src/a.ts"]), wrongSameBasename),
      false,
      "a same-basename import from another path does not bind",
    );

    // 4. An empty change list still needs operator scope and a pre-turn import.
    const boundEmpty = isVerifierDeliverableBound(d, [], "npm test", "ℹ tests 1\nℹ pass 1");
    assert.equal(boundEmpty, false, "a generic passing suite without declared scope is only regression evidence");
    const boundEmptyScoped = isVerifierDeliverableBound(d, [], "npm test", "ℹ tests 1\nℹ pass 1", new Set(["src/a.ts"]), baselineTests);
    assert.equal(boundEmptyScoped, true, "a no-change verification unit can bind only the operator-declared product scope");
    const boundFilteredScoped = isVerifierDeliverableBound(
      d,
      [],
      "npm test -- -t unrelated",
      "ℹ tests 1\nℹ pass 1",
      new Set(["src/a.ts"]),
      baselineTests,
    );
    assert.equal(boundFilteredScoped, false, "a filtered pass without evidence the scoped import test ran does not bind");

    // 5. Changed test file that did not run does not bind
    fs.mkdirSync(path.join(d, "test"), { recursive: true });
    fs.writeFileSync(path.join(d, "test/foo.test.ts"), "test('foo', () => {});\n");
    const boundNotRun = isVerifierDeliverableBound(
      d,
      [path.join(d, "test/foo.test.ts")],
      "npm test -- test/bar.test.ts",
      "ℹ tests 1\nℹ pass 1\nPASS test/bar.test.ts"
    );
    assert.equal(boundNotRun, false, "changed test file that was not executed must not bind");

    // 6. A changed test cannot declare itself as the deliverable.
    const boundRan = isVerifierDeliverableBound(
      d,
      [path.join(d, "test/foo.test.ts")],
      "npm test -- test/foo.test.ts",
      "ℹ tests 1\nℹ pass 1\nPASS test/foo.test.ts"
    );
    assert.equal(boundRan, false, "a changed test file cannot establish VERIFIED");

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "a2tester-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "a.ts"), "export const a = 1;\n");
      fs.symlinkSync(outside, path.join(d, "linked"), "dir");
      fs.writeFileSync(path.join(d, "test/linked.test.ts"), 'import { a } from "../linked/a.ts"; test("a", () => assert.equal(a, 1));\n');
      assert.equal(
        isVerifierDeliverableBound(d, [path.join(d, "linked/a.ts")], "npm test", "ℹ tests 1\nℹ pass 1", new Set(["linked/a.ts"]), new Map([["test/linked.test.ts", fs.readFileSync(path.join(d, "test/linked.test.ts"), "utf8")]])),
        false,
        "a deliverable reached through a symlink cannot bind",
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("ACC-VER-05: discoverVerifier and run_tests return no verifier for Makefile with only pytest: or empty workspace", async () => {
  const { RustCoreBridge } = await import("../src/tools.js");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "a2discover-"));
  try {
    // 1. Makefile with only pytest: target
    fs.writeFileSync(path.join(d, "Makefile"), "pytest:\n\tpytest\n");
    assert.equal(discoverVerifier(d), null, "Makefile without test: target should discover no verifier");

    const bridge1 = new RustCoreBridge(d);
    try {
      const res1 = await bridge1.executeTool("run_tests", {});
      assert.equal(res1.success, false);
      assert.match(res1.output, /no verifier/i);
    } finally {
      bridge1.shutdown();
    }

    // 2. Empty directory
    fs.rmSync(path.join(d, "Makefile"));
    assert.equal(discoverVerifier(d), null, "empty directory should discover no verifier");

    const bridge2 = new RustCoreBridge(d);
    try {
      const res2 = await bridge2.executeTool("run_tests", {});
      assert.equal(res2.success, false);
      assert.match(res2.output, /no verifier/i);
    } finally {
      bridge2.shutdown();
    }

    // 3. package.json with test script
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    const v = discoverVerifier(d);
    assert.ok(v, "package.json with test script should discover npm test");
    assert.equal(v?.command, "npm test");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("ACC-VER-04: zero-executed test run gives UNVERIFIED NO_TESTS_EXECUTED and keeps obligation", async () => {
  const replies: Reply[] = [
    { kind: "tools", calls: [{ name: "write_file", args: { path: "hello.txt", content: "hello" } }] },
    { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Created hello.txt" } }] },
    { kind: "text", content: "Done." },
  ];
  const gw = await startGateway((n) => replies[Math.min(n - 1, replies.length - 1)]);
  // The repo's test script passes but runs 0 tests (all skipped)
  const repo = makeRepo({
    "package.json": JSON.stringify({
      name: "all-skipped-repo",
      scripts: {
        test: "node -e \"console.log('ℹ tests 5\\nℹ suites 0\\nℹ pass 0\\nℹ fail 0\\nℹ cancelled 0\\nℹ skipped 5\\nℹ todo 0')\"",
      },
    }),
  });
  const home = makeHome();
  const prev = process.env.HOME;
  process.env.HOME = home;
  const app = new ApplicationCore({
    endpoint: gw.url,
    model: "m",
    maxSteps: 10,
    temperature: 0,
    workspace: repo,
    shell: "bash",
    continuation: { ...DEFAULT_CONTINUATION },
    approvalMode: "auto",
    fullAccess: true,
  } as HarnessConfig);

  const events: any[] = [];
  const server = new SidecarServer({
    app,
    mode: "auto",
    write: (l) => events.push(JSON.parse(l)),
    historyFile: path.join(home, "h"),
  });
  server.start();

  try {
    await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "Create hello.txt" }));
    await server.idle();
    const resultEvent = events.find((e) => e.type === "turn.result");
    assert.ok(resultEvent, "turn.result event must be emitted");
    assert.equal(resultEvent.turn.execution, "COMPLETED");
    assert.equal(resultEvent.turn.outcome, "UNVERIFIED");
    assert.equal(resultEvent.turn.reason, "NO_TESTS_EXECUTED");
    assert.equal(resultEvent.turn.unverifiedChangesPending, true, "obligation must stay pending");
  } finally {
    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
    await gw.close();
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
});
