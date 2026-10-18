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
    "pkg/x_test.go", "src/x.test.ts", "web/a.spec.jsx", "__tests__/a.js", "jest.config.js", "vitest.config.mts", ".mocharc.json", "build.rs", ".cargo/config.toml", ".github/workflows/ci.yml", "Makefile", ".env.local",
    "karma.conf.js", "jest-preset.js", "vitest.workspace.ts", "globalSetup.ts", "setup-tests.js", "test-helpers.ts", "internal/testhelper/x.go", "pkg/_testing.py",
    ".npmrc", ".yarnrc.yml", ".pnpmfile.cjs", "go.work", "rust-toolchain.toml", "tsconfig.json", ".coveragerc", ".gitattributes", "node_modules/x/i.js", ".venv/lib/x.py", "a/__pycache__/m.pyc"]) {
    assert.equal(isTestInfraPath(p), true, p);
  }
  for (const p of ["src/app.py", "pkg/server.go", "src/index.ts", "src/lib.rs", "README.md", "package.json", "pyproject.toml", "Cargo.toml", "contest.py"]) {
    assert.equal(isTestInfraPath(p), false, p);
  }
});

test("hidden test staging preserves workspace files and mounts only copied hidden files", async () => {
  const { stageHiddenFiles, hiddenOutputHasTests } = await import(path.join(ROOT, "eval/isolate.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hidden-stage-"));
  try {
    const source = path.join(root, "task/hidden");
    const ws = path.join(root, "workspace");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(path.join(ws, "test"), { recursive: true });
    fs.writeFileSync(path.join(source, "private.test.js"), "hidden\n");
    fs.writeFileSync(path.join(ws, "existing.js"), "keep root\n");
    fs.writeFileSync(path.join(ws, "test/existing.js"), "keep test\n");
    assert.deepEqual(stageHiddenFiles(source, ws, ".", { readOnlyHidden: true }), ["private.test.js"]);
    assert.deepEqual(stageHiddenFiles(source, ws, "test", { readOnlyHidden: true }), ["test/private.test.js"]);
    assert.equal(fs.readFileSync(path.join(ws, "existing.js"), "utf8"), "keep root\n");
    assert.equal(fs.readFileSync(path.join(ws, "test/existing.js"), "utf8"), "keep test\n");
    assert.equal(fs.readFileSync(path.join(ws, "private.test.js"), "utf8"), "hidden\n");
    assert.equal(fs.readFileSync(path.join(ws, "test/private.test.js"), "utf8"), "hidden\n");
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(ws, "sym"));
    assert.throws(() => stageHiddenFiles(source, ws, "sym/newparent", { readOnlyHidden: true }), /unsafe hidden test parent directory/);
    assert.equal(fs.existsSync(path.join(outsideDir, "newparent")), false);
    assert.equal(hiddenOutputHasTests("Ran 0 tests"), false);
    assert.equal(hiddenOutputHasTests("[no test files]"), false);
    assert.equal(hiddenOutputHasTests("Ran 1 test\n\nOK"), true);
    assert.equal(hiddenOutputHasTests("?   example/cmd [no test files]\nok  example/pkg 0.01s"), true);
    assert.equal(hiddenOutputHasTests("test result: ok. 5 passed; 0 failed\ntest result: ok. 0 passed; 0 failed"), true);
    assert.equal(hiddenOutputHasTests("?   example/cmd [no test files]"), false);
    assert.equal(hiddenOutputHasTests("test result: ok. 0 passed; 0 failed"), false);
    assert.equal(hiddenOutputHasTests("Ran 0 tests"), false);
    assert.equal(hiddenOutputHasTests(""), false);
    assert.equal(hiddenOutputHasTests("hello"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only the agent's source changes reach the fresh check workspace; adversarial workspace state never does", async () => {
  const { applyAgentChanges } = await hardened();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hardened-"));
  const write = (root: string, rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
  try {
    const agent = path.join(base, "agent");
    const fresh = path.join(base, "fresh");
    for (const dir of [agent, fresh]) {
      write(dir, "src/__init__.py", "\n");
      write(dir, "src/app.py", "def f(): return 1\n");
      write(dir, "src/old.py", "x = 1\n");
      write(dir, "package.json", JSON.stringify({ name: "x", main: "src/index.js", scripts: { test: "node --test" }, dependencies: { a: "1" } }));
      write(dir, "Cargo.toml", "[package]\nname = \"x\"\n\n[dependencies]\nserde = \"1\"\n");
      write(dir, "go.mod", "module x\n\ngo 1.22\n");
      write(dir, "node_modules/jest/index.js", "real\n");
    }
    // Legitimate source work.
    write(agent, "src/app.py", "def f(): return 2\n");
    fs.rmSync(path.join(agent, "src/old.py"));
    write(agent, "src/new.py", "y = 2\n");
    // Adversarial state: git hooks/config/filters, ignore edits, planted deps, tool config, shadowing, test files.
    write(agent, ".git/config", "[core]\n\tfsmonitor = touch /tmp/pwned\n");
    write(agent, ".gitattributes", "* filter=x\n");
    write(agent, ".gitignore", "\n");
    write(agent, "node_modules/jest/index.js", "process.exit(0)\n");
    write(agent, ".npmrc", "script-shell=./x.sh\n");
    write(agent, "x.sh", "exit 0\n");
    write(agent, "pytest.py", "raise SystemExit(0)\n");
    write(agent, "_pytest/__init__.py", "\n");
    write(agent, "conftest.py", "import pytest\n");
    write(agent, "tests/test_mine.py", "def test(): pass\n");
    write(agent, "notes.txt", "scratch\n");
    write(agent, "src/math.js", "module.exports = 1;\n"); // a JS file named like a Python stdlib module is ordinary source
    const result = applyAgentChanges(agent, fresh);
    assert.equal(fs.readFileSync(path.join(fresh, "src/app.py"), "utf8"), "def f(): return 2\n");
    assert.equal(fs.existsSync(path.join(fresh, "src/old.py")), false, "deletions are applied");
    assert.equal(fs.readFileSync(path.join(fresh, "src/new.py"), "utf8"), "y = 2\n", "new source files cross over");
    assert.equal(fs.existsSync(path.join(fresh, "src/math.js")), true, "shadowing rules are Python-only");
    for (const blocked of [".git/config", ".gitattributes", ".npmrc", "x.sh", "pytest.py", "_pytest/__init__.py", "conftest.py", "tests/test_mine.py", "notes.txt"]) {
      assert.equal(fs.existsSync(path.join(fresh, blocked)), false, `${blocked} never reaches the checks`);
    }
    assert.equal(fs.readFileSync(path.join(fresh, "node_modules/jest/index.js"), "utf8"), "real\n", "dependency trees come from setup, not the agent");
    assert.equal(fs.existsSync("/tmp/pwned"), false, "no git command ran against the agent's workspace");
    assert.deepEqual(result.configChanges, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("manifest changes outside plain dependency and metadata edits refuse the checks", async () => {
  const { testConfigChange } = await hardened();
  const pkg = (o: object) => JSON.stringify({ name: "x", main: "src/index.js", scripts: { test: "node --test" }, dependencies: { a: "1" }, ...o });
  assert.equal(testConfigChange("package.json", pkg({}), pkg({ dependencies: { a: "2" } })), null);
  assert.match(testConfigChange("package.json", pkg({}), pkg({ main: "test/index.js" })) ?? "", /"main"/);
  assert.match(testConfigChange("package.json", pkg({}), pkg({ exports: { ".": "./t.js" } })) ?? "", /"exports"/);
  assert.match(testConfigChange("package.json", pkg({}), pkg({ dependencies: { a: "file:../evil" } })) ?? "", /local or remote source/);
  const cargo = "[package]\nname = \"x\"\n\n[dependencies]\nserde = \"1\"\n";
  assert.equal(testConfigChange("Cargo.toml", cargo, cargo.replace('serde = "1"', 'serde = "1.0.200"')), null);
  assert.match(testConfigChange("Cargo.toml", cargo, `${cargo}\n[patch.crates-io]\nserde = { path = "../s" }\n`) ?? "", /patch\.crates-io/);
  assert.match(testConfigChange("Cargo.toml", cargo, cargo.replace('serde = "1"', 'serde = { path = "../s" }')) ?? "", /local, git or alternate-registry source/);
  assert.match(testConfigChange("go.mod", "module x\n", "module x\nreplace a => ../a\n") ?? "", /outside its require directives/);
  assert.equal(testConfigChange("go.mod", "module x\n", "module x\nrequire a v1.2.3\n"), null);
  const py = "[project]\nname = \"x\"\ndependencies = []\n";
  assert.equal(testConfigChange("pyproject.toml", py, py.replace("[]", '["requests"]')), null);
  assert.match(testConfigChange("pyproject.toml", py, `${py}\n[tool.pytest.ini_options]\naddopts = "--co"\n`) ?? "", /tool\.pytest/);
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
    const config = { corpusManifest: manifestFile, corpusManifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), corpusCustody: { custodian: "synthetic", approvedAt: "2026-01-01T00:00:00Z", reportPath: path.join(root, "custody.md"), reportSha256: createHash("sha256").update("custody report\n").digest("hex") } };
    fs.writeFileSync(path.join(root, "custody.md"), "custody report\n");
    assert.equal(corpusManifestProblem(config, tasks, ["t2-a", "t2-b"]), null);
    assert.match(corpusManifestProblem({ ...config, corpusCustody: undefined }, tasks, ["t2-a", "t2-b"]) ?? "", /corpusCustody/);
    assert.match(corpusManifestProblem(config, tasks, ["t2-a"]) ?? "", /population differs/);
    assert.match(corpusManifestProblem({ ...config, corpusCustody: { ...config.corpusCustody, reportSha256: "d".repeat(64) } }, tasks, ["t2-a", "t2-b"]) ?? "", /custody report differs/);
    fs.appendFileSync(path.join(tasks, "t2-b", "hidden", "sub", "data.txt"), "tampered\n");
    assert.match(corpusManifestProblem(config, tasks, ["t2-a", "t2-b"]) ?? "", /t2-b: hidden tests differ/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function hardenedRun(calls: Array<{ name: string; args: object }>, hiddenCommand?: string) {
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
    let taskArgs: string[] = [];
    if (hiddenCommand) {
      const tasks = path.join(root, "tasks");
      fs.mkdirSync(tasks);
      fs.cpSync(path.join(ROOT, "eval/tasks/selftest-add"), path.join(tasks, "selftest-add"), { recursive: true });
      const taskFile = path.join(tasks, "selftest-add/task.json");
      const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
      task.hidden.command = hiddenCommand;
      fs.writeFileSync(taskFile, JSON.stringify(task));
      taskArgs = ["--tasks", tasks];
    }
    const out = path.join(root, "out");
    const run = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", out, "--only", "selftest-add", ...taskArgs], { stdio: ["ignore", "ignore", "pipe"] });
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
  assert.match(gamed.hardened.configChanges.join(), /package.json "scripts" changed/);
  assert.ok(gamed.hardened.discarded.includes("test/extra.test.js"));
  assert.equal(gamed.falseVerified, false);
});

test("hardened checks hide oracle source from candidate code and reject empty-output commands", { timeout: 300_000 }, async () => {
  const attack = `const fs = require("node:fs");
const oracle = fs.readFileSync("hidden/math.hidden.test.js", "utf8");
if (oracle.length || oracle.includes("assert.equal(add(2, 3), 5)")) throw new Error("oracle source was visible");
exports.add = (a, b) => a + b;
`;
  const hidden = await hardenedRun([{ name: "write_file", args: { path: "math.js", content: attack } }]);
  assert.equal(hidden.hiddenPass, true, JSON.stringify(hidden));

  const empty = await hardenedRun([], "true");
  assert.equal(empty.hiddenPass, false, JSON.stringify(empty));
});

test("test data, symlinked paths, new Python packages, oversized files and manifest deletions never weaken the checks", async () => {
  const { applyAgentChanges, testConfigChange } = await hardened();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hardened-more-"));
  const write = (root: string, rel: string, content: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
  try {
    const agent = path.join(base, "agent");
    const fresh = path.join(base, "fresh");
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    for (const dir of [agent, fresh]) {
      write(dir, "pkg/render.go", "package pkg\n");
      write(dir, "pkg/testdata/out.golden", "expected\n");
      write(dir, "web/__snapshots__/a.test.js.snap", "exports[`a`] = `x`;\n");
      write(dir, "fixtures/input.json", "{}\n");
      write(dir, "lib/mod/__init__.py", "\n");
      write(dir, "pyproject.toml", "[project]\nname = \"x\"\n\n[tool.pytest.ini_options]\nfilterwarnings = [\"error\"]\n");
    }
    fs.symlinkSync(outside, path.join(fresh, "linked"));
    write(agent, "pkg/testdata/out.golden", "agent output\n");
    write(agent, "web/__snapshots__/a.test.js.snap", "exports[`a`] = `y`;\n");
    write(agent, "fixtures/input.json", "{\"x\":1}\n");
    write(agent, "linked/escape.py", "print('outside')\n");
    write(agent, "toplevel.py", "x = 1\n");
    write(agent, "newpkg/__init__.py", "\n");
    write(agent, "lib/mod/helper.py", "y = 1\n");
    write(agent, "lib/mod/huge.py", Buffer.alloc(3 * 1024 * 1024, 0x20));
    fs.rmSync(path.join(agent, "pyproject.toml"));
    const result = applyAgentChanges(agent, fresh);
    assert.equal(fs.readFileSync(path.join(fresh, "pkg/testdata/out.golden"), "utf8"), "expected\n", "golden files are test data");
    assert.equal(fs.readFileSync(path.join(fresh, "web/__snapshots__/a.test.js.snap"), "utf8"), "exports[`a`] = `x`;\n");
    assert.equal(fs.readFileSync(path.join(fresh, "fixtures/input.json"), "utf8"), "{}\n");
    assert.equal(fs.existsSync(path.join(outside, "escape.py")), false, "nothing is written through a symlink in the fresh tree");
    assert.equal(fs.existsSync(path.join(fresh, "toplevel.py")), false, "no new top-level Python module");
    assert.equal(fs.existsSync(path.join(fresh, "newpkg/__init__.py")), false, "no new Python package directory");
    assert.equal(fs.readFileSync(path.join(fresh, "lib/mod/helper.py"), "utf8"), "y = 1\n", "a new module inside an existing package crosses over");
    assert.equal(fs.existsSync(path.join(fresh, "lib/mod/huge.py")), false, "oversized files are not carried");
    assert.equal(fs.existsSync(path.join(fresh, "pyproject.toml")), true, "a deleted manifest is not deleted in the checks");
    assert.match(result.configChanges.join(), /pyproject\.toml deleted/, "and it refuses the checks");
    assert.match(testConfigChange("Cargo.toml", "[package]\nname = \"x\"\n", "[package]\nname = \"x\"\nautotests = false\n") ?? "", /\[package\]/);
    assert.match(testConfigChange("Cargo.toml", "[features]\ndefault = [\"a\"]\n", "[features]\ndefault = []\n") ?? "", /\[features\]/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("manifest guards fail closed on TOML headers they do not recognise, go.mod blocks and new manifests", async () => {
  const { testConfigChange, applyAgentChanges } = await hardened();
  const py = "[project]\nname = \"x\"\ndependencies = []\n";
  assert.match(testConfigChange("pyproject.toml", py, `${py}[tool.pytest.ini_options] # x\naddopts = "--deselect hidden"\n`) ?? "", /tool\.pytest/, "a commented header is not folded into [project]");
  assert.match(testConfigChange("pyproject.toml", py, `${py}  [tool.pytest.ini_options]\naddopts = "-q"\n`) ?? "", /tool\.pytest/, "an indented header is still a header");
  const cargo = "[package]\nname = \"x\"\n\n[dependencies]\nserde = \"1\"\n";
  assert.match(testConfigChange("Cargo.toml", cargo, `${cargo}[[test]]\nname = "hidden_x"\nrequired-features = ["nope"]\n`) ?? "", /\[\[test\]\]/, "an array table is not folded into [dependencies]");
  assert.match(testConfigChange("Cargo.toml", cargo, `${cargo}[profile.test]\nopt-level = 3\n`) ?? "", /profile\.test/);
  assert.match(testConfigChange("Cargo.toml", cargo, cargo.replace('serde = "1"', 'serde = { version = "1", registry = "evil" }')) ?? "", /alternate-registry/);
  assert.equal(testConfigChange("Cargo.toml", cargo, cargo.replace('serde = "1"', 'serde = "1.0.200"')), null);
  const withPath = cargo.replace('serde = "1"', 'serde = "1"\nlocal = { path = "crates/local" }');
  assert.equal(testConfigChange("Cargo.toml", withPath, withPath.replace('serde = "1"', 'serde = "1.0.200"')), null, "a baseline path dependency does not refuse unrelated edits");
  const gomod = "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n\nreplace (\n\tgithub.com/c/d => github.com/c/d v1.2.0\n)\n";
  assert.equal(testConfigChange("go.mod", gomod, gomod.replace("v1.0.0", "v1.1.0")), null, "require changes are dependency edits");
  assert.match(testConfigChange("go.mod", gomod, gomod.replace("v1.2.0\n)", "v1.2.0\n\tgithub.com/a/b => ./fake\n)")) ?? "", /outside its require/, "an entry added inside an existing replace block");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hardened-manifest-"));
  try {
    const agent = path.join(base, "agent");
    const fresh = path.join(base, "fresh");
    for (const dir of [agent, fresh]) {
      fs.mkdirSync(path.join(dir, "src", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(dir, "go.mod"), "module x\n\ngo 1.22\n");
      fs.writeFileSync(path.join(dir, "src", "pkg", "__init__.py"), "\n");
    }
    fs.mkdirSync(path.join(agent, "hiddenparent"), { recursive: true });
    fs.writeFileSync(path.join(agent, "hiddenparent", "go.mod"), "module y\n");
    fs.writeFileSync(path.join(agent, "src", "packaging.py"), "raise SystemExit(0)\n");
    fs.writeFileSync(path.join(agent, "src", "pkg", "util.py"), "z = 1\n");
    const result = applyAgentChanges(agent, fresh);
    assert.match(result.configChanges.join(), /hiddenparent\/go\.mod added/, "a new nested manifest refuses the checks");
    assert.equal(fs.existsSync(path.join(fresh, "src", "packaging.py")), false, "src/ is not a package: no new module beside a src layout's importable root");
    assert.equal(fs.existsSync(path.join(fresh, "src", "pkg", "util.py")), true, "a new module inside an existing package crosses over");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
