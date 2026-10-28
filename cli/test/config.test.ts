import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildConfig, autoDetectModel, configuredOperationPolicy, mergeOperationPolicy, readBoundedOperatorConfig } from "../src/config.js";
import { startGateway } from "./helpers/fixtures.js";

function runOperatorConfig(home: string, workspace: string, extraEnv: Record<string, string> = {}) {
  const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const configModule = pathToFileURL(path.join(cliDir, "src/config.ts")).href;
  const script = `
    const { loadEnvironment, buildConfig } = await import(${JSON.stringify(configModule)});
    process.chdir(${JSON.stringify(workspace)});
    loadEnvironment();
    const config = buildConfig({ endpoint: "http://127.0.0.1:1/v1", model: "fixture" });
    process.stdout.write(JSON.stringify(config.operationPolicy ?? null));
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: cliDir,
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...extraEnv },
    encoding: "utf8",
  });
}

describe("config", () => {
  test("operator config bounded read rejects growth after stat without consuming the whole file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-config-growth-race-"));
    const file = path.join(dir, "config.json");
    let fd: number | undefined;
    try {
      fs.writeFileSync(file, "{}");
      fd = fs.openSync(file, fs.constants.O_RDONLY);
      assert.equal(fs.fstatSync(fd).size, 2);

      // Simulate the file growing after the caller's stat check but before it reads.
      fs.appendFileSync(file, "x".repeat(80 * 1024));
      assert.throws(() => readBoundedOperatorConfig(fd!), /exceeds the 64 KiB size limit/);

      // The reader must stop at limit + 1 instead of allocating/consuming the grown file.
      const nextByte = Buffer.alloc(1);
      assert.equal(fs.readSync(fd, nextByte, 0, 1, null), 1);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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

  test("operation scheduling policy reads validated operator settings", () => {
    const settings: Record<string, string> = {
      NEXUS_OPERATION_MAX_WAIT_MS: "3600000",
      NEXUS_OPERATION_UNKNOWN_RESUME_BUDGET: "0",
      NEXUS_OPERATION_MAX_RUNS_PER_UNIT: "8",
      NEXUS_OPERATION_MIN_WAIT_MS: "250",
    };
    assert.deepEqual(configuredOperationPolicy((key) => settings[key]), {
      maxWaitMs: 3_600_000,
      unknownResumeBudget: 0,
      maxRunsPerUnit: 8,
      minWaitMs: 250,
    });
  });

  test("operator config.json supplies centralized policy with explicit precedence and workspace isolation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operator-config-home-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operator-config-workspace-"));
    const configDir = path.join(home, ".config", "nexus");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.env"), [
        "NEXUS_OPERATION_MAX_RUNS_PER_UNIT=9",
        "NEXUS_OPERATION_UNKNOWN_RESUME_BUDGET=3",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        version: 1,
        operationPolicy: { maxWaitMs: 60_000, maxRunsPerUnit: 4, minWaitMs: 250 },
      }));
      fs.writeFileSync(path.join(workspace, ".env"), "NEXUS_OPERATION_MAX_WAIT_MS=5000\n");
      fs.writeFileSync(path.join(workspace, "nexus.config.json"), JSON.stringify({
        version: 1,
        operationPolicy: { maxWaitMs: 1000, maxRunsPerUnit: 6 },
      }));

      const shellOverride = runOperatorConfig(home, workspace, { NEXUS_OPERATION_MAX_WAIT_MS: "20000" });
      assert.equal(shellOverride.status, 0, shellOverride.stderr);
      assert.deepEqual(JSON.parse(shellOverride.stdout), {
        maxWaitMs: 20_000,
        unknownResumeBudget: 3,
        maxRunsPerUnit: 4,
        minWaitMs: 250,
      });

      const fileValues = runOperatorConfig(home, workspace);
      assert.equal(fileValues.status, 0, fileValues.stderr);
      assert.deepEqual(JSON.parse(fileValues.stdout), {
        maxWaitMs: 60_000,
        unknownResumeBudget: 3,
        maxRunsPerUnit: 4,
        minWaitMs: 250,
      });

      fs.rmSync(path.join(configDir, "config.json"));
      fs.rmSync(path.join(configDir, "config.env"));
      const workspaceOnly = runOperatorConfig(home, workspace);
      assert.equal(workspaceOnly.status, 0, workspaceOnly.stderr);
      assert.equal(JSON.parse(workspaceOnly.stdout), null, "workspace config must not act as operator policy");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("operator config.json rejects invalid values and symbolic links", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-invalid-operator-config-"));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-invalid-config-workspace-"));
    const configDir = path.join(home, ".config", "nexus");
    const configFile = path.join(configDir, "config.json");
    const target = path.join(home, "target.json");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify({ version: 1, operationPolicy: { maxRunsPerUnit: 1.5 } }));
      const invalidValue = runOperatorConfig(home, workspace);
      assert.notEqual(invalidValue.status, 0);
      assert.match(invalidValue.stderr, /Invalid Nexus config\.json operationPolicy\.maxRunsPerUnit/);

      fs.writeFileSync(configFile, JSON.stringify({ version: 1, operationPolicy: { maxWaitMs: 2_147_483_648 } }));
      const oversizedWait = runOperatorConfig(home, workspace);
      assert.notEqual(oversizedWait.status, 0);
      assert.match(oversizedWait.stderr, /must not exceed Node's timer limit/);

      fs.writeFileSync(configFile, " ".repeat(65 * 1024));
      const oversizedFile = runOperatorConfig(home, workspace);
      assert.notEqual(oversizedFile.status, 0);
      assert.match(oversizedFile.stderr, /exceeds the 64 KiB size limit/);

      fs.writeFileSync(target, JSON.stringify({ version: 1, operationPolicy: { maxRunsPerUnit: 2 } }));
      fs.rmSync(configFile);
      fs.symlinkSync(target, configFile);
      const symlink = runOperatorConfig(home, workspace);
      assert.notEqual(symlink.status, 0);
      assert.match(symlink.stderr, /config\.json must not be a symbolic link/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("operation scheduling policy rejects invalid operator values", () => {
    assert.throws(
      () => configuredOperationPolicy((key) => key === "NEXUS_OPERATION_MAX_RUNS_PER_UNIT" ? "1.5" : undefined),
      /NEXUS_OPERATION_MAX_RUNS_PER_UNIT/,
    );
    assert.throws(
      () => configuredOperationPolicy((key) => ({ NEXUS_OPERATION_MAX_WAIT_MS: "3000000000", NEXUS_OPERATION_MIN_WAIT_MS: "2147483648" }[key])),
      /Node's timer limit/,
    );
    assert.throws(
      () => configuredOperationPolicy((key) => key === "NEXUS_OPERATION_UNKNOWN_RESUME_BUDGET" ? "" : undefined),
      /non-empty decimal integer/,
    );
    assert.throws(
      () => configuredOperationPolicy((key) => key === "NEXUS_OPERATION_UNKNOWN_RESUME_BUDGET" ? "2e0" : undefined),
      /non-empty decimal integer/,
    );
  });

  test("operation spec overrides cannot invert the configured wait interval", () => {
    assert.throws(
      () => mergeOperationPolicy({ minWaitMs: 5_000 }, { maxWaitMs: 1_000 }),
      /minWaitMs \(5000\) must not exceed maxWaitMs \(1000\)/,
    );
  });

  test("valid spec overrides can repair contradictory operator wait defaults", () => {
    const configured = configuredOperationPolicy((key) => ({
      NEXUS_OPERATION_MAX_WAIT_MS: "500",
      NEXUS_OPERATION_MIN_WAIT_MS: "1000",
    }[key]));
    assert.deepEqual(configured, { maxWaitMs: 500, minWaitMs: 1000 });
    assert.deepEqual(mergeOperationPolicy(configured, { maxWaitMs: 1500 }), {
      maxWaitMs: 1500,
      minWaitMs: 1000,
    });
    assert.throws(() => mergeOperationPolicy(configured, undefined), /must not exceed/);
  });

  test("operation spec overrides are validated after merging with operator policy", () => {
    const invalidOverrides: Array<[string, unknown]> = [
      ["string replay budget", { unknownResumeBudget: "invalid" }],
      ["negative replay budget", { unknownResumeBudget: -1 }],
      ["fractional run limit", { maxRunsPerUnit: 1.5 }],
      ["zero run limit", { maxRunsPerUnit: 0 }],
      ["string wait", { maxWaitMs: "1000" }],
      ["oversized max wait", { maxWaitMs: 2_147_483_648 }],
      ["oversized minimum wait", { minWaitMs: 2_147_483_648 }],
    ];
    for (const [label, value] of invalidOverrides) {
      assert.throws(
        () => mergeOperationPolicy(undefined, value as Parameters<typeof mergeOperationPolicy>[1]),
        /Invalid operation policy/,
        label,
      );
    }
    assert.throws(
      () => mergeOperationPolicy({ unknownResumeBudget: 2 }, { unknownResumeBudget: Number.NaN }),
      /Invalid operation policy unknownResumeBudget/,
    );
  });
});
