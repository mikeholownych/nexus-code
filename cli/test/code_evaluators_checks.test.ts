/**
 * WP-1302: typecheck_clean diagnostics handling. Checker output comes from the real TypeScript compiler where one is
 * installed; the comparison runs through the real evaluator. (The JavaScript parser and json_repair_rate have their own files.)
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
    // Newer compilers colour even piped output and report TS5081 ("at the current directory") instead of TS5057.
    assert.match((real.stdout + real.stderr).replace(/\u001b\[[0-9;]*m/g, ""), /TS50(?:57|81)/);
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
  const invalid = await verdict(byRevision(base, cand), { diagnosticPattern: "(" });
  assert.equal(invalid.passed, false, "a bad pattern in task data is a failed result, not an exception that loses the other evaluators");
  assert.match(String(invalid.details.error), /diagnosticPattern/);
});


test("typecheck_clean does not drop a task-recognised diagnostic that starts with a number", async () => {
  const pattern = "^\\d+ problems?:";
  const base = { status: 1, stdout: "1 problem: old thing\n" };
  const cand = { status: 1, stdout: "1 problem: old thing\n2 problems: brand new thing\n" };
  const result = await verdict(byRevision(base, cand), { diagnosticPattern: pattern });
  assert.equal(result.details.infrastructureFailure, false);
  assert.equal(result.passed, false);
  assert.deepEqual(result.details.newDiagnostics, ["2 problems: brand new thing"]);
});

test("typecheck_clean still drops code-frame gutters that follow a coded diagnostic, including rustc's", async () => {
  const frame = (line: number) => `error[E0308]: mismatched types\n --> src/main.rs:${line}:5\n  |\n${line} |     let x: u8 = "a";\n  |                 ^^^ expected \`u8\`\n`;
  const result = await verdict(byRevision({ status: 101, stderr: frame(2) }, { status: 101, stderr: frame(9) }));
  assert.equal(result.passed, true, JSON.stringify(result.details));
});

test("typecheck_clean normalizes only the location, not text inside the message", async () => {
  const msg = (value: string) => `src/a.ts(3,7): error TS2322: Type '"${value}"' is not assignable to type '"ok"'.\n`;
  const changed = await verdict(byRevision({ status: 1, stderr: msg("(1,2)") }, { status: 1, stderr: msg("(3,4)") }));
  assert.equal(changed.passed, false, "a different message must not compare equal");
  assert.equal(changed.details.newDiagnostics.length, 1);
  const moved = await verdict(byRevision({ status: 1, stderr: msg("(1,2)") }, { status: 1, stderr: msg("(1,2)").replace("(3,7)", "(9,7)") }));
  assert.equal(moved.passed, true, JSON.stringify(moved.details));
});

test("typecheck_clean does not treat a diagnostic in a file named like a summary line as a summary", async () => {
  const base = { status: 1, stderr: "src/a.ts(1,1): error TS2322: existing\n" };
  for (const file of ["Found 1 error.ts", "Errors  Files x.ts", "Found 2 errors in the same file.ts"]) {
    const cand = { status: 1, stderr: base.stderr + `${file}(1,1): error TS2304: Cannot find name 'x'.\n` };
    const result = await verdict(byRevision(base, cand));
    assert.equal(result.passed, false, file);
    assert.equal(result.details.newDiagnostics.length, 1, file);
  }
  const summary = await verdict(byRevision({ status: 1, stderr: base.stderr + "Found 1 error in src/a.ts:1\n" }, { status: 1, stderr: base.stderr + "Found 1 error in src/a.ts:9\n" }));
  assert.equal(summary.passed, true, "real tsc summary lines are still ignored");
});

test("typecheck_clean normalizes Go and flake8 style locations and paths with spaces", async () => {
  const go = (line: number) => `./my pkg/main.go:${line}:5: undefined: x\n`;
  const moved = await verdict(byRevision({ status: 1, stderr: go(3) }, { status: 1, stderr: go(40) }), { diagnosticPattern: "undefined:" });
  assert.equal(moved.passed, true, JSON.stringify(moved.details));
  const ts = (line: number) => `src/my dir/a b.ts(${line},7): error TS2322: Type 'string' is not assignable to type 'number'.\n`;
  const spaced = await verdict(byRevision({ status: 1, stderr: ts(3) }, { status: 1, stderr: ts(30) }));
  assert.equal(spaced.passed, true, JSON.stringify(spaced.details));
});

test("typecheck_clean rejects a diagnosticPattern that is not a string", async () => {
  const same = { status: 1, stderr: "src/a.ts(1,1): error TS2322: x\n" };
  for (const pattern of [42, {}, ["a"], null, true]) {
    const result = await verdict(byRevision(same, same), { diagnosticPattern: pattern });
    assert.equal(result.passed, false, JSON.stringify(pattern));
    assert.match(String(result.details.error), /diagnosticPattern/);
  }
});

test("typecheck_clean checks the diagnostic's own code, not text inside its message, for checker configuration errors", async () => {
  const noisy = { status: 1, stderr: `src/a.ts(1,7): error TS2322: Type '"error TS5057:"' is not assignable to type '"ok"'.\n` };
  const fixed = { status: 0, stderr: "" };
  const result = await verdict(byRevision(noisy, fixed));
  assert.equal(result.passed, true, JSON.stringify(result.details));
  assert.equal(result.details.infrastructureFailure, false);
});

test("typecheck_clean never normalizes inside a message, whatever the leading location shape", async () => {
  const shapes: Array<[string, (loc: number, text: string) => string, string?]> = [
    ["tsc --pretty", (loc, text) => `src/a.ts:${loc}:7 - error TS2322: Type '"${text}"' is not assignable to type '"ok"'.\n`],
    ["tsc plain", (loc, text) => `src/a.ts(${loc},7): error TS2322: Type '"${text}"' is not assignable to type '"ok"'.\n`],
    ["mypy style", (loc, text) => `a.py:${loc}: error: Incompatible "${text}"\n`, "^\\S+:\\d+: error:"],
    ["go style", (loc, text) => `./my pkg/main.go:${loc}:5: undefined: ${text}\n`, "undefined:"],
  ];
  for (const [name, line, pattern] of shapes) {
    const extra = pattern ? { diagnosticPattern: pattern } : {};
    const different = await verdict(byRevision({ status: 1, stderr: line(3, "f(1,2): x") }, { status: 1, stderr: line(3, "f(3,4): x") }), extra);
    assert.equal(different.passed, false, `${name}: a different message must be a new diagnostic`);
    assert.equal(different.details.newDiagnostics.length, 1, name);
    const moved = await verdict(byRevision({ status: 1, stderr: line(3, "f(1,2): x") }, { status: 1, stderr: line(30, "f(1,2): x") }), extra);
    assert.equal(moved.passed, true, `${name}: a moved location is not new: ${JSON.stringify(moved.details)}`);
  }
});

test("typecheck_clean does not let a location pattern eat a location-free diagnostic header", async () => {
  const header = (step: number) => `error[E0080]: evaluation panicked: step:${step}: failed\n`;
  const changed = await verdict(byRevision({ status: 101, stderr: header(1) }, { status: 101, stderr: header(2) }));
  assert.equal(changed.passed, false, JSON.stringify(changed.details));
  assert.equal(changed.details.newDiagnostics.length, 1);
  const same = await verdict(byRevision({ status: 101, stderr: header(1) }, { status: 101, stderr: header(1) }));
  assert.equal(same.passed, true);
});

test("typecheck_clean requires a file-like path before a line number and never spans into the message", async () => {
  const line = (n: number) => `error: cannot open 'a.ts:${n}: x'\n`;
  const result = await verdict(byRevision({ status: 1, stderr: line(12) }, { status: 1, stderr: line(13) }), { diagnosticPattern: "^error: cannot open" });
  assert.equal(result.passed, false, JSON.stringify(result.details));
  assert.equal(result.details.newDiagnostics.length, 1);
});

test("typecheck_clean recognises a configuration error only at the diagnostic's leading position, after code frames are filtered", async () => {
  const pretty = [
    "src/a.ts:1:20 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "",
    '1 const x: number = "error TS5057:";',
    "                     ~",
    "",
  ].join("\n");
  const result = await verdict(byRevision({ status: 2, stdout: pretty }, { status: 0, stdout: "" }));
  assert.equal(result.details.infrastructureFailure, false, "the quoted code in the excerpt is not a configuration error");
  assert.equal(result.passed, true, JSON.stringify(result.details));
  const real = await verdict(byRevision({ status: 1, stderr: "error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'.\n" }, { status: 1, stderr: "error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'.\n" }));
  assert.equal(real.passed, false);
  assert.equal(real.details.infrastructureFailure, true);
});

test("typecheck_clean treats every missing-tsconfig code the compiler has used as a configuration error", async () => {
  const lines = [
    "error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'.\n",
    "\u001b[91merror\u001b[0m\u001b[90m TS5081: \u001b[0mCannot find a tsconfig.json file at the current directory: /tmp/x/tsconfig.json.\n",
  ];
  for (const stderr of lines) {
    const result = await verdict(byRevision({ status: 1, stderr }, { status: 1, stderr }));
    assert.equal(result.passed, false, stderr);
    assert.equal(result.details.infrastructureFailure, true, stderr);
  }
});

test("typecheck_clean recognises diagnostics whose file path contains parentheses (route groups)", async () => {
  const line = (n: number) => `app/(auth)/page.tsx(${n},1): error TS2322: Type 'string' is not assignable to type 'number'.\n`;
  const fixed = await verdict(byRevision({ status: 1, stderr: line(1) }, { status: 0, stderr: "" }));
  assert.equal(fixed.details.infrastructureFailure, false, JSON.stringify(fixed.details));
  assert.equal(fixed.passed, true);
  const moved = await verdict(byRevision({ status: 1, stderr: line(1) }, { status: 1, stderr: line(9) }));
  assert.equal(moved.passed, true, JSON.stringify(moved.details));
});

test("typecheck_clean treats Windows-drive paths and extension-less build files as honest relocations", async () => {
  const win = (n: number) => `C:\\work\\my app\\src\\a.ts(${n},7): error TS2322: Type 'string' is not assignable to type 'number'.\n`;
  const drive = await verdict(byRevision({ status: 1, stderr: win(3) }, { status: 1, stderr: win(30) }));
  assert.equal(drive.passed, true, JSON.stringify(drive.details));
  const slash = (n: number) => `C:/proj/main.go:${n}:5: undefined: x\n`;
  const go = await verdict(byRevision({ status: 1, stderr: slash(3) }, { status: 1, stderr: slash(40) }), { diagnosticPattern: "undefined:" });
  assert.equal(go.passed, true, JSON.stringify(go.details));
  const make = (n: number) => `build/Makefile:${n}: *** missing separator.  Stop.\n`;
  const makefile = await verdict(byRevision({ status: 2, stderr: make(3) }, { status: 2, stderr: make(9) }), { diagnosticPattern: "\\*\\*\\*" });
  assert.equal(makefile.passed, true, JSON.stringify(makefile.details));
  const changed = await verdict(byRevision({ status: 2, stderr: make(3) }, { status: 2, stderr: "build/Makefile:3: *** other problem.  Stop.\n" }), { diagnosticPattern: "\\*\\*\\*" });
  assert.equal(changed.passed, false, "a different message is still new");
});

test("typecheck_clean does not read a location out of a file-name lookalike in the message", async () => {
  for (const pattern of ["^x\\(", undefined]) {
    const extra = pattern ? { diagnosticPattern: pattern } : {};
    const first = { status: 1, stderr: "x(1,2): y.ts\n" };
    const second = { status: 1, stderr: "x(5,6): y.ts\n" };
    const result = await verdict(byRevision(first, second), extra);
    assert.equal(result.passed, false, `x(1,2): y.ts and x(5,6): y.ts are different diagnostics (pattern ${pattern})`);
  }
});
