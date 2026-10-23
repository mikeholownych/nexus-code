/**
 * Candidate Identity & Validation Binding Test Suite
 * Nexus Issue #12 — WP-04 (INC-05, DEC-02, CAND-001..004, EVID-002, VER-001..005)
 */

import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import {
  CandidateTracker,
  computeCandidateIdentitySync,
  hashContent,
  resolveFileCandidateDetails,
  ValidationReceipt,
  CandidateIdentity,
} from "../src/core/candidate.js";
import { WorktreeManager } from "../src/worktree.js";
import { ExecutionSpine } from "../src/core/spine.js";
import { createDefaultRegistry } from "../src/core/capabilities.js";
import { AuthorityAdmissionEngine } from "../src/core/authority.js";

describe("WP-04: Candidate Identity & Validation Binding (INC-05, DEC-02)", () => {
  const tmpRoot = path.join(os.tmpdir(), `nexus-candidate-test-${Date.now()}-${process.pid}`);
  const rootGit = path.join(tmpRoot, "root-repo");
  const nonGitWorkspace = path.join(tmpRoot, "non-git-workspace");

  // Helper to initialize a clean git repository
  function initGitRepo(repoPath: string): void {
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Nexus Test"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@nexus.local"], { cwd: repoPath, stdio: "ignore" });

    // Initial files
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repository\n");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "index.ts"), "export const value = 42;\n");
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "node_modules/\n*.log\n.nexus/\n");

    execFileSync("git", ["add", "-A"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoPath, stdio: "ignore" });
  }

  // Setup test environment
  initGitRepo(rootGit);
  fs.mkdirSync(nonGitWorkspace, { recursive: true });
  fs.writeFileSync(path.join(nonGitWorkspace, "file1.txt"), "hello from non-git\n");
  fs.writeFileSync(path.join(nonGitWorkspace, "file2.txt"), "second file\n");

  test("CAND-001 & Property A: Unchanged candidate produces stable deterministic identity", () => {
    const tracker = new CandidateTracker();
    const id1 = tracker.computeCandidateIdentitySync(rootGit);
    const id2 = tracker.computeCandidateIdentitySync(rootGit);

    assert.strictEqual(typeof id1.candidateId, "string");
    assert.strictEqual(id1.candidateId.length, 64);
    assert.strictEqual(id1.candidateId, id2.candidateId, "Candidate ID must be deterministic for identical state");
    assert.strictEqual(id1.manifestHash, id2.manifestHash, "Manifest hash must be identical");
    assert.strictEqual(id1.trackedChanges.length, 0);
    assert.strictEqual(id1.untrackedFiles.length, 0);
  });

  test("CAND-001 & Property B: Tracked candidate modification changes identity", () => {
    const tracker = new CandidateTracker();
    const baselineId = tracker.computeCandidateIdentitySync(rootGit).candidateId;

    const indexPath = path.join(rootGit, "src", "index.ts");
    const originalContent = fs.readFileSync(indexPath, "utf-8");

    try {
      fs.writeFileSync(indexPath, "export const value = 100;\n"); // Mutate tracked file
      const mutatedId = tracker.computeCandidateIdentitySync(rootGit);

      assert.notStrictEqual(mutatedId.candidateId, baselineId, "Mutating tracked file must change candidateId");
      assert.strictEqual(mutatedId.trackedChanges.length, 1);
      assert.strictEqual(mutatedId.trackedChanges[0].path, "src/index.ts");
      assert.strictEqual(mutatedId.trackedChanges[0].status, "modified");
      assert.strictEqual(mutatedId.trackedChanges[0].contentHash, hashContent("export const value = 100;\n"));
    } finally {
      fs.writeFileSync(indexPath, originalContent); // Restore
    }

    // Verify returning to exact original content restores identical baseline candidateId
    const restoredId = tracker.computeCandidateIdentitySync(rootGit).candidateId;
    assert.strictEqual(restoredId, baselineId, "Restoring original content must restore identical candidateId");
  });

  test("CAND-001 & Property C: Staged and unstaged working-tree states are captured", () => {
    const tracker = new CandidateTracker();
    const baselineId = tracker.computeCandidateIdentitySync(rootGit).candidateId;
    const readmePath = path.join(rootGit, "README.md");
    const originalReadme = fs.readFileSync(readmePath, "utf-8");

    try {
      // Unstaged modification
      fs.writeFileSync(readmePath, "# Test Repository - Unstaged Edit\n");
      const unstagedId = tracker.computeCandidateIdentitySync(rootGit);
      assert.notStrictEqual(unstagedId.candidateId, baselineId);
      assert.strictEqual(unstagedId.trackedChanges.length, 1);

      // Stage the modification
      execFileSync("git", ["add", "README.md"], { cwd: rootGit, stdio: "ignore" });
      const stagedId = tracker.computeCandidateIdentitySync(rootGit);

      // Staged and unstaged edits with identical file contents on disk evaluate to identical candidate content
      assert.strictEqual(stagedId.candidateId, unstagedId.candidateId, "Candidate identity reflects disk content regardless of index staging");
      assert.strictEqual(stagedId.trackedChanges[0].contentHash, hashContent("# Test Repository - Unstaged Edit\n"));
    } finally {
      execFileSync("git", ["checkout", "HEAD", "--", "README.md"], { cwd: rootGit, stdio: "ignore" });
      fs.writeFileSync(readmePath, originalReadme);
    }
  });

  test("CAND-001 & Property D: Untracked file inclusion and mutation changes candidateId", () => {
    const tracker = new CandidateTracker();
    const baselineId = tracker.computeCandidateIdentitySync(rootGit).candidateId;
    const newFilePath = path.join(rootGit, "src", "new_module.ts");

    try {
      // Create untracked file
      fs.writeFileSync(newFilePath, "export const helper = () => true;\n");
      const withUntrackedId = tracker.computeCandidateIdentitySync(rootGit);

      assert.notStrictEqual(withUntrackedId.candidateId, baselineId, "Adding untracked file must change candidateId");
      assert.strictEqual(withUntrackedId.untrackedFiles.length, 1);
      assert.strictEqual(withUntrackedId.untrackedFiles[0].path, "src/new_module.ts");
      assert.strictEqual(withUntrackedId.untrackedFiles[0].status, "untracked");

      // Mutate the untracked file
      fs.writeFileSync(newFilePath, "export const helper = () => false;\n");
      const mutatedUntrackedId = tracker.computeCandidateIdentitySync(rootGit);

      assert.notStrictEqual(mutatedUntrackedId.candidateId, withUntrackedId.candidateId, "Mutating untracked file must change candidateId");
    } finally {
      if (fs.existsSync(newFilePath)) {
        fs.unlinkSync(newFilePath);
      }
    }

    const cleanedId = tracker.computeCandidateIdentitySync(rootGit).candidateId;
    assert.strictEqual(cleanedId, baselineId, "Removing untracked file must restore baseline candidateId");
  });

  test("candidate identity hashes nested repository worktree files but excludes nested Git history", () => {
    const tracker = new CandidateTracker();
    const nestedRepo = path.join(rootGit, "nested-repo");
    const nestedFile = path.join(nestedRepo, "src", "candidate.ts");
    const externalTarget = path.join(tmpRoot, "external-target.txt");
    const nestedLink = path.join(nestedRepo, "external-link");
    const source = "export const candidate = 'one';\n";

    try {
      initGitRepo(nestedRepo);
      fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
      fs.writeFileSync(nestedFile, source);
      fs.writeFileSync(externalTarget, "external version one\n");
      fs.symlinkSync(path.relative(nestedRepo, externalTarget), nestedLink);
      execFileSync("git", ["add", "-A"], { cwd: nestedRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "nested candidate"], { cwd: nestedRepo, stdio: "ignore" });

      const initial = tracker.computeCandidateIdentitySync(rootGit);
      assert.ok(initial.untrackedFiles.some((entry) => entry.path === "nested-repo/src/candidate.ts"));
      assert.strictEqual(initial.untrackedFiles.find((entry) => entry.path === "nested-repo/external-link")?.mode, "120000");
      assert.ok(initial.untrackedFiles.every((entry) => !entry.path.startsWith("nested-repo/.git/")));

      fs.writeFileSync(externalTarget, "external version two\n");
      assert.strictEqual(
        tracker.computeCandidateIdentitySync(rootGit).candidateId,
        initial.candidateId,
        "Candidate identity hashes symlink text without reading its external target",
      );

      fs.writeFileSync(nestedFile, "export const candidate = 'two';\n");
      const changed = tracker.computeCandidateIdentitySync(rootGit);
      assert.notStrictEqual(changed.candidateId, initial.candidateId, "Nested worktree content must change candidate identity");

      fs.writeFileSync(nestedFile, source);
      execFileSync("git", ["commit", "--allow-empty", "-m", "history only"], { cwd: nestedRepo, stdio: "ignore" });
      const historyOnly = tracker.computeCandidateIdentitySync(rootGit);
      assert.strictEqual(historyOnly.candidateId, initial.candidateId, "Nested repository history metadata must not affect worktree identity");
    } finally {
      fs.rmSync(nestedRepo, { recursive: true, force: true });
      fs.rmSync(externalTarget, { force: true });
    }
  });

  test("candidate identity fails closed on special files inside an untracked directory", () => {
    if (process.platform === "win32") return;
    const specialDir = path.join(rootGit, "special-candidate-dir");
    try {
      initGitRepo(specialDir);
      execFileSync("mkfifo", [path.join(specialDir, "pipe")]);
      assert.throws(() => computeCandidateIdentitySync(rootGit), /Unsupported filesystem object type/);
    } finally {
      fs.rmSync(specialDir, { recursive: true, force: true });
    }
  });

  test("candidate directory traversal stops when its entry budget is exceeded", () => {
    const nestedRepo = path.join(rootGit, "limited-nested-repo");
    try {
      initGitRepo(nestedRepo);
      fs.mkdirSync(path.join(nestedRepo, "one", "two"), { recursive: true });
      fs.writeFileSync(path.join(nestedRepo, "one", "two", "file.txt"), "candidate\n");
      execFileSync("git", ["add", "-A"], { cwd: nestedRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "nested candidate"], { cwd: nestedRepo, stdio: "ignore" });

      assert.throws(
        () => computeCandidateIdentitySync(rootGit, { maxEntries: 2 }),
        /Candidate manifest exceeds 2 entry limit/,
      );
    } finally {
      fs.rmSync(nestedRepo, { recursive: true, force: true });
    }
  });

  test("candidate file replacement with a symlink during resolution fails closed", () => {
    const targetFile = path.join(rootGit, "candidate-race.txt");
    const outsideTarget = path.join(tmpRoot, "candidate-race-target.txt");
    fs.writeFileSync(targetFile, "original regular file\n");
    fs.writeFileSync(outsideTarget, "must not be read through a replacement symlink\n");

    const originalLstat = fs.lstatSync;
    let replaced = false;
    const raceFs = new Proxy(fs, {
      get(target, property) {
        if (property === "lstatSync") {
          return (...args: any[]) => {
            const result = originalLstat(...args);
            if (!replaced && path.resolve(String(args[0])) === targetFile) {
              replaced = true;
              fs.unlinkSync(targetFile);
              fs.symlinkSync(outsideTarget, targetFile);
            }
            return result;
          };
        }
        return Reflect.get(target, property, target);
      },
    }) as typeof fs;

    try {
      assert.throws(() => resolveFileCandidateDetails(targetFile, raceFs));
      assert.strictEqual(replaced, true, "Fixture must replace the path after lstat and before the open");
    } finally {
      fs.rmSync(targetFile, { force: true });
      fs.rmSync(outsideTarget, { force: true });
    }
  });

  test("Property E: Git-ignored build artifacts are excluded from candidate identity", () => {
    const tracker = new CandidateTracker();
    const baselineId = tracker.computeCandidateIdentitySync(rootGit).candidateId;

    // Create an ignored log file per .gitignore (*.log)
    const logPath = path.join(rootGit, "build.log");
    try {
      fs.writeFileSync(logPath, "Build output logs...\n");
      const withLogId = tracker.computeCandidateIdentitySync(rootGit);

      assert.strictEqual(withLogId.candidateId, baselineId, "Ignored files must NOT alter candidateId");
      assert.strictEqual(withLogId.untrackedFiles.length, 0, "Ignored files must not appear in untracked candidate files");
    } finally {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
    }
  });

  test("Property F: Non-Git workspace candidate identity calculation", () => {
    const tracker = new CandidateTracker();
    const id1 = tracker.computeCandidateIdentitySync(nonGitWorkspace);
    assert.strictEqual(id1.isGit, false);
    assert.strictEqual(id1.rootBaseSha, "NON_GIT_WORKSPACE");
    assert.strictEqual(id1.trackedChanges.length, 2);

    const f1Path = path.join(nonGitWorkspace, "file1.txt");
    const origF1 = fs.readFileSync(f1Path, "utf-8");

    try {
      fs.writeFileSync(f1Path, "mutated non-git content\n");
      const id2 = tracker.computeCandidateIdentitySync(nonGitWorkspace);
      assert.notStrictEqual(id2.candidateId, id1.candidateId, "Mutating file in non-git workspace must flip candidateId");
    } finally {
      fs.writeFileSync(f1Path, origF1);
    }
  });

  test("CAND-002 & Property H: Material validation dependency changes invalidate validation receipts", () => {
    const tracker = new CandidateTracker();
    const candidateIdentity = tracker.computeCandidateIdentitySync(rootGit);

    const configPath = path.join(tmpRoot, "test_config.json");
    fs.writeFileSync(configPath, JSON.stringify({ strict: true }));

    try {
      const depHash = hashContent(fs.readFileSync(configPath));
      const receipt = tracker.recordValidationReceipt({
        candidateId: candidateIdentity.candidateId,
        verifierCommand: "npm test",
        exitCode: 0,
        stdoutHash: hashContent("all tests passed"),
        status: "PASSED",
        materialDependencies: [
          { name: "test_config", path: configPath, versionOrHash: depHash },
        ],
      });

      // 1. Initial validation check: valid
      const initialCheck = tracker.isCandidateValidForMergeSync(rootGit, receipt);
      assert.strictEqual(initialCheck.valid, true);

      // 2. Mutate material validation dependency
      fs.writeFileSync(configPath, JSON.stringify({ strict: false })); // Changed config!
      const invalidCheck = tracker.isCandidateValidForMergeSync(rootGit, receipt);

      assert.strictEqual(invalidCheck.valid, false, "Dependency modification must invalidate receipt");
      assert.match(invalidCheck.reason!, /CAND-002: Material validation dependency 'test_config' has changed/);
    } finally {
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
    }
  });

  test("CAND-002 & Property I: Validate -> mutate -> merge attempt fails closed (refused)", () => {
    const worktreeManager = new WorktreeManager(rootGit);
    const wt = worktreeManager.createWorktree("test-mutate-task");
    const tracker = new CandidateTracker();

    try {
      // 1. Make a candidate change in worktree
      const testFile = path.join(wt.worktreePath, "src", "feature.ts");
      fs.writeFileSync(testFile, "export const feat = true;\n");

      // 2. Validate candidate and obtain receipt
      const candidateIdAtValidation = tracker.computeCandidateIdentitySync(wt.worktreePath).candidateId;
      const receipt = tracker.recordValidationReceipt({
        candidateId: candidateIdAtValidation,
        verifierCommand: "npm test",
        exitCode: 0,
        stdoutHash: hashContent("test passed"),
        status: "PASSED",
        materialDependencies: [],
      });

      assert.strictEqual(receipt.status, "PASSED");

      // 3. Post-validation mutation (e.g. agent edits feature.ts or an unvalidated file)
      fs.writeFileSync(testFile, "export const feat = false; // mutated post validation\n");

      // Attempt worktree merge with the old validation receipt
      const mergeResult = worktreeManager.mergeWorktree(wt.taskId, "apply feat", receipt, tracker);

      assert.strictEqual(mergeResult.success, false, "Merge MUST be refused when candidate mutated post-validation");
      assert.match(mergeResult.error!, /CAND-003: Candidate identity at merge .* does not match validated candidate/);

      // Verify worktree is retained on refusal (not discarded)
      assert.strictEqual(fs.existsSync(wt.worktreePath), true, "Worktree must be retained on merge refusal");
    } finally {
      worktreeManager.discardWorktree(wt.taskId);
    }
  });

  test("CAND-002 & Property J: Out-of-band mutation detection", () => {
    const tracker = new CandidateTracker();
    const baseline = tracker.computeCandidateIdentitySync(rootGit);

    const receipt = tracker.recordValidationReceipt({
      candidateId: baseline.candidateId,
      verifierCommand: "npm test",
      exitCode: 0,
      stdoutHash: hashContent("ok"),
      status: "PASSED",
      materialDependencies: [],
    });

    // Mutate file out-of-band directly on disk
    const targetFile = path.join(rootGit, "README.md");
    const orig = fs.readFileSync(targetFile, "utf-8");

    try {
      fs.writeFileSync(targetFile, orig + "\nout of band line\n");

      // Re-check validity: should compute fresh candidate from disk and detect mismatch
      const check = tracker.isCandidateValidForMergeSync(rootGit, receipt);
      assert.strictEqual(check.valid, false, "Out-of-band modification must be detected");
      assert.match(check.reason!, /CAND-003: Candidate identity at merge/);
    } finally {
      fs.writeFileSync(targetFile, orig);
    }
  });

  test("CAND-003 & Property O: Validation for candidate A cannot authorize candidate B", () => {
    const worktreeManager = new WorktreeManager(rootGit);
    const wtA = worktreeManager.createWorktree("task-cand-a");
    const wtB = worktreeManager.createWorktree("task-cand-b");
    const tracker = new CandidateTracker();

    try {
      // Worktree A edits
      fs.writeFileSync(path.join(wtA.worktreePath, "src", "fileA.ts"), "export const a = 1;\n");
      const idA = tracker.computeCandidateIdentitySync(wtA.worktreePath);
      const receiptA = tracker.recordValidationReceipt({
        candidateId: idA.candidateId,
        verifierCommand: "npm test",
        exitCode: 0,
        stdoutHash: hashContent("passed A"),
        status: "PASSED",
        materialDependencies: [],
      });

      // Worktree B edits
      fs.writeFileSync(path.join(wtB.worktreePath, "src", "fileB.ts"), "export const b = 2;\n");

      // Attempt to merge worktree B using receipt A
      const mergeB = worktreeManager.mergeWorktree(wtB.taskId, "merge B", receiptA, tracker);
      assert.strictEqual(mergeB.success, false, "Receipt for candidate A cannot authorize candidate B");
      assert.match(mergeB.error!, /CAND-003: Candidate identity at merge .* does not match validated candidate/);
    } finally {
      worktreeManager.discardWorktree(wtA.taskId);
      worktreeManager.discardWorktree(wtB.taskId);
    }
  });

  test("CAND-004: Merge is refused if root repository is dirty or has uncommitted changes", () => {
    const worktreeManager = new WorktreeManager(rootGit);
    const wt = worktreeManager.createWorktree("task-dirty-root");
    const tracker = new CandidateTracker();

    try {
      // Valid worktree change and receipt
      fs.writeFileSync(path.join(wt.worktreePath, "src", "clean_feat.ts"), "export const ok = true;\n");
      const candId = tracker.computeCandidateIdentitySync(wt.worktreePath).candidateId;
      const receipt = tracker.recordValidationReceipt({
        candidateId: candId,
        verifierCommand: "npm test",
        exitCode: 0,
        stdoutHash: hashContent("ok"),
        status: "PASSED",
        materialDependencies: [],
      });

      // Make root workspace dirty!
      const rootReadme = path.join(rootGit, "README.md");
      const origReadme = fs.readFileSync(rootReadme, "utf-8");
      fs.writeFileSync(rootReadme, origReadme + "\nUncommitted root change\n");

      try {
        const mergeRes = worktreeManager.mergeWorktree(wt.taskId, "merge clean feat", receipt, tracker);
        assert.strictEqual(mergeRes.success, false, "Merge must be refused when root is dirty (CAND-004)");
        assert.match(mergeRes.error!, /CAND-004: Target root workspace contains uncommitted modifications/);
      } finally {
        fs.writeFileSync(rootReadme, origReadme);
      }
    } finally {
      worktreeManager.discardWorktree(wt.taskId);
    }
  });

  test("Property K: Unchanged candidate with valid receipt permits worktree merge", () => {
    const worktreeManager = new WorktreeManager(rootGit);
    const wt = worktreeManager.createWorktree("task-valid-merge");
    const tracker = new CandidateTracker();

    try {
      // 1. Add feature in worktree
      fs.writeFileSync(path.join(wt.worktreePath, "src", "verified_feat.ts"), "export const verified = true;\n");

      // 2. Validate
      const candId = tracker.computeCandidateIdentitySync(wt.worktreePath).candidateId;
      const receipt = tracker.recordValidationReceipt({
        candidateId: candId,
        verifierCommand: "npm test",
        exitCode: 0,
        stdoutHash: hashContent("tests ok"),
        status: "PASSED",
        materialDependencies: [],
      });

      // 3. Merge without any mutation
      const mergeRes = worktreeManager.mergeWorktree(wt.taskId, "apply verified feat", receipt, tracker);
      assert.strictEqual(mergeRes.success, true, `Merge should succeed when candidate is unchanged: ${mergeRes.error}`);
      assert.strictEqual(mergeRes.commitsMerged, 1);

      // Verify file now exists in root git repo
      assert.strictEqual(fs.existsSync(path.join(rootGit, "src", "verified_feat.ts")), true);
    } finally {
      // Reset root repo commit back 1 commit to keep repo clean
      try {
        execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: rootGit, stdio: "ignore" });
      } catch {}
      worktreeManager.discardWorktree(wt.taskId);
    }
  });

  test("Property L & M: Malformed or missing candidate identity fails closed", () => {
    const tracker = new CandidateTracker();

    // Missing candidateId
    assert.throws(() => {
      tracker.recordValidationReceipt({
        candidateId: "",
        verifierCommand: "npm test",
        exitCode: 0,
        stdoutHash: "",
        status: "PASSED",
        materialDependencies: [],
      });
    }, /CAND-001: Validation receipt must carry a non-empty candidateId string/);

    // Inaccessible path fails closed
    assert.throws(() => {
      tracker.computeCandidateIdentitySync("/non/existent/path/for/candidate");
    }, /Workspace path does not exist/);
  });

  test("Property N: Deterministic reconstruction and path sorting", () => {
    const tracker = new CandidateTracker();
    const idA = tracker.computeCandidateIdentitySync(rootGit);

    // Reconstruct in a new tracker instance
    const tracker2 = new CandidateTracker();
    const idB = tracker2.computeCandidateIdentitySync(rootGit);

    assert.strictEqual(idA.candidateId, idB.candidateId, "Independent tracker instance must compute identical candidateId");
    assert.strictEqual(idA.manifestHash, idB.manifestHash);
  });

  test("Property P: Full-access mode does not bypass candidate validation binding", () => {
    const authorityEngine = new AuthorityAdmissionEngine({ fullAccess: true });
    assert.strictEqual(authorityEngine.isFullAccess(), true);

    const worktreeManager = new WorktreeManager(rootGit);
    const wt = worktreeManager.createWorktree("task-full-access");
    const tracker = new CandidateTracker();

    try {
      fs.writeFileSync(path.join(wt.worktreePath, "src", "full_access.ts"), "export const fa = true;\n");
      const candId = tracker.computeCandidateIdentitySync(wt.worktreePath).candidateId;

      // Stale receipt
      const receipt = tracker.recordValidationReceipt({
        candidateId: candId,
        verifierCommand: "npm test",
        exitCode: 0,
        stdoutHash: hashContent("ok"),
        status: "PASSED",
        materialDependencies: [],
      });

      // Mutate post-validation
      fs.writeFileSync(path.join(wt.worktreePath, "src", "full_access.ts"), "export const fa = false;\n");

      // Even in a fullAccess context, mergeWorktree enforces CAND-003 and rejects the stale receipt
      const mergeRes = worktreeManager.mergeWorktree(wt.taskId, "merge under fullAccess", receipt, tracker);
      assert.strictEqual(mergeRes.success, false, "Full access mode must NOT bypass candidate validation binding");
      assert.match(mergeRes.error!, /CAND-003: Candidate identity at merge/);
    } finally {
      worktreeManager.discardWorktree(wt.taskId);
    }
  });

  test("ExecutionSpine Integration: CandidateMutationHook invalidates receipts on spine tool mutation", async () => {
    const registry = createDefaultRegistry();
    const tracker = new CandidateTracker();

    registry.setHandler("write_file", async (args) => {
      return { success: true, output: "wrote file" };
    });

    const spine = new ExecutionSpine({
      registry,
      hooks: {
        candidateMutation: tracker.createMutationHook(),
      },
    });

    // 1. Record an active receipt
    const receipt = tracker.recordValidationReceipt({
      candidateId: "cand-test-12345",
      verifierCommand: "npm test",
      exitCode: 0,
      stdoutHash: hashContent("passed"),
      status: "PASSED",
      materialDependencies: [],
    });

    assert.strictEqual(receipt.status, "PASSED");
    assert.strictEqual(tracker.getActiveReceipt("cand-test-12345") !== null, true);

    // 2. Execute a mutating tool through ExecutionSpine
    const result = await spine.execute(
      {
        toolName: "write_file",
        args: { path: "src/index.ts", content: "new content" },
        actor: "agent",
        executionDomain: "agent_orchestration",
      },
      { workspaceRoot: rootGit }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.candidateMutated, true);

    // 3. Verify receipt status was transitioned to INVALIDATED by CandidateMutationHook
    assert.strictEqual(receipt.status, "INVALIDATED", "Spine mutation must invalidate active receipt");
    assert.match(receipt.invalidationReason!, /Candidate mutated post-validation by tool 'write_file'/);
    assert.strictEqual(tracker.getActiveReceipt("cand-test-12345"), null, "Active receipt is no longer returned");
  });

  test("F-WP04-MAT-01: Git typechange detection (regular file <-> symlink)", () => {
    const tracker = new CandidateTracker();
    const baselineId = tracker.computeCandidateIdentitySync(rootGit).candidateId;

    const targetFile = path.join(rootGit, "src", "index.ts");
    const origContent = fs.readFileSync(targetFile, "utf-8");

    try {
      // 1. Replace regular file with symlink
      fs.unlinkSync(targetFile);
      fs.symlinkSync("README.md", targetFile);

      const symlinkId = tracker.computeCandidateIdentitySync(rootGit);
      assert.notStrictEqual(symlinkId.candidateId, baselineId, "Replacing file with symlink must alter candidateId");
      assert.strictEqual(symlinkId.trackedChanges.length, 1);
      assert.strictEqual(symlinkId.trackedChanges[0].status, "typechange");
      assert.strictEqual(symlinkId.trackedChanges[0].mode, "120000");

      // 2. Replace symlink back with regular file having different content
      fs.unlinkSync(targetFile);
      fs.writeFileSync(targetFile, "export const newContent = 100;\n");

      const regularFileId = tracker.computeCandidateIdentitySync(rootGit);
      assert.notStrictEqual(regularFileId.candidateId, symlinkId.candidateId, "Replacing symlink with file must alter candidateId");
      assert.strictEqual(regularFileId.trackedChanges[0].mode, "100644");
    } finally {
      try {
        if (fs.existsSync(targetFile) || fs.lstatSync(targetFile).isSymbolicLink()) {
          fs.unlinkSync(targetFile);
        }
      } catch {}
      fs.writeFileSync(targetFile, origContent);
    }
  });

  test("F-WP04-MAT-02: Immediate mutation invalidation on new file creation post-validation", async () => {
    const tracker = new CandidateTracker();
    const id = tracker.computeCandidateIdentitySync(rootGit);

    const receipt = tracker.recordValidationReceipt({
      candidateId: id.candidateId,
      verifierCommand: "npm test",
      exitCode: 0,
      stdoutHash: hashContent("ok"),
      status: "PASSED",
      materialDependencies: [],
    });

    assert.strictEqual(receipt.status, "PASSED");
    assert.strictEqual(tracker.getActiveReceipt(id.candidateId) !== null, true);

    const hook = tracker.createMutationHook();
    await hook(
      {
        toolName: "write_file",
        mutatedPaths: ["src/brand_new_unseen_file.ts"],
        invocationId: "inv-new-file",
        durationMs: 5,
      },
      { workspaceRoot: rootGit }
    );

    assert.strictEqual(receipt.status, "INVALIDATED", "Creating a new file inside candidate workspace must invalidate receipt");
    assert.match(receipt.invalidationReason!, /Candidate mutated post-validation by tool 'write_file'/);
    assert.strictEqual(tracker.getActiveReceipt(id.candidateId), null, "Active receipt must be cleared");
  });

  test("F-WP04-MIN-01: Symlink target text change changes candidateId; symlink and regular file are structurally distinct", () => {
    const tracker = new CandidateTracker();
    const testSymlinkPath = path.join(rootGit, "src", "link_test.ts");

    try {
      // 1. Point to README.md
      fs.symlinkSync("../README.md", testSymlinkPath);
      const idA = tracker.computeCandidateIdentitySync(rootGit);

      // 2. Point to index.ts
      fs.unlinkSync(testSymlinkPath);
      fs.symlinkSync("index.ts", testSymlinkPath);
      const idB = tracker.computeCandidateIdentitySync(rootGit);

      assert.notStrictEqual(idA.candidateId, idB.candidateId, "Changing symlink target text must change candidateId");
      assert.strictEqual(idA.untrackedFiles[0].mode, "120000");
      assert.strictEqual(idB.untrackedFiles[0].mode, "120000");

      // 3. Regular file with exact same string as target text
      fs.unlinkSync(testSymlinkPath);
      fs.writeFileSync(testSymlinkPath, "index.ts");
      const idRegular = tracker.computeCandidateIdentitySync(rootGit);

      assert.notStrictEqual(idRegular.candidateId, idB.candidateId, "Regular file and symlink must have distinct structural identities");
      assert.strictEqual(idRegular.untrackedFiles[0].mode, "100644");
    } finally {
      try {
        if (fs.existsSync(testSymlinkPath) || fs.lstatSync(testSymlinkPath).isSymbolicLink()) {
          fs.unlinkSync(testSymlinkPath);
        }
      } catch {}
    }
  });

  test("F-WP04-MIN-02: Executable mode chmod +x and chmod -x change candidateId", () => {
    const tracker = new CandidateTracker();
    const scriptPath = path.join(rootGit, "src", "run_script.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho test\n", { mode: 0o644 });
    execFileSync("git", ["add", "src/run_script.sh"], { cwd: rootGit });
    execFileSync("git", ["commit", "-m", "add script"], { cwd: rootGit });

    try {
      // Modify content (mode 100644)
      fs.writeFileSync(scriptPath, "#!/bin/sh\necho modified\n", { mode: 0o644 });
      const idNonExec = tracker.computeCandidateIdentitySync(rootGit);
      assert.strictEqual(idNonExec.trackedChanges[0].mode, "100644");

      // chmod +x (mode 100755)
      fs.chmodSync(scriptPath, 0o755);
      const idExec = tracker.computeCandidateIdentitySync(rootGit);
      assert.strictEqual(idExec.trackedChanges[0].mode, "100755");
      assert.notStrictEqual(idNonExec.candidateId, idExec.candidateId, "chmod +x on modified file must change candidateId");

      // chmod -x (revert to 100644)
      fs.chmodSync(scriptPath, 0o644);
      const idReverted = tracker.computeCandidateIdentitySync(rootGit);
      assert.strictEqual(idReverted.candidateId, idNonExec.candidateId, "chmod -x must restore original candidateId");
    } finally {
      try {
        execFileSync("git", ["rm", "-f", "src/run_script.sh"], { cwd: rootGit, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "cleanup script"], { cwd: rootGit, stdio: "ignore" });
      } catch {}
    }
  });

  test("F-WP04-MIN-03: Non-Git workspace symlink detection and target mutation", () => {
    const tracker = new CandidateTracker();
    const symPath = path.join(nonGitWorkspace, "sym_link.txt");

    try {
      // 1. Create symlink in non-git workspace
      fs.symlinkSync("file1.txt", symPath);
      const id1 = tracker.computeCandidateIdentitySync(nonGitWorkspace);
      const symEntry = id1.trackedChanges.find((e) => e.path === "sym_link.txt");
      assert.ok(symEntry, "Non-git symlink must be included in manifest");
      assert.strictEqual(symEntry.mode, "120000");
      assert.strictEqual(symEntry.status, "typechange");

      // 2. Change symlink target text
      fs.unlinkSync(symPath);
      fs.symlinkSync("file2.txt", symPath);
      const id2 = tracker.computeCandidateIdentitySync(nonGitWorkspace);
      assert.notStrictEqual(id1.candidateId, id2.candidateId, "Changing non-git symlink target must alter candidateId");

      // 3. Replace symlink with regular file
      fs.unlinkSync(symPath);
      fs.writeFileSync(symPath, "file2.txt");
      const id3 = tracker.computeCandidateIdentitySync(nonGitWorkspace);
      assert.notStrictEqual(id2.candidateId, id3.candidateId, "Replacing symlink with regular file in non-git must alter candidateId");
    } finally {
      try { fs.unlinkSync(symPath); } catch {}
    }
  });

  test("Combined Adversarial Case: Modified file + typechange + validate + subsequent new file mutation", async () => {
    const worktreeManager = new WorktreeManager(rootGit);
    const wt = worktreeManager.createWorktree("task-combined-adv");
    const tracker = new CandidateTracker();

    try {
      // 1. Modified tracked file + structural typechange
      const wtFile = path.join(wt.worktreePath, "src", "index.ts");
      fs.writeFileSync(wtFile, "export const value = 999;\n");
      const symFile = path.join(wt.worktreePath, "README.md");
      fs.unlinkSync(symFile);
      fs.symlinkSync("src/index.ts", symFile);

      // 2. Validate and obtain receipt
      const candId = tracker.computeCandidateIdentitySync(wt.worktreePath).candidateId;
      const receipt = tracker.recordValidationReceipt({
        candidateId: candId,
        verifierCommand: "npm test",
        exitCode: 0,
        stdoutHash: hashContent("passed combined"),
        status: "PASSED",
        materialDependencies: [],
      });
      assert.strictEqual(receipt.status, "PASSED");

      // 3. Post-validation new file creation through mutation hook
      const hook = tracker.createMutationHook();
      await hook(
        {
          toolName: "write_file",
          mutatedPaths: ["src/injected_backdoor.ts"],
          invocationId: "inv-backdoor",
          durationMs: 12,
        },
        { workspaceRoot: wt.worktreePath }
      );

      // Receipt must be immediately invalidated
      assert.strictEqual(receipt.status, "INVALIDATED");
      assert.strictEqual(tracker.getActiveReceipt(candId), null);

      // 4. Merge attempt must be refused (fails closed)
      const mergeRes = worktreeManager.mergeWorktree(wt.taskId, "merge combined", receipt, tracker);
      assert.strictEqual(mergeRes.success, false, "Merge must be refused after post-validation mutation");
      assert.match(mergeRes.error!, /CAND-003: Validation receipt status is INVALIDATED/);
    } finally {
      worktreeManager.discardWorktree(wt.taskId);
    }
  });
});
