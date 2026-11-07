/**
 * WP-1302 overlay hardening: the build and typecheck_clean evaluators run in a pinned workspace (the pre-agent tree
 * plus the candidate's changes). These tests drive the real runner and a real contained command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runner: any = await import(pathToFileURL(path.join(ROOT, "eval/evaluators/code/runner.mjs")).href);

/** Build a baseline and a candidate (a copy of it); `edit` mutates the candidate. */
function pair(baselineFiles: Record<string, string>, edit: (candidate: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1302-overlay-"));
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  fs.mkdirSync(baseline);
  for (const [rel, text] of Object.entries(baselineFiles)) {
    fs.mkdirSync(path.dirname(path.join(baseline, rel)), { recursive: true });
    fs.writeFileSync(path.join(baseline, rel), text);
  }
  fs.cpSync(baseline, candidate, { recursive: true, verbatimSymlinks: true });
  edit(candidate);
  return { root, baseline, candidate };
}

/** A build that fails when the named file contains BAD. */
const buildReading = (file: string) => ({ command: "/usr/bin/node", args: ["-e", `process.exit(require("fs").readFileSync(${JSON.stringify(file)},"utf8").includes("BAD")?1:0)`] });

async function runBuild(baseline: string, candidate: string, build: { command: string; args: string[] }) {
  const [result] = await runner.runCodeEvaluators({ task: { evaluators: ["build"], build }, candidateWorkspace: candidate, typecheckBaselineWorkspace: baseline });
  return result;
}

for (const file of ["data/table.json", "pkg/main.go", "src/native.c", "styles/app.css", "assets/schema.sql", "data/values.yaml"]) {
  test(`build sees a candidate edit to ${file}, not the baseline copy`, async () => {
    const { root, baseline, candidate } = pair({ [file]: "good\n" }, (c) => fs.writeFileSync(path.join(c, file), "BAD\n"));
    try {
      const result = await runBuild(baseline, candidate, buildReading(file));
      assert.equal(result.passed, false, `the candidate's edit must reach the build: ${JSON.stringify(result.details)}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("build sees a candidate-added data file and a candidate deletion of one", async () => {
  const { root, baseline, candidate } = pair({ "data/keep.json": "good\n", "data/gone.json": "good\n" }, (c) => {
    fs.writeFileSync(path.join(c, "data/added.json"), "good\n");
    fs.unlinkSync(path.join(c, "data/gone.json"));
  });
  try {
    const build = { command: "/usr/bin/node", args: ["-e", `const fs=require("fs"); process.exit(fs.existsSync("data/added.json") && !fs.existsSync("data/gone.json") ? 0 : 1)`] };
    const result = await runBuild(baseline, candidate, build);
    assert.equal(result.passed, true, JSON.stringify(result.details));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("candidate node_modules and in-repo build helpers never reach the pinned workspace, and the ignored paths are reported", async () => {
  const helpers = ["build.rs", "setup.py", "conftest.py", "tools/gen.js", "package.json"];
  const files: Record<string, string> = { "node_modules/dep/index.js": "good\n" };
  for (const helper of helpers) files[helper] = "good\n";
  const { root, baseline, candidate } = pair(files, (c) => {
    for (const rel of ["node_modules/dep/index.js", ...helpers]) fs.writeFileSync(path.join(c, rel), "BAD\n");
    fs.mkdirSync(path.join(c, "node_modules/evil"), { recursive: true });
    fs.writeFileSync(path.join(c, "node_modules/evil/index.js"), "BAD\n");
  });
  try {
    const script = `const fs=require("fs"); const bad=${JSON.stringify(["node_modules/dep/index.js", ...helpers])}.some((f)=>fs.readFileSync(f,"utf8").includes("BAD")) || fs.existsSync("node_modules/evil"); process.exit(bad?1:0)`;
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", script] });
    assert.equal(result.passed, true, `the pinned workspace must hold the baseline versions: ${JSON.stringify(result.details)}`);
    assert.deepEqual([...result.details.ignoredCandidateChanges].sort(), [...helpers].sort(), "pinned (ignored) candidate edits are reported");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a dangling baseline symlink replaced by a candidate file does not break the overlay", async () => {
  const { root, baseline, candidate } = pair({ "keep.txt": "good\n" }, () => {});
  fs.symlinkSync("/nonexistent/target/for/wp1302", path.join(baseline, "data.ts"));
  fs.cpSync(baseline, candidate, { recursive: true, verbatimSymlinks: true, force: true });
  fs.unlinkSync(path.join(candidate, "data.ts")); // rmSync leaves a dangling link behind on this Node
  fs.writeFileSync(path.join(candidate, "data.ts"), "BAD\n");
  try {
    const result = await runBuild(baseline, candidate, buildReading("data.ts"));
    assert.equal(result.passed, false);
    assert.equal(result.details.status, 1, `the build must run and see the candidate file, not fail setup: ${JSON.stringify(result.details)}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a candidate symlink is not carried but is reported, and does not fail the evaluator", async () => {
  const { root, baseline, candidate } = pair({ "keep.txt": "good\n" }, (c) => fs.symlinkSync("keep.txt", path.join(c, "link.json")));
  try {
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", "process.exit(0)"] });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.deepEqual(result.details.ignoredCandidateChanges, ["link.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a candidate virtualenv or cache is skipped without failing the build", async () => {
  const { root, baseline, candidate } = pair({ "keep.txt": "good\n" }, (c) => {
    fs.mkdirSync(path.join(c, ".venv/bin"), { recursive: true });
    fs.writeFileSync(path.join(c, ".venv/pyvenv.cfg"), "home = /usr/bin\n");
    fs.symlinkSync("/usr/bin/python3", path.join(c, ".venv/bin/python"));
    fs.mkdirSync(path.join(c, "pkg/__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(c, "pkg/__pycache__/m.cpython-312.pyc"), "x");
  });
  try {
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", "process.exit(0)"] });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.deepEqual(result.details.ignoredCandidateChanges, [".venv/"], "a skipped virtualenv is reported once; __pycache__ is never source");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scripts and build or checker configuration the build runs are pinned to the baseline and reported", async () => {
  const pinned = ["scripts/check.sh", "build.gradle", "pom.xml", "justfile", "Rakefile", "mypy.ini", "pyrightconfig.json", "ruff.toml", ".eslintrc.json", "jsconfig.json",
    "tslint.json", ".golangci.yml", ".rubocop.yml", "angular.json", "project.json", "tailwind.config.js", "build.mjs", "scripts/build.js",
    ".babelrc.js", ".babelrc.json", ".eslintrc.cjs", ".mocharc.yml", "webpack.config.js", "packages/app/.eslintrc.cjs", "packages/app/webpack.config.js", "packages/app/build.ts", "crates/core/Cargo.toml"];
  const files: Record<string, string> = { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" };
  for (const rel of pinned) files[rel] = "good\n";
  const { root, baseline, candidate } = pair(files, (c) => { for (const rel of pinned) fs.writeFileSync(path.join(c, rel), "BAD\n"); });
  try {
    const script = `const fs=require("fs"); process.exit(${JSON.stringify(pinned)}.some((f)=>fs.readFileSync(f,"utf8").includes("BAD"))?1:0)`;
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", script] });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.deepEqual([...result.details.ignoredCandidateChanges].sort(), [...pinned].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [name, files] of [
  ["a nested package named target", { "pkg/target/lib.txt": "good\n" }],
  ["a target directory beside a Cargo.toml that is not Cargo output", { "Cargo.toml": "good\n", "target/lib.txt": "good\n" }],
] as const) {
  test(`${name} is carried like any other directory`, async () => {
    const rel = Object.keys(files).find((file) => file.endsWith("lib.txt"))!;
    const { root, baseline, candidate } = pair({ ...files }, (c) => fs.writeFileSync(path.join(c, rel), "BAD\n"));
    try {
      const result = await runBuild(baseline, candidate, buildReading(rel));
      assert.equal(result.passed, false, `an edit to ${rel} must reach the build: ${JSON.stringify(result.details)}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const directory of ["node_modules", "target"]) {
  test(`a large ${directory}/ does not make the pinned snapshot refuse the workspace`, { timeout: 120_000 }, async () => {
    const { root, baseline, candidate } = pair({ "src/a.json": "good\n", "Cargo.toml": "good\n" }, (c) => fs.writeFileSync(path.join(c, "src/a.json"), "BAD\n"));
    try {
      for (const side of [baseline, candidate]) {
        const dir = path.join(side, directory, "big");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(side, directory, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
        for (let i = 0; i < 50_100; i += 1) fs.writeFileSync(path.join(dir, `f${i}`), "");
      }
      const result = await runBuild(baseline, candidate, buildReading("src/a.json"));
      assert.equal(result.details.status, 1, `snapshot must skip ${directory}: ${JSON.stringify(result.details)}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("a directory named venv without pyvenv.cfg is carried like any other", async () => {
  const { root, baseline, candidate } = pair({ "src/venv/x.json": "good\n" }, (c) => fs.writeFileSync(path.join(c, "src/venv/x.json"), "BAD\n"));
  try {
    const result = await runBuild(baseline, candidate, buildReading("src/venv/x.json"));
    assert.equal(result.passed, false, `an edit under src/venv/ must reach the build: ${JSON.stringify(result.details)}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a candidate-added CACHEDIR.TAG does not delete the baseline's target/ inputs from the build tree", async () => {
  const { root, baseline, candidate } = pair({ "Cargo.toml": "good\n", "target/input.rs": "good\n" }, (c) => fs.writeFileSync(path.join(c, "target/CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n"));
  try {
    const script = `process.exit(require("fs").existsSync("target/input.rs") ? 0 : 1)`;
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", script] });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.ok(result.details.ignoredCandidateChanges.includes("target/"), "the differing skip decision is reported");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a forged CACHEDIR.TAG plus a candidate-added Cargo.toml cannot make target/ edits vanish unreported", async () => {
  const { root, baseline, candidate } = pair({ "target/lib.txt": "good\n" }, (c) => {
    fs.writeFileSync(path.join(c, "Cargo.toml"), "x\n");
    fs.writeFileSync(path.join(c, "target/CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    fs.writeFileSync(path.join(c, "target/lib.txt"), "BAD\n");
  });
  try {
    const script = `process.exit(require("fs").readFileSync("target/lib.txt","utf8").includes("good") ? 0 : 1)`;
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", script] });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.ok(result.details.ignoredCandidateChanges.includes("target/"), JSON.stringify(result.details.ignoredCandidateChanges));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ordinary source that only looks like configuration is carried: policy pins build files at the project or package root", async () => {
  const carried = ["src/config/database.config.ts", "src/build.ts", "src/tools/format.js", "lib/gulpfile.ts", "src/app/webpack.config.js", "docs/lint.config.json"];
  const files: Record<string, string> = {};
  for (const rel of carried) files[rel] = "good\n";
  const { root, baseline, candidate } = pair(files, (c) => { for (const rel of carried) fs.writeFileSync(path.join(c, rel), "BAD\n"); });
  try {
    const script = `const fs=require("fs"); process.exit(${JSON.stringify(carried)}.every((f)=>fs.readFileSync(f,"utf8").includes("BAD"))?1:0)`;
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", script] });
    assert.equal(result.details.status, 1, `every one of these must reach the build: ${JSON.stringify(result.details)}`);
    assert.deepEqual(result.details.ignoredCandidateChanges, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** Pin tool configs and build scripts below a package root named by the baseline's own workspace manifest. */
const layouts: Array<[string, Record<string, string>]> = [
  ["package.json workspaces (array)", { "package.json": JSON.stringify({ workspaces: ["plugins/*"] }) }],
  ["package.json workspaces (object)", { "package.json": JSON.stringify({ workspaces: { packages: ["plugins/*"] } }) }],
  ["pnpm-workspace.yaml", { "pnpm-workspace.yaml": "packages:\n  - 'plugins/*'\n  - \"tools/*\"\n" }],
  ["Cargo workspace members", { "Cargo.toml": '[workspace]\nmembers = ["plugins/*"]\n' }],
  ["go.work use", { "go.work": "go 1.22\n\nuse (\n\t./plugins/a\n\t./plugins/b\n)\n" }],
  ["go.work single use", { "go.work": "go 1.22\n\nuse ./plugins/a\n" }],
  ["pnpm-workspace.yaml flow list", { "pnpm-workspace.yaml": "packages: ['plugins/*', \"tools/*\"]\n" }],
  ["pnpm-workspace.yaml multi-line flow list", { "pnpm-workspace.yaml": "packages: [\n  'tools/*',\n  \"plugins/*\"\n]\n" }],
  ["pnpm-workspace.yaml with trailing comments", { "pnpm-workspace.yaml": "packages:   # the plugin packages\n  - 'plugins/*'   # all of them\n" }],
  ["pnpm-workspace.yaml with an anchor on the key", { "pnpm-workspace.yaml": "packages: &pk\n  - \"plugins/*\"\n" }],
  ["lerna.json packages", { "lerna.json": JSON.stringify({ packages: ["plugins/*"] }) }],
  ["rush.json projects", { "rush.json": JSON.stringify({ projects: [{ packageName: "a", projectFolder: "plugins/a" }] }) }],
  ["nx.json workspaceLayout", { "nx.json": JSON.stringify({ workspaceLayout: { appsDir: "plugins" } }) }],
];
for (const [name, manifest] of layouts) {
  test(`tool configs under a plugins/<name>/ package root are pinned when the baseline's ${name} names it`, async () => {
    const pinned = ["plugins/a/.eslintrc.cjs", "plugins/a/webpack.config.js", "plugins/a/build.mjs"];
    const carried = ["plugins/a/src/build.ts", "plugins/a/src/config/db.config.ts", "other/b/.eslintrc.cjs", "other/b/build.mjs"];
    const files: Record<string, string> = { ...manifest };
    for (const rel of [...pinned, ...carried]) files[rel] = "good\n";
    const { root, baseline, candidate } = pair(files, (c) => { for (const rel of [...pinned, ...carried]) fs.writeFileSync(path.join(c, rel), "BAD\n"); });
    try {
      const script = `const fs=require("fs"); const bad=(f)=>fs.readFileSync(f,"utf8").includes("BAD"); process.exit(${JSON.stringify(pinned)}.some(bad) || !${JSON.stringify(carried)}.every(bad) ? 1 : 0)`;
      const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", script] });
      assert.equal(result.passed, true, JSON.stringify(result.details));
      assert.deepEqual([...result.details.ignoredCandidateChanges].filter((p: string) => p.startsWith("plugins/")).sort(), [...pinned].sort());
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("without a workspace manifest only the project root is a package root", async () => {
  const { root, baseline, candidate } = pair({ "plugins/a/.eslintrc.cjs": "good\n" }, (c) => fs.writeFileSync(path.join(c, "plugins/a/.eslintrc.cjs"), "BAD\n"));
  try {
    const result = await runBuild(baseline, candidate, buildReading("plugins/a/.eslintrc.cjs"));
    assert.equal(result.passed, false, "no manifest names plugins/a, so its config is ordinary carried source");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the conventional workspace folders stay package roots without any recognised manifest (union with the manifest roots)", async () => {
  const pinned = ["packages/a/webpack.config.js", "apps/b/.eslintrc.cjs", "libs/c/build.mjs", "crates/d/rustfmt.toml", "modules/e/.babelrc.js", "services/f/tailwind.config.js"];
  const files: Record<string, string> = { "lerna.json": "{}\n" };
  for (const rel of pinned) files[rel] = "good\n";
  const { root, baseline, candidate } = pair(files, (c) => { for (const rel of pinned) fs.writeFileSync(path.join(c, rel), "BAD\n"); });
  try {
    const script = `process.exit(${JSON.stringify(pinned)}.some((f)=>require("fs").readFileSync(f,"utf8").includes("BAD"))?1:0)`;
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", script] });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.deepEqual([...result.details.ignoredCandidateChanges].sort(), [...pinned].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace manifests are pinned, so a candidate cannot change the package roots", async () => {
  const manifests = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "rush.json", "go.work", "Cargo.toml", "package.json", "sub/pnpm-workspace.yaml"];
  const files: Record<string, string> = {};
  for (const rel of manifests) files[rel] = "good\n";
  const { root, baseline, candidate } = pair(files, (c) => { for (const rel of manifests) fs.writeFileSync(path.join(c, rel), "BAD\n"); });
  try {
    const script = `process.exit(${JSON.stringify(manifests)}.some((f)=>require("fs").readFileSync(f,"utf8").includes("BAD"))?1:0)`;
    const result = await runBuild(baseline, candidate, { command: "/usr/bin/node", args: ["-e", script] });
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.deepEqual([...result.details.ignoredCandidateChanges].sort(), [...manifests].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a pnpm-workspace.yaml alias the parser cannot resolve is reported, and the union still applies", async () => {
  const pinned = ["packages/a/.eslintrc.cjs"];
  const { root, baseline, candidate } = pair({ "pnpm-workspace.yaml": "packages:\n  - *shared\n", "packages/a/.eslintrc.cjs": "good\n" }, (c) => fs.writeFileSync(path.join(c, "packages/a/.eslintrc.cjs"), "BAD\n"));
  try {
    const result = await runBuild(baseline, candidate, buildReading("packages/a/.eslintrc.cjs"));
    assert.equal(result.passed, true, JSON.stringify(result.details));
    assert.deepEqual(result.details.ignoredCandidateChanges, pinned);
    assert.ok((result.details.workspaceNotes ?? []).some((note: string) => /pnpm-workspace\.yaml.*(anchor|alias)/i.test(note)), JSON.stringify(result.details));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
