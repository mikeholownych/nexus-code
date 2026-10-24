// Source identity for the cross-runner reproducibility workflow (ACC-SUP-08, REQ-REL-114).
//   record  <version> <dist-dir> <out.json> <runner-label>   identity of the checked-out RC source, workflow, toolchain and artifacts
//   compare <expected-version> <expected-commit> <expected-workflow-commit> <out.json> <identity.json>...
// `compare` fails unless every builder packaged the expected version and commit from identical source and lockfiles
// and produced identical artifact digests; on success it writes the combined evidence record.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LOCKFILES = ["cli/package-lock.json", "core/Cargo.lock", "rust-toolchain.toml", "scripts/release-tools/package-lock.json"];
const BUILDERS = ["ubuntu-22.04", "ubuntu-24.04"];
const RELEASE_ASSETS = ["compatibility.json", "SHA256SUMS", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json", "install.sh"];
const APPROVED_RUST_BUILD_IMAGE = "rust:1.95.0-bookworm@sha256:4c2fd73ef19c5ef9d54bee03b06b2839a392604fbfcd578ed948b71b37c1d7fb";
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (cmd, ...argv) => execFileSync(cmd, argv, { encoding: "utf8" }).trim();
const fail = (message) => { console.error(`repro-identity: ${message}`); process.exit(1); };

const [mode, ...rest] = process.argv.slice(2);
if (mode === "record") {
  const [version, dist, out, label] = rest;
  if (!version || !dist || !out || !label) fail("usage: record <version> <dist-dir> <out.json> <runner-label>");
  if (process.env.NEXUS_BUILD_CONTAINER_IMAGE !== APPROVED_RUST_BUILD_IMAGE) fail("Rust build image is not the approved digest-pinned Bookworm builder");
  if (process.env.GITHUB_REF !== "refs/heads/main") fail("reproducibility workflow must run from reviewed main");
  // Packaging must not have changed tracked source: the artifacts must still correspond to the recorded commit.
  const dirty = run("git", "status", "--porcelain", "--untracked-files=no");
  if (dirty) fail(`packaging modified tracked files:\n${dirty}`);
  const commit = run("git", "rev-parse", "HEAD");
  const tagCommit = run("git", "rev-parse", `refs/tags/${version}^{commit}`);
  if (tagCommit !== commit) fail(`fetched tag ${version} resolves to ${tagCommit}, not checked-out source commit ${commit}`);
  const workflowSha = process.env.GITHUB_WORKFLOW_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(workflowSha)) fail("reviewed main workflow commit is missing or invalid");
  const artifactNames = [`nexus-linux-x86_64-${version}.tar.gz`, ...RELEASE_ASSETS].sort();
  const missingArtifacts = artifactNames.filter((file) => !fs.existsSync(path.join(dist, file)));
  if (missingArtifacts.length) fail(`release output is missing required assets: ${missingArtifacts.join(", ")}`);
  const identity = {
    source: {
      version,
      commit,
      tree: run("git", "rev-parse", "HEAD^{tree}"),
      tagObject: run("git", "rev-parse", `refs/tags/${version}`),
      tagCommit,
      lockfiles: Object.fromEntries(LOCKFILES.map((file) => [file, sha256(file)])),
      // Non-ignored untracked files could be packaged without being part of the commit; both builders must agree.
      untracked: run("git", "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
    },
    toolchain: { node: process.version, npm: run("npm", "--version"), rustc: run("rustc", "-V"), cargo: run("cargo", "-V") },
    buildEnvironment: { rustContainerImage: process.env.NEXUS_BUILD_CONTAINER_IMAGE ?? null },
    runner: { label, image: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null },
    workflow: { ref: process.env.GITHUB_REF ?? null, sha: workflowSha, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    artifacts: Object.fromEntries(artifactNames.map((file) => [file, sha256(path.join(dist, file))])),
  };
  fs.writeFileSync(out, `${JSON.stringify(identity, null, 2)}\n`);
} else if (mode === "compare") {
  const [version, commit, workflowCommit, out, ...files] = rest;
  if (!version || !/^[0-9a-f]{40}$/.test(commit ?? "") || !/^[0-9a-f]{40}$/.test(workflowCommit ?? "") || !out || files.length < 2) fail("usage: compare <version> <commit> <workflow-commit> <out.json> <identity.json> <identity.json>...");
  const builders = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  for (const id of builders) {
    if (id.source.version !== version || id.source.commit !== commit) fail(`${id.runner.label} packaged ${id.source.version}@${id.source.commit}, not ${version}@${commit}`);
  }
  const [first] = builders;
  const labels = builders.map((id) => id.runner.label).sort();
  if (JSON.stringify(labels) !== JSON.stringify(BUILDERS)) fail(`builders must be exactly ${BUILDERS.join(", ")}; got ${labels.join(", ")}`);
  if (builders.some((id) => !id.runner.image || !id.runner.imageVersion)) fail("every builder must record its runner image and image version");
  const buildImages = builders.map((id) => id.buildEnvironment?.rustContainerImage);
  if (buildImages.some((image) => image !== APPROVED_RUST_BUILD_IMAGE)) fail("every builder must use the approved digest-pinned Bookworm Rust build image");
  if (new Set(buildImages).size !== 1) fail("builders used different Rust build images");
  // The released workflow is reviewed on main; the built product source remains bound to the exact RC tag commit above.
  for (const id of builders) {
    if (id.workflow?.ref !== "refs/heads/main" || id.workflow?.sha !== workflowCommit) fail(`${id.runner.label} did not record the expected reviewed main workflow commit ${workflowCommit}`);
  }
  if (new Set(builders.map((id) => id.workflow.sha)).size !== 1) fail("builders used different workflow definitions");
  if (new Set(builders.map((id) => `${id.workflow.runId}/${id.workflow.runAttempt}`)).size !== 1) fail("builders belong to different workflow runs");
  if (builders.some((id) => JSON.stringify(id.source) !== JSON.stringify(first.source))) fail("builders packaged different source or lockfiles");
  if (builders.some((id) => JSON.stringify(id.artifacts) !== JSON.stringify(first.artifacts))) fail("artifact digests differ between builders");
  const expectedAssets = [`nexus-linux-x86_64-${version}.tar.gz`, ...RELEASE_ASSETS].sort();
  if (JSON.stringify(Object.keys(first.artifacts).sort()) !== JSON.stringify(expectedAssets)) fail("identity evidence does not cover the exact six published release assets");
  const workflowRun = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const evidence = { requirement: "REQ-REL-114", acceptance: "ACC-SUP-08", result: "PASS", workflowRun, workflow: first.workflow, source: first.source, buildEnvironment: first.buildEnvironment, artifacts: first.artifacts, builders: builders.map(({ runner, toolchain }) => ({ runner, toolchain })) };
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
} else {
  fail("mode must be record or compare");
}
