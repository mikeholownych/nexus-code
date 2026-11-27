import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeKnowledgeSuggestionCommand } from "../src/knowledge_command.js";
import type { HarnessConfig } from "../src/types.js";
import { newOperation } from "../src/core/operation.js";
import { knowledgeOperationExcerpts, resolveKnowledgeOperationEvidence } from "../src/knowledge_operation_evidence.js";

test("completed operations provide scoped provenance and classify only captured checks as verified evidence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-knowledge-operation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldState = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = root;
  t.after(() => {
    if (oldState === undefined) delete process.env.NEXUS_STATE_DIR;
    else process.env.NEXUS_STATE_DIR = oldState;
  });
  const workspace = path.join(root, "checkout");
  const integrationWorktree = path.join(root, "integration");
  fs.mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init");
  git("-c", "user.name=Nexus Fixture", "-c", "user.email=nexus@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  git("worktree", "add", "--detach", integrationWorktree);

  const now = new Date().toISOString();
  const check = { command: "npm test", owners: ["operator"], status: "PASSED" };
  const run = { command: "npm test", startedAt: now, completedAt: now, timeoutMs: 1000, exitCode: 0, outputSha256: "a".repeat(64), outputTruncated: false };
  const op = newOperation("operation-1", "Implement a fixture", [{ id: "test", title: "Test", prompt: "Test the fixture" }], [], 0);
  const unit = op.units[0];
  unit.status = "COMPLETE";
  unit.result = { summary: "The candidate is complete and all tests pass.", completedAt: now, resourceId: "fixture", outcome: "VERIFIED" };
  op.status = "COMPLETE";
  op.git = { isolate: true, repoRoot: workspace, baseRef: "HEAD", baseCommit: commit, integrationBranch: "fixture", integrationWorktree, baseDir: root, units: {}, integrationVerifiers: ["npm test"] };
  op.integrations = [{ unitId: "test", branch: "fixture", commit, integratedCommit: commit, mergedAt: now, files: [], outcome: "VERIFIED", summary: "passed", verification: "PASSED", mergedChecks: [check as any], verificationBinding: { commit, worktree: integrationWorktree, runs: [run] } }];
  const dir = path.join(root, "tasks");
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, "operation-1.json");
  const persist = () => fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, taskId: op.id, workspace, workspacePath: workspace, status: "completed", operation: op,
  }), { mode: 0o600 });
  persist();

  const results = knowledgeOperationExcerpts(workspace, op.id);
  assert.ok(results.some((row) => row.evidence.source === "tool" && row.ref === "operation/operation-1"));
  assert.ok(results.some((row) => row.evidence.source === "model" && row.content.includes("all tests pass")));
  const proof = results.find((row) => row.evidence.source === "verified_evidence");
  assert.ok(proof);
  assert.deepEqual(resolveKnowledgeOperationEvidence(workspace, proof.ref), proof.evidence);
  assert.equal(resolveKnowledgeOperationEvidence(integrationWorktree, proof.ref), undefined);
  const suggestion = await executeKnowledgeSuggestionCommand(`suggest operation:${op.id}`, {
    workspace, endpoint: "http://127.0.0.1:1234/v1",
  } as HarnessConfig, {
    workspaceTrusted: true,
    generate: async (_contract, input) => {
      assert.match(input, /verified_evidence/);
      assert.match(input, /unitId/);
      return { key: "test", value: "Use npm test for integration.", category: "rule", sourceRefs: [proof.ref] };
    },
  });
  assert.equal(suggestion?.success, true);

  fs.writeFileSync(path.join(integrationWorktree, "new-content"), "candidate changed");
  assert.equal(resolveKnowledgeOperationEvidence(workspace, proof.ref), undefined);
  fs.unlinkSync(path.join(integrationWorktree, "new-content"));
  run.outputTruncated = true;
  persist();
  assert.equal(resolveKnowledgeOperationEvidence(workspace, proof.ref), undefined);
  op.status = "PAUSED";
  persist();
  assert.throws(() => knowledgeOperationExcerpts(workspace, op.id), /terminal operation/);
});

test("saved turn evidence requires its exact live candidate and execution proof", async (t) => {
  const { computeCandidateIdentitySync } = await import("../src/core/candidate.js");
  const { knowledgeSessionExcerpts, resolveKnowledgeSessionEvidence } = await import("../src/knowledge_session_evidence.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-knowledge-verified-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldState = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = root;
  t.after(() => {
    if (oldState === undefined) delete process.env.NEXUS_STATE_DIR;
    else process.env.NEXUS_STATE_DIR = oldState;
  });
  const workspace = path.join(root, "checkout");
  fs.mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
  git("init");
  git("-c", "user.name=Nexus Fixture", "-c", "user.email=nexus@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const candidateId = computeCandidateIdentitySync(workspace).candidateId;
  const sessionId = "session_20261127_080000_fixture";
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, `${sessionId}.json`);
  const verification = {
    status: "PASSED", source: "configured", command: "npm test", hasExecutedTests: true, isDeliverableBound: true,
    exitSuccess: true, outputSha256: "a".repeat(64), candidateId, at: new Date().toISOString(),
  };
  const persist = () => fs.writeFileSync(file, JSON.stringify({
    workspace, workspacePath: workspace, status: "completed", sessionId, messages: [{ role: "assistant", content: "Tests pass." }],
    lastTurn: { execution: "COMPLETED", outcome: "VERIFIED", verification },
  }), { mode: 0o600 });
  persist();
  const proof = knowledgeSessionExcerpts(workspace, sessionId).find((row) => row.evidence.source === "verified_evidence");
  assert.ok(proof);
  assert.deepEqual(resolveKnowledgeSessionEvidence(workspace, proof.ref), proof.evidence);
  verification.hasExecutedTests = false;
  persist();
  assert.equal(resolveKnowledgeSessionEvidence(workspace, proof.ref), undefined);
  verification.hasExecutedTests = true;
  persist();
  fs.writeFileSync(path.join(workspace, "new-content"), "candidate changed");
  assert.equal(resolveKnowledgeSessionEvidence(workspace, proof.ref), undefined);
});
