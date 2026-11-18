#!/usr/bin/env node
// Real-project smoke (plan unit MQ-3). Builds pinned, synthetic-but-representative repositories in a temp dir, runs the built
// headless CLI (`node cli/dist/index.js run --json`) on each against a scripted local mock gateway (write a file, run the
// verifier, task_completed) and asserts the JSON outcome per repository. The v1.1.4 defect (a verifier definition that could
// not be bound blocked every completion) was invisible to unit tests of the verifier and visible to any real run on a
// repository with a node_modules tree or a large Makefile; this is that run.
//
//   node scripts/real_project_smoke.mjs [--cli cli/dist/index.js] [--only name,name] [--require-all] [--seed-regression] [--json]
//
// Exit 0: every repository ended REGRESSION_FREE or VERIFIED as expected. Exit 1: a repository errored, hung, or ended with
// another outcome. Exit 2: usage or setup error. --seed-regression makes the scripted model deliver a fix that does not pass
// the repository's verifier in every repository, so the run must be red (it proves the job can fail).
// Not covered: a live model, real third-party repositories, network behaviour. No network is used; no credential is read.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
// NEXUS_SMOKE_TIMEOUT_MS shortens the bound for the hang test; the default is generous for a cold CI runner.
const RUN_TIMEOUT_MS = Number(process.env.NEXUS_SMOKE_TIMEOUT_MS) > 0 ? Number(process.env.NEXUS_SMOKE_TIMEOUT_MS) : 120_000;

// ------------------------------------------------------------------ pinned repositories

const ADD_BUGGY = "exports.add = (a, b) => a - b;\n";
const ADD_FIXED = "exports.add = (a, b) => a + b;\n";
const ADD_JS_TEST =
  'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';
const NODE_TEST = "env -u NODE_TEST_CONTEXT node --test test/*.test.js";

/** Every file is a fixed string or a pure function of its index: the same bytes on every run. */
function makeRepos() {
  const manyRefs = Array.from({ length: 140 }, (_, i) => `scripts/s${i}.js`);
  const deep = Array.from({ length: 24 }, (_, i) => `d${i}`).join("/");
  return [
    {
      name: "js-node_modules",
      // npm test under a populated node_modules: the definition cannot be bound, so the pass is regression evidence only.
      expect: "REGRESSION_FREE",
      files: {
        "package.json": JSON.stringify({ name: "smoke-js", version: "1.0.0", private: true, main: "./math.js", scripts: { test: NODE_TEST } }, null, 2) + "\n",
        "math.js": ADD_BUGGY,
        "test/math.test.js": ADD_JS_TEST,
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [`node_modules/pkg${i}/package.json`, JSON.stringify({ name: `pkg${i}`, version: "1.0.0", main: "index.js" }) + "\n"]),
        ),
        ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`node_modules/pkg${i}/index.js`, `module.exports = ${i};\n`])),
        "node_modules/.bin/.keep": "",
      },
      fix: { path: "math.js", content: ADD_FIXED },
      bad: { path: "math.js", content: "exports.add = (a, b) => a - b - 0;\n" },
      verifier: "npm test",
      // The workspace gitignores node_modules as a real project does.
      gitignore: "node_modules/\n",
    },
    {
      name: "makefile-large-graph",
      // make test whose Makefile names 140 files: more than 128 references, so the definition cannot be bound either.
      expect: "REGRESSION_FREE",
      files: {
        Makefile: `.PHONY: test\ntest:\n\t${NODE_TEST}\n\n` + manyRefs.map((f) => `# ${f}`).join("\n") + "\n",
        "math.js": ADD_BUGGY,
        "test/math.test.js": ADD_JS_TEST,
        ...Object.fromEntries(manyRefs.map((f) => [f, "\n"])),
      },
      fix: { path: "math.js", content: ADD_FIXED },
      bad: { path: "math.js", content: "exports.add = (a, b) => a - b - 0;\n" },
      verifier: "make test",
    },
    {
      name: "deeply-nested",
      // The code under test and its tests sit 24 directories down.
      expect: "REGRESSION_FREE",
      files: {
        "package.json": JSON.stringify({ name: "smoke-deep", version: "1.0.0", private: true, scripts: { test: `env -u NODE_TEST_CONTEXT node --test ${deep}/test/*.test.js` } }, null, 2) + "\n",
        [`${deep}/math.js`]: ADD_BUGGY,
        [`${deep}/test/math.test.js`]: ADD_JS_TEST,
        ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${deep}/gen/g${i}.js`, `module.exports = ${i};\n`])),
      },
      fix: { path: `${deep}/math.js`, content: ADD_FIXED },
      bad: { path: `${deep}/math.js`, content: "exports.add = (a, b) => a - b - 0;\n" },
      verifier: "npm test",
    },
    {
      name: "python-pytest",
      expect: "REGRESSION_FREE",
      needs: "pytest",
      files: {
        "pyproject.toml": "[project]\nname = \"calc\"\nversion = \"0.1.0\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
        "calc/__init__.py": "",
        "calc/math.py": "def add(a, b):\n    return a - b\n",
        "tests/test_math.py": "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom calc.math import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n",
      },
      fix: { path: "calc/math.py", content: "def add(a, b):\n    return a + b\n" },
      bad: { path: "calc/math.py", content: "def add(a, b):\n    return a - b - 0\n" },
      verifier: "python3 -m pytest -p no:cacheprovider -q",
    },
  ];
}

/** The outcomes that are a pass for this smoke. UNVERIFIED, NOT_ESTABLISHED, FAILED, BLOCKED and any error are not. */
const ACCEPTED = new Set(["REGRESSION_FREE", "VERIFIED"]);

// ------------------------------------------------------------------ scripted gateway

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** An OpenAI-compatible gateway answering the n-th chat request with script[n-1]; after the script, plain text "done". */
async function startGateway(script) {
  let n = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    req.on("data", () => {});
    req.on("end", () => {
      const reply = script[n++];
      res.writeHead(200, { "content-type": "text/event-stream" });
      let out = "";
      if (!reply) out += sse({ choices: [{ index: 0, delta: { content: "done" } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      else {
        out += sse({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] } }],
        });
        out += sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      }
      res.end(out + "data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: () => n,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ------------------------------------------------------------------ one repository

function writeRepo(root, repo) {
  for (const [name, content] of Object.entries(repo.files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  if (repo.gitignore) fs.writeFileSync(path.join(root, ".gitignore"), repo.gitignore);
  const git = (args) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
  const ok = [["init", "-q"], ["config", "user.name", "smoke"], ["config", "user.email", "smoke@example.invalid"], ["add", "-A"], ["commit", "-qm", "base"]].every((a) => git(a).status === 0);
  if (!ok) throw new Error(`git setup failed for ${repo.name}`);
}

function scriptFor(repo, seedRegression) {
  const change = seedRegression ? repo.bad : repo.fix;
  return [
    { name: "write_file", args: { path: change.path, content: change.content, overwrite: true } },
    { name: "run_command", args: { command: repo.verifier } },
    { name: "task_completed", args: { summary: `Fixed add() in ${change.path}` } },
  ];
}

/** Variables that carry credentials or point the CLI at something other than the scripted gateway never reach the child. */
function cleanEnv(home) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|NODE_TEST_CONTEXT)/.test(k)) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k) || /^(AWS_|GH_|GITHUB_|GOOGLE_)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
  };
}

function runCli(cli, args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, RUN_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
  });
}

/** The JSON result is the last top-level object on stdout; anything before it is not trusted. */
function parseResult(stdout) {
  const start = stdout.indexOf("\n{") >= 0 ? stdout.indexOf("\n{") + 1 : stdout.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}

/**
 * Whether the verifier will find pytest. The CLI under test runs with a throwaway HOME, so a pytest installed with
 * `pip install --user` (under the real home's user site) is invisible to it; the probe must see what the child sees.
 */
export function pytestAvailable() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-smoke-probe-"));
  try {
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_CACHE_HOME: path.join(home, ".cache") };
    delete env.PYTHONUSERBASE;
    return spawnSync("python3", ["-m", "pytest", "--version"], { stdio: "ignore", env }).status === 0;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export async function smokeOne(repo, { cli, seedRegression }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-smoke-${repo.name}-`));
  const root = path.join(base, "repo");
  const home = path.join(base, "home");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const gateway = await startGateway(scriptFor(repo, seedRegression));
  const started = Date.now();
  try {
    writeRepo(root, repo);
    const run = await runCli(
      cli,
      ["run", "-e", gateway.url, "-m", "m", "--yes", "--json", "--max-steps", "12", "-w", root, `Fix add() in ${repo.fix.path} so ${repo.verifier} passes.`],
      root,
      cleanEnv(home),
    );
    const result = parseResult(run.out);
    const problems = [];
    if (run.timedOut) problems.push(`hung: killed after ${RUN_TIMEOUT_MS / 1000}s`);
    else if (!result) problems.push(`no JSON result (exit ${run.code}); stderr: ${run.err.slice(-300).replace(/\s+/g, " ")}`);
    else {
      const turn = result.turn?.outcome;
      if (result.turn?.execution !== "COMPLETED") problems.push(`execution ${result.turn?.execution}, not COMPLETED${result.error ? `: ${String(result.error).slice(0, 200)}` : ""}`);
      if (!ACCEPTED.has(turn)) problems.push(`outcome ${turn} is not REGRESSION_FREE or VERIFIED: ${String(result.turn?.detail ?? result.turn?.reason ?? "").slice(0, 300)}`);
      else if (turn !== repo.expect) problems.push(`outcome ${turn}, expected ${repo.expect}`);
      // 0 is VERIFIED; 2 is REGRESSION_FREE (completed, regression evidence only). Any other code is an error.
      if (run.code !== (turn === "VERIFIED" ? 0 : 2)) problems.push(`exit code ${run.code}`);
    }
    return { name: repo.name, ok: problems.length === 0, problems, outcome: result?.turn?.outcome ?? null, ms: Date.now() - started, requests: gateway.requests() };
  } finally {
    await gateway.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ main

export async function main(argv) {
  const opt = { cli: path.join(ROOT, "cli", "dist", "index.js"), only: null, requireAll: false, cliGiven: false, seedRegression: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cli") { opt.cli = path.resolve(argv[++i] ?? ""); opt.cliGiven = true; }
    else if (a === "--only") opt.only = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    else if (a === "--require-all") opt.requireAll = true;
    else if (a === "--seed-regression") opt.seedRegression = true;
    else if (a === "--json") opt.json = true;
    else { console.error(`unknown argument ${a}`); return 2; }
  }
  // Without the Rust core the headless run does not verify at all (it ends NOT_REQUIRED), which would hide the defect this job exists for.
  const core = path.join(ROOT, "core", "target", "release", "harness-core");
  if (!opt.cliGiven && !fs.existsSync(core)) { console.error(`Rust core not built: ${core} (cargo build --release --manifest-path core/Cargo.toml --bin harness-core --bin nexus-tui)`); return 2; }
  if (!fs.existsSync(opt.cli)) { console.error(`CLI not built: ${opt.cli} (run npm run build in cli/)`); return 2; }
  const repos = makeRepos().filter((r) => !opt.only || opt.only.has(r.name));
  if (!repos.length) { console.error("no repository selected"); return 2; }

  const results = [];
  for (const repo of repos) {
    if (repo.needs === "pytest" && !pytestAvailable()) {
      const r = { name: repo.name, ok: !opt.requireAll, skipped: true, problems: opt.requireAll ? ["pytest is not installed where the isolated run can see it (--require-all); install it system-wide, not with pip --user"] : [], outcome: null, ms: 0, requests: 0 };
      results.push(r);
      continue;
    }
    results.push(await smokeOne(repo, opt));
  }
  const failed = results.filter((r) => !r.ok);
  if (opt.json) console.log(JSON.stringify({ seedRegression: opt.seedRegression, results }, null, 2));
  else {
    for (const r of results) console.log(`${r.ok ? (r.skipped ? "SKIP" : "ok  ") : "FAIL"}  ${r.name}  ${r.outcome ?? "-"}  ${r.ms}ms${r.problems.length ? `  ${r.problems.join("; ")}` : ""}`);
    console.log(failed.length ? `real-project smoke: ${failed.length} of ${results.length} failed` : `real-project smoke: ${results.length} repositories ok`);
  }
  return failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(String(e?.stack ?? e)); process.exit(2); });
}
