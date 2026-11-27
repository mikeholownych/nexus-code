import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCompactionRecord } from "../src/core/compaction_record.js";
import { executeKnowledgeSuggestionCommand } from "../src/knowledge_command.js";
import { knowledgeSessionExcerpts, resolveKnowledgeSessionEvidence } from "../src/knowledge_session_evidence.js";
import { SessionManager } from "../src/session.js";
import type { ChatMessage, HarnessConfig } from "../src/types.js";

test("knowledge sources include only audited originals of committed session compactions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-knowledge-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prior = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.NEXUS_STATE_DIR;
    else process.env.NEXUS_STATE_DIR = prior;
  });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const manager = new SessionManager();
  const sessionId = "session_20261127_080000_fixture";
  const committedId = "c1-aaaaaaaa";
  const uncommittedId = "c2-bbbbbbbb";
  const covered: ChatMessage[] = [
    { role: "user", content: "Use the repository's make check target." },
    { role: "assistant", content: "Tests pass according to my summary." },
  ];
  const record = buildCompactionRecord({ trigger: "fixture", covered, inserted: [], insertedAt: 1, beforeTokens: 50, afterTokens: 10 });
  manager.appendArchivedHistory(sessionId, covered, committedId, record);
  manager.appendArchivedHistory(sessionId, [{ role: "user", content: "Uncommitted archive text." }], uncommittedId, record);
  fs.writeFileSync(path.join(root, "sessions", `${sessionId}.json`), JSON.stringify({
    workspace, workspacePath: workspace, status: "completed", sessionId,
    messages: [{ role: "system", content: "Compacted session." }],
    history: { committedCompactions: [committedId], compactions: 1, archivedMessages: covered.length, complete: false },
  }), { mode: 0o600 });

  const excerpts = knowledgeSessionExcerpts(workspace, sessionId);
  assert.deepEqual(excerpts.map(({ content, evidence }) => [content, evidence.source]), [
    [covered[0].content, "operator"], [covered[1].content, "model"],
  ]);
  const source = excerpts[0];
  assert.equal(source.ref, `${sessionId}:archive:${committedId}:0`);
  assert.deepEqual(resolveKnowledgeSessionEvidence(workspace, source.ref), source.evidence);
  assert.equal(resolveKnowledgeSessionEvidence(workspace, `${sessionId}:archive:${uncommittedId}:0`), undefined);
  assert.equal(resolveKnowledgeSessionEvidence(root, source.ref), undefined);

  const shown = await executeKnowledgeSuggestionCommand(`show-source ${source.ref}`, { workspace, readOnly: true } as HarnessConfig);
  assert.equal(shown?.success, true);
  assert.deepEqual(JSON.parse(shown!.output), source);

  const archivePath = manager.archivedHistoryPath(sessionId);
  const original = fs.readFileSync(archivePath, "utf8");
  fs.writeFileSync(archivePath, original.replace("make check target", "forged test target"));
  assert.equal(resolveKnowledgeSessionEvidence(workspace, source.ref), undefined);
  assert.equal(knowledgeSessionExcerpts(workspace, sessionId).length, 0);

  fs.unlinkSync(archivePath);
  const external = path.join(root, "archive-outside-store");
  fs.writeFileSync(external, original, { mode: 0o600 });
  fs.symlinkSync(external, archivePath);
  assert.equal(resolveKnowledgeSessionEvidence(workspace, source.ref), undefined);
});
