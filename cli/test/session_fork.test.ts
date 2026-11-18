/**
 * RD-6: fork a saved session into a new id with its history up to a chosen point. Both continuations stay resumable,
 * the compaction records and archive lines the fork keeps still verify on resume (auditCompactionsOnResume), and the
 * source session is never modified.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/session.js";
import type { ChatMessage } from "../src/types.js";
import { buildCompactionRecord } from "../src/core/compaction_record.js";
import { protectArchivedMessages } from "../src/core/persistence_protection.js";
import { auditCompactionsOnResume } from "../src/core/agent_support.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { routeSlash } from "../src/slash/router.js";
import { findSlash, type SlashHost, type SlashReply } from "../src/slash/catalog.js";

let dir = "";
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fork-")); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const mk = (name: string) => new SessionManager(path.join(dir, name), () => WorkspacePath.fromSelectedWorkspace(dir));
const m = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, ...extra } as ChatMessage);
const call = (id: string): ChatMessage => m("assistant", "", { tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] } as any);
const SUMMARY = (n: number) => m("system", `[Structured Context Memory c${n}] summary ${n}`);

/** A conversation compacted twice: c1's summary sits at index 1, c2's at index 5. */
function seed(sessions: SessionManager, id: string) {
  const original1 = protectArchivedMessages([m("user", "q1"), call("t1"), m("tool", "result one", { tool_call_id: "t1", name: "read_file" })]);
  const original2 = protectArchivedMessages([m("user", "q2"), m("assistant", "a2")]);
  const messages = [m("system", "sys"), SUMMARY(1), m("user", "q3"), call("t3"), m("tool", "result three", { tool_call_id: "t3", name: "read_file" }), SUMMARY(2), m("user", "q4"), m("assistant", "a4")];
  const r1 = buildCompactionRecord({ trigger: "auto", covered: original1, inserted: [messages[1]], insertedAt: 1, beforeTokens: 9, afterTokens: 3 });
  const r2 = buildCompactionRecord({ trigger: "auto", covered: original2, inserted: [messages[5]], insertedAt: 5, beforeTokens: 9, afterTokens: 3 });
  sessions.appendArchivedHistory(id, original1, "c1-aaaa", r1);
  sessions.appendArchivedHistory(id, original2, "c2-bbbb", r2);
  sessions.saveSession({ id, title: "Original work", workspace: dir, model: "m", messages, history: { complete: false, compactions: 2, archivedMessages: 5, committedCompactions: ["c1-aaaa", "c2-bbbb"] } as any, findings: ["F1 a finding"] } as any);
  return { messages };
}

const digest = (file: string) => (fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "absent");
const files = (s: SessionManager, id: string) => [path.join(s.getSessionsDir(), `${id}.json`), path.join(s.getSessionsDir(), `${id}.messages.jsonl`), s.archivedHistoryPath(id)];

/** What resume does with a saved session: the archive audit. */
function audit(s: SessionManager, id: string) {
  const saved = s.loadSession(id)!;
  const committed: string[] = (saved.history as any).committedCompactions;
  const read = s.readArchivedHistory(id, new Set(committed));
  return { saved, read, result: auditCompactionsOnResume(saved.messages, read, committed) };
}

describe("SessionManager.forkSession", () => {
  test("two divergent continuations are both resumable, each with a verifying archive", () => {
    const s = mk("a");
    const source = s.generateSessionId();
    const { messages } = seed(s, source);
    const fork = s.forkSession(source);
    assert.notEqual(fork.id, source);
    assert.equal(fork.atMessage, messages.length);
    assert.deepEqual(s.loadSession(fork.id)!.messages, messages, "the fork starts with the source's whole history");
    // Continue each one differently, the way a running session saves.
    const a = s.loadSession(source)!;
    s.saveSession({ ...a, messages: [...a.messages, m("user", "continue with A")] });
    const b = s.loadSession(fork.id)!;
    s.saveSession({ ...b, messages: [...b.messages, m("user", "continue with B"), m("assistant", "B answers")] });
    const [loadedA, loadedB] = [s.loadSession(source)!, s.loadSession(fork.id)!];
    assert.equal(loadedA.messages.at(-1)!.content, "continue with A");
    assert.equal(loadedB.messages.at(-1)!.content, "B answers");
    assert.deepEqual(loadedA.messages.slice(0, messages.length), loadedB.messages.slice(0, messages.length), "they share the history before the fork");
    for (const id of [source, fork.id]) {
      const { result } = audit(s, id);
      assert.deepEqual(result.notes, [], `${id} resumes without a notice`);
      assert.equal(result.fullTranscript, undefined);
      assert.equal(result.trustedArchive.length, 5, `${id} still serves its archived originals`);
    }
    assert.deepEqual(s.readArchivedHistory(fork.id).messages, s.readArchivedHistory(source).messages, "the archive was copied");
    assert.equal(loadedB.title, "Fork of Original work");
    assert.deepEqual((loadedB as any).forkedFrom?.sessionId, source);
    assert.equal(s.listSessions().filter((x) => x.id === fork.id).length, 1, "the fork is listed");
  });

  test("the source session is never modified, by the fork or by what the fork does afterwards", () => {
    const s = mk("b");
    const source = s.generateSessionId();
    seed(s, source);
    const before = files(s, source).map(digest);
    const fork = s.forkSession(source, { atMessage: 3 });
    const b = s.loadSession(fork.id)!;
    s.saveSession({ ...b, messages: [...b.messages, m("user", "only in the fork")] });
    assert.deepEqual(files(s, source).map(digest), before);
    assert.ok(!before.includes("absent"));
  });

  test("forking before a compaction's summary leaves that compaction out and the fork still audits clean", () => {
    const s = mk("c");
    const source = s.generateSessionId();
    seed(s, source);
    const fork = s.forkSession(source, { atMessage: 3 });
    const { saved, read, result } = audit(s, fork.id);
    assert.equal(saved.messages.length, 3);
    assert.deepEqual((saved.history as any).committedCompactions, ["c1-aaaa"]);
    assert.equal((saved.history as any).compactions, 1);
    assert.equal(read.messages.length, 3, "only the kept compaction's originals were copied");
    assert.equal(s.readArchivedHistory(fork.id).messages.length, 3, "and no line of the dropped compaction is in the fork's archive file at all");
    assert.deepEqual(result.notes, []);
    assert.equal(result.fullTranscript, undefined, "resume does not undo a compaction the fork kept");
    assert.equal(s.readArchivedHistory(source).messages.length, 5, "the source archive keeps both");
  });

  test("a cut inside a tool exchange backs up to the last complete point", () => {
    const s = mk("d");
    const source = s.generateSessionId();
    seed(s, source);
    // Messages 0..3 end on the assistant call t3 whose result is message 4.
    const fork = s.forkSession(source, { atMessage: 4 });
    assert.equal(fork.atMessage, 3);
    assert.equal(s.loadSession(fork.id)!.messages.length, 3);
    assert.equal(s.forkSession(source, { atMessage: 5 }).atMessage, 5, "with its result included the exchange is complete");
  });

  test("refuses an unknown source, an out-of-range point, an unsafe or existing id; nothing is created", () => {
    const s = mk("e");
    const source = s.generateSessionId();
    seed(s, source);
    const listed = () => fs.readdirSync(s.getSessionsDir()).sort();
    const before = listed();
    assert.throws(() => s.forkSession("session_nope"), /not found/i);
    assert.throws(() => s.forkSession(source, { atMessage: 0 }), /between 1 and 8/);
    assert.throws(() => s.forkSession(source, { atMessage: 9 }), /between 1 and 8/);
    assert.throws(() => s.forkSession(source, { atMessage: 2.5 }), /between 1 and 8/);
    assert.throws(() => s.forkSession(source, { newId: "../evil" }), /safe/i);
    assert.throws(() => s.forkSession(source, { newId: source }), /already exists/);
    assert.deepEqual(listed(), before);
  });
});

describe("/fork", () => {
  test("is in the catalogue and has a handler that saves, forks and switches to the fork", async () => {
    assert.ok(findSlash("fork"));
    const s = mk("f");
    const source = s.generateSessionId();
    seed(s, source);
    const calls: string[] = [];
    const host = {
      sessionId: () => source,
      saveSession: () => calls.push("save"),
      resumeSession: (id: string) => { calls.push(`resume ${id}`); return { ok: true, message: `Resumed session ${id}.` }; },
      app: { getSessionManager: () => s, getAgent: () => ({ getMessages: () => new Array(8).fill(m("user", "x")), getActiveWorktree: () => undefined }) },
    } as unknown as SlashHost;
    const out = (await routeSlash(host, "fork", "5", new AbortController().signal)) as SlashReply;
    assert.equal(out.success, true, out.output);
    const forks = s.listSessions().filter((x) => x.id !== source);
    assert.equal(forks.length, 1);
    assert.deepEqual(calls, ["save", `resume ${forks[0].id}`]);
    assert.match(out.output, new RegExp(`${source}`), "names the session to return to");
    assert.equal(s.loadSession(forks[0].id)!.messages.length, 5);
    const bad = (await routeSlash(host, "fork", "banana", new AbortController().signal)) as SlashReply;
    assert.equal(bad.success, false);
  });
});
