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
import { fileURLToPath, pathToFileURL } from "node:url";

import { AutonomousAgent } from "../src/agent.js";
import { parseModelResponse } from "../src/parser.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { makeRepo, startGateway } from "./helpers/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ev: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/index.mjs")).href);
const { runArgv }: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/command.mjs")).href);

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-code-evaluators-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** Node's built-in TypeScript parser exists from Node.js 22.13; the engines floor is 22. */
const HAS_TS_PARSER = typeof (module as any).stripTypeScriptTypes === "function";

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
  const run = runArgv(node, ["-e", "console.log(process.argv[1])", "$(echo injected)"]);
  assert.equal(run.stdout.trim(), "$(echo injected)");
  // The command sees a minimal environment, not the evaluator's.
  process.env.NEXUS_WP1105_SECRET = "leak";
  try {
    const env = runArgv(node, ["-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"]);
    assert.deepEqual(JSON.parse(env.stdout), ["LANG", "LC_ALL", "PATH"]);
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
  assert.equal(silent.details.statusRegression, true);
  await assert.rejects(ev.evaluateTypecheckClean({ baseline: spec("b", "/tmp/x"), candidate: spec("c", "/tmp/x/") }), /must be separate/);
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
