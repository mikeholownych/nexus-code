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

test("release job prepares the same evaluator environment as CI before running the CLI suite", () => {
  const ci = read("ci.yml");
  const release = read("release.yml");
  const jobs = [
    ["CI Node matrix", jobSection(ci, "test-matrix")],
    ["CI Linux packaging", jobSection(ci, "linux-x86_64")],
    ["release package", jobSection(release, "package")],
  ] as const;

  for (const [jobName, job] of jobs) {
    assert.ok(
      !job.includes(RETIRED_RUNNER_TRIM_STEP),
      `${jobName} does not invoke the retired runner trim script`,
    );
    const suite = job.indexOf("run: npm --prefix cli test");
    assert.ok(suite >= 0, `${jobName} runs the CLI suite`);
    assert.match(job, /timeout-minutes: 45\n\s+run: npm --prefix cli test/, `${jobName} bounds the CLI suite to 45 minutes so a hung test process fails the job`);
    const positions = REQUIRED_EVALUATOR_SETUP.map((step) => {
      const position = job.indexOf(step);
      assert.ok(position >= 0, `${jobName} includes required evaluator setup: ${step}`);
      assert.ok(position < suite, `${jobName} runs evaluator setup before the CLI suite: ${step}`);
      return position;
    });
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index - 1] < positions[index], `${jobName} preserves evaluator setup order`);
    }
  }
});
