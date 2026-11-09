/**
 * The packaged evaluator runtime (eval/runtime_files.mjs, staged by scripts/stage_eval_runtime.mjs) must contain every file
 * the staged modules reach, or an installed `nexus eval` fails at run time (a new eval/check_phase.mjs import once broke
 * this). Three reference forms are followed:
 *   - static `import ... from "./x"`, `import "./x"` and literal `import("./x")`;
 *   - `new URL("./x", import.meta.url)`;
 *   - a sibling file named next to `import.meta.url`: `path.join(path.dirname(fileURLToPath(import.meta.url)), "x")`.
 * Limit: references built from computed strings or from a variable that holds the module directory are not followed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Repository-relative files a module reaches by the supported reference forms. */
function referencedFiles(file: string, source: string): string[] {
  const directory = path.posix.dirname(file);
  const found: string[] = [];
  const add = (relative: string) => found.push(path.posix.normalize(path.posix.join(directory, relative)));
  for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g)) add(match[1]);
  for (const match of source.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) add(match[1]);
  for (const match of source.matchAll(/import\.meta\.url\)\)\s*,\s*["']([^"'/.][^"']*)["']/g)) add(match[1]);
  return found;
}

test("the reference scanner follows static imports, new URL(import.meta.url) and sibling data files", () => {
  const sample = [
    'import a from "./a.mjs";',
    'export { b } from "../b.mjs";',
    'const s = fileURLToPath(new URL("./sup.mjs", import.meta.url));',
    'const t = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "policy.json"), "utf8"));',
    'const h = path.join(path.dirname(fileURLToPath(import.meta.url)), "scan.mjs");',
  ].join("\n");
  assert.deepEqual(referencedFiles("eval/x.mjs", sample).sort(), ["b.mjs", "eval/a.mjs", "eval/policy.json", "eval/scan.mjs", "eval/sup.mjs"]);
});

test("every file a staged evaluator module reaches is itself staged", async () => {
  const { EVAL_RUNTIME_FILES } = await import(pathToFileURL(path.join(ROOT, "scripts/stage_eval_runtime.mjs")).href);
  const staged = new Set<string>(EVAL_RUNTIME_FILES);
  const missing: string[] = [];
  for (const file of EVAL_RUNTIME_FILES as string[]) {
    if (!/\.(mjs|cjs)$/.test(file)) continue;
    for (const target of referencedFiles(file, fs.readFileSync(path.join(ROOT, file), "utf8"))) {
      if (!staged.has(target)) missing.push(`${file} reaches ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});
