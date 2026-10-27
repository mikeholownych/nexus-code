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

    const nestedTemplateText = ';`${`import "../src/a.ts"`}`;\ntest("unrelated", () => {});\n';
    assert.equal(bind(nestedTemplateText), false, "nested template text must not expose import-looking tokens");

    const regexOnly = 'const pattern = /import\\s+.*from\\s+\\"\\.\\.\\/src\\/a\\.ts\\"/;\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexOnly), false, "a regular expression must not establish an import binding");

    const regexAfterCondition = 'if (true) /import from "..\\/src\\/a.ts"/.test("");\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexAfterCondition), false, "a regular expression after a control condition must not establish an import binding");

    const regexAfterBlock = 'if (true) {} /import from "..\\/src\\/a.ts"/.test("");\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexAfterBlock), false, "a regular expression after a block must not establish an import binding");

    const regexAfterAwait = 'await /import from "..\\/src\\/a.ts"/.test("");\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexAfterAwait), false, "a regular expression after await must not establish an import binding");

    const regexAfterVoid = 'void /import from "..\\/src\\/a.ts"/.test("");\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexAfterVoid), false, "a regular expression after void must not establish an import binding");

    const regexAfterTypeof = 'typeof /import from "..\\/src\\/a.ts"/.test("");\ntest("unrelated", () => {});\n';
    assert.equal(bind(regexAfterTypeof), false, "a regular expression after typeof must not establish an import binding");

    const jsxAttribute = 'const element = <div import="../src/a.ts">text</div>;\ntest("unrelated", () => {});\n';
    assert.equal(bind(jsxAttribute), false, "a JSX attribute named import must not establish an import binding");

    const unreachable = 'if (false) { import("../src/a.ts"); }\ntest("unrelated", () => {});\n';
    assert.equal(bind(unreachable), false, "an unreachable dynamic import must not establish a binding");

    const actual = 'import { a } from "../src/a.ts";\ntest("actual", () => assert.equal(a, 1));\n';
    assert.equal(bind(actual), true, "an executable static import establishes a binding");

    const actualBeforeDivision = 'import { a } from "../src/a.ts";\nconst ratio = 4 / 2;\ntest("actual", () => assert.equal(a * ratio, 2));\n';
    assert.equal(bind(actualBeforeDivision), true, "later arithmetic cannot invalidate an earlier unambiguous static import");

    const commonJs = 'const { a } = require("../src/a.js");\ntest("actual", () => assert.equal(a, 1));\n';
    assert.equal(bind(commonJs), true, "a top-level literal CommonJS require binds the tested deliverable");

    const commonJsSideEffect = 'require("../src/a.js");\ntest("actual", () => {});\n';
    assert.equal(bind(commonJsSideEffect), true, "a top-level literal CommonJS side-effect import is executable");

    const conditionalRequire = 'if (enabled) require("../src/a.js");\ntest("conditional", () => {});\n';
    assert.equal(bind(conditionalRequire), false, "a conditional CommonJS require cannot establish coverage");

    const nestedRequire = 'function load() { require("../src/a.js"); }\ntest("nested", () => {});\n';
    assert.equal(bind(nestedRequire), false, "a nested CommonJS require cannot establish coverage");

    const dynamicRequire = 'const { a } = require(modulePath);\ntest("dynamic", () => assert.equal(a, 1));\n';
    assert.equal(bind(dynamicRequire), false, "a computed CommonJS module path cannot establish coverage");

    const memberRequire = 'loader.require("../src/a.js");\ntest("member", () => {});\n';
    assert.equal(bind(memberRequire), false, "a member method named require cannot establish coverage");

    const shadowedRequire = 'const require = loader;\nrequire("../src/a.js");\ntest("shadowed", () => {});\n';
    assert.equal(bind(shadowedRequire), false, "a shadowed CommonJS loader cannot establish coverage");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
