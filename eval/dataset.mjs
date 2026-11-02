// Load a versioned evaluation dataset while keeping agent stimulus separate from evaluator-only oracles.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { confinedPath } from "./isolate.mjs";

const SPLITS = new Set(["regression", "benchmark"]);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_JSONL_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_TASK_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TASK_TREE_BYTES = 512 * 1024 * 1024;
const MAX_TASK_TREE_ENTRIES = 50_000;
const MAX_TASK_TREE_DEPTH = 64;
const EXAMPLE_KEYS = new Set(["id", "split", "domain", "objective", "taskDir", "tier", "class", "difficulty", "steps", "minutes"]);
const ORACLE_KEYS = new Set(["id", "hidden", "regression"]);
const TASK_KEYS = new Set(["id", "tier", "fixture", "repo", "setup", "steps", "minutes", "class", "difficulty", "faults", "t4Fixture", "t4RunnerFault"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function readRegularFile(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path.basename(file)} must be a regular file`);
    if (stat.size > maxBytes) throw new Error(`${path.basename(file)} exceeds the ${maxBytes}-byte size limit`);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error(`${path.basename(file)} exceeds the ${maxBytes}-byte size limit`);
      chunks.push(chunk.subarray(0, count));
    }
    if (total !== stat.size) throw new Error(`${path.basename(file)} changed size while being read`);
    return Buffer.concat(chunks, total);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function readJsonl(file) {
  const bytes = readRegularFile(file, MAX_JSONL_BYTES);
  const text = bytes.toString("utf8");
  if (text && !text.endsWith("\n")) throw new Error(`${path.basename(file)} must end with a newline`);
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > MAX_ROWS) throw new Error(`${path.basename(file)} exceeds the ${MAX_ROWS}-record limit`);
  const rows = lines.map((line, i) => {
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) throw new Error(`${path.basename(file)} line ${i + 1} exceeds the ${MAX_RECORD_BYTES}-byte record limit`);
    try { return JSON.parse(line); }
    catch { throw new Error(`${path.basename(file)} line ${i + 1} is invalid JSON`); }
  });
  return { bytes, rows };
}
function datasetTaskTreeDigest(root) {
  let total = 0;
  let entriesSeen = 0;
  const hash = createHash("sha256");
  hash.update("nexus-task-tree-v2\0");
  const frame = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size);
    hash.update(bytes);
  };
  const walk = (dir, depth) => {
    if (depth > MAX_TASK_TREE_DEPTH) throw new Error(`dataset task tree exceeds ${MAX_TASK_TREE_DEPTH} directory levels`);
    const handle = fs.opendirSync(dir);
    try {
      const entries = [];
      let entry;
      while ((entry = handle.readSync()) !== null) {
        entriesSeen++;
        if (entriesSeen > MAX_TASK_TREE_ENTRIES) throw new Error(`dataset task tree exceeds ${MAX_TASK_TREE_ENTRIES} entries`);
        entries.push(entry);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const item = path.join(dir, entry.name);
        const relative = path.relative(root, item).split(path.sep).join("/");
        const stat = fs.lstatSync(item);
        if (stat.isSymbolicLink()) throw new Error(`dataset task contains a symlink: ${relative}`);
        if (stat.isDirectory()) {
          hash.update("D");
          frame(relative);
          walk(item, depth + 1);
          continue;
        }
        if (!stat.isFile()) throw new Error(`dataset task contains a special file: ${relative}`);
        hash.update("F");
        frame(relative);
        let fd;
        try {
          fd = fs.openSync(item, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          const current = fs.fstatSync(fd);
          if (!current.isFile() || current.size !== stat.size || (current.mode & 0o111) !== (stat.mode & 0o111)) throw new Error(`dataset task file changed while hashing: ${relative}`);
          if (current.size > MAX_TASK_FILE_BYTES) throw new Error(`dataset task file exceeds ${MAX_TASK_FILE_BYTES} bytes: ${relative}`);
          total += current.size;
          if (total > MAX_TASK_TREE_BYTES) throw new Error(`dataset task tree exceeds ${MAX_TASK_TREE_BYTES} bytes`);
          frame(String(current.mode & 0o111));
          const length = Buffer.alloc(8);
          length.writeBigUInt64BE(BigInt(current.size));
          hash.update(length);
          let remaining = current.size;
          while (remaining > 0) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
            const count = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (count === 0) throw new Error(`dataset task file shortened while hashing: ${relative}`);
            hash.update(chunk.subarray(0, count));
            remaining -= count;
          }
          const extra = Buffer.alloc(1);
          if (fs.readSync(fd, extra, 0, 1, null) !== 0) throw new Error(`dataset task file grew while hashing: ${relative}`);
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    } finally {
      try { handle.closeSync(); }
      catch (error) { if (error.code !== "ERR_DIR_CLOSED") throw error; }
    }
  };
  walk(root, 0);
  return hash.digest("hex");
}

/** Recheck resource bounds and the manifest-pinned tree digest immediately before/after snapshotting. */
export function assertDatasetTaskDigest(dir, expected, id = "task") {
  if (!HASH.test(expected ?? "") || datasetTaskTreeDigest(dir) !== expected) throw new Error(`dataset task ${id} digest mismatch`);
}

/** Validate and load a dataset; returned task records combine private oracle data only in evaluator memory. */
export function loadDataset(datasetPath, { split = null, only = null } = {}) {
  const root = path.resolve(datasetPath);
  const manifestPath = confinedPath(root, "manifest.json");
  const manifestBytes = readRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || typeof manifest.name !== "string" || !manifest.name || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("dataset manifest requires schemaVersion 1, name, and version");
  }
  if (JSON.stringify(Object.keys(manifest.splits ?? {}).sort()) !== JSON.stringify(["benchmark", "regression"])) throw new Error("dataset manifest must define exactly regression and benchmark splits");
  const examplesFile = confinedPath(root, "examples.jsonl");
  const oraclesFile = confinedPath(root, "oracles.jsonl");
  const examples = readJsonl(examplesFile);
  const oracles = readJsonl(oraclesFile);
  if (manifest.files?.["examples.jsonl"] !== sha256(examples.bytes)) throw new Error("examples.jsonl digest mismatch");
  if (manifest.files?.["oracles.jsonl"] !== sha256(oracles.bytes)) throw new Error("oracles.jsonl digest mismatch");
  const oracleById = new Map();
  for (const oracle of oracles.rows) {
    if (!oracle || typeof oracle.id !== "string" || !ID.test(oracle.id) || oracleById.has(oracle.id)) throw new Error("oracle ids must be unique safe strings");
    if (Object.keys(oracle).some((key) => !ORACLE_KEYS.has(key))) throw new Error(`oracle ${oracle.id} contains an unsupported field`);
    oracleById.set(oracle.id, oracle);
  }
  const ids = new Set();
  const rows = examples.rows.map((example) => {
    if (!example || typeof example.id !== "string" || !ID.test(example.id) || ids.has(example.id)) throw new Error("example ids must be unique safe strings");
    ids.add(example.id);
    if (Object.keys(example).some((key) => !EXAMPLE_KEYS.has(key))) throw new Error(`example ${example.id} contains an unsupported field`);
    if (!SPLITS.has(example.split) || !Array.isArray(manifest.domains) || !manifest.domains.includes(example.domain) || typeof example.objective !== "string" || !example.objective.trim() || typeof example.taskDir !== "string") {
      throw new Error(`example ${example.id} requires a supported split, domain, and objective`);
    }
    const oracle = oracleById.get(example.id);
    if (!oracle) throw new Error(`example ${example.id} has no oracle`);
    const taskDir = confinedPath(root, example.taskDir);
    assertDatasetTaskDigest(taskDir, manifest.tasks?.[example.id], example.id);
    const taskFile = confinedPath(taskDir, "task.json");
    const sourceTask = JSON.parse(readRegularFile(taskFile, MAX_RECORD_BYTES).toString("utf8"));
    if (sourceTask.id !== example.id || Object.keys(sourceTask).some((key) => !TASK_KEYS.has(key)) || ["objective", "hidden", "regression"].some((key) => Object.hasOwn(sourceTask, key))) {
      throw new Error(`dataset task ${example.id} must contain only sanitized fixture metadata`);
    }
    // Keep fixture/setup metadata from the migrated task, while taking objective and split metadata only from examples.
    const task = { ...sourceTask, id: example.id, objective: example.objective, tier: example.tier ?? sourceTask.tier };
    for (const key of ["class", "difficulty", "steps", "minutes"]) if (example[key] !== undefined) task[key] = example[key];
    task.hidden = oracle.hidden;
    task.regression = oracle.regression;
    return { id: example.id, split: example.split, domain: example.domain, dir: taskDir, treeSha256: manifest.tasks[example.id], task };
  });
  if (oracleById.size !== ids.size || [...oracleById.keys()].some((id) => !ids.has(id))) throw new Error("examples and oracles must contain the same ids");
  if (Object.keys(manifest.tasks ?? {}).length !== ids.size || Object.keys(manifest.tasks).some((id) => !ids.has(id))) throw new Error("manifest task digests must cover exactly the examples");
  const counts = Object.fromEntries([...SPLITS].map((name) => [name, rows.filter((r) => r.split === name).length]));
  for (const name of SPLITS) if (manifest.splits?.[name]?.count !== counts[name]) throw new Error(`manifest ${name} count does not match examples`);
  if (split !== null && split !== undefined && !SPLITS.has(split)) throw new Error(`unsupported dataset split: ${split}`);
  const selected = rows.filter((row) => (!split || row.split === split) && (!only || only.has(row.id)));
  if (only && selected.length !== only.size) throw new Error("requested task id is absent from the selected dataset split");
  return { manifest, manifestSha256: sha256(manifestBytes), rows: selected };
}
