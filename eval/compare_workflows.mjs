#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ARMS } from "./workflow_modes.mjs";
import { loadDataset } from "./dataset.mjs";
import { EVAL_RUNTIME_FILES } from "./runtime_files.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (!args.config || !args.dataset || !args.out || args.config === true || args.dataset === true || args.out === true) {
  console.error("usage: node eval/compare_workflows.mjs --config <provider-config.json> --dataset <dataset> --split benchmark|regression --out <new-dir> [--runs N] [--only id,id]");
  process.exit(2);
}
const sourceConfig = JSON.parse(fs.readFileSync(args.config, "utf8"));
if (sourceConfig.qualification === true) throw new Error("comparative workflow harness currently runs development evaluations only; use identical pinned provider settings and a reviewed held-out qualification protocol");
if ((sourceConfig.agent ?? "nexus") !== "nexus") throw new Error("workflow-arm comparison currently requires the Nexus sidecar adapter");
if (sourceConfig.proxy === false) throw new Error("workflow comparison requires the per-run model proxy so inference requests and upstream failures are observable");
const datasetPath = path.resolve(args.dataset);
const dataset = loadDataset(datasetPath, { split: args.split ?? "benchmark" });
const filter = args.only ? new Set(String(args.only).split(",").map((id) => id.trim()).filter(Boolean)) : null;
const selectedRows = dataset.rows.filter((row) => !filter || filter.has(row.id));
if (selectedRows.some((row) => !["T1", "T2"].includes(row.task.tier))) throw new Error("workflow comparison currently supports T1/T2 tasks only; T3 steering and T4 interruption semantics are not yet preserved across all five arms");
const tasks = selectedRows.map((row) => row.id);
if (filter && [...filter].some((id) => !tasks.includes(id))) throw new Error("--only contains an ID absent from the selected dataset split");
if (!tasks.length) throw new Error("the selected workflow dataset is empty");
const runs = Number(args.runs ?? 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error("--runs must be an integer from 1 to 100");
const out = path.resolve(args.out);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(out, { mode: 0o700 });
fs.chmodSync(out, 0o700);
fs.mkdirSync(path.join(out, "configs"), { mode: 0o700 });
fs.mkdirSync(path.join(out, "arms"), { mode: 0o700 });
const manifest = {
  schema: "nexus-workflow-comparison-v1",
  createdAt: new Date().toISOString(),
  sourceConfigSha256: sha256(fs.readFileSync(args.config)),
  harness: {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=all", "--", "eval", "docs/v1.3.0/PA4_COMPARATIVE_EVALUATION.md").length > 0,
    runtimeFiles: EVAL_RUNTIME_FILES.map((file) => ({ file, sha256: sha256(fs.readFileSync(path.join(ROOT, file))) })),
  },
  dataset: { name: dataset.manifest.name, version: dataset.manifest.version, split: args.split ?? "benchmark", manifestSha256: dataset.manifestSha256, taskIds: tasks },
  runsPerArmTask: runs,
  arms: WORKFLOW_ARMS,
  order: "counterbalanced cyclic arm order per task and replicate; each arm run uses a fresh eval/run.mjs workspace and HOME",
  timing: "end-to-end eval/run.mjs process wall time per task-arm invocation, including preparation and deterministic post-run evaluation; failed invocations remain included",
  heldOutQualification: false,
  failedRunsPreserved: true,
};
fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const rows = [];
let invocation = 0;
for (let replicate = 0; replicate < runs; replicate++) {
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
    for (let armOffset = 0; armOffset < WORKFLOW_ARMS.length; armOffset++) {
      const arm = WORKFLOW_ARMS[(armOffset + taskIndex + replicate) % WORKFLOW_ARMS.length];
      const id = tasks[taskIndex];
      const key = `${String(replicate + 1).padStart(3, "0")}-${String(taskIndex + 1).padStart(4, "0")}-${arm}`;
      const armOut = path.join(out, "arms", key);
      const config = { ...sourceConfig, name: `${sourceConfig.name ?? "comparison"}-${arm}`, workflowArm: arm, runs: 1 };
      const configPath = path.join(out, "configs", `${key}.json`);
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      const startedAt = new Date().toISOString();
      const result = spawnSync(process.execPath, [path.join(ROOT, "eval/run.mjs"), "--config", configPath, "--dataset", datasetPath,
        "--split", args.split ?? "benchmark", "--only", id, "--runs", "1", "--out", armOut], {
        cwd: ROOT, encoding: "utf8", timeout: (Number(config.minutes ?? 120) + 10) * 60_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME ?? "/tmp" },
      });
      invocation++;
      const finishedAt = new Date().toISOString();
      const record = { invocation, replicate: replicate + 1, task: id, arm, exitCode: result.status, signal: result.signal ?? null, error: result.error?.message ?? null, startedAt, finishedAt, attemptWallMs: Date.parse(finishedAt) - Date.parse(startedAt), evidenceDir: path.relative(out, armOut) };
      fs.mkdirSync(path.dirname(armOut), { recursive: true });
      fs.writeFileSync(path.join(out, `${key}.stdout.log`), result.stdout ?? "", { mode: 0o600 });
      fs.writeFileSync(path.join(out, `${key}.stderr.log`), result.stderr ?? "", { mode: 0o600 });
      const armManifestPath = path.join(armOut, "manifest.json");
      if (fs.existsSync(armManifestPath)) record.modelFingerprint = JSON.parse(fs.readFileSync(armManifestPath, "utf8")).fingerprint ?? null;
      if (result.status === 0 && fs.existsSync(path.join(armOut, "results.jsonl"))) {
        const lines = fs.readFileSync(path.join(armOut, "results.jsonl"), "utf8").split("\n").filter(Boolean);
        if (lines.length === 1) {
          const run = JSON.parse(lines[0]);
          rows.push({ ...record, result: run });
        } else record.error = `expected exactly one run record, found ${lines.length}`;
      }
      if (!rows.some((row) => row.invocation === invocation)) rows.push(record);
      fs.appendFileSync(path.join(out, "runs.jsonl"), `${JSON.stringify(rows.at(-1))}\n`, { mode: 0o600 });
      console.log(`${arm} ${id} replicate ${replicate + 1}: ${result.status === 0 ? "recorded" : `failed (${result.status ?? result.signal ?? "spawn error"})`}`);
    }
  }
}
fs.writeFileSync(path.join(out, "summary.json"), `${JSON.stringify({ manifest, invocations: invocation, records: rows.length, failures: rows.filter((row) => row.exitCode !== 0 || row.error).length }, null, 2)}\n`, { mode: 0o600 });

function parseArgs(items) {
  const out = {};
  for (let i = 0; i < items.length; i++) {
    const key = items[i].replace(/^--/, "");
    if (items[i] === "--") throw new Error("unexpected positional arguments");
    const value = items[i + 1];
    if (value === undefined || value.startsWith("--")) out[key] = true;
    else { out[key] = value; i++; }
  }
  return out;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function git(...args) { const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`); return result.stdout.trim(); }
