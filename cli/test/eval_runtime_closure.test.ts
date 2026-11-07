/**
 * The packaged evaluator runtime (scripts/stage_eval_runtime.mjs) must contain every module the staged modules import,
 * or an installed `nexus eval` fails with ERR_MODULE_NOT_FOUND (a new eval/check_phase.mjs import once broke this).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("every relative import of a staged evaluator module is itself staged", async () => {
  const { EVAL_RUNTIME_FILES } = await import(pathToFileURL(path.join(ROOT, "scripts/stage_eval_runtime.mjs")).href);
  const staged = new Set<string>(EVAL_RUNTIME_FILES);
  const missing: string[] = [];
  for (const file of EVAL_RUNTIME_FILES as string[]) {
    if (!/\.(mjs|cjs)$/.test(file)) continue;
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (!staged.has(target)) missing.push(`${file} imports ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});
