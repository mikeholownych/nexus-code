import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let datasetApi;
try {
  datasetApi = await import("./dataset.mjs");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const evalRoot = path.dirname(fileURLToPath(import.meta.url));
const datasetRoot = path.join(evalRoot, "datasets", "core-v1");

function requiredLoader() {
  assert.equal(typeof datasetApi?.loadDataset, "function", "versioned dataset loader must be available");
  return datasetApi.loadDataset;
}

test("dataset selection returns exactly manifest-declared ids for each split", () => {
  const loadDataset = requiredLoader();
  const manifest = JSON.parse(fs.readFileSync(path.join(datasetRoot, "manifest.json"), "utf8"));
  const examples = fs.readFileSync(path.join(datasetRoot, "examples.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));

  for (const split of ["regression", "benchmark"]) {
    const selected = loadDataset(datasetRoot, { split });
    const expectedIds = examples.filter((example) => example.split === split).map((example) => example.id);
    assert.deepEqual(selected.rows.map((row) => row.id), expectedIds);
    assert.equal(selected.manifest.splits[split].count, expectedIds.length);
  }
});

test("dataset selection refuses unknown ids and invalid splits", () => {
  const loadDataset = requiredLoader();
  assert.throws(() => loadDataset(datasetRoot, { split: "held-out" }), /unsupported dataset split/);
  assert.throws(() => loadDataset(datasetRoot, { split: "" }), /unsupported dataset split/);
  assert.throws(() => loadDataset(datasetRoot, { only: new Set(["missing-task"]) }), /absent from the selected dataset split/);
});

test("versioned core dataset keeps stimulus and oracle records separate", () => {
  const loadDataset = requiredLoader();
  const manifest = JSON.parse(fs.readFileSync(path.join(datasetRoot, "manifest.json"), "utf8"));
  const readJsonl = (name) => fs.readFileSync(path.join(datasetRoot, name), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const examples = readJsonl("examples.jsonl");
  const oracles = readJsonl("oracles.jsonl");
  const loaded = loadDataset(datasetRoot, { split: "benchmark" });

  assert.equal(loaded.manifest.version, manifest.version);
  assert.deepEqual(new Set(examples.map((row) => row.id)), new Set(oracles.map((row) => row.id)));
  assert.ok(examples.every((row) => !["hidden", "regression", "assertions"].some((key) => Object.hasOwn(row, key))));
  assert.ok(oracles.every((row) => ["hidden", "regression"].some((key) => Object.hasOwn(row, key))));
  assert.ok(loaded.rows.every((row) => row.split === "benchmark" && typeof row.task.objective === "string"));
});

test("loader rejects stimulus data changed after its manifest was frozen", () => {
  const loadDataset = requiredLoader();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dataset-test-"));
  try {
    const copy = path.join(temp, "dataset");
    fs.cpSync(datasetRoot, copy, { recursive: true });
    const examplesFile = path.join(copy, "examples.jsonl");
    const changed = fs.readFileSync(examplesFile, "utf8").replace("returns a + b.", "returns a - b.");
    fs.writeFileSync(examplesFile, changed);
    assert.throws(() => loadDataset(copy), /examples\.jsonl digest mismatch/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});


test("loader rejects oracle data changed after its manifest was frozen", () => {
  const loadDataset = requiredLoader();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dataset-oracle-test-"));
  try {
    const copy = path.join(temp, "dataset");
    fs.cpSync(datasetRoot, copy, { recursive: true });
    const oracleFile = path.join(copy, "oracles.jsonl");
    const changed = fs.readFileSync(oracleFile, "utf8").replace("npm test --silent", "npm test --fail");
    fs.writeFileSync(oracleFile, changed);
    assert.throws(() => loadDataset(copy), /oracles\.jsonl digest mismatch/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("loader rejects task data changed after its manifest was frozen", () => {
  const loadDataset = requiredLoader();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dataset-task-test-"));
  try {
    const copy = path.join(temp, "dataset");
    fs.cpSync(datasetRoot, copy, { recursive: true });
    fs.appendFileSync(path.join(copy, "tasks", "selftest-add", "task.json"), " ");
    assert.throws(() => loadDataset(copy), /dataset task selftest-add digest mismatch/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});


test("runner rejects unsupported dataset split before starting a candidate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dataset-runner-test-"));
  try {
    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ name: "dataset-validation", endpoint: "http://127.0.0.1:1/v1", model: "m" }));
    const result = spawnSync(process.execPath, [
      path.join(evalRoot, "run.mjs"), "--config", config, "--out", path.join(root, "out"),
      "--dataset", datasetRoot, "--split", "held-out",
    ], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /unsupported dataset split: held-out/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate launch envelope contains stimulus but no oracle data in argv env or stdin", async () => {
  let runnerApi;
  try {
    runnerApi = await import("./runner_api.mjs");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  assert.equal(typeof runnerApi?.createAgentLaunchPayload, "function", "runner API must expose the payload used at the candidate sandbox boundary");
  assert.equal(typeof runnerApi?.serializeAgentLaunchPayload, "function", "runner API must serialize the exact candidate launch payload");

  const sentinel = "ORACLE_SENTINEL_LAUNCH_ENVELOPE_PRIVATE";
  const localToken = "LOCAL_PROXY_TOKEN_FOR_TEST";
  const payload = runnerApi.createAgentLaunchPayload({
    task: {
      id: "selftest-add",
      objective: "Add math.js with an add function.",
      hidden: { command: `node hidden.test.js # ${sentinel}` },
      regression: { command: `node regression.test.js # ${sentinel}` },
    },
    config: { agent: "nexus", model: "fixture-model", apiKey: sentinel, sampling: { temperature: 0 }, limits: { context: 4096, output: 512 } },
    agentIdentity: { command: process.execPath, argsPrefix: ["/candidate/nexus.js"] },
    budget: { steps: 4, minutes: 1 },
    localToken,
  });
  const launchStdin = runnerApi.serializeAgentLaunchPayload(payload);
  const visibleLaunch = JSON.stringify(payload);

  assert.ok(payload.argv.includes("Add math.js with an add function."), "objective reaches the candidate argv");
  assert.ok(launchStdin.includes("Add math.js with an add function."), "sandbox launch stdin carries the candidate payload");
  assert.ok(!visibleLaunch.includes(sentinel), "oracle sentinel is absent from argv and environment");
  assert.ok(!launchStdin.includes(sentinel), "oracle sentinel is absent from sandbox launch stdin");
  assert.equal(payload.env.OPENAI_API_KEY, localToken, "candidate receives only its run-scoped local proxy credential");
  assert.equal(payload.env.LOCAL_LLM_API_KEY, localToken, "candidate receives the same intended local proxy token");
});

test("per-run versioned snapshot guard preserves the bounded dataset digest", async () => {
  let integrity;
  try {
    integrity = await import("./runner_integrity.mjs");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  assert.equal(typeof integrity?.assertTaskSnapshotDigest, "function", "runner integrity API must expose a per-run snapshot guard");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dataset-snapshot-test-"));
  try {
    const copy = path.join(temp, "dataset");
    fs.cpSync(datasetRoot, copy, { recursive: true });
    const row = requiredLoader()(copy).rows[0];
    fs.writeFileSync(path.join(row.dir, "oversized.bin"), "x");
    assert.throws(() => integrity.assertTaskSnapshotDigest({
      dir: row.dir,
      treeSha256: row.treeSha256,
      id: row.id,
      versionedDataset: true,
    }), /digest mismatch|exceeds/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("importable runner API passes only evaluator config and keeps credentials private", async () => {
  const api = await import("./runner_api.mjs");
  assert.equal(typeof api.runVersionedEvaluation, "function", "runner API must export versioned evaluation");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runner-api-test-"));
  try {
    const executable = path.join(temp, "nexus");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const outputDir = path.join(temp, "output");
    let observed;
    const result = await api.runVersionedEvaluation({
      config: { apiKey: "synthetic-test-key", steps: 3 },
      nexusExecutable: executable,
      dataset: datasetRoot,
      outputDir,
      split: "regression",
      runs: 2,
      cwd: temp,
    }, {
      run: ({ configPath, ...options }) => {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        observed = {
          configPath, config, configMode: fs.statSync(configPath).mode & 0o777,
          credential: fs.readFileSync(config.apiKey.file, "utf8"),
          credentialMode: fs.statSync(config.apiKey.file).mode & 0o777,
          options,
        };
        fs.mkdirSync(options.outputDir, { mode: 0o700 });
        fs.writeFileSync(path.join(options.outputDir, "results.jsonl"), "{}\n");
      },
      score: () => ({ taskCount: 1, passRate: 1 }),
    });

    assert.equal(observed.config.agent, "nexus");
    assert.equal(observed.config.nexusExecutable, executable);
    assert.deepEqual(observed.config.apiKey, { file: path.join(path.dirname(observed.configPath), "api-key.env"), var: "NEXUS_EVAL_API_KEY" });
    assert.equal(observed.configMode, 0o600);
    assert.equal(observed.credentialMode, 0o600);
    assert.equal(observed.credential, "NEXUS_EVAL_API_KEY=synthetic-test-key\n");
    assert.equal(fs.existsSync(observed.options.dataset), true);
    assert.equal(fs.existsSync(observed.configPath), false, "private runner configuration is removed after completion");
    assert.deepEqual(result.score, { taskCount: 1, passRate: 1 });
    assert.equal(JSON.parse(fs.readFileSync(result.scoreFile, "utf8")).passRate, 1);
    assert.equal(fs.statSync(result.scoreFile).mode & 0o777, 0o600);
    await assert.rejects(api.runVersionedEvaluation({
      config: {}, nexusExecutable: executable, dataset: datasetRoot, outputDir,
    }), /output directory must not already exist/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
