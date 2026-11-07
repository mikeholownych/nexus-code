import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GLOBAL_OPTIONAL_VALUE_OPTIONS, GLOBAL_VALUE_OPTIONS, firstCommandToken, isolateEvalCommandHome, resolveInstalledEvalRuntime } from "../src/eval_cli.js";

test("--isolated-home is applied when global options precede the eval subcommand", () => {
  const before = process.env.HOME;
  const restore = isolateEvalCommandHome(["-e", "http://127.0.0.1:1/v1", "--workspace", "/tmp/w", "eval", "--dataset", "d", "--isolated-home"]);
  try {
    assert.ok(restore, "isolation must be applied, not silently skipped");
    assert.notEqual(process.env.HOME, before);
  } finally {
    restore?.();
  }
  assert.equal(process.env.HOME, before);
});

test("--isolated-home is rejected when the invocation is not an eval command", () => {
  assert.throws(() => isolateEvalCommandHome(["run", "--isolated-home"]), /--isolated-home.*eval/);
  assert.throws(() => isolateEvalCommandHome(["-m", "eval", "run", "--isolated-home"]), /--isolated-home.*eval/);
  assert.equal(isolateEvalCommandHome(["run", "task"]), undefined);
});

test("a `--` that is an option's value does not end option parsing for an eval invocation", () => {
  const cases = [
    ["eval", "--dataset", "d", "--output", "--", "--isolated-home"],
    ["eval", "--output", "--", "--isolated-home", "--dataset", "d"],
    ["-e", "--", "eval", "--dataset", "d", "--isolated-home"],
    ["-m", "--", "-w", "--", "eval", "--isolated-home"],
  ];
  for (const args of cases) {
    const before = process.env.HOME;
    const restore = isolateEvalCommandHome(args);
    try {
      assert.ok(restore, `isolation must apply for: ${args.join(" ")}`);
      assert.notEqual(process.env.HOME, before);
    } finally {
      restore?.();
    }
  }
});

test("operands after `--` are never read as the --isolated-home option", () => {
  // `nexus run -- explain --isolated-home` is a prompt about the flag, not a request to use it.
  assert.equal(isolateEvalCommandHome(["run", "--", "explain", "--isolated-home"]), undefined);
  assert.equal(isolateEvalCommandHome(["--", "explain", "--isolated-home"]), undefined);
});

test("--isolated-home after `--` is not an eval invocation, and clustered short flags are read like Commander", () => {
  assert.equal(isolateEvalCommandHome(["--", "eval", "x", "--isolated-home"]), undefined);
  // -yw takes /x as the workspace value; the next token is the command.
  assert.equal(firstCommandToken(["-yw", "/x", "eval"]), "eval");
  // -ywPATH carries its value attached, so `eval` is the command.
  assert.equal(firstCommandToken(["-yw/x", "eval"]), "eval");
  // -yr takes an optional value: `eval` would be consumed as the resume id, exactly as Commander does.
  assert.equal(firstCommandToken(["-yr", "eval", "run"]), "run");
  assert.equal(firstCommandToken(["-y", "eval"]), "eval");
});

test("GLOBAL_VALUE_OPTIONS matches the global option table in index.ts", () => {
  const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"), "utf8");
  const start = source.indexOf('.name("nexus")');
  const end = source.indexOf(".action(", start);
  assert.ok(start > 0 && end > start, "global option table not found");
  const required = new Set<string>();
  const optional = new Set<string>();
  for (const match of source.slice(start, end).matchAll(/\.option\("([^"]+)"/g)) {
    const spec = match[1];
    const flags = spec.split(/[ ,]+/).filter((token) => token.startsWith("-"));
    if (spec.includes("<")) flags.forEach((flag) => required.add(flag));
    else if (spec.includes("[")) flags.forEach((flag) => optional.add(flag));
  }
  assert.deepEqual([...GLOBAL_VALUE_OPTIONS].sort(), [...required].sort());
  assert.deepEqual([...GLOBAL_OPTIONAL_VALUE_OPTIONS].sort(), [...optional].sort());
});

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

function runEvalCli(args: string[], home: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, "eval", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    timeout: 30_000,
  });
}

function runEvalCliAsync(args: string[], home: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [CLI, "eval", ...args], {
    env: { ...process.env, ...extraEnv, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

async function mockEvalEndpoint() {
  const requests: Array<{ path: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "eval-test", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unexpected mock endpoint request" } }));
        return;
      }
      requests.push({ path: req.url ?? "", body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-eval-limit-test", choices: [{ index: 0, delta: { role: "assistant", content: "Done." } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-eval-limit-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("eval CLI help exposes versioned dataset options", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-help-"));
  try {
    const result = runEvalCli(["--help"], home);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
    for (const option of ["--dataset", "--split", "--runs", "--isolated-home", "--output"]) {
      assert.match(output, new RegExp(option.replaceAll("-", "\\-")), output);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("versioned eval rejects limit before runner or output creation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-limit-"));
  const dataset = path.join(home, "dataset");
  const output = path.join(home, "scores", "score.json");
  const outputDir = `${output}.artifacts`;
  fs.mkdirSync(dataset);
  try {
    const result = runEvalCli(["--dataset", dataset, "--split", "benchmark", "--limit", "1", "--output", output], home, {
      NEXUS_HOME: path.join(home, "missing-installed-package"),
    });
    const text = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, text);
    assert.match(text, /--limit is not supported for versioned datasets/i, text);
    assert.equal(fs.existsSync(path.dirname(output)), false, "unsupported arguments must fail before creating the score directory");
    assert.equal(fs.existsSync(output), false, "unsupported arguments must fail before writing score output");
    assert.equal(fs.existsSync(outputDir), false, "unsupported arguments must fail before creating run artifacts");
    assert.doesNotMatch(text, /NEXUS_HOME|installed evaluator runtime/i, "argument validation must happen before installed runner resolution");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("legacy eval help keeps --limit and documents its legacy-only scope", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-legacy-help-"));
  try {
    const result = runEvalCli(["--help"], home);
    const text = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, text);
    assert.match(text, /--limit <number>/, text);
    assert.match(text, /legacy/i, text);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("legacy eval invocation and limit remain supported for non-empty datasets", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-legacy-run-"));
  const dataset = path.join(home, "legacy.json");
  const output = path.join(home, "legacy-score.md");
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(dataset, JSON.stringify([
    { instance_id: "legacy-first", repo: "example/repo", problem_statement: "first legacy task" },
    { instance_id: "legacy-second", repo: "example/repo", problem_statement: "second legacy task" },
  ]));
  const mock = await mockEvalEndpoint();
  try {
    const result = await runEvalCliAsync([dataset, "--limit", "1", "--max-steps", "1", "--endpoint", mock.endpoint, "--model", "eval-test", "--workspace", workspace, "--output", output], home);
    const text = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, text);
    assert.match(text, /Loaded 1 benchmark task instance/);
    assert.match(fs.readFileSync(output, "utf8"), /Total Instances\*\*: 1/);
    assert.equal(mock.requests.length, 1, "--limit 1 must evaluate exactly the first non-empty dataset instance");
    assert.match(JSON.stringify(mock.requests[0].body.messages), /first legacy task/);
    assert.doesNotMatch(JSON.stringify(mock.requests[0].body.messages), /second legacy task/);
  } finally {
    await mock.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("versioned eval invokes resolved installed runner", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-installed-runner-"));
  const packageRoot = path.join(home, "installed");
  const dataset = path.join(home, "dataset");
  const output = path.join(home, "scores", "score.json");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "eval"), { recursive: true });
  fs.mkdirSync(dataset);
  fs.writeFileSync(path.join(packageRoot, "bin", "nexus"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(path.join(packageRoot, "eval", "runner_api.mjs"), [
    "export async function runVersionedEvaluation(options) {",
    "  return { outputDir: options.outputDir, resultsFile: options.outputDir + '/results.jsonl', manifestFile: options.outputDir + '/manifest.json', scoreFile: options.outputDir + '/score.json', score: { installedRunner: true, split: options.split, runs: options.runs, home: process.env.HOME, runtimePaths: options.config.sandboxRuntimePaths } };",
    "}",
  ].join("\n"));
  try {
    const result = runEvalCli(["--dataset", dataset, "--split", "benchmark", "--runs", "2", "--isolated-home", "--endpoint", "http://127.0.0.1:1/v1", "--model", "eval-test", "--output", output], home, { NEXUS_HOME: packageRoot });
    const text = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, text);
    const score = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(score.score.installedRunner, true);
    assert.equal(score.score.split, "benchmark");
    assert.equal(score.runs, 2);
    assert.deepEqual(score.score.runtimePaths, [path.join(packageRoot, "lib", "cli"), path.join(packageRoot, "lib", "core")]);
    assert.notEqual(score.score.home, home, "isolated runs start before config and runner initialization");
    assert.equal(fs.existsSync(score.score.home), false, "the temporary command HOME is removed at process exit");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installed eval resolver refuses checkout fallback", () => {
  assert.throws(() => resolveInstalledEvalRuntime({}), /installed Nexus launcher \(NEXUS_HOME is unavailable\)/);
});

test("installed eval resolver rejects a runtime symlink outside the package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-runtime-boundary-"));
  const packageRoot = path.join(root, "package");
  const outsideRunner = path.join(root, "runner_api.mjs");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "eval"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "bin", "nexus"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(outsideRunner, "export {};\n");
  fs.symlinkSync(outsideRunner, path.join(packageRoot, "eval", "runner_api.mjs"));
  try {
    assert.throws(() => resolveInstalledEvalRuntime({ NEXUS_HOME: packageRoot }), /resolves outside NEXUS_HOME/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
