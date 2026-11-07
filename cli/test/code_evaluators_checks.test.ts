/**
 * WP-1302: typecheck_clean diagnostics handling and the built-in JavaScript syntax parser. Checker output comes from
 * the real TypeScript compiler where one is installed; the comparison runs through the real evaluator.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ev: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/index.mjs")).href);
const TSC = path.join(ROOT, "cli/node_modules/typescript/bin/tsc");
const HAS_TSC = fs.existsSync(TSC);

function scratch(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run the real compiler in `cwd` and return what a contained runner would. */
function realTsc(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [TSC, "--noEmit", ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, FORCE_COLOR: "0" } });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

const spec = (name: string) => ({ command: "tsc", args: ["--noEmit"], cwd: `/tmp/wp1302-${name}` });
const verdict = (runner: (cmd: string, args: string[], o: { cwd: string }) => any, extra: Record<string, unknown> = {}) =>
  ev.evaluateTypecheckClean({ baseline: spec("baseline"), candidate: spec("candidate"), runner, ...extra });
const byRevision = (baselineOut: any, candidateOut: any) => async (_c: string, _a: string[], o: { cwd: string }) => (o.cwd.endsWith("baseline") ? baselineOut : candidateOut);

test("typecheck_clean fails when both revisions report a missing tsconfig (real tsc TS5057)", { skip: !HAS_TSC }, async () => {
  const empty = scratch("wp1302-notsconfig-");
  try {
    const real = realTsc(empty, ["-p", "."]);
    assert.match(real.stdout + real.stderr, /TS5057/);
    const result = await verdict(byRevision(real, real));
    assert.equal(result.passed, false, "nothing was type-checked, so an identical config error is not a clean comparison");
    assert.equal(result.details.infrastructureFailure, true);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("typecheck_clean ignores line and column shifts of an existing diagnostic", async () => {
  const before = { status: 1, stderr: "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n" };
  const after = { status: 1, stderr: "src/a.ts(14,5): error TS2322: Type 'string' is not assignable to type 'number'.\n" };
  const shifted = await verdict(byRevision(before, after));
  assert.equal(shifted.passed, true, JSON.stringify(shifted.details));
  const colon = await verdict(byRevision(
    { status: 101, stderr: "error[E0308]: mismatched types\n --> src/main.rs:2:5\n" },
    { status: 101, stderr: "error[E0308]: mismatched types\n --> src/main.rs:9:5\n" },
  ));
  assert.equal(colon.passed, true, JSON.stringify(colon.details));
  // A second copy of the same message is still a new diagnostic.
  const doubled = await verdict(byRevision(before, { status: 1, stderr: after.stderr + "src/b.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n" }));
  assert.equal(doubled.passed, false);
  assert.equal(doubled.details.newDiagnostics.length, 1);
});

test("typecheck_clean understands --pretty output from the real compiler", { skip: !HAS_TSC }, async () => {
  const baseline = scratch("wp1302-pretty-base-");
  const candidate = scratch("wp1302-pretty-cand-");
  try {
    for (const dir of [baseline, candidate]) {
      fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ files: ["a.ts"], compilerOptions: { strict: true } }));
      fs.writeFileSync(path.join(dir, "a.ts"), 'export const a: number = "x";\n');
    }
    fs.writeFileSync(path.join(candidate, "a.ts"), '\n\nexport const a: number = "x";\n');
    const pretty = (dir: string) => ({ ...realTsc(dir, ["--pretty", "-p", "."]) });
    const prettyBase = pretty(baseline);
    const prettyCand = pretty(candidate);
    assert.match(prettyBase.stdout, /\u001b\[/, "the fixture really produced colored --pretty output");
    const unchanged = await verdict(byRevision(prettyBase, prettyCand));
    assert.equal(unchanged.passed, true, JSON.stringify(unchanged.details));
    assert.equal(unchanged.details.infrastructureFailure, false);

    fs.writeFileSync(path.join(candidate, "a.ts"), 'export const a: number = "x";\nexport const b: boolean = 1;\n');
    const added = await verdict(byRevision(prettyBase, pretty(candidate)));
    assert.equal(added.passed, false);
    assert.equal(added.details.infrastructureFailure, false);
    assert.equal(added.details.newDiagnostics.length, 1, JSON.stringify(added.details.newDiagnostics));
    assert.match(added.details.newDiagnostics[0], /TS2322/);
  } finally {
    fs.rmSync(baseline, { recursive: true, force: true });
    fs.rmSync(candidate, { recursive: true, force: true });
  }
});

test("typecheck_clean accepts a task-supplied diagnostic pattern for checkers without TS or rustc codes", async () => {
  const base = { status: 1, stdout: "a.py:3: error: Incompatible types in assignment\n" };
  const cand = { status: 1, stdout: "a.py:3: error: Incompatible types in assignment\na.py:9: error: Name \"x\" is not defined\n" };
  const unrecognised = await verdict(byRevision(base, cand));
  assert.equal(unrecognised.details.infrastructureFailure, true, "without a pattern these are not recognised diagnostics");
  const recognised = await verdict(byRevision(base, cand), { diagnosticPattern: "^\\S+:\\d+: error:" });
  assert.equal(recognised.details.infrastructureFailure, false);
  assert.equal(recognised.passed, false);
  assert.deepEqual(recognised.details.newDiagnostics, ['a.py:9: error: Name "x" is not defined']);
  await assert.rejects(verdict(byRevision(base, cand), { diagnosticPattern: "(" }), /diagnosticPattern/);
});

