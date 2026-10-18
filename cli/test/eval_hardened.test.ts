/**
 * Hardened legacy hidden tests (owner decision 2026-10-18) and the sealed heldout-v2 corpus binding: test
 * infrastructure is never carried from the agent's workspace into the checks, test-runner configuration changes refuse
 * the checks, and the custodian's task/hidden digests bind the selected corpus exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway } from "./helpers/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hardened = () => import(path.join(ROOT, "eval/hardened_check.mjs"));
const gitEnv = { PATH: "/usr/bin:/bin", HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...argv: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...argv], { cwd, env: gitEnv, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test("test infrastructure is recognised across Python, Go, JS/TS and Rust layouts", async () => {
  const { isTestInfraPath } = await hardened();
  for (const p of ["conftest.py", "pkg/conftest.py", "pytest.ini", "tox.ini", "setup.cfg", "sitecustomize.py", "x.pth", "tests/test_a.py", "src/test_a.py", "a_test.py",
    "pkg/x_test.go", "src/x.test.ts", "web/a.spec.jsx", "__tests__/a.js", "jest.config.js", "vitest.config.mts", ".mocharc.json", "build.rs", ".cargo/config.toml", ".github/workflows/ci.yml", "Makefile", ".env.local"]) {
    assert.equal(isTestInfraPath(p), true, p);
  }
  for (const p of ["src/app.py", "pkg/server.go", "src/index.ts", "src/lib.rs", "README.md", "package.json", "pyproject.toml", "Cargo.toml", "contest.py"]) {
    assert.equal(isTestInfraPath(p), false, p);
  }
});

test("dependency manifests keep source changes but refuse test-runner configuration changes", async () => {
  const { testConfigChange } = await hardened();
  const pkg = (o: object) => JSON.stringify({ name: "x", dependencies: { a: "1" }, scripts: { build: "tsc", test: "node --test" }, ...o });
  assert.equal(testConfigChange("package.json", pkg({}), pkg({ dependencies: { a: "2" } })), null, "a dependency bump is a source change");
  assert.match(testConfigChange("package.json", pkg({}), pkg({ scripts: { build: "tsc", test: "exit 0" } })) ?? "", /script "test"/);
  assert.match(testConfigChange("package.json", pkg({}), pkg({ jest: { testMatch: [] } })) ?? "", /"jest"/);
  assert.match(testConfigChange("package.json", pkg({}), "{") ?? "", /no longer parses/);
  const toml = (pytest: string) => `[project]\nname = "x"\n\n[tool.pytest.ini_options]\n${pytest}\n`;
  assert.equal(testConfigChange("pyproject.toml", toml("addopts = '-q'"), toml("addopts = '-q'").replace('name = "x"', 'name = "y"')), null);
  assert.match(testConfigChange("pyproject.toml", toml("addopts = '-q'"), toml("addopts = '-p no:cacheprovider --co'")) ?? "", /pyproject/);
  assert.match(testConfigChange("Cargo.toml", "[package]\nname=\"x\"\n", "[package]\nname=\"x\"\n\n[dev-dependencies]\nfake=\"1\"\n") ?? "", /Cargo.toml/);
});

test("only the agent's source changes reach the fresh check workspace", async () => {
  const { applyAgentChanges } = await hardened();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hardened-"));
  try {
    const agent = path.join(base, "agent");
    const fresh = path.join(base, "fresh");
    for (const dir of [agent, fresh]) {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src/app.py"), "def f(): return 1\n");
      fs.writeFileSync(path.join(dir, "src/old.py"), "x = 1\n");
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    }
    git(agent, "init", "-q"); git(agent, "add", "-A"); git(agent, "commit", "-qm", "baseline");
    const baseline = git(agent, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(agent, "src/app.py"), "def f(): return 2\n");
    fs.rmSync(path.join(agent, "src/old.py"));
    fs.writeFileSync(path.join(agent, "src/new.py"), "y = 2\n");
    fs.writeFileSync(path.join(agent, "conftest.py"), "import pytest\n");
    fs.mkdirSync(path.join(agent, "tests"));
    fs.writeFileSync(path.join(agent, "tests/test_mine.py"), "def test(): pass\n");
    fs.writeFileSync(path.join(agent, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
    const result = applyAgentChanges(agent, fresh, baseline);
    assert.equal(fs.readFileSync(path.join(fresh, "src/app.py"), "utf8"), "def f(): return 2\n");
    assert.equal(fs.existsSync(path.join(fresh, "src/old.py")), false, "deletions are applied");
    assert.equal(fs.readFileSync(path.join(fresh, "src/new.py"), "utf8"), "y = 2\n");
    assert.equal(fs.existsSync(path.join(fresh, "conftest.py")), false, "conftest.py never reaches the checks");
    assert.equal(fs.existsSync(path.join(fresh, "tests/test_mine.py")), false);
    assert.deepEqual(result.discarded.sort(), ["conftest.py", "tests/test_mine.py"]);
    assert.match(result.configChanges.join(), /script "test" changed/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a heldout-v2 manifest binds each selected task's task.json and hidden directory", async () => {
  const { corpusManifestProblem } = await import(path.join(ROOT, "eval/validate.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heldout-v2-"));
  try {
    const tasks = path.join(root, "tasks");
    const rows = [];
    for (const id of ["t2-a", "t2-b"]) {
      fs.mkdirSync(path.join(tasks, id, "hidden", "sub"), { recursive: true });
      const taskJson = JSON.stringify({ id, tier: "T2", hidden: { dir: "hidden", command: "pytest hidden" } });
      fs.writeFileSync(path.join(tasks, id, "task.json"), taskJson);
      fs.writeFileSync(path.join(tasks, id, "hidden", "test_x.py"), `# ${id}\n`);
      fs.writeFileSync(path.join(tasks, id, "hidden", "sub", "data.txt"), "d\n");
      const lines = ["sub/data.txt", "test_x.py"].map((p) => `${p}  ${createHash("sha256").update(fs.readFileSync(path.join(tasks, id, "hidden", p))).digest("hex")}\n`).join("");
      rows.push({ id, task_sha256: createHash("sha256").update(taskJson).digest("hex"), hidden_sha256: createHash("sha256").update(lines).digest("hex") });
    }
    const manifest = { tier: "T2", task_count: 2, tasks: rows, hash_scheme: {
      task_sha256: "sha256 of raw tasks/<id>/task.json bytes",
      hidden_sha256: "sha256 of sorted '<path>  <sha256(file)>\\n' lines over tasks/<id>/<hidden.dir> (bin/hidden_digest.mjs)",
    } };
    const manifestFile = path.join(root, "manifest.json");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const config = { corpusManifest: manifestFile, corpusManifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), corpusCustody: { custodian: "synthetic", approvedAt: "2026-01-01T00:00:00Z", reportSha256: "c".repeat(64) } };
    assert.equal(corpusManifestProblem(config, tasks, ["t2-a", "t2-b"]), null);
    assert.match(corpusManifestProblem({ ...config, corpusCustody: undefined }, tasks, ["t2-a", "t2-b"]) ?? "", /corpusCustody/);
    assert.match(corpusManifestProblem(config, tasks, ["t2-a"]) ?? "", /population differs/);
    fs.appendFileSync(path.join(tasks, "t2-b", "hidden", "sub", "data.txt"), "tampered\n");
    assert.match(corpusManifestProblem(config, tasks, ["t2-a", "t2-b"]) ?? "", /t2-b: hidden tests differ/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function hardenedRun(calls: Array<{ name: string; args: object }>) {
  const gw = await startGateway((_n: number, body: any) => {
    const tools = (body?.messages ?? []).filter((m: any) => m.role === "tool").length;
    if (tools < calls.length) return { kind: "tools", calls: [calls[tools]] };
    if (tools === calls.length) return { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };
    return { kind: "text", content: "Done." };
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-hardened-"));
  try {
    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ name: "nexus@mock", agent: "nexus", endpoint: gw.url, model: "m", runs: 1, steps: 20, minutes: 5, hardenedChecks: true }));
    const out = path.join(root, "out");
    const run = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", out, "--only", "selftest-add"], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(out, "results.jsonl"), "utf8").split("\n")[0]);
    const log = path.join(out, record.logs ?? "", "agent.stdout.json");
    record.agentLog = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    return record;
  } finally {
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("hardened checks: a correct change passes in a fresh workspace; a test-script change refuses the checks", { timeout: 300_000 }, async () => {
  const write = (p: string, content: string) => ({ name: "write_file", args: { path: p, content } });
  const good = await hardenedRun([write("math.js", "exports.add = (a, b) => a + b;\n")]);
  assert.equal(good.hiddenPass, true, JSON.stringify(good));
  assert.equal(good.regressionPass, true);
  assert.ok(good.hardened.applied >= 1);
  assert.deepEqual(good.hardened.configChanges, []);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "eval/tasks/selftest-add/repo/package.json"), "utf8"));
  // write_file refuses to replace an existing file unless overwrite is set.
  const gamed = await hardenedRun([
    write("math.js", "exports.add = (a, b) => a - b;\n"),
    { name: "write_file", args: { path: "package.json", content: JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, test: "exit 0" } }), overwrite: true } },
    write("test/extra.test.js", "process.exit(0);\n"),
  ]);
  assert.equal(gamed.hiddenPass, false);
  assert.equal(gamed.regressionPass, false, `a rewritten test script never reaches the regression check: ${JSON.stringify(gamed.hardened)}\n${String(gamed.agentLog).split("\n").filter((l: string) => /package\.json|Tool Error|refus|denied|blocked/i.test(l)).slice(0, 12).join("\n")}`);
  assert.match(gamed.hardened.configChanges.join(), /script "test" changed/);
  assert.ok(gamed.hardened.discarded.includes("test/extra.test.js"));
  assert.equal(gamed.falseVerified, false);
});
