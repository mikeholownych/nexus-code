/**
 * Test Suite for PLAN-11 PR-11e:
 * - ACC-VER-08: Experimental surfaces labelled (nexus eval, /tdd); nexus eval preserves operator checkout HEAD; reviewer/researcher roles are read-only and refuse write_file.
 * - VER-12: /copy on X11 targets CLIPBOARD selection.
 * - VER-15: Image ingest limits images to 20MB and rejects SVG.
 * - VER-16: Stager handles diffs with spaces in filenames.
 */

import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import * as http from "node:http";

import { fileURLToPath } from "node:url";

import { slashCatalog } from "../src/slash/catalog.js";
import { BenchmarkEvaluator, SweBenchInstance } from "../src/evaluator.js";
import { AutonomousAgent } from "../src/agent.js";
import { buildConfig } from "../src/config.js";
import { isReadOnlyRole, READ_ONLY_ROLES } from "../src/core/roles.js";
import { copyToClipboard } from "../src/clipboard.js";
import { encodeImageFile, MAX_IMAGE_BYTES } from "../src/image.js";
import { parseDiffHunks } from "../src/stager.js";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("PLAN-11 PR-11e: Experimental surfaces, read-only roles, and utilities", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr11e-test-"));

  test("ACC-VER-08: nexus eval --help displays [experimental] label", () => {
    const stdout = execFileSync(
      process.execPath,
      [path.join(cliDir, "dist/index.js"), "eval", "--help"],
      { encoding: "utf-8" }
    );
    assert.match(stdout, /\[experimental\]/i, "nexus eval --help must include [experimental]");
  });

  test("ACC-VER-08: /tdd help displays [experimental] label in catalog and cheatsheet", () => {
    const catalog = slashCatalog();
    const tddSpec = catalog.find((cmd) => cmd.name === "tdd");
    assert.ok(tddSpec, "tdd must exist in slashCatalog");
    assert.match(tddSpec.summary, /\[experimental\]/i, "slashCatalog /tdd summary must include [experimental]");

    const replSrc = fs.readFileSync(path.join(cliDir, "src/repl.ts"), "utf-8");
    assert.match(replSrc, /\/tdd.*\[experimental\]/, "repl.ts cheatsheet must mark /tdd as [experimental]");
  });

  test("ACC-VER-08 & VER-07: nexus eval leaves operator workspace HEAD completely unchanged", async () => {
    const repoDir = path.join(tmpBase, "eval-head-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Nexus Test"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@nexus.local"], { cwd: repoDir, stdio: "ignore" });

    // Commit 1 (base commit)
    fs.writeFileSync(path.join(repoDir, "file1.txt"), "base content\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "commit 1 (base)"], { cwd: repoDir, stdio: "ignore" });
    const commit1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim();

    // Commit 2 (HEAD of operator)
    fs.writeFileSync(path.join(repoDir, "file2.txt"), "head content\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "commit 2 (operator HEAD)"], { cwd: repoDir, stdio: "ignore" });
    const operatorHeadBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim();

    assert.notStrictEqual(commit1, operatorHeadBefore, "Precondition: commit 1 and commit 2 must be distinct");

    // Start a mock server for agent completions
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "mock-eval-1",
        choices: [{
          message: {
            role: "assistant",
            content: "Evaluated benchmark task.",
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: {
                name: "task_completed",
                arguments: JSON.stringify({ summary: "No-op fix" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }));
    });
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port)));

    const evaluator = new BenchmarkEvaluator(repoDir);
    const instance: SweBenchInstance = {
      instance_id: "test__repo-42",
      repo: "test/repo",
      base_commit: commit1,
      problem_statement: "Fix bug in repo based on commit 1",
    };

    try {
      const result = await evaluator.evaluateInstance(instance, {
        endpoint: `http://127.0.0.1:${port}/v1`,
        model: "mock-model",
        maxSteps: 2,
        temperature: 0,
        workspace: repoDir,
        shell: "bash",
      });
      assert.strictEqual(result.instanceId, "test__repo-42");

      // Verify that operator repo HEAD is 100% unchanged!
      const operatorHeadAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim();
      assert.strictEqual(operatorHeadAfter, operatorHeadBefore, "Operator HEAD must be untouched after evaluation");

      // Verify operator working directory has no uncommitted changes
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" }).trim();
      assert.strictEqual(status, "", "Operator workspace must be clean after evaluation");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("ACC-VER-08 & VER-13: Reviewer and researcher roles enforce read-only tool policy and refuse write_file", async () => {
    assert.strictEqual(isReadOnlyRole("reviewer"), true);
    assert.strictEqual(isReadOnlyRole("researcher"), true);
    assert.strictEqual(isReadOnlyRole("implementer"), false);
    assert.strictEqual(isReadOnlyRole("architect"), false);
    assert.strictEqual(isReadOnlyRole("tester"), false);

    const repoDir = path.join(tmpBase, "reviewer-repo");
    fs.mkdirSync(repoDir, { recursive: true });

    // Reviewer agent
    const reviewer = new AutonomousAgent({
      endpoint: "http://127.0.0.1:9999/v1",
      model: "test-model",
      maxSteps: 2,
      temperature: 0,
      workspace: repoDir,
      shell: "bash",
      role: "reviewer",
    });

    assert.strictEqual(reviewer.role, "reviewer");
    assert.strictEqual(reviewer.config.readOnly, true);
    assert.strictEqual(reviewer.config.approvalMode, "read-only");

    const reviewerTools = reviewer.getEffectiveTools().map((t) => t.function.name);
    assert.ok(reviewerTools.includes("read_file"), "Reviewer must have read_file");
    assert.ok(!reviewerTools.includes("write_file"), "Reviewer must not be offered write_file");
    assert.ok(!reviewerTools.includes("edit_file"), "Reviewer must not be offered edit_file");

    // Attempting a write_file tool call must be refused with read-only violation
    const writeCall = {
      id: "call-write-1",
      type: "function" as const,
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: "forbidden.txt", content: "mutating content" }),
      },
    };

    const { receipt } = await (reviewer as any).dispatchToolCall(writeCall, 1, "agent");
    assert.strictEqual(receipt.success, false, "write_file must fail for reviewer");
    assert.strictEqual(receipt.status, "DENIED", "status must be DENIED");
    assert.match(receipt.error, /Read-only mode violation/i, "error must cite read-only mode violation");
    assert.strictEqual(fs.existsSync(path.join(repoDir, "forbidden.txt")), false, "file must not be created");

    // Researcher agent
    const researcher = new AutonomousAgent({
      endpoint: "http://127.0.0.1:9999/v1",
      model: "test-model",
      maxSteps: 2,
      temperature: 0,
      workspace: repoDir,
      shell: "bash",
      role: "researcher",
    });

    assert.strictEqual(researcher.role, "researcher");
    assert.strictEqual(researcher.config.readOnly, true);
    assert.strictEqual(researcher.config.approvalMode, "read-only");

    const researcherTools = researcher.getEffectiveTools().map((t) => t.function.name);
    assert.ok(researcherTools.includes("read_file"));
    assert.ok(!researcherTools.includes("write_file"));

    const researcherWrite = await (researcher as any).dispatchToolCall(writeCall, 1, "agent");
    assert.strictEqual(researcherWrite.receipt.success, false);
    assert.strictEqual(researcherWrite.receipt.status, "DENIED");
    assert.match(researcherWrite.receipt.error, /Read-only mode violation/i);
  });

  test("VER-12: Clipboard copy executes with clipboard selection arguments on Linux", () => {
    // Test clipboard copy interface
    const res = copyToClipboard("test clipboard text");
    assert.strictEqual(typeof res.success, "boolean");

    // Verify source code uses execFileSync with -selection clipboard and --clipboard --input
    const clipSrc = fs.readFileSync(path.join(cliDir, "src/clipboard.ts"), "utf-8");
    assert.match(clipSrc, /execFileSync\(cmd,\s*args/);
    assert.match(clipSrc, /"-selection",\s*"clipboard"/);
    assert.match(clipSrc, /"--clipboard",\s*"--input"/);
  });

  test("VER-15: Image ingest enforces 20MB limit and rejects SVG format", () => {
    const imgDir = path.join(tmpBase, "images");
    fs.mkdirSync(imgDir, { recursive: true });

    // 1. Reject SVG
    const svgPath = path.join(imgDir, "icon.svg");
    fs.writeFileSync(svgPath, "<svg><circle cx='5' cy='5' r='5'/></svg>");
    const svgResult = encodeImageFile(svgPath);
    assert.strictEqual(svgResult.success, false);
    assert.match(svgResult.error || "", /Unsupported image format '\.svg'/);

    // 2. Reject image > 20 MB
    const hugePngPath = path.join(imgDir, "huge.png");
    const fd = fs.openSync(hugePngPath, "w");
    fs.ftruncateSync(fd, 21 * 1024 * 1024); // 21 MB
    fs.closeSync(fd);

    const hugeResult = encodeImageFile(hugePngPath);
    assert.strictEqual(hugeResult.success, false);
    assert.match(hugeResult.error || "", /the limit is 20 MB/);

    // 3. Accept small valid image
    const validPngPath = path.join(imgDir, "small.png");
    // Minimal 1x1 transparent PNG buffer
    const pngBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    fs.writeFileSync(validPngPath, pngBuffer);

    const validResult = encodeImageFile(validPngPath);
    assert.strictEqual(validResult.success, true);
    assert.strictEqual(validResult.mimeType, "image/png");
    assert.ok(validResult.dataUri.startsWith("data:image/png;base64,"));
  });

  test("VER-16: Stager parses diff hunks with paths containing spaces", () => {
    const diffText = `diff --git a/path with spaces/file one.txt b/path with spaces/file one.txt
index 1111111..2222222 100644
--- a/path with spaces/file one.txt
+++ b/path with spaces/file one.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 edited
 line 3
`;
    const files = parseDiffHunks(diffText);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].oldPath, "path with spaces/file one.txt");
    assert.strictEqual(files[0].newPath, "path with spaces/file one.txt");
    assert.strictEqual(files[0].hunks.length, 1);
    assert.ok(files[0].hunks[0].lines.some((l) => l.includes("+line 2 edited")));
    assert.ok(files[0].hunks[0].lines.length >= 4);
  });
});

function extensionManagersReadOnly(agent: AutonomousAgent): boolean[] {
  return [
    (agent as any).skillManager.readOnly,
    (agent as any).mcpManager.readOnly,
    (agent as any).pluginManager.readOnly,
    (agent as any).knowledge.readOnly,
  ];
}

test("mode-selected read-only can be deliberately changed, unlike an explicit read-only launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-readonly-mode-change-"));
  try {
    const selected = new AutonomousAgent(buildConfig({ mode: "read-only", workspace: root }), 0, { durable: false });
    assert.equal(selected.getApprovalMode(), "read-only");
    assert.equal((selected as any).isReadOnly(), true, "mode-selected read-only is enforced before it is changed");
    assert.equal((selected as any).bridge.readOnly, true, "the tool bridge starts read-only");
    assert.equal((selected as any).authorityEngine.isReadOnly(), true, "authority starts read-only");
    assert.deepEqual(extensionManagersReadOnly(selected), [true, true, true, true], "all extension managers start read-only");
    selected.setApprovalMode("auto");
    assert.equal(selected.getApprovalMode(), "auto");
    assert.equal((selected as any).isReadOnly(), false);
    assert.equal((selected as any).bridge.readOnly, false, "changing the mode restores write authority");
    assert.equal((selected as any).authorityEngine.isReadOnly(), false, "authority also restores write authority");
    assert.deepEqual(extensionManagersReadOnly(selected), [false, false, false, false]);
    selected.shutdown();

    const explicit = new AutonomousAgent(buildConfig({ readOnly: true, workspace: root }), 0, { durable: false });
    explicit.setApprovalMode("auto");
    assert.equal(explicit.getApprovalMode(), "read-only");
    assert.equal((explicit as any).isReadOnly(), true);
    assert.equal((explicit as any).bridge.readOnly, true, "an explicit --read-only launch cannot lower the bridge");
    assert.equal((explicit as any).authorityEngine.isReadOnly(), true);
    assert.deepEqual(extensionManagersReadOnly(explicit), [true, true, true, true]);
    explicit.shutdown();

    const runtime = new AutonomousAgent(buildConfig({ workspace: root }), 0, { durable: false });
    runtime.setApprovalMode("read-only");
    assert.equal(runtime.getApprovalMode(), "read-only");
    assert.equal((runtime as any).isReadOnly(), true);
    assert.equal((runtime as any).bridge.readOnly, true);
    assert.equal((runtime as any).authorityEngine.isReadOnly(), true);
    runtime.setApprovalMode("auto");
    assert.equal(runtime.getApprovalMode(), "auto", "runtime mode-selected read-only can be left deliberately");
    assert.equal((runtime as any).isReadOnly(), false);
    assert.equal((runtime as any).bridge.readOnly, false);
    assert.equal((runtime as any).authorityEngine.isReadOnly(), false);
    assert.deepEqual(extensionManagersReadOnly(runtime), [false, false, false, false]);
    runtime.shutdown();

    const stable = new AutonomousAgent(buildConfig({ mode: "review", workspace: root }), 0, { durable: false });
    const stableMcp = (stable as any).mcpManager;
    const stablePlugins = (stable as any).pluginManager;
    (stable as any).extensibilityInitialized = true;
    stable.setApprovalMode("auto");
    assert.strictEqual((stable as any).mcpManager, stableMcp, "review->auto must not recreate MCP");
    assert.strictEqual((stable as any).pluginManager, stablePlugins, "review->auto must not recreate plugins");
    assert.equal((stable as any).extensibilityInitialized, true, "review->auto keeps extensibility initialized");
    stable.setApprovalMode("read-only");
    assert.notStrictEqual((stable as any).mcpManager, stableMcp, "an effective read-only change refreshes MCP posture");
    assert.notStrictEqual((stable as any).pluginManager, stablePlugins, "an effective read-only change refreshes plugins");
    stable.shutdown();

    const fallback = new AutonomousAgent(buildConfig({ mode: "review", workspace: root }), 0, { durable: false });
    fallback.setCheckpointReadOnlyFallback(true);
    assert.equal(fallback.getApprovalMode(), "read-only");
    assert.equal((fallback as any).config.readOnly, false, "the transient fallback must not leak into config");
    assert.equal((fallback as any).bridge.readOnly, true);
    assert.equal((fallback as any).authorityEngine.isReadOnly(), true);
    assert.deepEqual(extensionManagersReadOnly(fallback), [true, true, true, true]);
    fallback.setApprovalMode("auto");
    assert.equal(fallback.getApprovalMode(), "read-only", "the active fallback remains authoritative");
    assert.equal((fallback as any).config.readOnly, false);
    assert.equal((fallback as any).bridge.readOnly, true);
    assert.equal((fallback as any).authorityEngine.isReadOnly(), true);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-readonly-mode-other-"));
    try {
      fallback.setWorkspace(other);
      assert.equal((fallback as any).isReadOnly(), true, "workspace switch keeps the fallback");
      assert.equal((fallback as any).bridge.readOnly, true, "workspace switch rebuilds a read-only bridge");
      assert.equal((fallback as any).authorityEngine.isReadOnly(), true);
      assert.deepEqual(extensionManagersReadOnly(fallback), [true, true, true, true]);
      fallback.setShell("bash");
      assert.equal((fallback as any).bridge.readOnly, true, "shell switch keeps the fallback bridge read-only");
      assert.equal((fallback as any).authorityEngine.isReadOnly(), true);
      assert.deepEqual(extensionManagersReadOnly(fallback), [true, true, true, true]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    fallback.setCheckpointReadOnlyFallback(false);
    assert.equal(fallback.getApprovalMode(), "auto", "the queued auto mode resumes after the fallback");
    assert.equal((fallback as any).bridge.readOnly, false);
    assert.equal((fallback as any).authorityEngine.isReadOnly(), false);
    assert.deepEqual(extensionManagersReadOnly(fallback), [false, false, false, false]);
    fallback.shutdown();

    const full = new AutonomousAgent(buildConfig({ yes: true, workspace: root }), 0, { durable: false });
    assert.equal((full as any).authorityEngine.isFullAccess(), true, "full-access launch starts unrestricted");
    full.setApprovalMode("read-only");
    assert.equal((full as any).authorityEngine.isReadOnly(), true);
    assert.equal((full as any).authorityEngine.isFullAccess(), false, "read-only clears engine full access");
    assert.equal((full as any).config.fullAccess, false);
    const outside = await (full as any).authorityEngine.confine(
      { toolName: "read_file", args: { path: "/etc/passwd" }, actor: "agent", executionDomain: "agent_orchestration" },
      { workspaceRoot: root },
    );
    assert.equal(outside.confined, false, "read-only cannot read outside the workspace");
    full.setApprovalMode("auto");
    assert.equal((full as any).authorityEngine.isFullAccess(), true, "configured full access returns in auto mode");
    full.setCheckpointReadOnlyFallback(true);
    assert.equal((full as any).authorityEngine.isFullAccess(), false, "the fallback disables engine full access");
    full.setCheckpointReadOnlyFallback(false);
    assert.equal((full as any).authorityEngine.isFullAccess(), true, "releasing the fallback restores engine full access");
    full.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
