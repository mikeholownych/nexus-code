import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stageEvaluatorRuntime, EVAL_RUNTIME_FILES } from "../scripts/stage_eval_runtime.mjs";

const expectedRuntimeFiles = [
  "eval/run.mjs", "eval/validate.mjs", "eval/t4_fixtures.mjs", "eval/isolate.mjs",
  "eval/hide_oracle.cjs", "eval/hide_oracle.py", "eval/unlink_then_exec.sh",
  "eval/agent_sandbox.mjs", "eval/model_proxy.mjs", "eval/score.mjs", "eval/dataset.mjs",
  "eval/runner_integrity.mjs", "eval/runner_api.mjs", "eval/oracle.mjs", "eval/infra.mjs",
  "eval/workspace.mjs", "eval/resources.mjs", "eval/cgroup_supervisor.mjs", "eval/t3.mjs",
  "eval/hardened_check.mjs", "eval/toolchain-versions.json", "eval/scan-compiler-exposure.mjs",
  "eval/evaluators/code/index.mjs",
  "eval/evaluators/code/syntax_ast.mjs",
  "eval/evaluators/code/build.mjs",
  "eval/evaluators/code/typecheck_clean.mjs",
  "eval/evaluators/code/diff_boundary.mjs",
  "eval/evaluators/code/runner.mjs",
  "eval/evaluators/code/json_repair_rate.mjs",
  "eval/evaluators/code/parsers.mjs",
  "eval/evaluators/code/command.mjs",
  "eval/evaluators/code/result.mjs",
  "eval/evaluators/code/README.md",
];

test("installed candidate runs all public benchmark tasks with provenance", {
  skip: process.env.NEXUS_PACKAGE_ARCHIVE && process.env.NEXUS_PACKAGE_INSTALL_ROOT && process.env.NEXUS_ACCEPTANCE_EVIDENCE_PATH
    ? false
    : "set exact package archive, safe install root and evidence paths to run installed-candidate acceptance",
  timeout: 180_000,
}, async () => {
  const packageArchive = fs.realpathSync(process.env.NEXUS_PACKAGE_ARCHIVE);
  const installRoot = path.resolve(process.env.NEXUS_PACKAGE_INSTALL_ROOT);
  const evidencePath = process.env.NEXUS_ACCEPTANCE_EVIDENCE_PATH;
  const packageArchiveSha256 = createHash("sha256").update(fs.readFileSync(packageArchive)).digest("hex");
  assert.equal(path.basename(evidencePath).startsWith(`acceptance-${packageArchiveSha256.slice(0, 12)}`), true, "acceptance evidence must be candidate-specific");
  assert.equal(fs.existsSync(evidencePath), false, "candidate evidence is immutable and must not overwrite an earlier run");
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(installRoot === "/tmp" || installRoot.startsWith("/tmp/") || installRoot === "/var/tmp" || installRoot.startsWith("/var/tmp/"), false, "candidate runtime must be installed outside protected temporary roots");
  assert.equal(installRoot === sourceRoot || installRoot.startsWith(`${sourceRoot}${path.sep}`), false, "candidate install root must be outside the source checkout");
  fs.mkdirSync(installRoot, { recursive: true });
  assert.deepEqual(fs.readdirSync(installRoot), [], "candidate install root must be empty");
  const listing = spawnSync("tar", ["-tzf", packageArchive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(listing.stdout.split("\n").filter(Boolean).every((entry) => entry.startsWith("nexus/") && !entry.split("/").includes("..")), "candidate archive must contain only the nexus/ package root");
  const extracted = spawnSync("tar", ["-xzf", packageArchive, "-C", installRoot], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  const packageRoot = fs.realpathSync(path.join(installRoot, "nexus"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-benchmark-acceptance-"));
  const dataset = path.join(outside, "dataset");
  fs.cpSync(path.join(sourceRoot, "eval/datasets/core-v1"), dataset, { recursive: true });
  const manifestPath = path.join(dataset, "manifest.json");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const examples = fs.readFileSync(path.join(sourceRoot, "eval/datasets/core-v1/examples.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const oracles = fs.readFileSync(path.join(sourceRoot, "eval/datasets/core-v1/oracles.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const oracleById = new Map(oracles.map((oracle) => [oracle.id, oracle]));
  const benchmark = examples.filter((example) => example.split === "benchmark");
  const expectedIds = benchmark.map((example) => example.id).sort();
  assert.equal(expectedIds.length, manifest.splits.benchmark.count);
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "v112-ac5-local" }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw);
        requests.push(body);
        const toolCall = {
          id: `accept-${requests.length}`,
          type: "function",
          function: { name: "task_completed", arguments: JSON.stringify({ summary: "deterministic acceptance fixture" }) },
        };
        const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] } }] }) +
          frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n");
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("invalid JSON request body");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const workspace = path.join(outside, "workspace");
  fs.mkdirSync(workspace);
  const outputPath = path.join(outside, "score.json");
  const launcher = path.join(packageRoot, "bin", "nexus");
  const child = spawn(launcher, ["eval", "--dataset", dataset, "--split", "benchmark", "--runs", "1", "--max-steps", "1", "--max-minutes", "1", "--isolated-home", "--workspace", workspace, "--output", outputPath], {
    cwd: outside,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: outside,
      NEXUS_HOME: packageRoot,
      LOCAL_LLM_ENDPOINT: `http://127.0.0.1:${address.port}/v1`,
      LOCAL_LLM_MODEL: "v112-ac5-local",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  let timer;
  try {
    const status = await new Promise((resolve, reject) => {
      timer = setTimeout(() => child.kill("SIGTERM"), 165_000);
      child.once("error", reject);
      child.once("close", resolve);
    });
    clearTimeout(timer);
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    const artifactDir = `${outputPath}.artifacts`;
    const resultRecords = fs.readFileSync(path.join(artifactDir, "results.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const score = JSON.parse(fs.readFileSync(path.join(artifactDir, "score.json"), "utf8"));
    assert.equal(resultRecords.length, expectedIds.length, "every benchmark task must produce one invocation record");
    assert.equal(requests.length, expectedIds.length, "every benchmark task must reach the captured local provider once");
    assert.deepEqual(resultRecords.map((record) => record.task).sort(), expectedIds);
    assert.deepEqual(score.rows.map((row) => row.task).sort(), expectedIds);
    assert.equal(score.totals.runs, expectedIds.length);
    const requestText = (request) => (request.messages ?? []).map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    const captured = requests.map(requestText);
    const requestIndexByTask = new Map();
    for (const example of benchmark) {
      const requestIndex = captured.findIndex((messages) => messages.includes(example.objective));
      assert.notEqual(requestIndex, -1, `captured candidate request is missing ${example.id}`);
      requestIndexByTask.set(example.id, requestIndex);
      const request = captured[requestIndex];
      const oracle = oracleById.get(example.id);
      assert.ok(oracle?.hidden?.command, `hidden validator is missing for ${example.id}`);
      assert.equal(request.includes(`${oracle.hidden.dir}/`), false, `relative hidden oracle path leaked to candidate request for ${example.id}`);
      assert.equal(request.includes(oracle.hidden.command), false, `hidden validator command leaked to candidate request for ${example.id}`);
    }
    const resultByTask = new Map(resultRecords.map((record) => [record.task, record]));
    const scoreByTask = new Map(score.rows.map((row) => [row.task, row]));
    const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const evidence = {
      schemaVersion: 1,
      candidate: {
        packageArchiveSha256,
        launcherSha256: sha256File(launcher),
        cliBundleSha256: sha256File(path.join(packageRoot, "lib", "cli", "dist", "index.js")),
        coreBinarySha256: sha256File(path.join(packageRoot, "lib", "core", "harness-core")),
      },
      dataset: { name: manifest.name, version: manifest.version, split: "benchmark", manifestSha256, manifestSha256Source: "recomputed from final integrated eval/datasets/core-v1/manifest.json" },
      provider: { kind: "loopback-deterministic-fake", capturedRequests: requests.length },
      expectedTaskIds: expectedIds,
      missingTaskIds: [],
      skippedTaskIds: [],
      results: expectedIds.map((taskId) => {
        const record = resultByTask.get(taskId);
        const scored = scoreByTask.get(taskId);
        return {
          taskId,
          invocations: 1,
          requestSha256: createHash("sha256").update(JSON.stringify(requests[requestIndexByTask.get(taskId)])).digest("hex"),
          validatorResult: { hiddenPass: record.hiddenPass, regressionPass: record.regressionPass, exitCode: record.exitCode, timedOut: record.timedOut },
          scorerResult: { claimed: scored.claimed, correct: scored.correct, errors: scored.errors, regressions: scored.regressions },
        };
      }),
    };
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(installRoot, { recursive: true, force: true });
  }

  assert.ok(fs.existsSync(evidencePath), `acceptance evidence is missing: ${evidencePath}`);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.dataset.name, manifest.name);
  assert.equal(evidence.dataset.version, manifest.version);
  assert.equal(evidence.dataset.split, "benchmark");
  assert.equal(evidence.dataset.manifestSha256, createHash("sha256").update(manifestBytes).digest("hex"));
  assert.equal(evidence.dataset.manifestSha256Source, "recomputed from final integrated eval/datasets/core-v1/manifest.json");
  for (const digest of [evidence.candidate.packageArchiveSha256, evidence.candidate.launcherSha256, evidence.candidate.cliBundleSha256, evidence.candidate.coreBinarySha256]) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual([...evidence.expectedTaskIds].sort(), expectedIds);
  assert.equal(evidence.provider.kind, "loopback-deterministic-fake");
  assert.equal(evidence.provider.capturedRequests, expectedIds.length);
  assert.deepEqual(evidence.missingTaskIds, []);
  assert.deepEqual(evidence.skippedTaskIds, []);
  assert.equal(evidence.results.length, expectedIds.length);
  assert.deepEqual(evidence.results.map((result) => result.taskId).sort(), expectedIds);
  for (const result of evidence.results) {
    assert.equal(result.invocations, 1, result.taskId);
    assert.ok(result.validatorResult && typeof result.validatorResult === "object", result.taskId);
    assert.ok(result.scorerResult && typeof result.scorerResult === "object", result.taskId);
  }
});

test("evaluator runtime allowlist copies only runtime files", () => {
  assert.deepEqual(EVAL_RUNTIME_FILES, expectedRuntimeFiles);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-runtime-package-"));
  const source = path.join(root, "source");
  const packageRoot = path.join(root, "package");
  try {
    for (const file of expectedRuntimeFiles) {
      const sourceFile = path.join(source, file);
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(sourceFile, `runtime:${file}\n`);
    }
    fs.mkdirSync(path.join(source, "eval", "datasets", "core-v1"), { recursive: true });
    fs.writeFileSync(path.join(source, "eval", "datasets", "core-v1", "oracles.jsonl"), "secret oracle\n");
    fs.mkdirSync(path.join(source, "eval", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(source, "eval", "tasks", "held-out.json"), "held-out\n");

    stageEvaluatorRuntime(source, packageRoot);

    for (const file of expectedRuntimeFiles) {
      assert.equal(fs.readFileSync(path.join(packageRoot, file), "utf8"), `runtime:${file}\n`, file);
    }
    assert.equal(fs.existsSync(path.join(packageRoot, "eval", "datasets")), false);
    assert.equal(fs.existsSync(path.join(packageRoot, "eval", "tasks")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evaluator runtime staging fails when an allowlisted module is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-runtime-missing-"));
  try {
    assert.throws(() => stageEvaluatorRuntime(root, path.join(root, "package")), /required evaluator runtime module is missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged evaluator runtime executes outside checkout", { skip: process.env.NEXUS_PACKAGE_ROOT ? false : "set NEXUS_PACKAGE_ROOT to a freshly built package" }, async () => {
  const packageRoot = fs.realpathSync(process.env.NEXUS_PACKAGE_ROOT);
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(packageRoot === sourceRoot || packageRoot.startsWith(`${sourceRoot}${path.sep}`), false, "package must be staged outside the source checkout");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-installed-eval-smoke-"));
  const dataset = path.join(outside, "dataset");
  const outputDir = path.join(outside, "score.json.artifacts");
  fs.mkdirSync(dataset);
  try {
    const examples = "";
    const oracles = "";
    fs.writeFileSync(path.join(dataset, "examples.jsonl"), examples);
    fs.writeFileSync(path.join(dataset, "oracles.jsonl"), oracles);
    fs.writeFileSync(path.join(dataset, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      name: "empty-package-smoke",
      version: "1.0.0",
      domains: [],
      splits: { regression: { count: 0 }, benchmark: { count: 0 } },
      files: {
        "examples.jsonl": createHash("sha256").update(examples).digest("hex"),
        "oracles.jsonl": createHash("sha256").update(oracles).digest("hex"),
      },
      tasks: {},
    }, null, 2)}\n`);

    const launcher = path.join(packageRoot, "bin", "nexus");
    const help = spawnSync(launcher, ["eval", "--help"], {
      cwd: outside,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: outside, NEXUS_HOME: packageRoot },
      timeout: 30_000,
    });
    assert.equal(help.status, 0, `${help.stdout}${help.stderr}`);
    assert.match(help.stdout, /--dataset <path>/);
    assert.match(help.stdout, /--split <name>/);

    const evalRun = spawnSync(launcher, [
      "eval", "--dataset", dataset, "--split", "benchmark", "--runs", "1", "--output", path.join(outside, "score.json"),
    ], {
      cwd: outside,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: outside,
        NEXUS_HOME: packageRoot,
        LOCAL_LLM_ENDPOINT: "http://127.0.0.1:1/v1",
        LOCAL_LLM_MODEL: "package-smoke",
      },
      timeout: 30_000,
    });
    assert.equal(evalRun.status, 0, `${evalRun.stdout}${evalRun.stderr}`);
    const score = JSON.parse(fs.readFileSync(path.join(outside, "score.json"), "utf8"));
    assert.equal(score.score.totals.runs, 0);
    assert.equal(fs.existsSync(path.join(outputDir, "results.jsonl")), true);
    assert.equal(fs.existsSync(path.join(outputDir, "score.json")), true);
    assert.equal(fs.statSync(path.join(outside, "score.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(outputDir, "score.json")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("installed package launches a non-empty candidate without mounting evaluator code", { timeout: 120_000, skip: process.env.NEXUS_PACKAGE_ROOT ? false : "set NEXUS_PACKAGE_ROOT to a freshly built package" }, async () => {
  const packageRoot = fs.realpathSync(process.env.NEXUS_PACKAGE_ROOT);
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(packageRoot === sourceRoot || packageRoot.startsWith(`${sourceRoot}${path.sep}`), false, "package must be staged outside the source checkout");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-installed-eval-candidate-"));
  const dataset = path.join(outside, "dataset");
  fs.cpSync(path.join(sourceRoot, "eval", "datasets", "core-v1"), dataset, { recursive: true });
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "package-smoke" }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
      if (requests.length === 1) {
        res.end(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "write-math", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "math.js", content: "exports.add = (a, b) => a + b;\n" }) } }] } }] }) + frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n");
      } else {
        res.end(frame({ choices: [{ index: 0, delta: { content: "Implemented math.js." } }] }) + frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const launcher = path.join(packageRoot, "bin", "nexus");
  const child = spawn(launcher, ["eval", "--dataset", dataset, "--split", "regression", "--runs", "1", "--max-steps", "3", "--output", path.join(outside, "score.json")], {
    cwd: outside,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: outside, NEXUS_HOME: packageRoot, LOCAL_LLM_ENDPOINT: `http://127.0.0.1:${address.port}/v1`, LOCAL_LLM_MODEL: "package-smoke" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  let timer;
  try {
    const status = await new Promise((resolve, reject) => {
      timer = setTimeout(() => child.kill("SIGTERM"), 100_000);
      child.once("error", reject);
      child.once("close", resolve);
    });
    clearTimeout(timer);
    assert.equal(status, 0, `${stdout}${stderr}`);
    assert.ok(requests.length >= 1, `installed candidate must reach the deterministic provider; stdout=${stdout}\nstderr=${stderr}`);
    assert.match(JSON.stringify(requests[0].messages), /Add math\.js exporting add/);
    assert.equal(fs.existsSync(path.join(outside, "score.json.artifacts", "results.jsonl")), true);
    assert.equal(fs.existsSync(path.join(outside, "score.json.artifacts", "score.json")), true);
    const artifactScore = JSON.parse(fs.readFileSync(path.join(outside, "score.json.artifacts", "score.json"), "utf8"));
    assert.equal(artifactScore.totals.crashed, 0, JSON.stringify(artifactScore));
    assert.equal(artifactScore.rows.find((row) => row.task === "selftest-add")?.correct, 1, JSON.stringify(artifactScore));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
