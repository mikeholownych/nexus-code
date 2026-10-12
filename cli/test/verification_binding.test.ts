/**
 * What a passing verifier run is evidence of: tests executed, the whole suite ran (not a filtered part), and the run
 * covers the changed files (VERIFIED) rather than only showing nothing else broke (REGRESSION_FREE).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectTestCommand, hasExecutedTests, isFilteredVerifierCommand, isVerifierDeliverableBound } from "../src/tester.js";

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-binding-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

const NODE_PASS = "✔ adds (1.2ms)\nℹ tests 3\nℹ pass 3\nℹ fail 0\n";

describe("test filter sanitization", () => {
  test("a filter cannot inject a command or become a flag", () => {
    const root = workspace({ "Cargo.toml": "[package]\nname = \"x\"\n" });
    try {
      for (const bad of ["foo\ntouch /tmp/pwned", "foo\rbar", "a;b", "a && b", "$(id)", "`id`", "a'b", "--nocapture", "-x"]) {
        assert.throws(() => detectTestCommand(root, bad), /unsafe characters/, JSON.stringify(bad));
      }
      assert.equal(detectTestCommand(root, "parser::tests::repairs"), "cargo test -- parser::tests::repairs");
      assert.equal(detectTestCommand(root, "  spaced name  "), "cargo test -- spaced name");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("filtered runs", () => {
  test("name filters, node ids and positional cargo names are filtered", () => {
    for (const command of [
      "npm test -- -t \"adds\"",
      "pytest -k parser",
      "pytest tests/test_a.py::test_b",
      "go test -run=TestA ./...",
      "go test -run TestA ./...",
      "node --test --test-name-pattern=adds",
      "make test FILTER=foo",
      "cargo test parser",
      "cargo test -- parser",
      "cargo test --manifest-path core/Cargo.toml -- parser",
      "npx mocha --grep adds",
    ]) {
      assert.equal(isFilteredVerifierCommand(command), true, command);
    }
  });

  test("whole-suite runs and unrelated `--` are not filtered", () => {
    for (const command of ["make test", "npm test", "cargo test", "cargo test --manifest-path core/Cargo.toml --release", "cargo test -p core", "go test ./...", "pytest", "git diff -- src", "npm --prefix cli test"]) {
      assert.equal(isFilteredVerifierCommand(command), false, command);
    }
  });
});

describe("executed tests", () => {
  test("reports with at least one test are evidence; empty, zero and unrecognised output are not", () => {
    assert.equal(hasExecutedTests(NODE_PASS), true);
    assert.equal(hasExecutedTests("ℹ tests 0\nℹ pass 0\n"), false);
    assert.equal(hasExecutedTests("test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"), true);
    assert.equal(hasExecutedTests("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out"), false);
    assert.equal(hasExecutedTests("Tests:       5 passed, 5 total"), true);
    assert.equal(hasExecutedTests("No tests found\nTests: 0 total"), false);
    assert.equal(hasExecutedTests("============ 3 passed in 0.12s ============"), true);
    assert.equal(hasExecutedTests("collected 0 items\n===== no tests ran in 0.01s ====="), false);
    assert.equal(hasExecutedTests("ok  \texample.com/pkg\t0.012s"), true);
    assert.equal(hasExecutedTests("ok  \texample.com/pkg\t0.012s [no tests to run]\n?   \texample.com/other\t[no test files]"), false);
    assert.equal(hasExecutedTests(""), false);
    assert.equal(hasExecutedTests("build finished"), false);
  });
});

describe("deliverable binding", () => {
  test("a suite that never touches the changed file is not evidence about it", () => {
    const root = workspace({ "math.js": "exports.add = (a, b) => a - b;\n", "test/other.test.js": "require('../util');\n", "util.js": "" });
    try {
      assert.equal(isVerifierDeliverableBound(root, [path.join(root, "math.js")], "npm test", NODE_PASS), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a test that imports the changed module binds it; a mere mention of its name does not", () => {
    const root = workspace({
      "src/agent.ts": "",
      "test/a.test.ts": 'import { run } from "../src/agent.js";\n',
      "test/b.test.ts": "// the agent loop is tested elsewhere\nconst agent = 1;\n",
    });
    try {
      assert.equal(isVerifierDeliverableBound(root, [path.join(root, "src/agent.ts")], "npm test", NODE_PASS), true);
      fs.rmSync(path.join(root, "test/a.test.ts"));
      assert.equal(isVerifierDeliverableBound(root, [path.join(root, "src/agent.ts")], "npm test", NODE_PASS), false, "a word match is not an import");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed test file, or a run that names the changed file, binds it", () => {
    const root = workspace({ "lib.py": "", "test_lib.py": "" });
    try {
      assert.equal(isVerifierDeliverableBound(root, [path.join(root, "lib.py"), path.join(root, "test_lib.py")], "pytest", "===== 2 passed in 0.1s ====="), true);
      assert.equal(isVerifierDeliverableBound(root, [path.join(root, "lib.py")], "pytest lib.py", "===== 2 passed in 0.1s ====="), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Rust inline tests under cargo test bind their file", () => {
    const root = workspace({ "src/file_ops.rs": "fn f() {}\n#[cfg(test)]\nmod tests { #[test] fn t() {} }\n", "src/plain.rs": "fn g() {}\n" });
    const output = "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out";
    try {
      assert.equal(isVerifierDeliverableBound(root, [path.join(root, "src/file_ops.rs")], "cargo test", output), true);
      assert.equal(isVerifierDeliverableBound(root, [path.join(root, "src/plain.rs")], "cargo test", output), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("no executed tests binds nothing, even when the change is a test", () => {
    const root = workspace({ "a.test.js": "" });
    try {
      assert.equal(isVerifierDeliverableBound(root, [path.join(root, "a.test.js")], "make test", ""), false);
      assert.equal(isVerifierDeliverableBound(root, [], "make test", ""), false);
      assert.equal(isVerifierDeliverableBound(root, [], "make test", NODE_PASS), true, "no recorded change: executed tests are the evidence");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
