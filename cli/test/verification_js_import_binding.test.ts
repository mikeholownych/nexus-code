import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isVerifierDeliverableBound } from "../src/tester.js";

test("ACC-VER-03: only executable JavaScript imports bind a declared deliverable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-js-import-binding-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    const target = path.join(root, "src/a.ts");
    fs.writeFileSync(target, "export const a = 1;\n");
    const scoped = new Set(["src/a.ts"]);
    const output = "ℹ tests 1\nℹ pass 1\n";
    const bind = (content: string) => isVerifierDeliverableBound(
      root,
      [target],
      "npm test",
      output,
      scoped,
      new Map([["test/a.test.ts", content]]),
    );

    const commented = '// import { a } from "../src/a.ts";\ntest("unrelated", () => {});\n';
    assert.equal(bind(commented), false, "a comment must not establish an import binding");

    const blockCommented = '/* import { a } from "../src/a.ts"; */\ntest("unrelated", () => {});\n';
    assert.equal(bind(blockCommented), false, "a block comment must not establish an import binding");

    const textOnly = 'const note = "import { a } from \\\"../src/a.ts\\\"";\ntest("unrelated", () => {});\n';
    assert.equal(bind(textOnly), false, "a string literal must not establish an import binding");

    const regexOnly = 'const pattern = /import\\s+.*from\\s+\\"\\.\\.\\/src\\/a\\.ts\\"/;\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexOnly), false, "a regular expression must not establish an import binding");

    const regexAfterCondition = 'if (true) /import from "..\\/src\\/a.ts"/.test("");\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexAfterCondition), false, "a regular expression after a control condition must not establish an import binding");

    const regexAfterBlock = 'if (true) {} /import from "..\\/src\\/a.ts"/.test("");\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexAfterBlock), false, "a regular expression after a block must not establish an import binding");

    const unreachable = 'if (false) { import("../src/a.ts"); }\ntest("unrelated", () => {});\n';
    assert.equal(bind(unreachable), false, "an unreachable dynamic import must not establish a binding");

    const actual = 'import { a } from "../src/a.ts";\ntest("actual", () => assert.equal(a, 1));\n';
    assert.equal(bind(actual), true, "an executable static import establishes a binding");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
