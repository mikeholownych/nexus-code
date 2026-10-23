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
const COMMIT = "a".repeat(40);
const APPROVED_RUST_IMAGE = "rust:1.95.0-bookworm@sha256:4c2fd73ef19c5ef9d54bee03b06b2839a392604fbfcd578ed948b71b37c1d7fb";

function identity(label: string, overrides: { commit?: string; lock?: string; archive?: string; workflowRef?: string; image?: string | null; rustImage?: string | null } = {}) {
  return {
    source: { version: "v1.0.0-rc.1", commit: overrides.commit ?? COMMIT, tree: "b".repeat(40), tagObject: "c".repeat(40), lockfiles: { "cli/package-lock.json": "1", "core/Cargo.lock": overrides.lock ?? "2", "rust-toolchain.toml": "3" } },
    toolchain: { node: "v22", npm: "10", rustc: "rustc 1.95.0", cargo: "cargo 1.95.0" },
    buildEnvironment: { rustContainerImage: overrides.rustImage === undefined ? APPROVED_RUST_IMAGE : overrides.rustImage },
    runner: { label, image: overrides.image === undefined ? label.replace("-", "").replace(".04", "") : overrides.image, imageVersion: "20261012.1" },
    workflow: { ref: overrides.workflowRef ?? "refs/tags/v1.0.0-rc.1", sha: overrides.commit ?? COMMIT, runId: "42", runAttempt: "1" },
    artifacts: { "nexus-linux-x86_64-v1.0.0-rc.1.tar.gz": overrides.archive ?? "d" },
  };
}

test("repro compare accepts only identical source, lockfiles and artifacts from distinct builders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-identity-"));
  const write = (name: string, value: unknown) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const compare = (...files: string[]) => spawnSync(process.execPath, [SCRIPT, "compare", "v1.0.0-rc.1", COMMIT, path.join(dir, "out.json"), ...files], { encoding: "utf8" });
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
      ["workflow from a branch", write("w.json", identity("ubuntu-24.04", { workflowRef: "refs/heads/patched" })), /ran the workflow from refs\/heads\/patched/],
    ];
    for (const [name, other, message] of cases) {
      const result = compare(a, other);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, message, name);
    }
    assert.notEqual(compare(a).status, 0, "a single builder is not cross-runner evidence");
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
