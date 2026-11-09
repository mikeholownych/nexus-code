// core-v1 is generated from eval/tasks, which stays the single source for every task fixture (finding 01M6KXHHJZNK).
//
//   node eval/datasets/sync_core_v1.mjs          check: exit 1 and list every difference
//   node eval/datasets/sync_core_v1.mjs --write  regenerate eval/datasets/core-v1/tasks and the manifest tree digests
//
// A dataset task directory is the eval/tasks directory with one change: task.json keeps only { id, tier, fixture, steps,
// minutes }. The objective, split and domain live in examples.jsonl and the hidden/regression commands in oracles.jsonl;
// those two files are hand-written, so the check compares them with task.json instead of generating them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { datasetTaskTreeDigest } from "../dataset.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { tasksDir: path.join(HERE, "../tasks"), datasetDir: path.join(HERE, "core-v1") };
// Every key of a source task.json must be accounted for, or the check fails: a key added to eval/tasks that core-v1 does
// not carry (evaluators, build, t4Fixture, class, ...) would otherwise run in one place and not in the other.
const KEPT_KEYS = ["id", "tier", "fixture", "steps", "minutes"];
const MOVED_KEYS = ["objective", "hidden", "regression"]; // examples.jsonl and oracles.jsonl, compared by the check
const DROPPED_KEYS = ["description"]; // prose for readers of eval/tasks; the dataset does not run on it
// The keys a record in the hand-written files may carry; any other key is a field core-v1 would run on that eval/tasks lacks.
const EXAMPLE_KEYS = ["id", "split", "domain", "objective", "taskDir", "tier", "steps", "minutes"];
const ORACLE_KEYS = ["id", "hidden", "regression"];
// Source tasks deliberately not in core-v1 (none today). Listing one here is the only way to leave it out.
const EXCLUDED_FROM_CORE_V1 = [];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

function listFiles(root, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, relative));
    else out.push(relative);
  }
  return out.sort();
}

/** The dataset's task.json for a source task.json. */
export function projectTaskJson(source) {
  const projected = {};
  for (const key of KEPT_KEYS) if (key in source) projected[key] = source[key];
  return projected;
}

/** Every way core-v1 differs from eval/tasks; an empty list means they agree. */
export function checkCoreV1({ tasksDir = DEFAULTS.tasksDir, datasetDir = DEFAULTS.datasetDir, excluded = EXCLUDED_FROM_CORE_V1 } = {}) {
  const problems = [];
  const manifest = readJson(path.join(datasetDir, "manifest.json"));
  const examples = new Map(readJsonl(path.join(datasetDir, "examples.jsonl")).map((row) => [row.id, row]));
  const oracles = new Map(readJsonl(path.join(datasetDir, "oracles.jsonl")).map((row) => [row.id, row]));
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) { problems.push(`${entry.name}: eval/tasks/${entry.name} is a symlink; task directories must be real directories`); continue; }
    if (entry.isDirectory() && !Object.hasOwn(manifest.tasks, entry.name) && !excluded.includes(entry.name)) problems.push(`${entry.name}: eval/tasks/${entry.name} is not in core-v1 (add it, or list it in EXCLUDED_FROM_CORE_V1)`);
  }
  for (const [file, rows] of [["examples.jsonl", examples], ["oracles.jsonl", oracles]]) {
    for (const id of rows.keys()) if (!Object.hasOwn(manifest.tasks, id)) problems.push(`${id}: ${file} has it but the manifest does not (not in the manifest)`);
  }
  for (const id of Object.keys(manifest.tasks)) {
    const source = path.join(tasksDir, id);
    const copy = path.join(datasetDir, "tasks", id);
    if (fs.lstatSync(source, { throwIfNoEntry: false })?.isSymbolicLink()) { problems.push(`${id}: eval/tasks/${id} is a symlink; task directories must be real directories`); continue; }
    if (fs.lstatSync(copy, { throwIfNoEntry: false })?.isSymbolicLink()) { problems.push(`${id}: core-v1/tasks/${id} is a symlink; task directories must be real directories`); continue; }
    if (!fs.existsSync(source)) { problems.push(`${id}: eval/tasks/${id} is missing`); continue; }
    if (!fs.existsSync(copy)) { problems.push(`${id}: core-v1/tasks/${id} is missing`); continue; }
    const sourceFiles = listFiles(source);
    const copyFiles = listFiles(copy);
    for (const file of new Set([...sourceFiles, ...copyFiles])) {
      if (file === "task.json") continue;
      if (!sourceFiles.includes(file)) problems.push(`${id}: ${file} exists only in core-v1`);
      else if (!copyFiles.includes(file)) problems.push(`${id}: ${file} is missing from core-v1`);
      else if (!fs.readFileSync(path.join(source, file)).equals(fs.readFileSync(path.join(copy, file)))) problems.push(`${id}: ${file} differs from eval/tasks`);
      else if ((fs.statSync(path.join(source, file)).mode & 0o111) !== (fs.statSync(path.join(copy, file)).mode & 0o111)) problems.push(`${id}: ${file} mode (executable bits) differs from eval/tasks`);
    }
    const sourceTask = readJson(path.join(source, "task.json"));
    for (const key of Object.keys(sourceTask)) {
      if (![...KEPT_KEYS, ...MOVED_KEYS, ...DROPPED_KEYS].includes(key)) problems.push(`${id}: task.json key "${key}" has no core-v1 mapping (map it in sync_core_v1.mjs or list it as intentionally dropped)`);
    }
    const copyTask = readJson(path.join(copy, "task.json"));
    if (JSON.stringify(projectTaskJson(sourceTask)) !== JSON.stringify(copyTask)) problems.push(`${id}: task.json is not the projection of eval/tasks/${id}/task.json`);
    const example = examples.get(id);
    if (!example) problems.push(`${id}: missing from examples.jsonl`);
    else {
      for (const key of Object.keys(example)) if (!EXAMPLE_KEYS.includes(key)) problems.push(`${id}: examples.jsonl key "${key}" is not an allowed example field`);
      for (const key of ["objective", "tier", "steps", "minutes"]) {
        if (sourceTask[key] !== example[key]) problems.push(`${id}: examples.jsonl ${key} differs from eval/tasks`);
      }
      if (example.taskDir !== `tasks/${id}`) problems.push(`${id}: examples.jsonl taskDir is ${JSON.stringify(example.taskDir)}, expected "tasks/${id}"`);
    }
    const oracle = oracles.get(id);
    if (!oracle) problems.push(`${id}: missing from oracles.jsonl`);
    else {
      for (const key of Object.keys(oracle)) if (!ORACLE_KEYS.includes(key)) problems.push(`${id}: oracles.jsonl key "${key}" is not an allowed oracle field`);
      for (const key of ["hidden", "regression"]) {
        if (JSON.stringify(sourceTask[key] ?? null) !== JSON.stringify(oracle[key] ?? null)) problems.push(`${id}: oracles.jsonl ${key} differs from eval/tasks`);
      }
    }
    if (datasetTaskTreeDigest(copy) !== manifest.tasks[id]) problems.push(`${id}: manifest tree digest does not match core-v1/tasks/${id}`);
  }
  return problems;
}

/** Regenerate the task directories and their manifest digests from eval/tasks. */
export function writeCoreV1({ tasksDir = DEFAULTS.tasksDir, datasetDir = DEFAULTS.datasetDir } = {}) {
  const manifestPath = path.join(datasetDir, "manifest.json");
  const manifest = readJson(manifestPath);
  for (const id of Object.keys(manifest.tasks)) {
    const copy = path.join(datasetDir, "tasks", id);
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(path.join(tasksDir, id), copy, { recursive: true });
    const sourceTask = readJson(path.join(tasksDir, id, "task.json"));
    fs.writeFileSync(path.join(copy, "task.json"), `${JSON.stringify(projectTaskJson(sourceTask), null, 2)}\n`);
    manifest.tasks[id] = datasetTaskTreeDigest(copy);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) writeCoreV1();
  const problems = checkCoreV1();
  for (const problem of problems) console.error(problem);
  process.exit(problems.length ? 1 : 0);
}
