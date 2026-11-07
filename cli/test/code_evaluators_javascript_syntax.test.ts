/** WP-1302: the built-in JavaScript syntax parser must reject ESM-syntax errors that `node --check <file>` accepts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ev: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/index.mjs")).href);

function scratch(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

for (const [name, source] of [
  ["ESM import with a syntax error", 'import fs from "node:fs";\nexport const a = ;\n'],
  ["ESM export with a syntax error", "export const a = 1 +;\n"],
  ["import statement followed by garbage", 'import x from "y"; syntax error here\n'],
] as const) {
  test(`syntax_ast rejects a .js file: ${name}`, async () => {
    const root = scratch("wp1302-esm-");
    try {
      fs.writeFileSync(path.join(root, "bad.js"), source);
      const result = await ev.evaluateSyntaxAst({ root, files: ["bad.js"] });
      assert.equal(result.passed, false, "node --check alone accepts these; the parser must not");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("syntax_ast still accepts valid ESM and CommonJS .js and honours package type", async () => {
  const root = scratch("wp1302-esm-ok-");
  try {
    fs.writeFileSync(path.join(root, "esm.js"), 'import fs from "node:fs";\nexport const a = fs.constants;\n');
    fs.writeFileSync(path.join(root, "cjs.js"), 'const fs = require("node:fs");\nmodule.exports = fs;\n');
    fs.writeFileSync(path.join(root, "m.mjs"), "export const a = 1;\n");
    fs.writeFileSync(path.join(root, "c.cjs"), "module.exports = 1;\n");
    const ok = await ev.evaluateSyntaxAst({ root, files: ["esm.js", "cjs.js", "m.mjs", "c.cjs"] });
    assert.equal(ok.passed, true, JSON.stringify(ok.details));
    fs.writeFileSync(path.join(root, "bad.cjs"), "export const a = 1;\n");
    const cjsWithExport = await ev.evaluateSyntaxAst({ root, files: ["bad.cjs"] });
    assert.equal(cjsWithExport.passed, false, "ESM syntax in a .cjs file is a syntax error");
    fs.mkdirSync(path.join(root, "pkg"));
    fs.writeFileSync(path.join(root, "pkg/package.json"), JSON.stringify({ type: "commonjs" }));
    fs.writeFileSync(path.join(root, "pkg/x.js"), "export const a = 1;\n");
    const typed = await ev.evaluateSyntaxAst({ root, files: ["pkg/x.js"] });
    assert.equal(typed.passed, false, "a package declaring commonjs makes ESM syntax in .js an error");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
