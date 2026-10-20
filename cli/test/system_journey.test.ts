import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { ApplicationCore } from "../src/core/app.js";
import { CandidateTracker, hashContent, ValidationReceipt } from "../src/core/candidate.js";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { HarnessConfig } from "../src/types.js";

/**
 * WP-11 Decisive Multi-Actor System Journey Test (INC-12)
 *
 * Demonstrates the full cohesive Nexus lifecycle:
 * 1. Multiple engineering actors with isolated contexts (Implementer, Operator, Independent Reviewer).
 * 2. Scoped authority and deliberate unauthorized mutation attempts failing closed.
 * 3. Real engineering work producing candidate mutations.
 * 4. Cryptographic candidate identity calculation and authoritative validation binding.
 * 5. Independent assessment boundary (evaluator receives only candidate + spec).
 * 6. Accepted-only consequential progression (merge rejected without valid receipt, allowed with it).
 * 7. Durable state persistence and milestone recovery.
 */
describe("WP-11: Decisive Multi-Actor System Journey & Lifecycle Qualification (INC-12)", () => {
  let tmpDir: string;
  let gitRepoDir: string;
  let activeApps: ApplicationCore[] = [];

  beforeEach(() => {
    activeApps = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wp11-journey-"));
    gitRepoDir = path.join(tmpDir, "repo");

    fs.mkdirSync(gitRepoDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.email", "tester@nexus.local"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: gitRepoDir });

    fs.writeFileSync(path.join(gitRepoDir, "README.md"), "# Production System\n");
    fs.mkdirSync(path.join(gitRepoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(gitRepoDir, "src", "index.ts"), "export const status = 'healthy';\n");
    execFileSync("git", ["add", "."], { cwd: gitRepoDir });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: gitRepoDir });
  });

  afterEach(() => {
    for (const a of activeApps) {
      try {
        a.shutdown();
      } catch {}
    }
    activeApps = [];
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
    return {
      endpoint: "http://localhost:1234/v1",
      model: "test-model",
      workspace: gitRepoDir,
      maxSteps: 5,
      temperature: 0.1,
      shell: "bash",
      ...overrides,
    };
  }

  function createApp(overrides: Partial<HarnessConfig> = {}): ApplicationCore {
    const app = new ApplicationCore(createConfig(overrides));
    activeApps.push(app);
    return app;
  }

  test("Complete Multi-Actor Lifecycle: Worktree Isolation -> Unauthorized Rejection -> Candidate Validation -> Independent Assessment -> Merge", async () => {
    // -------------------------------------------------------------------------
    // Phase 1: Setup Implementer in Speculative Worktree
    // -------------------------------------------------------------------------
    const implementerApp = createApp({ worktree: true });
    const implementerTaskId = implementerApp.getTaskId();
    const worktreeMgr = implementerApp.getAgent().getWorktreeManager();
    const worktreeInfo = worktreeMgr.createWorktree(implementerTaskId);
    const worktreePath = worktreeInfo.worktreePath;

    assert.ok(fs.existsSync(worktreePath), "Worktree directory must exist");
    assert.strictEqual(worktreeInfo.branch, `nexus/${implementerTaskId}`);

    // Bind worktree to durable state
    const taskState = implementerApp.getStateManager().loadTaskState(implementerTaskId);
    taskState.worktreeBinding = {
      taskId: implementerTaskId,
      worktreePath,
      branch: worktreeInfo.branch,
      baseCommit: worktreeInfo.baseCommit,
    };
    implementerApp.getStateManager().saveTaskState(taskState);

    // -------------------------------------------------------------------------
    // Phase 2: Deliberate Unauthorized Operation (Fail-Closed Gate)
    // -------------------------------------------------------------------------
    // Attempt unauthorized read-only mutation through ExecutionSpine
    const readOnlyApp = createApp({ readOnly: true, workspace: worktreePath });
    const deniedReceipt = await readOnlyApp.executeOperatorCommand("rm -rf src/index.ts");

    assert.strictEqual(deniedReceipt.success, false, "Unauthorized mutation must fail closed");
    assert.strictEqual(deniedReceipt.status, "DENIED", "Status must be DENIED");
    assert.match(deniedReceipt.error!, /Read-only mode/, "Error must identify read-only violation");
    assert.strictEqual(fs.existsSync(path.join(worktreePath, "src", "index.ts")), true, "File must remain untouched");

    // -------------------------------------------------------------------------
    // Phase 3: Real Engineering Mutation in Worktree
    // -------------------------------------------------------------------------
    // Implementer applies validated feature change inside worktree
    const featureCode = "export const status = 'healthy';\nexport const version = '2.0.0';\n";
    fs.writeFileSync(path.join(worktreePath, "src", "index.ts"), featureCode);

    // -------------------------------------------------------------------------
    // Phase 4: Candidate Identity Computation
    // -------------------------------------------------------------------------
    const candidateTracker = implementerApp.getCandidateTracker();
    const candidate = candidateTracker.computeCandidateIdentitySync(worktreePath);

    assert.ok(candidate.candidateId.length > 20, "Candidate ID must be a non-empty cryptographic hash");
    assert.strictEqual(candidate.trackedChanges.length, 1);
    assert.strictEqual(candidate.trackedChanges[0].path, "src/index.ts");

    // -------------------------------------------------------------------------
    // Phase 5: Verification & Authoritative Receipt Binding
    // -------------------------------------------------------------------------
    const verifierReceipt = candidateTracker.recordValidationReceipt({
      candidateId: candidate.candidateId,
      verifierCommand: "npm test",
      exitCode: 0,
      stdoutHash: hashContent("all tests passed"),
      status: "PASSED",
      materialDependencies: [],
    });

    implementerApp.getStateManager().recordCandidateAndReceipt(implementerTaskId, {
      candidateId: candidate.candidateId,
      candidateIdentity: candidate,
      receipt: verifierReceipt,
    });
    implementerApp.checkpointState("Candidate verified by test verifier");

    // -------------------------------------------------------------------------
    // Phase 6: Independent Assessment Boundary (SEGR-002)
    // -------------------------------------------------------------------------
    // Independent validator receives only candidate patch and declared receipt, without agent scratchpad
    const independentDecision = candidateTracker.isCandidateValidForMergeSync(worktreePath, verifierReceipt);
    assert.strictEqual(independentDecision.valid, true, "Independent assessment must approve valid candidate");

    // Negative Assessment: Out-of-band mutation invalidates receipt
    fs.writeFileSync(path.join(worktreePath, "src", "index.ts"), featureCode + "// unverified addition\n");
    const mutatedDecision = candidateTracker.isCandidateValidForMergeSync(worktreePath, verifierReceipt);
    assert.strictEqual(mutatedDecision.valid, false, "Independent assessment must reject mutated candidate");
    assert.match(mutatedDecision.reason!, /Candidate was modified after validation/);

    // Revert out-of-band mutation back to verified state
    fs.writeFileSync(path.join(worktreePath, "src", "index.ts"), featureCode);
    const restoredDecision = candidateTracker.isCandidateValidForMergeSync(worktreePath, verifierReceipt);
    assert.strictEqual(restoredDecision.valid, true, "Restored candidate must re-validate cleanly");

    // -------------------------------------------------------------------------
    // Phase 7: Consequential Progression (Worktree Merge into Root Repository)
    // -------------------------------------------------------------------------
    // 7a: Negative test — Refuse merge with missing validation receipt
    const noReceiptMerge = worktreeMgr.mergeWorktree(
      implementerTaskId,
      "feat: upgrade without receipt",
      undefined,
      candidateTracker,
      { requireValidation: true }
    );
    assert.strictEqual(noReceiptMerge.success, false, "Merge without receipt must be refused");
    assert.match(noReceiptMerge.error!, /No authoritative validation receipt provided/);

    // 7b: Valid merge with matching validation receipt
    const mergeResult = worktreeMgr.mergeWorktree(
      implementerTaskId,
      "feat: upgrade status to 2.0.0",
      verifierReceipt,
      candidateTracker
    );
    assert.strictEqual(mergeResult.success, true, "Merge must succeed for verified candidate");

    // Verify root repository contains merged changes
    const rootIndexContent = fs.readFileSync(path.join(gitRepoDir, "src", "index.ts"), "utf-8");
    assert.strictEqual(rootIndexContent, featureCode, "Root repository must reflect merged feature code");

    // -------------------------------------------------------------------------
    // Phase 8: Bounded State Recovery & Reconstruction (WP-07 Composition)
    // -------------------------------------------------------------------------
    // Reconstruct a fresh ApplicationCore on the same repository
    const recoveryApp = createApp();
    const recResult = await recoveryApp.recoverTask(implementerTaskId);

    assert.strictEqual(recResult.success, true, "Task state must recover cleanly");
    assert.strictEqual(recoveryApp.getTaskId(), implementerTaskId);
    assert.strictEqual(recoveryApp.getTaskState().candidateId, candidate.candidateId);
  });

  test("real generated worktree paths tolerate uncertain entropy and reject positive credentials", () => {
    const syntheticEntropyComponent = "aZ7mK2pQ9x-V4nR8cT1yB6hW3";
    assert.ok(InformationFlowBoundary.getGlobalInstance().classifyText(syntheticEntropyComponent)
      .some((finding) => finding.classificationType === "UNCERTAIN"));

    const workspace = path.join(tmpDir, syntheticEntropyComponent, "repo");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "README.md"), "# Synthetic workspace\n");
    fs.writeFileSync(path.join(workspace, "src", "index.ts"), "export const status = 'healthy';\n");
    execFileSync("git", ["init"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "tester@nexus.local"], { cwd: workspace });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: workspace });

    const app = createApp({ worktree: true, workspace });
    const taskId = app.getTaskId();
    assert.ok(taskId);
    const generatedWorktree = app.getAgent().getWorktreeManager().createWorktree(taskId);
    const stateManager = app.getStateManager();
    const taskState = stateManager.loadTaskState(taskId);
    taskState.worktreeBinding = {
      taskId: generatedWorktree.taskId,
      worktreePath: generatedWorktree.worktreePath,
      branch: generatedWorktree.branch,
      baseCommit: generatedWorktree.baseCommit,
    };
    assert.doesNotThrow(() => stateManager.saveTaskState(taskState));
    assert.equal(stateManager.loadTaskState(taskId).worktreeBinding?.worktreePath, generatedWorktree.worktreePath);

    const mismatchedTaskState = {
      ...taskState,
      taskId: `other-${taskId}`,
      worktreeBinding: { ...taskState.worktreeBinding, worktreePath: generatedWorktree.worktreePath },
    };
    assert.throws(() => stateManager.saveTaskState(mismatchedTaskState), /Sensitive-data protection or classification failed/);

    taskState.worktreeBinding.worktreePath = path.join(tmpDir, "external", syntheticEntropyComponent, "repo");
    assert.throws(() => stateManager.saveTaskState(taskState), /Sensitive-data protection or classification failed/);

    const syntheticCredential = `ghp_${"A".repeat(36)}`;
    taskState.worktreeBinding.worktreePath = path.join(workspace, ".nexus", "worktrees", syntheticCredential);
    assert.throws(() => stateManager.saveTaskState(taskState), /Sensitive-data protection or classification failed/);
  });
});
