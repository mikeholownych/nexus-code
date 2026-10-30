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

const EVALUATOR_SETUP = [
  "go-version: '1.22.12'",
  "run: bash scripts/install-evaluator-toolchains.sh",
  "run: bash scripts/ci-trim-runner-image.sh",
  "run: bash scripts/ensure-ci-bubblewrap.sh",
  "run: bash scripts/ensure-ci-user-cgroups.sh",
  'echo "NEXUS_EVAL_TEST_WORKSPACE_ROOT=$root" >> "$GITHUB_ENV"',
  'echo "NEXUS_EVAL_TEST_RUNTIME_ROOT=$runtime_root" >> "$GITHUB_ENV"',
  "sudo install -o root -g root -m 0755 \"$node_runtime\" /usr/bin/node",
];

test("release job prepares the same evaluator environment as CI before running the CLI suite", () => {
  const ci = read("ci.yml");
  const release = read("release.yml");
  const suite = release.indexOf("run: npm --prefix cli test");
  assert.ok(suite >= 0, "release.yml runs the CLI suite");
  for (const step of EVALUATOR_SETUP) {
    assert.equal(release.includes(step), ci.includes(step), `release.yml and ci.yml disagree on: ${step}`);
    if (release.includes(step)) assert.ok(release.indexOf(step) < suite, `release.yml runs before the CLI suite: ${step}`);
  }
});
