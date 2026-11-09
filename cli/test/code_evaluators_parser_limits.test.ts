/**
 * WP-1302: syntax_ast must not let one huge or pathological source file block the evaluator.
 */
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

test("a source file over the size limit is refused without being parsed", async () => {
  const root = scratch("wp1302-big-source-");
  try {
    fs.writeFileSync(path.join(root, "huge.ts"), `export const x = "${"a".repeat(3 * 1024 * 1024)}";\n`);
    let parsed = false;
    const started = Date.now();
    const result = await ev.evaluateSyntaxAst({ root, files: ["huge.ts"], maxSourceBytes: 1024 * 1024, parsers: { typescript: () => { parsed = true; return {}; } } });
    assert.equal(result.passed, false);
    assert.equal(parsed, false, "the parser must not see an oversized file");
    assert.match(result.details.failures[0].error, /larger than/);
    assert.ok(Date.now() - started < 5_000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the built-in TypeScript parser runs under a timeout instead of blocking the evaluator", async () => {
  const root = scratch("wp1302-parser-timeout-");
  try {
    fs.writeFileSync(path.join(root, "slow.ts"), `export const x = "${"a".repeat(2 * 1024 * 1024)}";\n`);
    const started = Date.now();
    const result = await ev.evaluateSyntaxAst({ root, files: ["slow.ts"], parserTimeoutMs: 1 });
    assert.equal(result.passed, false);
    assert.match(result.details.failures[0].error, /timed out|terminated/);
    assert.ok(Date.now() - started < 10_000, "returned promptly");
    const ok = await ev.evaluateSyntaxAst({ root, files: ["slow.ts"], parserTimeoutMs: 30_000 });
    assert.equal(ok.passed, true, JSON.stringify(ok.details));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
