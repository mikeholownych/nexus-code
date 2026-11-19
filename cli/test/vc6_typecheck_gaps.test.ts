import "./helpers/leak_guard.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { classifyTypecheck, discoverTypecheck, discoverTypechecks, parseTypecheckDiagnostics, runTypecheck, typecheckSignatures, DiscoveredTypecheck } from "../src/tester.js";
import { workspaceChangedPaths } from "../src/git.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, Reply } from "./helpers/fixtures.js";

// VC-6: callers broken in untouched files, shell-changed files, Go, Python.

const TSC_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "typescript", "bin", "tsc");
const NODE_VERIFIER = "env -u NODE_TEST_CONTEXT node --test test/*.test.js";
const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, extra: Partial<HarnessConfig> = {}): HarnessConfig => ({
  trustedDeliverableFiles: ["math.js"],
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
  ...extra,
});
const write = (name: string, content: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content, overwrite: true } }] });
const shell = (command: string): Reply => ({ kind: "tools", calls: [{ name: "run_command", args: { command } }] });
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2020", module: "commonjs", types: [] }, include: ["*.ts"] });
const PKG = JSON.stringify({ name: "x", version: "1.0.0", private: true, scripts: { test: NODE_VERIFIER } });
const ADD_TEST = 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';
const fix = write("math.js", "exports.add = (a, b) => a + b;\n");

const FAKE_GO = `#!/bin/sh
if [ "$1" = version ]; then echo "go version go1.25.0 linux/amd64"; exit 0; fi
if grep -q BADGO main.go 2>/dev/null; then printf '# example.com/m\\nmain.go:3:2: undefined: BADGO\\n'; exit 1; fi
exit 0
`;
const FAKE_PYRIGHT = `#!/bin/sh
if [ "$1" = --version ]; then echo "pyright 1.1.380"; exit 0; fi
if grep -q BADPY app.py 2>/dev/null; then printf '%s\\n' "$PWD/app.py:2:1 - error: bad type (reportGeneralTypeIssues)" '1 error, 0 warnings, 0 informations'; exit 1; fi
exit 0
`;
const FAKE_MYPY = `#!/bin/sh
if [ "$1" = --version ]; then echo "mypy 1.11.0 (compiled: yes)"; exit 0; fi
if grep -q BADPY app.py 2>/dev/null; then printf 'app.py:2: error: bad type  [assignment]\\nFound 1 error in 1 file\\n'; exit 1; fi
exit 0
`;
const FAKE_CARGO = `#!/bin/sh
if [ "$1" = --version ]; then echo "cargo 1.90.0"; exit 0; fi
if grep -q BADRUST core/src/lib.rs 2>/dev/null; then printf 'error[E0425]: cannot find value BADRUST in this scope\n --> core/src/lib.rs:1:1\n'; exit 1; fi
exit 0
`;

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc6-"));
  for (const [name, content] of Object.entries({ "package.json": PKG, "test/math.test.js": ADD_TEST, "math.js": "exports.add = (a, b) => a - b;\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: root, stdio: "ignore" });
  return root;
}

/** A PATH holding only the basics plus the named tools: `tsc` is the real compiler, any other name a fake script. */
function toolPath(tools: Record<string, string | "real-tsc">, hideTools: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc6-bin-"));
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  for (const t of ["env", "bash", "sh", "git", "dirname", "ls", "cat", "grep", "printf", "rm", "mkdir", "npm"]) {
    const found = execSync(`command -v ${t} || true`, { shell: "/bin/sh" }).toString().trim();
    if (found.startsWith("/")) fs.symlinkSync(found, path.join(dir, t));
  }
  for (const [name, body] of Object.entries(tools)) {
    if (body === "real-tsc") fs.symlinkSync(TSC_BIN, path.join(dir, name));
    else {
      fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
    }
  }
  return dir;
}

async function withAgent<T>(files: Record<string, string>, opts: { tools: Record<string, string>; hideTools?: string[]; steps: Reply[]; env?: Record<string, string>; config?: Partial<HarnessConfig>; prepare?: (root: string) => void }, body: (agent: AutonomousAgent, root: string) => Promise<T>): Promise<T> {
  const root = repo(files);
  opts.prepare?.(root);
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, NEXUS_TYPECHECK: process.env.NEXUS_TYPECHECK };
  const bin = toolPath(opts.tools, opts.hideTools);
  // The ambient PATH minus any directory that provides go, pyright, mypy or tsc: only the fakes below exist.
  const hidden = new Set(["go", "pyright", "mypy", "tsc", ...(opts.hideTools ?? [])]);
  const ambient = (saved.PATH ?? "").split(path.delimiter).filter((d) => d && ![...hidden].some((t) => fs.existsSync(path.join(d, t))));
  process.env.PATH = [bin, ...ambient].join(path.delimiter);
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc6-home-"));
  delete process.env.NEXUS_TYPECHECK;
  Object.assign(process.env, opts.env ?? {});
  const gw = await startGateway((n) => opts.steps[n - 1] ?? { kind: "text", content: "done" });
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root, opts.config)));
  try {
    return await body(agent, root);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(process.env.HOME!, { recursive: true, force: true });
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.NEXUS_TYPECHECK === undefined) delete process.env.NEXUS_TYPECHECK;
    else process.env.NEXUS_TYPECHECK = saved.NEXUS_TYPECHECK;
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const turnOf = (files: Record<string, string>, opts: Parameters<typeof withAgent>[1]) => withAgent(files, opts, async (agent) => { return agent.runTurn("npm test fails; fix math.js."); });

describe("VC-6: a change that breaks an untouched caller", () => {
  const files = { "tsconfig.json": TSCONFIG, "lib.ts": "export const f = (a: number): number => a;\n", "caller.ts": 'import { f } from "./lib";\nexport const y: number = f(1);\n' };
  const breakLib = write("lib.ts", "export const f = (a: number, b: number): number => a + b;\n");

  test("blocks VERIFIED when the baseline was clean and an untouched file now fails", { timeout: 120_000 }, async () => {
    const turn = await turnOf(files, { tools: { tsc: "real-tsc" }, steps: [fix, breakLib, done] });
    assert.notEqual(turn.outcome, "VERIFIED");
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "FAILED");
    assert.equal(tc?.baselineErrorCount, 0);
    assert.equal(tc?.introducedCount, 1);
    assert.match(tc?.firstDiagnostics?.[0] ?? "", /caller\.ts/);
  });

  test("an error the baseline already had in an untouched file stays PREEXISTING", { timeout: 120_000 }, async () => {
    const turn = await turnOf({ ...files, "legacy.ts": 'export const n: number = "one";\n' }, { tools: { tsc: "real-tsc" }, steps: [fix, write("lib.ts", "export const f = (a: number): number => a + 1;\n"), done] });
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "PREEXISTING");
    assert.equal(tc?.baselineErrorCount, 1);
    assert.equal(tc?.introducedCount, 0);
    assert.equal(turn.verification?.status, "PASSED");
  });

  test("NEXUS_TYPECHECK=off keeps the opt-out: no check, no block", { timeout: 120_000 }, async () => {
    const turn = await turnOf(files, { tools: { tsc: "real-tsc" }, steps: [fix, breakLib, done], env: { NEXUS_TYPECHECK: "off" } });
    assert.equal(turn.verification?.typecheck?.status, "NOT_APPLICABLE");
    assert.equal(turn.verification?.status, "PASSED");
  });

  test("classification with a baseline: a new error in an untouched file is FAILED, a known one PREEXISTING", () => {
    const check = { tool: "tsc" as const, configPath: "tsconfig.json" };
    const ws = os.tmpdir();
    const out = "a.ts(1,1): error TS2322: old\nb.ts(2,2): error TS2345: new";
    const baseline = new Set(typecheckSignatures(check, "a.ts(9,9): error TS2322: old", ws));
    const r = classifyTypecheck(check, out, ws, new Set(), baseline);
    assert.equal(r.status, "FAILED");
    assert.equal(r.introducedCount, 1);
    assert.equal(classifyTypecheck(check, out, ws, new Set()).status, "PREEXISTING", "no baseline: unchanged behaviour");
    assert.equal(classifyTypecheck(check, "a.ts(1,1): error TS2322: old", ws, new Set(), baseline).status, "PREEXISTING", "the line number moving does not make it new");
  });
});

describe("VC-6: every configured project in a workspace is checked", () => {
  test("discovers the root TypeScript project and nested Rust project", () => {
    const root = repo({ "tsconfig.json": TSCONFIG, "core/Cargo.toml": "[package]\nname = \"core\"\nversion = \"0.1.0\"\nedition = \"2021\"\n", "core/src/lib.rs": "pub fn ok() {}\n" });
    try {
      const checks = discoverTypechecks(root);
      assert.deepEqual(checks.map((check) => check.configPath), ["tsconfig.json", "core/Cargo.toml"]);
      assert.equal(discoverTypecheck(root)?.configPath, "tsconfig.json", "the single-project compatibility API remains root-scoped");
      assert.match(checks[1].command, /--manifest-path core\/Cargo\.toml/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers multiple typecheck configurations in one project", () => {
    const root = repo({ "tsconfig.json": TSCONFIG, "Cargo.toml": "[package]\nname = \"root\"\nversion = \"0.1.0\"\nedition = \"2021\"\n" });
    try {
      assert.deepEqual(discoverTypechecks(root).map((check) => check.configPath), ["tsconfig.json", "Cargo.toml"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports incomplete discovery after the bounded project scan limit", () => {
    const root = repo({});
    try {
      for (let index = 0; index < 33; index++) {
        const project = path.join(root, `packages/p${index}`);
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, "tsconfig.json"), TSCONFIG);
      }
      const checks = discoverTypechecks(root);
      assert.equal(checks.length, 33);
      assert.equal(checks.at(-1)?.discoveryIncomplete, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nested Rust type error blocks completion even when the root TypeScript check passes", { timeout: 120_000 }, async () => {
    const files = { "tsconfig.json": TSCONFIG, "types.ts": "export const n: number = 1;\n", "core/Cargo.toml": "[package]\nname = \"core\"\nversion = \"0.1.0\"\nedition = \"2021\"\n", "core/src/lib.rs": "pub fn ok() {}\n" };
    const turn = await turnOf(files, { tools: { tsc: "real-tsc", cargo: FAKE_CARGO }, steps: [fix, write("core/src/lib.rs", "pub fn fail() { BADRUST; }\n"), done], config: { authoritativeVerifierCommand: NODE_VERIFIER }, env: { NEXUS_TYPECHECK: "enforce" } });
    const checks = turn.verification?.typecheck?.projects;
    assert.deepEqual(checks?.map((check) => check.configPath), ["tsconfig.json", "core/Cargo.toml"]);
    assert.equal(checks?.[0]?.status, "PASSED");
    assert.equal(checks?.[1]?.status, "FAILED");
    assert.equal(turn.verification?.typecheck?.status, "FAILED");
    assert.notEqual(turn.outcome, "VERIFIED");
  });

  test("an unavailable nested typechecker blocks even when the root typecheck passes", { timeout: 120_000 }, async () => {
    const files = { "tsconfig.json": TSCONFIG, "types.ts": "export const n: number = 1;\n", "native/Cargo.toml": "[package]\nname = \"native\"\nversion = \"0.1.0\"\nedition = \"2021\"\n" };
    const turn = await turnOf(files, { tools: { tsc: "real-tsc" }, hideTools: ["cargo"], steps: [fix, done], config: { authoritativeVerifierCommand: NODE_VERIFIER }, env: { NEXUS_TYPECHECK: "enforce" } });
    const checks = turn.verification?.typecheck?.projects;
    assert.deepEqual(checks?.map((check) => check.status), ["PASSED", "UNAVAILABLE"]);
    assert.equal(turn.verification?.typecheck?.status, "UNAVAILABLE");
    assert.notEqual(turn.outcome, "VERIFIED");
  });
});

describe("VC-6: files changed through the shell count as modified", () => {
  const files = { "tsconfig.json": TSCONFIG, "types.ts": "export const n: number = 1;\n" };
  // A configured verifier skips the baseline run, so only the workspace diff can attribute the error to the candidate.
  const configured = { config: { authoritativeVerifierCommand: NODE_VERIFIER }, env: { NEXUS_TYPECHECK: "enforce" } };

  test("an error written by a shell command blocks", { timeout: 120_000 }, async () => {
    const turn = await turnOf(files, { tools: { tsc: "real-tsc" }, steps: [fix, shell(`printf 'export const n: number = "one";\\n' > types.ts`), done], ...configured });
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "FAILED");
    assert.deepEqual(tc?.shellChangedFiles, ["types.ts"]);
    assert.notEqual(turn.verification?.status, "PASSED");
  });

  test("a file that was already dirty before the task is not counted as the candidate's", { timeout: 120_000 }, async () => {
    const turn = await turnOf({ ...files, "legacy.ts": "export const k: number = 1;\n" }, {
      tools: { tsc: "real-tsc" }, steps: [fix, done], ...configured,
      prepare: (root) => fs.writeFileSync(path.join(root, "legacy.ts"), 'export const k: number = "dirty";\n'),
    });
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "PREEXISTING");
    assert.equal(tc?.shellChangedFiles, undefined);
    assert.equal(turn.verification?.status, "PASSED");
  });

  test("workspaceChangedPaths: modified, untracked and renamed paths, absolute", () => {
    const root = repo({ "a.txt": "a", "b.txt": "b" });
    try {
      fs.writeFileSync(path.join(root, "a.txt"), "changed");
      fs.writeFileSync(path.join(root, "new.txt"), "n");
      execSync("git mv b.txt c.txt", { cwd: root });
      const got = workspaceChangedPaths(root).map((p) => path.relative(fs.realpathSync(root), fs.realpathSync(path.dirname(p)) + "/" + path.basename(p))).sort();
      assert.deepEqual(got, ["a.txt", "c.txt", "new.txt"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("VC-6: Go (go vet)", () => {
  const files = { "go.mod": "module example.com/m\n\ngo 1.25\n", "main.go": "package main\n\nfunc main() {}\n" };
  const goPath = { go: FAKE_GO };

  test("go vet error in a changed file blocks; clean passes; both recorded under go.mod", { timeout: 120_000 }, async () => {
    const bad = await turnOf(files, { tools: goPath, steps: [fix, write("main.go", "package main\n\nBADGO\n"), done] });
    assert.equal(bad.verification?.typecheck?.status, "FAILED");
    assert.equal(bad.verification?.typecheck?.tool, "go");
    assert.equal(bad.verification?.typecheck?.configPath, "go.mod");
    assert.match(bad.verification?.typecheck?.toolVersion ?? "", /go version go1\.25/);
    assert.notEqual(bad.outcome, "VERIFIED");
    const ok = await turnOf(files, { tools: goPath, steps: [fix, done] });
    assert.equal(ok.verification?.typecheck?.status, "PASSED");
    assert.equal(ok.outcome, "VERIFIED");
  });

  test("go not on PATH: UNAVAILABLE, never PASSED, and the outcome is not blocked", { timeout: 120_000 }, async () => {
    const turn = await turnOf(files, { tools: {}, steps: [fix, done] });
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "UNAVAILABLE");
    assert.match(tc?.scope ?? "", /not installed/);
    assert.notEqual(tc?.status as string, "PASSED");
  });

  test("NEXUS_TYPECHECK=off disables go vet", { timeout: 120_000 }, async () => {
    const turn = await turnOf(files, { tools: goPath, steps: [fix, write("main.go", "package main\n\nBADGO\n"), done], env: { NEXUS_TYPECHECK: "off" } });
    assert.equal(turn.verification?.typecheck?.status, "NOT_APPLICABLE");
  });

  test("go diagnostics parse; an unlocated go failure is ENVIRONMENT", () => {
    const d = parseTypecheckDiagnostics("# example.com/m\nvet: main.go:3:2: undefined: x\ninternal/a.go:7:1: bad\n");
    assert.deepEqual(d.files, ["main.go", "internal/a.go"]);
    assert.equal(d.errorCount, 2);
    const check = { tool: "go" as const, configPath: "go.mod" };
    assert.equal(classifyTypecheck(check, "go: example.com/x@v1: module lookup disabled by GOPROXY=off", os.tmpdir(), new Set()).status, "ENVIRONMENT");
  });
});

describe("VC-6: Python (pyright or mypy, only when configured)", () => {
  const app = "x: int = 1\n";
  const badApp = write("app.py", "x: int = 1\nBADPY\n");

  test("pyright configured: a located error in a changed file blocks", { timeout: 120_000 }, async () => {
    const turn = await turnOf({ "pyrightconfig.json": "{}", "app.py": app }, { tools: { pyright: FAKE_PYRIGHT }, steps: [fix, badApp, done] });
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "FAILED");
    assert.equal(tc?.tool, "pyright");
    assert.equal(tc?.configPath, "pyrightconfig.json");
    assert.notEqual(turn.outcome, "VERIFIED");
  });

  test("mypy configured in pyproject.toml: a located error in a changed file blocks", { timeout: 120_000 }, async () => {
    const turn = await turnOf({ "pyproject.toml": "[tool.mypy]\nstrict = true\n", "app.py": app }, { tools: { mypy: FAKE_MYPY }, steps: [fix, badApp, done] });
    assert.equal(turn.verification?.typecheck?.status, "FAILED");
    assert.equal(turn.verification?.typecheck?.tool, "mypy");
    assert.equal(turn.verification?.typecheck?.configPath, "pyproject.toml");
  });

  test("the tool is on PATH but the project does not configure it: not applicable", { timeout: 120_000 }, async () => {
    const turn = await turnOf({ "app.py": app }, { tools: { pyright: FAKE_PYRIGHT, mypy: FAKE_MYPY }, steps: [fix, badApp, done] });
    assert.equal(turn.verification?.typecheck?.status, "NOT_APPLICABLE");
    assert.equal(turn.verification?.status, "PASSED");
  });

  test("configured but not installed: UNAVAILABLE", { timeout: 120_000 }, async () => {
    const turn = await turnOf({ "mypy.ini": "[mypy]\n", "app.py": app }, { tools: {}, steps: [fix, done] });
    assert.equal(turn.verification?.typecheck?.status, "UNAVAILABLE");
  });

  test("diagnostics parse for pyright and mypy; discovery order and the project virtualenv", () => {
    const py = parseTypecheckDiagnostics("/w/app.py:2:1 - error: bad (reportX)\n  /w/b.py:3:4 - warning: meh\n1 error");
    assert.deepEqual(py.files, ["/w/app.py"]);
    const my = parseTypecheckDiagnostics("app.py:2: error: bad  [assignment]\napp.py:2: note: see\nFound 1 error in 1 file");
    assert.deepEqual(my.files, ["app.py"]);
    assert.equal(my.errorCount, 1);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc6-disc-"));
    const saved = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent";
      fs.mkdirSync(path.join(root, ".venv/bin"), { recursive: true });
      fs.writeFileSync(path.join(root, ".venv/bin/mypy"), "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(path.join(root, "mypy.ini"), "[mypy]\n");
      const found = discoverTypecheck(root) as DiscoveredTypecheck;
      assert.equal(found.tool, "mypy");
      assert.equal(found.command, "./.venv/bin/mypy .");
      assert.equal(found.missingTool, undefined);
      fs.rmSync(path.join(root, ".venv"), { recursive: true });
      assert.equal(discoverTypecheck(root)?.missingTool, true);
      fs.rmSync(path.join(root, "mypy.ini"));
      assert.equal(discoverTypecheck(root), null);
    } finally {
      process.env.PATH = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("VC-6: UNAVAILABLE evidence", () => {
  test("a probe that cannot find the tool (126/127) or a missingTool check is UNAVAILABLE; other probe failures stay ENVIRONMENT", async () => {
    const check: DiscoveredTypecheck = { tool: "go", probe: "go version", command: "go vet ./...", configPath: "go.mod", configSha256: "" };
    const exec = (exit: number) => async () => ({ success: true, output: JSON.stringify({ exit_code: exit, stdout: "", stderr: "" }) });
    assert.equal((await runTypecheck(check, exec(127), os.tmpdir(), new Set(), 10)).status, "UNAVAILABLE");
    assert.equal((await runTypecheck(check, exec(126), os.tmpdir(), new Set(), 10)).status, "UNAVAILABLE");
    assert.equal((await runTypecheck(check, exec(2), os.tmpdir(), new Set(), 10)).status, "ENVIRONMENT");
    let ran = false;
    const r = await runTypecheck({ ...check, missingTool: true }, async () => { ran = true; return { success: true, output: "" }; }, os.tmpdir(), new Set(), 10);
    assert.equal(r.status, "UNAVAILABLE");
    assert.equal(ran, false, "a missing tool is never run");
  });
});
