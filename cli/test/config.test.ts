import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { buildConfig, autoDetectModel } from "../src/config.js";
import { startGateway } from "./helpers/fixtures.js";

describe("config", () => {
  test("a shell NEXUS_VERIFY_ATTESTATION outranks config.env for the provenance setting", () => {
    const cliDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-attest-precedence-"));
    try {
      fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
      fs.writeFileSync(path.join(home, ".config", "nexus", "config.env"), "NEXUS_VERIFY_ATTESTATION=0\n");
      const effective = (shell: string | undefined): unknown => {
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
        if (shell !== undefined) env.NEXUS_VERIFY_ATTESTATION = shell;
        const run = spawnSync(process.execPath, [
          "--import", "tsx", "--input-type=module", "-e",
          'const { loadEnvironment } = await import("./src/config.ts"); loadEnvironment(); process.stdout.write(JSON.stringify(process.env.NEXUS_VERIFY_ATTESTATION ?? null));',
        ], { cwd: cliDir, env, encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        return JSON.parse(run.stdout);
      };
      assert.equal(effective("1"), "1", "config.env =0 must not defeat an explicit shell =1");
      assert.equal(effective(undefined), "0", "config.env applies when the shell does not set it");
      assert.equal(effective(""), "", "an explicitly empty shell value is kept so it is rejected, not replaced");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("workspace trust does not select the tool approval mode", () => {
    const previousTrustOverride = process.env.NEXUS_TRUST_WORKSPACE;
    const previousApprovalMode = process.env.NEXUS_APPROVAL_MODE;
    process.env.NEXUS_TRUST_WORKSPACE = "1";
    delete process.env.NEXUS_APPROVAL_MODE;
    try {
      assert.equal(buildConfig({ endpoint: "e", model: "x" }).approvalMode, "review");
      assert.equal(buildConfig({ endpoint: "e", model: "x", mode: "auto" }).approvalMode, "auto");
      assert.equal(buildConfig({ endpoint: "e", model: "x", mode: "read-only" }).approvalMode, "read-only");
      process.env.NEXUS_APPROVAL_MODE = "auto";
      assert.equal(buildConfig({ endpoint: "e", model: "x" }).approvalMode, "auto");
    } finally {
      if (previousTrustOverride === undefined) delete process.env.NEXUS_TRUST_WORKSPACE;
      else process.env.NEXUS_TRUST_WORKSPACE = previousTrustOverride;
      if (previousApprovalMode === undefined) delete process.env.NEXUS_APPROVAL_MODE;
      else process.env.NEXUS_APPROVAL_MODE = previousApprovalMode;
    }
  });

  test("operator deliverable scope is literal, workspace-relative, and rejects oracle paths and symlinks", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-deliverable-scope-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-deliverable-outside-"));
    try {
      fs.mkdirSync(path.join(workspace, "src"));
      fs.writeFileSync(path.join(workspace, "src", "math.js"), "exports.add = (a, b) => a + b;\n");
      fs.symlinkSync(outside, path.join(workspace, "linked"), "dir");
      assert.deepEqual(
        buildConfig({ workspace, deliverableFile: ["src/math.js", "src/math.js"] }).trustedDeliverableFiles,
        ["src/math.js"],
      );
      for (const invalid of ["../outside.js", "/tmp/outside.js", "test/math.test.js", "linked/secret.js", "src/*.js"]) {
        assert.throws(() => buildConfig({ workspace, deliverableFile: invalid }), /Invalid --deliverable-file/);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("buildConfig applies flags and defaults", () => {
    const config = buildConfig({ endpoint: "http://127.0.0.1:1/v1", model: "x", workspace: "rel-dir", maxSteps: "7", readOnly: true });
    assert.equal(config.endpoint, "http://127.0.0.1:1/v1");
    assert.equal(config.model, "x");
    assert.equal(config.workspace, path.resolve("rel-dir"));
    assert.equal(config.maxSteps, 7);
    assert.equal(config.readOnly, true);
    assert.equal(buildConfig({ endpoint: "e", model: "x" }).maxSteps, 30);
  });

  test("autoDetectModel replaces the placeholder with the first listed model", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "unused" }));
    try {
      const detected = await autoDetectModel(buildConfig({ endpoint: gw.url, model: "local-model" }));
      assert.equal(detected.model, "m");
      const explicit = await autoDetectModel(buildConfig({ endpoint: gw.url, model: "chosen" }));
      assert.equal(explicit.model, "chosen");
    } finally {
      await gw.close();
    }
  });
});
