import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { KnowledgeGraph } from "../src/knowledge.js";
import { KnowledgeSuggestions, type KnowledgeEvidence } from "../src/knowledge_suggestions.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-knowledge-suggestion-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "checkout");
  fs.mkdirSync(worktree);
  const git = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { stdio: "ignore" });
  git("init");
  fs.writeFileSync(path.join(worktree, "package.json"), "{}");
  git("add", "package.json");
  git("-c", "user.name=Nexus Fixture", "-c", "user.email=nexus@example.invalid", "commit", "-m", "fixture");
  let evidence: KnowledgeEvidence | undefined = { source: "tool", revision: "a".repeat(64) };
  let now = Date.parse("2026-11-27T08:00:00.000Z");
  const options = {
    stateDir: path.join(root, "state"),
    resolveEvidence: (ref: string) => ref === "session:fixture" ? evidence : undefined,
    now: () => now,
  };
  const open = () => new KnowledgeSuggestions(worktree, options);
  const proposal = { key: "package-manager", value: "Use npm", category: "rule" as const, sourceRefs: ["session:fixture"], paths: ["package.json"] };
  return { root, worktree, git, options, open, proposal, setEvidence(value: KnowledgeEvidence | undefined) { evidence = value; }, advance(days: number) { now += days * 86_400_000; } };
}

test("suggestion review and rejection survive reopen and suppress duplicate evidence", (t) => {
  const { worktree, open, proposal, setEvidence } = fixture(t);
  const candidate = open().propose(proposal);
  assert.equal(candidate.state, "candidate");
  assert.equal(candidate.freshness, "current");
  assert.equal(candidate.validationStatus, "model_suggestion_unverified");
  assert.equal(new KnowledgeGraph(worktree, { trusted: true }).exportPromptSection(), "");
  assert.equal(open().review(candidate.id, "operator").state, "reviewed");
  assert.equal(open().reject(candidate.id, "operator").state, "rejected");
  assert.equal(open().propose(proposal).state, "rejected");
  setEvidence({ source: "tool", revision: "b".repeat(64) });
  assert.notEqual(open().propose(proposal).id, candidate.id);
});

test("unknown evidence and changed inputs block review", (t) => {
  const { worktree, open, proposal, setEvidence } = fixture(t);
  const candidate = open().propose(proposal);
  setEvidence(undefined);
  assert.equal(open().list()[0].freshness, "unknown");
  assert.throws(() => open().review(candidate.id, "operator"), /fresh evidence/);
  setEvidence({ source: "tool", revision: "a".repeat(64) });
  fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"changed"}');
  assert.equal(open().list()[0].freshness, "stale");
  assert.throws(() => open().review(candidate.id, "operator"), /fresh evidence/);
});

test("rejection, expiry and deletion preserve deduplication for the same evidence", (t) => {
  const { open, proposal, advance } = fixture(t);
  const candidate = open().propose(proposal);
  advance(31);
  assert.equal(open().list()[0].state, "expired");
  assert.equal(open().propose(proposal).state, "expired");
  assert.equal(open().delete(candidate.id, "operator").state, "deleted");
  assert.equal(open().propose(proposal).state, "deleted");
  assert.equal(open().list()[0].proposal, undefined);
});

test("proposal admission refuses missing references, invalid scope and sensitive content", (t) => {
  const { open, proposal, options, worktree } = fixture(t);
  assert.throws(() => open().propose({ ...proposal, sourceRefs: ["session:unavailable"] }), /provenance/);
  assert.throws(() => open().propose({ ...proposal, paths: ["../outside"] }), /path scope/);
  assert.throws(() => open().propose({ ...proposal, value: "api_key=sk-1234567890ABCDEFGHIJKLMNOPQRST" }), /Sensitive content/);
  assert.throws(() => new KnowledgeSuggestions(worktree, { ...options, readOnly: true }).propose(proposal), /Read-only/);
  assert.equal(open().list().length, 0);
});

test("another checkout does not inherit suggestion records", (t) => {
  const { root, git, open, proposal, options } = fixture(t);
  open().propose(proposal);
  const sibling = path.join(root, "sibling");
  git("worktree", "add", "--detach", sibling);
  assert.deepEqual(new KnowledgeSuggestions(sibling, options).list(), []);
});

test("operator promotion publishes only reviewed, fresh proposals as unverified knowledge", (t) => {
  const { worktree, open, proposal, options } = fixture(t);
  const candidate = open().propose(proposal);
  const graph = () => new KnowledgeGraph(worktree, { trusted: true, suggestions: open() });
  assert.throws(() => open().promote(candidate.id, "operator"), /Cannot transition/);
  open().review(candidate.id, "operator");
  assert.equal(graph().get(proposal.key), undefined);
  assert.equal(open().promote(candidate.id, "operator").state, "promoted");
  assert.deepEqual(graph().get(proposal.key)?.provenance.sourceRefs, ["session:fixture"]);
  assert.equal(graph().get(proposal.key)?.validationStatus, "operator_reviewed_unverified");
  assert.match(graph().exportPromptSection(), /freshness: current/);
  fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"changed"}');
  assert.equal(graph().get(proposal.key), undefined);
  assert.equal(graph().exportPromptSection(), "");
  assert.equal(new KnowledgeSuggestions(worktree, { ...options, readOnly: true }).list()[0].freshness, "stale");
  assert.equal(open().delete(candidate.id, "operator").state, "deleted");
});

test("terminal session source references resolve only in the saved workspace", async (t) => {
  const { worktree, root } = fixture(t);
  const { knowledgeSessionExcerpts, resolveKnowledgeSessionEvidence } = await import("../src/knowledge_session_evidence.js");
  const stateDir = path.join(root, "nexus-state");
  const originalStateDir = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = stateDir;
  t.after(() => {
    if (originalStateDir === undefined) delete process.env.NEXUS_STATE_DIR;
    else process.env.NEXUS_STATE_DIR = originalStateDir;
  });
  const sessionId = "session_20261127_080000_fixture";
  const sessions = path.join(stateDir, "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const file = path.join(sessions, `${sessionId}.json`);
  const session = {
    sessionId, workspace: worktree, workspacePath: worktree, status: "completed",
    messages: [
      { role: "user", content: "Use npm for this repository." },
      { role: "assistant", content: "npm was used." },
      { role: "assistant", content: "api_key=sk-1234567890ABCDEFGHIJKLMNOPQRST" },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(session), { mode: 0o600 });
  const excerpts = knowledgeSessionExcerpts(worktree, sessionId);
  assert.equal(excerpts.length, 2);
  assert.equal(excerpts[0].evidence.source, "operator");
  assert.equal(excerpts[1].evidence.source, "model");
  assert.deepEqual(resolveKnowledgeSessionEvidence(worktree, excerpts[1].ref), excerpts[1].evidence);
  assert.equal(resolveKnowledgeSessionEvidence(root, excerpts[1].ref), undefined);
  assert.throws(() => knowledgeSessionExcerpts(worktree, "../anything"), /terminal session/);
  fs.writeFileSync(file, JSON.stringify({ ...session, status: "in_progress" }));
  assert.equal(resolveKnowledgeSessionEvidence(worktree, excerpts[1].ref), undefined);
});
