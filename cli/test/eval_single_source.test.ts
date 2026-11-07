/**
 * One source of truth (finding 01M6KXHHJZNK): the core-v1 task fixtures are generated from eval/tasks, and the evaluator
 * runtime file list is defined once and shared by the packaging stage and the harness identity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(ROOT, file)).href);

test("the repository's core-v1 tasks match eval/tasks exactly", async () => {
  const { checkCoreV1 } = await load("eval/datasets/sync_core_v1.mjs");
  assert.deepEqual(checkCoreV1(), []);
});

test("core-v1 drift is detected, and the generator repairs it", async () => {
  const { checkCoreV1, writeCoreV1 } = await load("eval/datasets/sync_core_v1.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1302-core-v1-"));
  try {
    const tasksDir = path.join(root, "tasks");
    const datasetDir = path.join(root, "core-v1");
    fs.cpSync(path.join(ROOT, "eval/tasks"), tasksDir, { recursive: true });
    fs.cpSync(path.join(ROOT, "eval/datasets/core-v1"), datasetDir, { recursive: true });
    assert.deepEqual(checkCoreV1({ tasksDir, datasetDir }), []);
    fs.appendFileSync(path.join(tasksDir, "t2-bugfix-csv/csv.js"), "// drift\n");
    const drift = checkCoreV1({ tasksDir, datasetDir });
    assert.ok(drift.some((problem: string) => /t2-bugfix-csv/.test(problem)), JSON.stringify(drift));
    fs.writeFileSync(path.join(tasksDir, "t2-bugfix-csv/task.json"), fs.readFileSync(path.join(tasksDir, "t2-bugfix-csv/task.json"), "utf8").replace('"steps": 60', '"steps": 61'));
    writeCoreV1({ tasksDir, datasetDir });
    const after = checkCoreV1({ tasksDir, datasetDir });
    assert.deepEqual(after.filter((problem: string) => !/examples\.jsonl/.test(problem)), [], "files and the manifest digest are regenerated");
    assert.ok(after.some((problem: string) => /examples\.jsonl.*steps/.test(problem)), "a changed step budget must also be changed in examples.jsonl, which is not generated");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("one evaluator runtime file list feeds both the packaging stage and the harness identity", async () => {
  const shared = await load("eval/runtime_files.mjs");
  const staged = await load("scripts/stage_eval_runtime.mjs");
  assert.strictEqual(staged.EVAL_RUNTIME_FILES, shared.EVAL_RUNTIME_FILES, "the stage re-exports the shared list, it does not copy it");
  const run = fs.readFileSync(path.join(ROOT, "eval/run.mjs"), "utf8");
  assert.match(run, /import \{ EVAL_RUNTIME_FILES \} from "\.\/runtime_files\.mjs"/);
  assert.match(run, /const sourceFiles = EVAL_RUNTIME_FILES;/);
  assert.doesNotMatch(run, /const sourceFiles = \[/, "run.mjs must not carry its own list");
  for (const file of shared.EVAL_RUNTIME_FILES as string[]) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is listed but missing`);
  assert.ok(shared.EVAL_RUNTIME_FILES.includes("eval/runtime_files.mjs"), "the list file is itself staged");
});
