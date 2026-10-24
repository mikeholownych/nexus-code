/**
 * Cross-runner reproducibility source identity (ACC-SUP-08, REQ-REL-114): the compare gate in
 * scripts/repro-identity.mjs passes only when distinct builders packaged the requested version and commit from
 * identical source and lockfiles and produced identical artifact digests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/repro-identity.mjs");
const PACKAGE_SCRIPT = path.join(ROOT, "scripts/package-linux.sh");
const MAKEFILE = path.join(ROOT, "Makefile");
const COMMIT = "a".repeat(40);
const WORKFLOW_COMMIT = "f".repeat(40);
const APPROVED_RUST_IMAGE = "rust:1.95.0-bookworm@sha256:4c2fd73ef19c5ef9d54bee03b06b2839a392604fbfcd578ed948b71b37c1d7fb";

function identity(label: string, overrides: { commit?: string; lock?: string; archive?: string; workflowRef?: string; workflowSha?: string; image?: string | null; rustImage?: string | null; missingAsset?: boolean } = {}) {
  return {
    source: { version: "v1.0.0-rc.1", commit: overrides.commit ?? COMMIT, tree: "b".repeat(40), tagObject: "c".repeat(40), lockfiles: { "cli/package-lock.json": "1", "core/Cargo.lock": overrides.lock ?? "2", "rust-toolchain.toml": "3", "scripts/release-tools/package-lock.json": "4" } },
    toolchain: { node: "v22", npm: "10", rustc: "rustc 1.95.0", cargo: "cargo 1.95.0" },
    buildEnvironment: { rustContainerImage: overrides.rustImage === undefined ? APPROVED_RUST_IMAGE : overrides.rustImage },
    runner: { label, image: overrides.image === undefined ? label.replace("-", "").replace(".04", "") : overrides.image, imageVersion: "20261012.1" },
    workflow: { ref: overrides.workflowRef ?? "refs/heads/main", sha: overrides.workflowSha ?? "f".repeat(40), runId: "42", runAttempt: "1" },
    artifacts: {
      "nexus-linux-x86_64-v1.0.0-rc.1.tar.gz": overrides.archive ?? "d",
      "compatibility.json": "e",
      "SHA256SUMS": "f",
      "THIRD_PARTY_NOTICES.txt": "g",
      "sbom.cdx.json": "h",
      ...(overrides.missingAsset ? {} : { "install.sh": "i" }),
    },
  };
}

test("repro compare accepts only identical source, lockfiles and artifacts from distinct builders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-identity-"));
  const write = (name: string, value: unknown) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const compare = (...files: string[]) => spawnSync(process.execPath, [SCRIPT, "compare", "v1.0.0-rc.1", COMMIT, WORKFLOW_COMMIT, path.join(dir, "out.json"), ...files], { encoding: "utf8" });
  try {
    const a = write("a.json", identity("ubuntu-22.04"));
    const b = write("b.json", identity("ubuntu-24.04"));
    const pass = compare(a, b);
    assert.equal(pass.status, 0, pass.stderr);
    const evidence = JSON.parse(fs.readFileSync(path.join(dir, "out.json"), "utf8"));
    assert.equal(evidence.result, "PASS");
    assert.equal(evidence.source.commit, COMMIT);
    assert.equal(evidence.buildEnvironment.rustContainerImage, APPROVED_RUST_IMAGE);
    assert.deepEqual(evidence.builders.map((builder: any) => builder.runner.label), ["ubuntu-22.04", "ubuntu-24.04"]);

    const missingA = write("missing-a.json", identity("ubuntu-22.04", { missingAsset: true }));
    const missingB = write("missing-b.json", identity("ubuntu-24.04", { missingAsset: true }));
    const missingAssetResult = compare(missingA, missingB);
    assert.notEqual(missingAssetResult.status, 0);
    assert.match(missingAssetResult.stderr, /does not cover the exact six published release assets/);

    const cases: [string, string, RegExp][] = [
      ["other commit", write("c.json", identity("ubuntu-24.04", { commit: "e".repeat(40) })), /not v1\.0\.0-rc\.1@/],
      ["lockfile drift", write("l.json", identity("ubuntu-24.04", { lock: "9" })), /different source or lockfiles/],
      ["artifact drift", write("x.json", identity("ubuntu-24.04", { archive: "f" })), /artifact digests differ/],
      ["same builder twice", a, /must be exactly/],
      ["unexpected builder", write("u.json", identity("ubuntu-20.04")), /must be exactly/],
      ["missing runner image", write("i.json", identity("ubuntu-24.04", { image: null })), /runner image/],
      ["missing Rust build image", write("ri.json", identity("ubuntu-24.04", { rustImage: null })), /approved digest-pinned Bookworm Rust build image/],
      ["unpinned Rust build image", write("ru.json", identity("ubuntu-24.04", { rustImage: "rust:1.95.0-bookworm" })), /approved digest-pinned Bookworm Rust build image/],
      ["EOL Bullseye build image", write("bullseye.json", identity("ubuntu-24.04", { rustImage: "rust:1.95.0-bullseye@sha256:" + "3".repeat(64) })), /approved digest-pinned Bookworm Rust build image/],
      ["different Bookworm build digest", write("rd.json", identity("ubuntu-24.04", { rustImage: "rust:1.95.0-bookworm@sha256:" + "2".repeat(64) })), /approved digest-pinned Bookworm Rust build image/],
      ["workflow from a branch", write("w.json", identity("ubuntu-24.04", { workflowRef: "refs/heads/patched" })), /expected reviewed main workflow commit/],
      ["workflow identity drift", write("ws.json", identity("ubuntu-24.04", { workflowSha: "e".repeat(40) })), /expected reviewed main workflow commit/],
    ];
    for (const [name, other, message] of cases) {
      const result = compare(a, other);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, message, name);
    }
    assert.notEqual(compare(a).status, 0, "a single builder is not cross-runner evidence");
    const invalidWorkflowCommit = spawnSync(process.execPath, [SCRIPT, "compare", "v1.0.0-rc.1", COMMIT, "invalid", path.join(dir, "invalid.json"), a, b], { encoding: "utf8" });
    assert.notEqual(invalidWorkflowCommit.status, 0, "comparison must require the exact workflow commit");
    assert.match(invalidWorkflowCommit.stderr, /usage: compare/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repro record binds the checked-out commit to the fetched tag's peeled commit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-record-tag-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(path.join(dir, "bin"));
    for (const [name, output] of [["npm", "10.0.0"], ["rustc", "rustc 1.95.0"], ["cargo", "cargo 1.95.0"]]) {
      const tool = path.join(dir, "bin", name);
      fs.writeFileSync(tool, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
      fs.chmodSync(tool, 0o755);
    }
    git("init", "--quiet");
    git("config", "user.name", "Repro fixture");
    git("config", "user.email", "repro-fixture@example.invalid");
    for (const file of ["cli/package-lock.json", "core/Cargo.lock", "rust-toolchain.toml", "scripts/release-tools/package-lock.json"]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), "fixture\n");
    }
    fs.writeFileSync(path.join(dir, "source.txt"), "source\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "source fixture");
    const sourceCommit = git("rev-parse", "HEAD");
    git("tag", "v1.0.0-rc.1");
    const dist = path.join(dir, "dist");
    fs.mkdirSync(dist);
    for (const name of ["nexus-linux-x86_64-v1.0.0-rc.1.tar.gz", "compatibility.json", "SHA256SUMS", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json", "install.sh"]) {
      fs.writeFileSync(path.join(dist, name), `${name}\n`);
    }
    const env = {
      ...process.env,
      PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_SHA: WORKFLOW_COMMIT,
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      NEXUS_BUILD_CONTAINER_IMAGE: APPROVED_RUST_IMAGE,
    };
    const out = path.join(dir, "identity.json");
    const record = () => spawnSync(process.execPath, [SCRIPT, "record", "v1.0.0-rc.1", dist, out, "ubuntu-22.04"], { cwd: dir, env, encoding: "utf8" });
    const valid = record();
    assert.equal(valid.status, 0, valid.stderr);
    const identityRecord = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(identityRecord.source.commit, sourceCommit);
    assert.equal(identityRecord.source.tagCommit, sourceCommit);
    assert.equal(identityRecord.workflow.sha, WORKFLOW_COMMIT);

    git("commit", "--quiet", "--allow-empty", "-m", "different tag target");
    const movedTagCommit = git("rev-parse", "HEAD");
    git("checkout", "--quiet", sourceCommit);
    git("update-ref", "refs/tags/v1.0.0-rc.1", movedTagCommit);
    const moved = record();
    assert.notEqual(moved.status, 0);
    assert.match(moved.stderr, /resolves to .* not checked-out source commit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Linux packaging rejects an omitted pinned builder unless host builds are explicitly opted into", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-builder-guard-"));
  const out = path.join(dir, "dist");
  try {
    const result = spawnSync("bash", [PACKAGE_SCRIPT, "v1.0.0", out], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NEXUS_BUILD_CONTAINER_IMAGE: "", NEXUS_ALLOW_HOST_RUST_BUILD: "" },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /NEXUS_BUILD_CONTAINER_IMAGE must use the approved digest-pinned Rust 1\.95 Bookworm builder/);
    assert.equal(fs.existsSync(out), false, "reject before creating package output or invoking build tools");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Makefile reproducibility gate uses the approved builder for both package builds", () => {
  const makefile = fs.readFileSync(MAKEFILE, "utf8");
  assert.ok(makefile.includes(`APPROVED_RUST_BUILD_IMAGE := ${APPROVED_RUST_IMAGE}`));
  const reproducibilityTarget = makefile.slice(makefile.indexOf("verify-reproducibility:"));
  const packageCalls = reproducibilityTarget.match(/NEXUS_BUILD_CONTAINER_IMAGE=\$\(APPROVED_RUST_BUILD_IMAGE\) bash scripts\/package-linux\.sh/g) ?? [];
  assert.equal(packageCalls.length, 2, "both reproducibility builds must use the approved digest-pinned Rust builder");
});
