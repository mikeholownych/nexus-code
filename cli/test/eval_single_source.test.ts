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
    fs.appendFileSync(path.join(tasksDir, "t2-bugfix-csv/repo/csv.js"), "// drift\n");
    const drift = checkCoreV1({ tasksDir, datasetDir });
    assert.ok(drift.some((problem: string) => /t2-bugfix-csv/.test(problem)), JSON.stringify(drift));
    fs.writeFileSync(path.join(tasksDir, "t2-bugfix-csv/task.json"), fs.readFileSync(path.join(tasksDir, "t2-bugfix-csv/task.json"), "utf8").replace('"steps": 60', '"steps": 61'));
    writeCoreV1({ tasksDir, datasetDir });
    const after = checkCoreV1({ tasksDir, datasetDir });
    assert.deepEqual(after.filter((problem: string) => !/examples\.jsonl/.test(problem)), [], "files and the manifest digest are regenerated");
    assert.ok(after.some((problem: string) => /examples\.jsonl.*steps/.test(problem)), "a changed step budget must also be changed in examples.jsonl, which is not generated");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function copies() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1302-core-v1-"));
  const tasksDir = path.join(root, "tasks");
  const datasetDir = path.join(root, "core-v1");
  fs.cpSync(path.join(ROOT, "eval/tasks"), tasksDir, { recursive: true });
  fs.cpSync(path.join(ROOT, "eval/datasets/core-v1"), datasetDir, { recursive: true });
  return { root, tasksDir, datasetDir };
}

test("a source task.json key that core-v1 would silently drop fails the check", async () => {
  const { checkCoreV1 } = await load("eval/datasets/sync_core_v1.mjs");
  const { root, tasksDir, datasetDir } = copies();
  try {
    const file = path.join(tasksDir, "t2-bugfix-csv/task.json");
    const task = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of ["evaluators", "build", "t4Fixture", "class"]) {
      fs.writeFileSync(file, JSON.stringify({ ...task, [key]: key === "evaluators" ? ["build"] : {} }, null, 2));
      const problems = checkCoreV1({ tasksDir, datasetDir });
      assert.ok(problems.some((problem: string) => new RegExp(`t2-bugfix-csv.*"${key}"`).test(problem)), `${key}: ${JSON.stringify(problems)}`);
    }
    fs.writeFileSync(file, JSON.stringify({ ...task, description: "reworded" }, null, 2));
    assert.ok(!checkCoreV1({ tasksDir, datasetDir }).some((problem: string) => /"description"/.test(problem)), "description is intentionally dropped");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("task ids must agree across eval/tasks, the manifest, examples and oracles", async () => {
  const { checkCoreV1 } = await load("eval/datasets/sync_core_v1.mjs");
  const { root, tasksDir, datasetDir } = copies();
  try {
    fs.cpSync(path.join(tasksDir, "t2-bugfix-csv"), path.join(tasksDir, "t9-new-task"), { recursive: true });
    assert.ok(checkCoreV1({ tasksDir, datasetDir }).some((problem: string) => /t9-new-task.*not in core-v1/.test(problem)));
    assert.deepEqual(checkCoreV1({ tasksDir, datasetDir, excluded: ["t9-new-task"] }), [], "an explicit exclusion is allowed");
    fs.appendFileSync(path.join(datasetDir, "examples.jsonl"), JSON.stringify({ id: "t8-ghost", split: "benchmark", domain: "coding-task", objective: "x", taskDir: "tasks/t8-ghost", tier: "T2", steps: 1, minutes: 1 }) + "\n");
    assert.ok(checkCoreV1({ tasksDir, datasetDir, excluded: ["t9-new-task"] }).some((problem: string) => /t8-ghost.*examples\.jsonl.*not in the manifest/.test(problem)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an executable bit that differs between eval/tasks and core-v1 fails the check", async () => {
  const { checkCoreV1 } = await load("eval/datasets/sync_core_v1.mjs");
  const { root, tasksDir, datasetDir } = copies();
  try {
    const file = path.join(tasksDir, "t2-bugfix-csv/repo/csv.js");
    fs.chmodSync(file, 0o755);
    assert.ok(checkCoreV1({ tasksDir, datasetDir }).some((problem: string) => /t2-bugfix-csv.*csv\.js.*mode/.test(problem)));
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
