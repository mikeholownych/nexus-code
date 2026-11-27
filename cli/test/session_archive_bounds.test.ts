import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session.js";
import type { ChatMessage } from "../src/types.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(maxArchivedHistoryBytes: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-session-archive-bound-"));
  roots.push(root);
  return { root, sessions: new SessionManager(path.join(root, "sessions"), undefined, { maxArchivedHistoryBytes }) };
}

const message = (content: string): ChatMessage => ({ role: "user", content });

test("session archive capacity is shared across sessions and refused append preserves all existing bytes", () => {
  const { sessions } = fixture(512);
  const first = sessions.archivedHistoryPath("first");
  const second = sessions.archivedHistoryPath("second");

  sessions.appendArchivedHistory("first", [message("small first history")], "c1-aaaa");
  sessions.appendArchivedHistory("second", [message("small second history")], "c1-bbbb");
  const firstBefore = fs.readFileSync(first);
  const secondBefore = fs.readFileSync(second);

  assert.throws(
    () => sessions.appendArchivedHistory("second", [message("x".repeat(512))], "c2-cccc"),
    /Session history archive limit \(512 bytes\) would be exceeded.*no archive data was written/,
  );
  assert.deepEqual(fs.readFileSync(first), firstBefore, "the other session's archive is unchanged");
  assert.deepEqual(fs.readFileSync(second), secondBefore, "the target archive is unchanged");
  assert.deepEqual(sessions.readArchivedHistory("second").messages, [message("small second history")]);
});

test("fork refuses to duplicate recovery history over the aggregate cap before creating fork state", () => {
  const { sessions } = fixture(512);
  const sourceId = "source";
  const forkId = "forked";
  const archived = [message("x".repeat(256))];
  sessions.appendArchivedHistory(sourceId, archived, "c1-aaaa");
  sessions.saveSession({
    id: sourceId,
    title: "Source",
    workspace: "/workspace",
    model: "test-model",
    messages: [{ role: "system", content: "summary" }, { role: "user", content: "current" }],
    history: { complete: false, compactions: 1, archivedMessages: 1, committedCompactions: ["c1-aaaa"] },
  } as any);
  const sourceArchive = fs.readFileSync(sessions.archivedHistoryPath(sourceId));

  assert.throws(
    () => sessions.forkSession(sourceId, { newId: forkId }),
    /Session history archive limit \(512 bytes\) would be exceeded.*no archive data was written/,
  );
  assert.deepEqual(fs.readFileSync(sessions.archivedHistoryPath(sourceId)), sourceArchive);
  assert.equal(fs.existsSync(sessions.archivedHistoryPath(forkId)), false, "no partial fork archive remains");
  assert.equal(sessions.loadSession(forkId), null, "no fork session was saved");
});

test("archive limit cannot be configured above the existing retained-state ceiling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-session-archive-invalid-limit-"));
  roots.push(root);
  assert.throws(
    () => new SessionManager(path.join(root, "sessions"), undefined, { maxArchivedHistoryBytes: Number.MAX_SAFE_INTEGER }),
    /Session archive byte limit must be an integer from 0 to 2147483648/,
  );
});

test("empty archive append remains a no-op when the aggregate limit is already full", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-session-archive-empty-"));
  roots.push(root);
  const sessionsDir = path.join(root, "sessions");
  const archive = path.join(sessionsDir, "full.history.jsonl");
  const content = `${JSON.stringify({ archivedAt: "2026-01-01T00:00:00.000Z", message: message("x".repeat(128)) })}\n`;
  // Seed directly so the test can represent an archive exactly at the configured ceiling.
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, content);
  const sessions = new SessionManager(sessionsDir, undefined, { maxArchivedHistoryBytes: Buffer.byteLength(content) });
  const before = fs.readFileSync(archive);

  sessions.appendArchivedHistory("full", [], "c2-empty");
  assert.deepEqual(fs.readFileSync(archive), before);
});
