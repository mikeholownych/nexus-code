/**
 * WP-1302: resource budgets and command-path confinement for evaluator commands (audit A9).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ev: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/index.mjs")).href);
const { createContainedRunner, runArgv }: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/command.mjs")).href);

function scratch(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("a relative command that resolves outside the workspace through a symlink is refused", async () => {
  const root = scratch("wp1302-cmd-symlink-");
  try {
    fs.mkdirSync(path.join(root, "bin"));
    fs.symlinkSync("/usr/bin/id", path.join(root, "bin/tool"));
    const run = await runArgv("./bin/tool", [], { cwd: root });
    assert.notEqual(run.error, null);
    assert.match(String(run.error), /outside the workspace/);
    assert.equal(run.status, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a relative command with .. that leaves the workspace is refused, and an in-workspace executable still runs", async () => {
  const root = scratch("wp1302-cmd-dotdot-");
  const workspace = path.join(root, "ws");
  try {
    fs.mkdirSync(path.join(workspace, "bin"), { recursive: true });
    fs.copyFileSync("/usr/bin/true", path.join(root, "outside-tool"));
    fs.chmodSync(path.join(root, "outside-tool"), 0o755);
    const escaped = await runArgv("../outside-tool", [], { cwd: workspace });
    assert.match(String(escaped.error), /outside the workspace/);
    fs.copyFileSync("/usr/bin/true", path.join(workspace, "bin/inside-tool"));
    fs.chmodSync(path.join(workspace, "bin/inside-tool"), 0o755);
    const inside = await runArgv("./bin/inside-tool", [], { cwd: workspace });
    assert.equal(inside.error, null, String(inside.error));
    assert.equal(inside.status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the resource contract reaches the isolated process for build and typecheck commands", async () => {
  const seen: any[] = [];
  const runner = createContainedRunner({
    sandboxAvailable: () => true,
    isolatedProcessArgv: (spec: any) => ({ cmd: "/usr/bin/true", argv: [], timeoutMs: spec.timeoutMs }),
    runIsolatedProcess: async (_spec: any, options: any) => { seen.push(options); return { status: 0, stdout: "", stderr: "" }; },
  });
  const resources = { cpuPercent: 100, memoryBytes: 512 * 1024 * 1024, tasks: 64, storageBytes: 64 * 1024 * 1024, workspaceRoot: "/dev/shm/x" };
  const cwd = scratch("wp1302-resources-");
  try {
    await runner(process.execPath, [], { cwd, resources });
    assert.deepEqual(seen.at(-1).resources, resources);
    const build = await ev.evaluateBuild({ command: process.execPath, args: [], cwd, resources, runner: async (_c: string, _a: string[], options: any) => { seen.push(options); return { status: 0 }; } });
    assert.equal(build.passed, true);
    assert.deepEqual(seen.at(-1).resources, resources, "evaluateBuild forwards the contract");
    const spec = (name: string) => ({ command: "tsc", args: [], cwd: `/tmp/wp1302-${name}` });
    await ev.evaluateTypecheckClean({ baseline: spec("baseline"), candidate: spec("candidate"), resources, runner: async (_c: string, _a: string[], options: any) => { seen.push(options); return { status: 0 }; } });
    assert.deepEqual(seen.at(-1).resources, resources, "evaluateTypecheckClean forwards the contract");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("a command cannot write a file larger than the evaluator's file-size budget", async () => {
  const cwd = scratch("wp1302-fsize-");
  try {
    const script = `const fs=require("fs"); const fd=fs.openSync("big.bin","w"); const chunk=Buffer.alloc(1024*1024); for(let i=0;i<8;i++) fs.writeSync(fd, chunk);`;
    const limited = await runArgv(process.execPath, ["-e", script], { cwd, maxFileBytes: 1024 * 1024 });
    assert.notEqual(limited.status, 0, "an 8 MiB write must fail under a 1 MiB budget");
    assert.ok(fs.statSync(path.join(cwd, "big.bin")).size <= 1024 * 1024, "the file stops at the budget");
    const generous = await runArgv(process.execPath, ["-e", script], { cwd, maxFileBytes: 64 * 1024 * 1024 });
    assert.equal(generous.status, 0, JSON.stringify(generous));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("a build spec can set the file-size budget", async () => {
  const runner: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/runner.mjs")).href);
  const root = scratch("wp1302-spec-fsize-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  try {
    for (const dir of [baseline, candidate]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "a.txt"), "x\n"); }
    fs.writeFileSync(path.join(candidate, "a.txt"), "y\n");
    const script = `require("fs").writeFileSync("out.bin", Buffer.alloc(2*1024*1024));`;
    const run = (maxFileBytes: number) => runner.runCodeEvaluators({ task: { evaluators: [{ type: "build", command: process.execPath, args: ["-e", script], maxFileBytes }] }, candidateWorkspace: candidate, typecheckBaselineWorkspace: baseline });
    assert.equal((await run(1024 * 1024))[0].passed, false);
    assert.equal((await run(64 * 1024 * 1024))[0].passed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a typecheck_clean spec can set the file-size budget for both revisions", async () => {
  const runner: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/runner.mjs")).href);
  const root = scratch("wp1302-tc-fsize-");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  try {
    for (const dir of [baseline, candidate]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "a.txt"), "x\n"); }
    fs.writeFileSync(path.join(candidate, "a.txt"), "y\n");
    const script = `require("fs").writeFileSync("out.bin", Buffer.alloc(2*1024*1024));`;
    const run = (maxFileBytes: number) => runner.runCodeEvaluators({ task: { evaluators: [{ type: "typecheck_clean", command: process.execPath, args: ["-e", script], maxFileBytes }] }, candidateWorkspace: candidate, typecheckBaselineWorkspace: baseline });
    assert.equal((await run(1024 * 1024))[0].passed, false);
    assert.equal((await run(64 * 1024 * 1024))[0].passed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an in-workspace relative command runs from /workspace without a host-path runtime mount", async () => {
  const captured: any[] = [];
  const runner = createContainedRunner({
    sandboxAvailable: () => true,
    isolatedProcessArgv: (spec: any) => { captured.push(spec); return { cmd: "/usr/bin/true", argv: [], timeoutMs: spec.timeoutMs }; },
    runIsolatedProcess: async () => ({ status: 0, stdout: "", stderr: "" }),
  });
  const cwd = scratch("wp1302-cmd-mount-");
  try {
    fs.mkdirSync(path.join(cwd, "scripts"));
    fs.copyFileSync("/usr/bin/true", path.join(cwd, "scripts/build"));
    fs.chmodSync(path.join(cwd, "scripts/build"), 0o755);
    await runner("./scripts/build", ["--x"], { cwd });
    const spec = captured.at(-1);
    assert.ok(spec.argv.includes("/workspace/scripts/build"), JSON.stringify(spec.argv));
    assert.deepEqual(spec.readOnlyPaths, [], "a scratch root outside /tmp (e.g. /srv) must not need a runtime allowlist entry");
    assert.deepEqual(spec.allowedFiles, []);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("a checker killed by the memory limit is a failure even if it printed only old diagnostics", async () => {
  const runner = createContainedRunner({
    sandboxAvailable: () => true,
    isolatedProcessArgv: (spec: any) => ({ cmd: "/usr/bin/true", argv: [], timeoutMs: spec.timeoutMs }),
    runIsolatedProcess: async () => ({ status: 1, signal: null, stdout: "", stderr: "src/a.ts(1,1): error TS2322: old\n", resources: { oomKills: 1, exitCode: 137, signal: "SIGKILL", cleaned: true } }),
  });
  const cwd = scratch("wp1302-oom-");
  try {
    const run = await runner(process.execPath, [], { cwd });
    assert.match(String(run.error), /memory limit/);
    const spec = (name: string) => ({ command: "tsc", args: [], cwd: `/tmp/wp1302-${name}` });
    const verdict = await ev.evaluateTypecheckClean({ baseline: spec("baseline"), candidate: spec("candidate"), runner: async (_c: string, _a: string[], o: { cwd: string }) => (o.cwd.endsWith("candidate") ? run : { status: 1, stderr: "src/a.ts(1,1): error TS2322: old\n" }) });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.details.infrastructureFailure, true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
