import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The release job runs the same CLI suite as CI, including evaluator tests that need the
// pinned toolchains and sandbox. rc.12's release failed with "go: command not found"
// because release.yml lacked steps that ci.yml had; keep the two environments aligned.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => fs.readFileSync(path.join(root, ".github/workflows", name), "utf8");

const REQUIRED_EVALUATOR_SETUP = [
  "go-version: '1.22.12'",
  "run: bash scripts/install-evaluator-toolchains.sh",
  "run: bash scripts/ensure-ci-bubblewrap.sh",
  "run: bash scripts/ensure-ci-user-cgroups.sh",
  'echo "NEXUS_EVAL_TEST_WORKSPACE_ROOT=$root" >> "$GITHUB_ENV"',
  'echo "NEXUS_EVAL_TEST_RUNTIME_ROOT=$runtime_root" >> "$GITHUB_ENV"',
  "sudo install -o root -g root -m 0755 \"$node_runtime\" /usr/bin/node",
];
const RETIRED_RUNNER_TRIM_STEP = "bash scripts/ci-trim-runner-image.sh";

function jobSection(workflow: string, name: string): string {
  const marker = `\n  ${name}:`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow defines the ${name} job`);
  const bodyStart = start + marker.length;
  const remaining = workflow.slice(bodyStart);
  const nextJob = remaining.search(/\n  [a-zA-Z0-9_-]+:/);
  return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
}

// A job that runs the whole suite in one step (`npm --prefix cli test`), and CI's shard leg, which runs one
// shard of the same suite (`npm run test:cli -- --shard=K/N`). The suite step of each needs the same environment.
const WHOLE_SUITE = "run: npm --prefix cli test";
const SHARD_SUITE = /npm --prefix cli run test:cli -- --shard=\$\{\{ matrix\.shard \}\}\/(\d+) /;

function suiteStep(job: string, jobName: string): { position: number; timeoutMinutes: number } {
  const whole = job.indexOf(WHOLE_SUITE);
  const shard = SHARD_SUITE.exec(job);
  assert.ok(whole >= 0 || shard, `${jobName} runs the CLI suite`);
  const position = whole >= 0 ? whole : shard!.index;
  // The step-level bound is the last `timeout-minutes` before the command, inside the same step.
  const stepStart = job.lastIndexOf("\n      - ", position);
  const bound = /^ {8}timeout-minutes: (\d+)$/m.exec(job.slice(stepStart, position));
  assert.ok(bound, `${jobName} bounds the CLI suite step so a hung test process fails the job`);
  return { position, timeoutMinutes: Number(bound[1]) };
}

test("every job that runs the CLI suite prepares the same evaluator environment first and bounds the suite step", () => {
  const ci = read("ci.yml");
  const release = read("release.yml");
  const jobs = [
    ["CI shard leg", jobSection(ci, "test-shard"), "shard"],
    ["release package", jobSection(release, "package"), "whole"],
  ] as const;

  for (const [jobName, job, kind] of jobs) {
    assert.ok(
      !job.includes(RETIRED_RUNNER_TRIM_STEP),
      `${jobName} does not invoke the retired runner trim script`,
    );
    assert.equal(job.includes(WHOLE_SUITE), kind === "whole", `${jobName} runs the ${kind === "whole" ? "whole suite in one step" : "suite by shard"}`);
    const suite = suiteStep(job, jobName);
    if (kind === "whole") assert.equal(suite.timeoutMinutes, 45, `${jobName} bounds the whole suite to 45 minutes`);
    else assert.ok(suite.timeoutMinutes <= 45, `${jobName} bounds a shard no more loosely than the whole suite`);
    const positions = REQUIRED_EVALUATOR_SETUP.map((step) => {
      const position = job.indexOf(step);
      assert.ok(position >= 0, `${jobName} includes required evaluator setup: ${step}`);
      assert.ok(position < suite.position, `${jobName} runs evaluator setup before the CLI suite: ${step}`);
      return position;
    });
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index - 1] < positions[index], `${jobName} preserves evaluator setup order`);
    }
  }
});

test("the CI shard legs and the gates job together run what `npm --prefix cli test` runs, on both Node versions", () => {
  // release.yml runs `npm --prefix cli test`. CI's test-matrix checks must stand for the same commands.
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "cli/package.json"), "utf8")).scripts;
  assert.equal(scripts.test, "npm run test:cli && npm run test:scope", "the suite is exactly test:cli then test:scope");
  assert.equal(scripts["test:cli"], "node scripts/test_shards.mjs", "test:cli is the sharding runner, which runs every file when no shard is named");

  const ci = read("ci.yml");
  const shard = jobSection(ci, "test-shard");
  const gates = jobSection(ci, "test-gates");
  const nodes = /^ {8}node: \[22, 24\]$/m;
  assert.match(shard, nodes, "shard legs run on Node 22 and 24");
  assert.match(gates, nodes, "the gates run on Node 22 and 24");
  assert.match(shard, /^ {6}fail-fast: false/m, "one failing leg does not cancel the others");

  // The matrix must list every index 1..N of the N in --shard=K/N, or part of the suite would never run.
  const total = Number(SHARD_SUITE.exec(shard)?.[1]);
  const listed = /^ {8}shard: \[([\d, ]+)\]$/m.exec(shard)?.[1].split(",").map((value) => Number(value.trim()));
  assert.deepEqual(listed, Array.from({ length: total }, (_, index) => index + 1), `the shard matrix is exactly 1..${total}`);
  // The suite's exit status must survive the pipe into the log file.
  const suiteRun = shard.slice(shard.lastIndexOf("\n      - ", SHARD_SUITE.exec(shard)!.index));
  assert.match(suiteRun, /set -o pipefail\n[\s\S]*\| tee /, "the shard step fails when the suite fails although its output is piped");
  for (const [jobName, job] of [["test-shard", shard], ["test-gates", gates]] as const) {
    assert.doesNotMatch(job, /continue-on-error|^ {4}if:/m, `${jobName} is never skipped and cannot fail softly`);
  }

  assert.match(gates, /^ {8}run: npm --prefix cli run test:scope$/m, "the gates job runs the other half of the suite");
  for (const gate of [
    "- run: node scripts/sync-version.mjs --check",
    "- run: node scripts/check_doc_versions.mjs",
    "- run: node scripts/check_requirements.mjs --enforce",
    "- run: node scripts/check_invariants.mjs",
    'node scripts/check_deprecated_lock.mjs "$lockfile"',
    "make lint",
    "- run: cargo test --locked --manifest-path core/Cargo.toml",
  ]) assert.ok(gates.includes(gate), `the gates job still runs: ${gate}`);
  assert.ok(shard.includes("- run: cargo build --locked --release --manifest-path core/Cargo.toml --bin harness-core --bin nexus-tui"), "every leg builds the release core the suite drives");
});

test("the CI packaging job leaves the suite to the gates and shard legs, which the required test-matrix checks stand for", () => {
  const ci = read("ci.yml");
  const packaging = jobSection(ci, "linux-x86_64");
  // The suite ran here a third time (24 of the job's 33 minutes) on the commit test-shard already covers on Node 22.
  for (const repeated of [WHOLE_SUITE, "test:cli", "make lint", "cargo test"]) {
    assert.ok(!packaging.includes(`${repeated}\n`) && !new RegExp(`run: .*${repeated}`).test(packaging), `linux-x86_64 does not repeat: ${repeated}`);
  }
  // What only this job establishes: dependency policy, a reproducible package, and a package that installs and starts.
  for (const step of [
    "- run: cargo deny --manifest-path core/Cargo.toml --config deny.toml check licenses advisories",
    "- run: bash scripts/security_gates.sh",
    '- run: bash scripts/package-linux.sh "v${{ steps.release-version.outputs.version }}" "$RUNNER_TEMP/dist"',
    '- run: bash scripts/package-linux.sh "v${{ steps.release-version.outputs.version }}" "$RUNNER_TEMP/repro-check"',
    "- run: cmp \"$RUNNER_TEMP/dist/SHA256SUMS\" \"$RUNNER_TEMP/repro-check/SHA256SUMS\"",
    "- run: bash scripts/smoke-package.sh ",
    "- run: bash scripts/installer-smoke.sh ",
  ]) assert.ok(packaging.includes(step), `linux-x86_64 still runs: ${step}`);
  assert.doesNotMatch(packaging, /continue-on-error|^ {4}if:/m, "the packaging job is never skipped and cannot fail softly");
  // The release itself is still gated on the whole suite in the job that builds what is published.
  assert.ok(jobSection(read("release.yml"), "package").includes(WHOLE_SUITE), "release.yml runs the whole suite before publishing");
});

test("the required test-matrix checks fail unless every gate and every shard leg succeeded", () => {
  const ci = read("ci.yml");
  const aggregate = jobSection(ci, "test-matrix");
  // Check names `test-matrix (22)` and `test-matrix (24)` come from the job id and this matrix; a `name:` would change them.
  assert.match(aggregate, /^ {8}node: \[22, 24\]$/m);
  assert.doesNotMatch(aggregate, /^ {4}name:/m);
  assert.match(aggregate, /^ {4}needs: \[test-gates, test-shard\]$/m);
  // A skipped required check counts as passing, so the job must run whatever happened to the jobs it needs.
  assert.match(aggregate, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
  assert.doesNotMatch(aggregate, /continue-on-error/);
  assert.match(aggregate, /GATES_RESULT: \$\{\{ needs\.test-gates\.result \}\}/);
  assert.match(aggregate, /SHARDS_RESULT: \$\{\{ needs\.test-shard\.result \}\}/);
  assert.match(aggregate, /^ {10}test "\$GATES_RESULT" = success$/m);
  assert.match(aggregate, /^ {10}test "\$SHARDS_RESULT" = success$/m);
  assert.match(ci, /^ {2}linux-x86_64:$/m, "the packaging check keeps its name");
});

test("superseded pull-request runs are cancelled, push runs never are, and every CI job has a timeout", () => {
  const ci = read("ci.yml");
  assert.match(ci, /^concurrency:\n {2}group: ci-\$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('run-\{0\}', github\.run_id\) \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
  const names = [...ci.slice(ci.indexOf("\njobs:")).matchAll(/^ {2}([a-zA-Z0-9_-]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(names, ["test-gates", "test-shard", "test-matrix", "linux-x86_64", "diff-coverage"]);
  for (const name of names) assert.match(jobSection(ci, name), /^ {4}timeout-minutes: \d+$/m, `${name} has a job timeout`);
  const checkouts = ci.match(/uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}fetch-depth: 0.*\n {10}persist-credentials: false/g) ?? [];
  assert.equal(checkouts.length, (ci.match(/uses: actions\/checkout@/g) ?? []).length, "no checkout leaves the token in the clone");
});
