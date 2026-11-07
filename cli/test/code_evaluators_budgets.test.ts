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
