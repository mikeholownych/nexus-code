/**
 * WP-1105 deterministic code evaluators (eval/evaluators/code/) and the tool-call syntax telemetry the JSON repair
 * evaluator scores. Parsers, commands and the agent turn are real: nothing here is scored from a model's own claims.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import module from "node:module";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AutonomousAgent } from "../src/agent.js";
import { parseModelResponse } from "../src/parser.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ev: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/index.mjs")).href);
const isolation: any = await import(pathToFileURL(path.join(ROOT, "eval/isolate.mjs")).href);
const runner = async () => {
  try { return await import(path.join(ROOT, "eval/evaluators/code/runner.mjs")); }
  catch (error) { assert.fail(`the runner-level code evaluator module should be available: ${String(error)}`); }
};
const { runArgv }: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/command.mjs")).href);

function temporaryDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProbe(workspace: string, script: string) {
  const scriptPath = path.join(workspace, "probe.mjs");
  fs.writeFileSync(scriptPath, script);
  return { command: "/usr/bin/node", args: ["./probe.mjs"] };
}

async function listenOnLoopback() {
  const server = net.createServer((socket) => socket.end("reached host network"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
}

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-code-evaluators-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** Node's built-in TypeScript parser exists from Node.js 22.13; the engines floor is 22. */
const HAS_TS_PARSER = typeof (module as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes === "function";

test("syntax_ast parses TypeScript, JavaScript and Python with the built-in parsers", async () => {
  const root = workspace({
    "src/ok.ts": "enum Mode { A }\nexport function f(x: string): Mode { return Mode.A; }\n",
    "src/bad.ts": "const a: number = ;\n",
    "lib/ok.mjs": "export const x = 1;\n",
    "lib/bad.cjs": "module.exports = {;\n",
    "py/ok.py": "def f(x):\n    return x + 1\n",
    "py/bad.py": "def f(:\n",
  });
  try {
    if (!HAS_TS_PARSER) {
      // Older Node.js: TypeScript fails closed with the reason; JavaScript and Python still parse.
      const ts = await ev.evaluateSyntaxAst({ root, files: ["src/ok.ts"] });
      assert.equal(ts.passed, false);
      assert.match(ts.details.failures[0].error, /22\.13/);
      assert.equal((await ev.evaluateSyntaxAst({ root, files: ["lib/ok.mjs", "py/ok.py"] })).passed, true);
      assert.equal((await ev.evaluateSyntaxAst({ root, files: ["lib/bad.cjs"] })).passed, false);
      assert.equal((await ev.evaluateSyntaxAst({ root, files: ["py/bad.py"] })).passed, false);
      return;
    }
    const pass = await ev.evaluateSyntaxAst({ root, files: ["src/ok.ts", "lib/ok.mjs", "py/ok.py"] });
    assert.equal(pass.passed, true, JSON.stringify(pass.details));
    assert.deepEqual(pass.details.files, ["lib/ok.mjs", "py/ok.py", "src/ok.ts"]);

    const fail = await ev.evaluateSyntaxAst({ root, files: ["src/bad.ts", "lib/bad.cjs", "py/bad.py", "src/ok.ts"] });
    assert.equal(fail.passed, false);
    assert.equal(fail.score, 0);
    assert.deepEqual(fail.details.failures.map((f: any) => f.file).sort(), ["lib/bad.cjs", "py/bad.py", "src/bad.ts"]);
    assert.deepEqual(fail.details.files, ["src/ok.ts"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syntax_ast fails closed on unsafe paths, escaping symlinks, unsupported files and languages without a parser", async () => {
  const outside = workspace({ "secret.ts": "export {};\n" });
  const root = workspace({ "a.rs": "fn main() {}\n", "b.tsx": "export const C = () => <div/>;\n", "c.txt": "x\n" });
  fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
  fs.symlinkSync(outside, path.join(root, "linkdir"));
  try {
    const result = await ev.evaluateSyntaxAst({ root, files: ["../outside.ts", "/etc/passwd", "link.ts", "a.rs", "b.tsx", "c.txt", "missing.ts", "linkdir/secret.ts"] });
    assert.equal(result.passed, false);
    const why = Object.fromEntries(result.details.failures.map((f: any) => [f.file, f.error]));
    assert.match(why["../outside.ts"], /unsafe source path/);
    assert.match(why["/etc/passwd"], /unsafe source path/);
    assert.match(why["link.ts"], /escapes workspace/);
    assert.match(why["linkdir/secret.ts"], /escapes workspace/, "a symlinked directory cannot reach outside the workspace");
    assert.match(why["a.rs"], /no rust AST parser configured/);
    assert.match(why["b.tsx"], /no tsx AST parser configured/);
    assert.match(why["c.txt"], /unsupported source extension/);
    assert.match(why["missing.ts"], /ENOENT/);
    assert.equal((await ev.evaluateSyntaxAst({ root, files: [] })).passed, false, "no files is not a pass");

    // A caller-supplied parser fills a gap or replaces a default; one reporting errors fails the file.
    const rust = await ev.evaluateSyntaxAst({ root, files: ["a.rs"], parsers: { rust: (src: string) => (src.includes("fn") ? { kind: "File" } : { errors: ["x"] }) } });
    assert.equal(rust.passed, true);
    const reported = await ev.evaluateSyntaxAst({ root, files: ["a.rs"], parsers: { rust: () => ({ errors: ["expected item"] }) } });
    assert.equal(reported.passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("build passes only on a clean zero exit of the real command", async () => {
  const node = process.execPath;
  assert.equal((await ev.evaluateBuild({ command: node, args: ["-e", "process.exit(0)"] })).passed, true);
  const failed = await ev.evaluateBuild({ command: node, args: ["-e", "process.exit(3)"] });
  assert.equal(failed.passed, false);
  assert.equal(failed.details.status, 3);
  const slow = await ev.evaluateBuild({ command: node, args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 200 });
  assert.equal(slow.passed, false);
  assert.equal(slow.details.timedOut, true);
  const missing = await ev.evaluateBuild({ command: "nexus-no-such-binary-wp1105" });
  assert.equal(missing.passed, false);
  assert.ok(missing.details.error, "spawn failure is reported");
  // The command never runs through a shell.
  const run = await runArgv(node, ["-e", "console.log(process.argv[1])", "$(echo injected)"]);
  assert.equal(run.stdout.trim(), "$(echo injected)");
  // The command sees a minimal environment, not the evaluator's.
  process.env.NEXUS_WP1105_SECRET = "leak";
  try {
    const env = await runArgv(node, ["-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"]);
    assert.deepEqual(JSON.parse(env.stdout), ["HOME", "LANG", "PATH", "PWD"]);
  } finally {
    delete process.env.NEXUS_WP1105_SECRET;
  }
});

test("typecheck_clean fails only on diagnostics the candidate adds, and on infrastructure failure", async () => {
  const same = (stderr: string) => async () => ({ status: 1, stderr });
  const spec = (command: string, cwd: string) => ({ command, args: ["--noEmit"], cwd });
  const unchanged = await ev.evaluateTypecheckClean({ baseline: spec("b", "/tmp/base"), candidate: spec("c", "/tmp/cand"), runner: same("a.ts(1,1): error TS1: existing") });
  assert.equal(unchanged.passed, true);
  const added = await ev.evaluateTypecheckClean({
    baseline: spec("b", "/tmp/base"), candidate: spec("c", "/tmp/cand"),
    runner: async (command: string) => ({ status: 1, stderr: command === "b" ? "same\n" : "same\nsame\nnew" }),
  });
  assert.deepEqual(added.details.newDiagnostics, ["same", "new"]);
  assert.equal(added.passed, false);
  const crashed = await ev.evaluateTypecheckClean({ baseline: spec("b", "/tmp/base"), candidate: spec("c", "/tmp/cand"), runner: async (c: string) => (c === "b" ? { status: 0 } : { status: null, signal: "SIGKILL" }) });
  assert.equal(crashed.passed, false);
  assert.equal(crashed.details.infrastructureFailure, true);
  const silent = await ev.evaluateTypecheckClean({ baseline: spec("b", "/tmp/base"), candidate: spec("c", "/tmp/cand"), runner: async (c: string) => ({ status: c === "b" ? 0 : 2 }) });
  assert.equal(silent.passed, false, "a candidate that newly fails without output does not pass");
  assert.equal(silent.details.infrastructureFailure, true, "a nonzero checker run without a recognized diagnostic is not a valid comparison");
  // A failing baseline's exit code may differ from the candidate's without a regression when diagnostics do not grow.
  const fewer = await ev.evaluateTypecheckClean({
    baseline: spec("b", "/tmp/base"), candidate: spec("c", "/tmp/cand"),
    runner: async (c: string) => (c === "b" ? { status: 2, stderr: "error TS1001: e1\nerror TS1002: e2" } : { status: 1, stderr: "error TS1001: e1" }),
  });
  assert.equal(fewer.passed, true, JSON.stringify(fewer.details));
  const silentAfterFailure = await ev.evaluateTypecheckClean({ baseline: spec("b", "/tmp/base"), candidate: spec("c", "/tmp/cand"), runner: async (c: string) => (c === "b" ? { status: 2, stderr: "error TS1001: e1" } : { status: 2 }) });
  assert.equal(silentAfterFailure.passed, false, "a failing candidate with no diagnostics is not a pass");
  await assert.rejects(ev.evaluateTypecheckClean({ baseline: spec("b", "/tmp/x"), candidate: spec("c", "/tmp/x/") }), /must be separate/);
});

test("typecheck_clean rejects unavailable checkers on both revisions", async () => {
  const spec = (cwd: string) => ({ command: "tsc", args: ["--noEmit"], cwd });
  const unavailable = await ev.evaluateTypecheckClean({
    baseline: spec("/tmp/wp1105-baseline"),
    candidate: spec("/tmp/wp1105-candidate"),
    runner: async () => ({ status: 127, stdout: "", stderr: "Cannot find module 'typescript'" }),
  });
  assert.equal(unavailable.passed, false);
  assert.equal(unavailable.details.infrastructureFailure, true);
});

test("build and typecheck use pinned baseline configuration after candidate config edits", async () => {
  const root = temporaryDirectory("code-evaluator-pinned-config-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  for (const directory of [baseline, candidate]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(baseline, "src"));
  fs.writeFileSync(path.join(baseline, "src/main.ts"), "export const value: number = 1;\n");
  fs.writeFileSync(path.join(baseline, "package.json"), JSON.stringify({ scripts: {
    build: `node -e 'const fs=require("node:fs"); process.exit(fs.readFileSync("src/main.ts","utf8").includes("TYPE_ERROR")?1:0)'`,
    typecheck: `node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync("tsconfig.json","utf8")); const bad=c.files.some((f)=>fs.readFileSync(f,"utf8").includes("TYPE_ERROR")); if(bad) console.error("error TS9999: candidate source error"); process.exit(bad?1:0)'`,
  } }));
  fs.writeFileSync(path.join(baseline, "tsconfig.json"), JSON.stringify({ files: ["src/main.ts"] }));
  fs.cpSync(baseline, candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, "src/main.ts"), "export const value: number = TYPE_ERROR;\n");
  fs.writeFileSync(path.join(candidate, "package.json"), JSON.stringify({ scripts: { build: "node -e 'process.exit(0)'", typecheck: "node -e 'process.exit(0)'" } }));
  fs.writeFileSync(path.join(candidate, "tsconfig.json"), JSON.stringify({ files: [] }));
  try {
    const { needsEvaluatorConfigurationBaseline, runCodeEvaluators } = await runner();
    assert.equal(needsEvaluatorConfigurationBaseline({ evaluators: ["build"] }), true, "build-only tasks also need the pre-agent config snapshot");
    const [build, typecheck] = await runCodeEvaluators({
      task: {
        evaluators: ["build", "typecheck_clean"],
        build: { command: "npm", args: ["run", "build"] },
        typecheck: { command: "npm", args: ["run", "typecheck"] },
      },
      candidateWorkspace: candidate,
      hiddenWorkspace: candidate,
      typecheckBaselineWorkspace: baseline,
    });
    assert.deepEqual({ build: build.passed, typecheck: typecheck.passed }, { build: false, typecheck: false }, JSON.stringify({ build: build.details, typecheck: typecheck.details }));
    assert.deepEqual(typecheck.details.newDiagnostics, ["error TS9999: candidate source error"], JSON.stringify(typecheck.details));

    const [buildOnly] = await runCodeEvaluators({
      task: { evaluators: ["build"], build: { command: "npm", args: ["run", "build"] } },
      candidateWorkspace: candidate,
      typecheckBaselineWorkspace: baseline,
    });
    assert.equal(buildOnly.passed, false, JSON.stringify(buildOnly.details));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syntax_ast defaults to existing supported changed source files", async () => {
  const root = temporaryDirectory("code-evaluator-syntax-defaults-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(path.join(baseline, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseline, "src/main.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(baseline, "src/deleted.js"), "export const deleted = 1;\n");
  fs.writeFileSync(path.join(baseline, "README.md"), "before\n");
  fs.cpSync(baseline, candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, "src/main.js"), "export const value = 2;\n");
  fs.unlinkSync(path.join(candidate, "src/deleted.js"));
  fs.writeFileSync(path.join(candidate, "README.md"), "after\n");
  try {
    const { captureWorkspaceSnapshot, runCodeEvaluators } = await runner();
    const [result] = await runCodeEvaluators({
      task: { evaluators: ["syntax_ast"] },
      candidateWorkspace: candidate,
      baselineSnapshot: captureWorkspaceSnapshot(baseline),
    });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.deepEqual(result.details.files, ["src/main.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("diff_boundary accepts exact paths and directory prefixes and rejects everything else", () => {
  const result = ev.evaluateDiffBoundary({
    changedFiles: ["src/a.ts", "src/deep/b.ts", "README.md", "srcx/c.ts", "../secret", "/etc/passwd", "src/./a.ts", "src\\a.ts"],
    allowedPaths: ["src/", "README.md"],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.details.accepted, ["README.md", "src/a.ts", "src/deep/b.ts"]);
  assert.deepEqual(result.details.violations.map((v: any) => v.file).sort(), ["../secret", "/etc/passwd", "src/./a.ts", "src\\a.ts", "srcx/c.ts"]);
  assert.equal(ev.evaluateDiffBoundary({ changedFiles: ["src/a.ts"], allowedPaths: ["src/"] }).passed, true);
});

test("json_repair_rate scores the agent's tool-call syntax counts and fails closed without telemetry", () => {
  const result = ev.evaluateJsonRepairRate([{ native: 6, trailing: 1, structural: 1, invalid: 0 }, undefined, { native: 2 }]);
  assert.equal(result.passed, true);
  assert.equal(result.score, (8 + 0.5 * 2) / 10);
  assert.equal(result.details.total, 10);
  const invalid = ev.evaluateJsonRepairRate({ native: 3, invalid: 1 });
  assert.equal(invalid.passed, false);
  assert.equal(invalid.score, 0.75);
  const empty = ev.evaluateJsonRepairRate([undefined]);
  assert.equal(empty.passed, false);
  assert.equal(empty.details.error, "no tool calls recorded");
  assert.throws(() => ev.evaluateJsonRepairRate({ native: -1 }), /non-negative integer/);
  assert.throws(() => ev.evaluateJsonRepairRate({ native: 1.5 }), /non-negative integer/);
});

test("the parser counts each recognized tool call as native, repaired or invalid", () => {
  const native = (args: string) => parseModelResponse({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: args } }] } as any, { nativeTools: true });
  assert.deepEqual(native('{"path":"a.txt"}').toolCallSyntax, { native: 1, trailing: 0, structural: 0, invalid: 0 });
  assert.deepEqual(native('{"path":"a.txt",}').toolCallSyntax, { native: 0, trailing: 1, structural: 0, invalid: 0 });
  assert.deepEqual(native('{"path":"a.txt"').toolCallSyntax, { native: 0, trailing: 0, structural: 1, invalid: 0 });
  // A structurally repaired write is rejected, and still counted.
  const write = parseModelResponse({ role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: '{"path":"a","content":"x' } }] } as any, { nativeTools: true });
  assert.equal(write.toolCalls.length, 0);
  assert.equal(write.toolCallSyntax?.structural, 1);
  // Text tool calls: a trailing repair, and a tool_call tag whose JSON does not parse.
  const text = parseModelResponse({ role: "assistant", content: '<tool_call>{"name":"read_file","arguments":{"path":"a.txt",},}</tool_call><tool_call>{name: read_file ((</tool_call>' }, { nativeTools: false });
  assert.equal(text.toolCalls.length, 1);
  assert.deepEqual(text.toolCallSyntax, { native: 0, trailing: 1, structural: 0, invalid: 1 });
  // A reply consisting solely of one fenced JSON call is counted like a tag.
  const fenced = parseModelResponse({ role: "assistant", content: '```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```' }, { nativeTools: false });
  assert.equal(fenced.toolCalls.length, 1);
  assert.deepEqual(fenced.toolCallSyntax, { native: 1, trailing: 0, structural: 0, invalid: 0 });
  assert.equal(parseModelResponse({ role: "assistant", content: "no tools here" }).toolCallSyntax, undefined);
});

test("a real agent turn reports its tool-call syntax on the turn result", { timeout: 60_000 }, async () => {
  const repo = makeRepo({ "a.txt": "alpha\n" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-code-evaluators-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  const gw = await startGateway((n) =>
    n === 1 ? { kind: "tools", calls: [{ name: "read_file", args: { path: "a.txt" } }] }
      // Double-encoded arguments with a trailing comma, as some models send them: parsed only after a trailing repair.
      : n === 2 ? { kind: "tools", calls: [{ name: "file_info", args: '{"path":"a.txt",}' }] }
        : { kind: "text", content: "Read a.txt; it says alpha." });
  const config = {
    endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true,
    continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 30 },
  } as HarnessConfig;
  const agent = new AutonomousAgent(config);
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  try {
    const turn = await agent.runTurn("What does a.txt say?");
    assert.ok(turn.toolCallSyntax, JSON.stringify(turn));
    assert.deepEqual(turn.toolCallSyntax, { native: 1, trailing: 1, structural: 0, invalid: 0 });
    assert.equal(ev.evaluateJsonRepairRate(turn.toolCallSyntax).details.total, 2);
  } finally {
    agent.shutdown();
    await gw.close();
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a delegated subagent's tool calls are counted on the parent turn", { timeout: 60_000 }, async () => {
  const repo = makeRepo({ "a.txt": "alpha\n" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-code-evaluators-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  const isSubagent = (body: any) => JSON.stringify(body?.messages ?? []).includes("[Subagent Objective]");
  const toolResults = (body: any) => (body?.messages ?? []).filter((m: any) => m.role === "tool").length;
  const gw = await startGateway((_n, body) => {
    if (isSubagent(body)) {
      // The subagent's call has a trailing comma: parsed only after a repair, and counted on the parent's turn.
      return toolResults(body) === 0
        ? { kind: "tools", calls: [{ name: "read_file", args: '{"path":"a.txt",}' }] }
        : { kind: "text", content: "Subagent report: a.txt says alpha." };
    }
    return toolResults(body) === 0
      ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "Read a.txt and report." } }] }
      : { kind: "text", content: "a.txt says alpha." };
  });
  const config = {
    endpoint: gw.url, model: "m", maxSteps: 8, temperature: 0, workspace: repo, shell: "bash", approvalMode: "auto", fullAccess: true,
    continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 30 },
  } as HarnessConfig;
  const agent = new AutonomousAgent(config);
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  const log = console.log;
  console.log = () => {};
  try {
    const turn = await agent.runTurn("Use a subagent to read a.txt.");
    assert.ok((gw.requests as any[]).some(isSubagent), "the subagent ran");
    assert.deepEqual(turn.toolCallSyntax, { native: 1, trailing: 1, structural: 0, invalid: 0 }, JSON.stringify(turn.toolCallSyntax));
  } finally {
    console.log = log;
    agent.shutdown();
    await gw.close();
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("build evaluator runs candidate code without host filesystem or network access", async () => {
  const root = temporaryDirectory("code-evaluator-build-containment-");
  const workspace = path.join(root, "workspace");
  const secret = path.join(root, "host-secret.txt");
  const marker = path.join(root, "host-write.txt");
  fs.mkdirSync(workspace);
  fs.writeFileSync(secret, "host-only-secret");
  const { server, port } = await listenOnLoopback();
  try {
    const script = `
      import fs from "node:fs";
      import net from "node:net";
      let escaped = false;
      try { if (fs.readFileSync(${JSON.stringify(secret)}, "utf8") === "host-only-secret") escaped = true; } catch {}
      try { fs.writeFileSync(${JSON.stringify(marker)}, "host-write"); escaped = true; } catch {}
      const socket = net.createConnection(${port}, "127.0.0.1");
      socket.once("connect", () => { escaped = true; socket.destroy(); finish(); });
      socket.once("error", finish);
      let finished = false;
      function finish() { if (finished) return; finished = true; clearTimeout(timer); if (escaped) process.exitCode = 73; }
      const timer = setTimeout(() => { socket.destroy(); finish(); }, 300);
    `;
    const command = writeProbe(workspace, script);
    const { evaluateBuild } = ev;
    const result = await evaluateBuild({ ...command, cwd: workspace, timeoutMs: 2_000 });
    assert.equal(fs.existsSync(marker), false, "candidate code must not write outside its workspace");
    if (isolation.sandboxAvailable()) {
      assert.equal(result.passed, true, JSON.stringify(result.details));
      assert.equal(result.details.status, 0);
    } else {
      assert.equal(result.passed, false);
      assert.equal(result.details.infrastructureFailure, true);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typecheck evaluator isolates the candidate revision from host paths and network", async () => {
  const root = temporaryDirectory("code-evaluator-typecheck-containment-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  const secret = path.join(root, "host-secret.txt");
  const marker = path.join(root, "host-write.txt");
  fs.mkdirSync(baseline);
  fs.mkdirSync(candidate);
  fs.writeFileSync(secret, "host-only-secret");
  const { server, port } = await listenOnLoopback();
  try {
    const baselineCommand = writeProbe(baseline, "process.stdout.write('baseline clean\\n');");
    const candidateCommand = writeProbe(candidate, `
      import fs from "node:fs";
      import net from "node:net";
      let escaped = false;
      try { if (fs.readFileSync(${JSON.stringify(secret)}, "utf8") === "host-only-secret") escaped = true; } catch {}
      try { fs.writeFileSync(${JSON.stringify(marker)}, "host-write"); escaped = true; } catch {}
      const socket = net.createConnection(${port}, "127.0.0.1");
      socket.once("connect", () => { escaped = true; socket.destroy(); finish(); });
      socket.once("error", finish);
      let finished = false;
      function finish() { if (finished) return; finished = true; clearTimeout(timer); if (escaped) process.exitCode = 73; }
      const timer = setTimeout(() => { socket.destroy(); finish(); }, 300);
    `);
    const { evaluateTypecheckClean } = ev;
    const result = await evaluateTypecheckClean({
      baseline: { ...baselineCommand, cwd: baseline, timeoutMs: 2_000 },
      candidate: { ...candidateCommand, cwd: candidate, timeoutMs: 2_000 },
    });
    assert.equal(fs.existsSync(marker), false, "candidate typecheck must not write outside its workspace");
    if (isolation.sandboxAvailable()) {
      assert.equal(result.passed, true, JSON.stringify(result.details));
      assert.equal(result.details.infrastructureFailure, false);
    } else {
      assert.equal(result.passed, false);
      assert.equal(result.details.infrastructureFailure, true, "an unavailable sandbox must fail closed");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("build evaluator timeout reaps a delayed descendant process", async () => {
  const root = temporaryDirectory("code-evaluator-descendant-");
  const workspace = path.join(root, "workspace");
  const marker = path.join(workspace, "late-descendant.txt");
  const started = path.join(workspace, "descendant-started.txt");
  fs.mkdirSync(workspace);
  try {
    const delayedChild = `const fs=require('node:fs'); fs.writeFileSync('descendant-started.txt', 'started'); setTimeout(() => fs.writeFileSync('late-descendant.txt', 'escaped'), 1500);`;
    const script = `
      import { spawn } from "node:child_process";
      import fs from "node:fs";
      spawn("/usr/bin/node", ["-e", ${JSON.stringify(delayedChild)}], { stdio: "ignore" }).unref();
      const deadline = Date.now() + 5_000;
      const poll = setInterval(() => {
        if (fs.existsSync("descendant-started.txt")) { clearInterval(poll); setTimeout(() => {}, 10_000); }
        else if (Date.now() >= deadline) { clearInterval(poll); process.exitCode = 74; }
      }, 10);
    `;
    const command = writeProbe(workspace, script);
    const { evaluateBuild } = ev;
    const result = await evaluateBuild({ ...command, cwd: workspace, timeoutMs: 1_000 });
    assert.equal(result.passed, false, "a timed out build must fail");
    assert.equal(result.details.timedOut, true, `the fixture must prove a timeout (actual: ${JSON.stringify(result.details)})`);
    assert.equal(fs.readFileSync(started, "utf8"), "started", "the descendant must start before timeout cleanup is measured");
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    assert.equal(fs.existsSync(marker), false, "a descendant must not survive the bounded process run");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contained runner fails closed when filesystem and network isolation are unavailable", async () => {
  const { createContainedRunner } = await import(path.join(ROOT, "eval/evaluators/code/command.mjs"));
  assert.equal(typeof createContainedRunner, "function", "command runner should expose a deterministic isolation test seam");
  let processStarted = false;
  const run = createContainedRunner({
    sandboxAvailable: () => false,
    isolatedProcessArgv: () => { throw new Error("must not build a host command"); },
    runIsolatedProcess: async () => { processStarted = true; return { status: 0 }; },
  });
  const result = await run("/usr/bin/node", ["-e", "process.exit(0)"], { cwd: os.tmpdir(), timeoutMs: 100 });
  assert.equal(result.status, null);
  assert.match(result.error ?? "", /containment|sandbox|bubblewrap/i);
  assert.equal(processStarted, false, "no direct host fallback may run when isolation is unavailable");
});

test("runner diff boundary detects modified, deleted, and untracked paths from snapshots", async () => {
  const root = temporaryDirectory("code-evaluator-runner-diff-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(path.join(baseline, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseline, "src/modified.js"), "old\n");
  fs.writeFileSync(path.join(baseline, "src/deleted.js"), "delete me\n");
  fs.writeFileSync(path.join(baseline, "src/stable.js"), "same\n");
  fs.cpSync(baseline, candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, "src/modified.js"), "new\n");
  fs.unlinkSync(path.join(candidate, "src/deleted.js"));
  fs.writeFileSync(path.join(candidate, "src/untracked.js"), "new file\n");
  try {
    const { captureWorkspaceSnapshot, runCodeEvaluators } = await runner();
    const baselineSnapshot = captureWorkspaceSnapshot(baseline);
    const results = await runCodeEvaluators({
      task: { evaluators: [{ type: "diff_boundary", allowedPaths: ["src/"] }] },
      candidateWorkspace: candidate,
      baselineSnapshot,
    });
    assert.equal(results[0]?.passed, true);
    assert.deepEqual(results[0]?.details?.accepted, ["src/deleted.js", "src/modified.js", "src/untracked.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner diff boundary rejects forbidden modified, deleted, and untracked paths", async () => {
  const root = temporaryDirectory("code-evaluator-runner-forbidden-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(path.join(baseline, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseline, "src/modified.js"), "old\n");
  fs.writeFileSync(path.join(baseline, "src/deleted.js"), "delete me\n");
  fs.writeFileSync(path.join(baseline, "notes.txt"), "old\n");
  fs.cpSync(baseline, candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, "src/modified.js"), "new\n");
  fs.unlinkSync(path.join(candidate, "notes.txt"));
  fs.writeFileSync(path.join(candidate, "forbidden-untracked.txt"), "new file\n");
  try {
    const { captureWorkspaceSnapshot, runCodeEvaluators } = await runner();
    const results = await runCodeEvaluators({
      task: { evaluators: [{ type: "diff_boundary", allowedPaths: ["src/"] }] },
      candidateWorkspace: candidate,
      baselineSnapshot: captureWorkspaceSnapshot(baseline),
    });
    assert.equal(results[0]?.passed, false);
    assert.deepEqual(results[0]?.details?.violations.map((item: { file: string }) => item.file), ["forbidden-untracked.txt", "notes.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner diff boundary fails closed on missing baseline or empty changes", async () => {
  const root = temporaryDirectory("code-evaluator-runner-empty-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(baseline);
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(baseline, "same.txt"), "same\n");
  fs.copyFileSync(path.join(baseline, "same.txt"), path.join(candidate, "same.txt"));
  try {
    const { captureWorkspaceSnapshot, runCodeEvaluators } = await runner();
    const task = { evaluators: [{ type: "diff_boundary", allowedPaths: ["src/"] }] };
    const missing = await runCodeEvaluators({ task, candidateWorkspace: candidate, baselineSnapshot: null });
    const empty = await runCodeEvaluators({ task, candidateWorkspace: candidate, baselineSnapshot: captureWorkspaceSnapshot(baseline) });
    assert.equal(missing[0]?.passed, false, "missing baseline evidence must fail closed");
    assert.equal(empty[0]?.passed, false, "no changed paths is not sufficient evidence to pass");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typecheck_clean compares candidate diagnostics with a preserved pre-agent workspace", async () => {
  const root = temporaryDirectory("code-evaluator-typecheck-baseline-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(path.join(baseline, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseline, "src/main.ts"), "export const value = 1;\n");
  fs.cpSync(baseline, candidate, { recursive: true });
  const probe = 'import fs from "node:fs"; if (fs.readFileSync("src/main.ts", "utf8").includes("introduced")) process.stdout.write("error TS1234: introduced\\n");';
  fs.writeFileSync(path.join(baseline, "probe.mjs"), probe);
  fs.writeFileSync(path.join(candidate, "probe.mjs"), probe);
  fs.writeFileSync(path.join(candidate, "src/main.ts"), "export const value = introduced;\n");
  try {
    const { runCodeEvaluators } = await runner();
    const [result] = await runCodeEvaluators({
      task: { evaluators: ["typecheck_clean"], typecheck: { command: "/usr/bin/node", args: ["./probe.mjs"] } },
      candidateWorkspace: candidate,
      hiddenWorkspace: candidate,
      typecheckBaselineWorkspace: baseline,
    });
    assert.equal(result.passed, false, JSON.stringify(result.details));
    assert.deepEqual(result.details.newDiagnostics, ["error TS1234: introduced"]);
    assert.equal(result.details.infrastructureFailure, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("diff boundary includes nested .git paths in the candidate workspace", async () => {
  const root = temporaryDirectory("code-evaluator-nested-git-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(path.join(baseline, "src"), { recursive: true });
  fs.writeFileSync(path.join(baseline, "src/main.js"), "stable\n");
  fs.cpSync(baseline, candidate, { recursive: true });
  fs.mkdirSync(path.join(candidate, "src/.git"), { recursive: true });
  fs.writeFileSync(path.join(candidate, "src/.git/config"), "candidate data\n");
  try {
    const { captureWorkspaceSnapshot, runCodeEvaluators } = await runner();
    const [result] = await runCodeEvaluators({
      task: { evaluators: [{ type: "diff_boundary", allowedPaths: ["src/.git/config"] }] },
      candidateWorkspace: candidate,
      baselineSnapshot: captureWorkspaceSnapshot(baseline),
    });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.deepEqual(result.details.accepted, ["src/.git/config"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace snapshot refuses a directory swapped to an outside symlink before enumeration", async () => {
  const root = temporaryDirectory("code-evaluator-directory-race-");
  const workspace = path.join(root, "workspace");
  const nested = path.join(workspace, "nested");
  const moved = path.join(workspace, "nested-original");
  const outside = path.join(root, "outside");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(nested, "ordinary.txt"), "inside\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
  let clockCalls = 0;
  let swapped = false;
  try {
    const { captureWorkspaceSnapshot } = await runner();
    assert.throws(() => captureWorkspaceSnapshot(workspace, { now: () => {
      clockCalls += 1;
      if (!swapped && clockCalls === 5) {
        fs.renameSync(nested, moved);
        fs.symlinkSync(outside, nested, "dir");
        swapped = true;
      }
      return clockCalls;
    } }), /snapshot refused|changed|symlink/i);
    assert.equal(swapped, true, "the test must replace the directory between inspection and enumeration");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner snapshot records symlinks without following them and rejects special files", async (t) => {
  const root = temporaryDirectory("code-evaluator-runner-links-");
  const outside = path.join(root, "outside");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(outside);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(outside, "secret.txt"), "must not be traversed");
  fs.symlinkSync(outside, path.join(workspace, "linked"), "dir");
  try {
    const { captureWorkspaceSnapshot } = await runner();
    const snapshot = captureWorkspaceSnapshot(workspace);
    assert.equal(snapshot.has("linked"), true);
    assert.equal(snapshot.has("linked/secret.txt"), false);

    if (!fs.existsSync("/usr/bin/mkfifo")) {
      t.skip("mkfifo is unavailable for the special-file fixture");
      return;
    }
    const fifo = path.join(workspace, "special.pipe");
    const created = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    assert.throws(() => captureWorkspaceSnapshot(workspace), /special file/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner snapshot fails closed on deterministic depth, entry, byte, and deadline limits", async () => {
  const root = temporaryDirectory("code-evaluator-runner-limits-");
  try {
    const { captureWorkspaceSnapshot } = await runner();
    const depthRoot = path.join(root, "depth");
    fs.mkdirSync(path.join(depthRoot, "one", "two"), { recursive: true });
    assert.throws(() => captureWorkspaceSnapshot(depthRoot, { maxDepth: 1 }), /depth/i);

    const entryRoot = path.join(root, "entries");
    fs.mkdirSync(entryRoot);
    fs.writeFileSync(path.join(entryRoot, "one"), "1");
    fs.writeFileSync(path.join(entryRoot, "two"), "2");
    assert.throws(() => captureWorkspaceSnapshot(entryRoot, { maxEntries: 1 }), /entr(y|ies)/i);

    const byteRoot = path.join(root, "bytes");
    fs.mkdirSync(byteRoot);
    fs.writeFileSync(path.join(byteRoot, "payload"), "1234");
    assert.throws(() => captureWorkspaceSnapshot(byteRoot, { maxBytes: 2 }), /byte/i);

    let now = 0;
    assert.throws(() => captureWorkspaceSnapshot(byteRoot, { timeoutMs: 1, now: () => now++ }), /deadline|timeout/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace snapshot stops incrementally at a single-directory entry limit", async () => {
  const workspace = temporaryDirectory("code-evaluator-single-directory-limit-");
  const names = ["first.txt", "second.txt", "third.txt"];
  for (const name of names) fs.writeFileSync(path.join(workspace, name), name);
  let reads = 0;
  let closed = false;
  try {
    const { captureWorkspaceSnapshot } = await runner();
    assert.throws(() => captureWorkspaceSnapshot(workspace, {
      maxEntries: 2,
      openDirectory: () => ({
        readSync() { reads += 1; return names[reads - 1] ? { name: names[reads - 1] } : null; },
        closeSync() { closed = true; },
      }),
    }), /entry count/i);
    assert.equal(reads, 3, "the walker reads only the first entry beyond the limit to detect overflow");
    assert.equal(closed, true, "the directory iterator must close when a limit rejects the snapshot");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
