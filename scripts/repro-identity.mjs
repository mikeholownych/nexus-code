// Source identity for the cross-runner reproducibility workflow (ACC-SUP-08, REQ-REL-114).
//   record  <version> <dist-dir> <out.json> <runner-label>   identity of the checked-out RC source, toolchain and artifacts
//   compare <expected-version> <expected-commit> <out.json> <identity.json>...
// `compare` fails unless every builder packaged the expected version and commit from identical source and lockfiles
// and produced identical artifact digests; on success it writes the combined evidence record.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LOCKFILES = ["cli/package-lock.json", "core/Cargo.lock", "rust-toolchain.toml"];
const BUILDERS = ["ubuntu-22.04", "ubuntu-24.04"];
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (cmd, ...argv) => execFileSync(cmd, argv, { encoding: "utf8" }).trim();
const fail = (message) => { console.error(`repro-identity: ${message}`); process.exit(1); };

const [mode, ...rest] = process.argv.slice(2);
if (mode === "record") {
  const [version, dist, out, label] = rest;
  if (!version || !dist || !out || !label) fail("usage: record <version> <dist-dir> <out.json> <runner-label>");
  // Packaging must not have changed tracked source: the artifacts must still correspond to the recorded commit.
  const dirty = run("git", "status", "--porcelain", "--untracked-files=no");
  if (dirty) fail(`packaging modified tracked files:\n${dirty}`);
  const identity = {
    source: {
      version,
      commit: run("git", "rev-parse", "HEAD"),
      tree: run("git", "rev-parse", "HEAD^{tree}"),
      tagObject: run("git", "rev-parse", `refs/tags/${version}`),
      lockfiles: Object.fromEntries(LOCKFILES.map((file) => [file, sha256(file)])),
    },
    toolchain: { node: process.version, npm: run("npm", "--version"), rustc: run("rustc", "-V"), cargo: run("cargo", "-V") },
    runner: { label, image: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null },
    workflow: { ref: process.env.GITHUB_REF ?? null, sha: process.env.GITHUB_WORKFLOW_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    artifacts: Object.fromEntries(fs.readdirSync(dist).sort().map((file) => [file, sha256(path.join(dist, file))])),
  };
  fs.writeFileSync(out, `${JSON.stringify(identity, null, 2)}\n`);
} else if (mode === "compare") {
  const [version, commit, out, ...files] = rest;
  if (!version || !/^[0-9a-f]{40}$/.test(commit ?? "") || !out || files.length < 2) fail("usage: compare <version> <commit> <out.json> <identity.json> <identity.json>...");
  const builders = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  for (const id of builders) {
    if (id.source.version !== version || id.source.commit !== commit) fail(`${id.runner.label} packaged ${id.source.version}@${id.source.commit}, not ${version}@${commit}`);
  }
  const [first] = builders;
  const labels = builders.map((id) => id.runner.label).sort();
  if (JSON.stringify(labels) !== JSON.stringify(BUILDERS)) fail(`builders must be exactly ${BUILDERS.join(", ")}; got ${labels.join(", ")}`);
  if (builders.some((id) => !id.runner.image || !id.runner.imageVersion)) fail("every builder must record its runner image and image version");
  // The workflow definition itself must come from the RC tag, so a modified repro.yml on a branch cannot PASS.
  for (const id of builders) {
    if (id.workflow?.ref !== `refs/tags/${version}` || id.workflow?.sha !== commit) fail(`${id.runner.label} ran the workflow from ${id.workflow?.ref}@${id.workflow?.sha}, not refs/tags/${version}@${commit}`);
  }
  if (new Set(builders.map((id) => `${id.workflow.runId}/${id.workflow.runAttempt}`)).size !== 1) fail("builders belong to different workflow runs");
  if (builders.some((id) => JSON.stringify(id.source) !== JSON.stringify(first.source))) fail("builders packaged different source or lockfiles");
  if (builders.some((id) => JSON.stringify(id.artifacts) !== JSON.stringify(first.artifacts))) fail("artifact digests differ between builders");
  const workflowRun = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const evidence = { requirement: "REQ-REL-114", acceptance: "ACC-SUP-08", result: "PASS", workflowRun, workflow: first.workflow, source: first.source, artifacts: first.artifacts, builders: builders.map(({ runner, toolchain }) => ({ runner, toolchain })) };
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
} else {
  fail("mode must be record or compare");
}
