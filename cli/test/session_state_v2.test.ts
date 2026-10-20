import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/session.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { acquireFileGuard, releaseFileGuard } from "../src/core/file_guard.js";
import { StateStoreBusyError } from "../src/core/state_store_guard.js";

function fixture(run: (manager: SessionManager, workspace: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-session-v2-"));
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const manager = new SessionManager(path.join(root, "sessions"), () => WorkspacePath.fromSelectedWorkspace(workspace));
  try { run(manager, workspace); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("session listing rebuilds and refreshes message counts from schema-two cursors", () => fixture((manager, workspace) => {
  const messages = [{ role: "user" as const, content: "question" }, { role: "assistant" as const, content: "answer" }];
  manager.saveSession({ id: "session-two", workspace, messages });
  assert.equal(manager.listSessions()[0].messageCount, 2);
  fs.unlinkSync(manager.getIndexPath());
  assert.equal(manager.rebuildIndex().sessions["session-two"].messageCount, 2);
  manager.getStateManager().recordProgress("session-two", { messages: [...messages, { role: "user", content: "follow-up" }] });
  assert.equal(manager.listSessions()[0].messageCount, 3);
  const raw = JSON.parse(fs.readFileSync(manager.getStateManager().getStateFilePath("session-two"), "utf8"));
  assert.equal(Object.hasOwn(raw, "messages"), false); assert.equal(raw.messageLog.count, 3);
}));

test("session index uses protected committed metadata rather than a caller's unredacted title", () => fixture((manager, workspace) => {
  const synthetic = `sk-${"B".repeat(28)}`;
  manager.saveSession({ id: "session-two", workspace, title: `review ${synthetic}`, messages: [{ role: "user", content: "ordinary request" }] });
  assert.equal(fs.readFileSync(manager.getIndexPath(), "utf8").includes(synthetic), false);
  assert.match(manager.listSessions()[0].title, /REDACTED/);
  manager.rebuildIndex();
  assert.equal(fs.readFileSync(manager.getIndexPath(), "utf8").includes(synthetic), false);
}));

test("session archive publication fails closed while another process owns the store guard", () => fixture((manager) => {
  const guard = acquireFileGuard(path.join(manager.getSessionsDir(), ".nexus-state.guard")); assert.ok(guard);
  try {
    assert.throws(() => manager.appendArchivedHistory("session-two", [{ role: "user", content: "archive revision" }], "compaction-two"), StateStoreBusyError);
    assert.equal(fs.existsSync(manager.archivedHistoryPath("session-two")), false);
  } finally { releaseFileGuard(guard); }
  manager.appendArchivedHistory("session-two", [{ role: "user", content: "archive revision" }], "compaction-two");
  assert.equal(manager.readArchivedHistory("session-two").messages.length, 1);
}));
