/**
 * CX-2: each compaction leaves an auditable record (what it covered, what it inserted), resume checks the archive against
 * it, and when the compaction's own output is damaged but the archive is verified, resume restores the full transcript.
 */
import "./helpers/leak_guard.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig, type ChatMessage } from "../src/types.js";
import { SessionManager } from "../src/session.js";
import { auditCompaction, buildCompactionRecord, fullTranscript, insertedBlockPresent, isCompactionRecord, MAX_COVERED_IDS, messageDigest } from "../src/core/compaction_record.js";
import { protectArchivedMessages, redactForPersistence } from "../src/core/persistence_protection.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content } as ChatMessage);

describe("the record", () => {
  test("a message's id is its content, not its key order or identity", () => {
    const a = { role: "user", content: "hi", extra: { y: 1, x: 2 } };
    const b = { extra: { x: 2, y: 1 }, content: "hi", role: "user" };
    assert.equal(messageDigest(a), messageDigest(b));
    assert.notEqual(messageDigest(a), messageDigest({ ...a, content: "hi!" }));
    assert.match(messageDigest(a), /^[0-9a-f]{64}$/);
  });

  test("it lists the covered ids in order with one digest over them, and where and what was inserted", () => {
    const covered = [msg("user", "a"), msg("assistant", "b"), msg("tool", "c")];
    const record = buildCompactionRecord({ trigger: "auto", covered, inserted: [msg("system", "summary")], insertedAt: 1, beforeTokens: 900, afterTokens: 300 });
    assert.deepEqual(record.coveredIds, covered.map((m) => messageDigest(m).slice(0, 16)));
    assert.equal(record.coveredCount, 3);
    assert.deepEqual({ at: record.inserted!.at, count: record.inserted!.count, chars: record.inserted!.chars }, { at: 1, count: 1, chars: 7 });
    assert.equal(isCompactionRecord(JSON.parse(JSON.stringify(record))), true);
    assert.equal(buildCompactionRecord({ trigger: "auto", covered, inserted: [], insertedAt: 0, beforeTokens: 1, afterTokens: 1 }).inserted, null, "a compaction that inserted nothing says so");
  });

  test("a very large compaction keeps its count and digest and says the id list was cut", () => {
    const covered = Array.from({ length: MAX_COVERED_IDS + 5 }, (_, i) => msg("tool", `m${i}`));
    const record = buildCompactionRecord({ trigger: "auto", covered, inserted: [], insertedAt: 0, beforeTokens: 1, afterTokens: 1 });
    assert.equal(record.coveredIds.length, MAX_COVERED_IDS);
    assert.equal(record.coveredCount, MAX_COVERED_IDS + 5);
    assert.equal(record.coveredIdsTruncated, true);
    assert.equal(auditCompaction("c", record, covered).status, "ok", "the digest still verifies the whole prefix");
  });

  test("audit: intact is ok; an altered, missing or extra archived message is corrupt and names what differs; no record is unauditable", () => {
    const covered = [msg("user", "a"), msg("assistant", "b"), msg("tool", "c")];
    const record = buildCompactionRecord({ trigger: "manual", covered, inserted: [], insertedAt: 0, beforeTokens: 1, afterTokens: 1 });
    assert.equal(auditCompaction("c1", record, covered).status, "ok");
    const altered = auditCompaction("c1", record, [covered[0], msg("assistant", "B"), covered[2]]);
    assert.equal(altered.status, "corrupt");
    assert.match(altered.problems.join(), /archived message\(s\) 2 differ/);
    assert.match(auditCompaction("c1", record, covered.slice(0, 2)).problems.join(), /covers 3 message\(s\), the archive holds 2/);
    assert.equal(auditCompaction("c1", record, [...covered, msg("user", "x")]).status, "corrupt");
    assert.deepEqual(auditCompaction("c1", undefined, covered), { id: "c1", status: "unauditable", problems: [], coveredIds: [] });
  });

  test("the full transcript is the first system message, the originals in archive order, then what followed the compaction", () => {
    const saved = [msg("system", "S"), msg("system", "summary block"), msg("user", "recent"), msg("assistant", "reply")];
    const archived = [msg("user", "old1"), msg("assistant", "old2")];
    assert.deepEqual(fullTranscript(saved, archived).map((m) => m.content), ["S", "old1", "old2", "recent", "reply"]);
  });

  test("the inserted block is found where it was put, or elsewhere after a later shift, and not when altered or gone", () => {
    const block = msg("system", "summary");
    const record = buildCompactionRecord({ trigger: "auto", covered: [msg("user", "a")], inserted: [block], insertedAt: 1, beforeTokens: 1, afterTokens: 1 });
    assert.equal(insertedBlockPresent(record, [msg("system", "S"), block, msg("user", "u")]), true);
    assert.equal(insertedBlockPresent(record, [msg("system", "S"), msg("system", "extra"), block]), true, "found after a shift");
    assert.equal(insertedBlockPresent(record, [msg("system", "S"), msg("system", "summary!"), msg("user", "u")]), false, "altered");
    assert.equal(insertedBlockPresent(record, [msg("system", "S"), msg("user", "u")]), false, "gone");
    const none = buildCompactionRecord({ trigger: "auto", covered: [msg("user", "a")], inserted: [], insertedAt: 0, beforeTokens: 1, afterTokens: 1 });
    assert.equal(insertedBlockPresent(none, [msg("system", "S")]), true, "nothing was inserted, so nothing can be missing");
  });
});

describe("redaction does not make a good summary look missing", () => {
  test("a summary that contained a secret hashes the same as the saved conversation's redacted copy of it", () => {
    const body = "abcdefghijklmnopqrstuvwxyz0123456789";
    const secret = `${["ghp", "_", body].join("")} and Authorization: Bearer ${body}${body}`; // built here so no key-shaped literal is committed
    const block = msg("system", `[Structured Context Memory - durable task state]\nnotes: ${secret}`);
    const record = buildCompactionRecord({ trigger: "auto", covered: protectArchivedMessages([msg("user", "a")]), inserted: protectArchivedMessages([block]), insertedAt: 1, beforeTokens: 1, afterTokens: 1 });
    const savedLikeSessionStore = redactForPersistence([msg("system", "S"), block, msg("user", "u")]);
    assert.equal(JSON.stringify(savedLikeSessionStore).includes(body), false, "the saved copy is redacted");
    assert.notEqual(JSON.stringify(protectArchivedMessages([block])), JSON.stringify([block]), "and so is the record's copy");
    assert.equal(insertedBlockPresent(record, savedLikeSessionStore), true);
    assert.equal(insertedBlockPresent(record, redactForPersistence(savedLikeSessionStore)), true, "protecting twice changes nothing");
  });
});

// -------------------------------------------------------------------------------------------- through a real compaction

let home = "";
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cx2-home-"));
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const cfg = (endpoint: string, workspace: string): HarnessConfig => ({ endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", continuation: { ...DEFAULT_CONTINUATION }, approvalMode: "auto", fullAccess: true }) as HarnessConfig;
const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const write = (n: number): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: `w${n}.txt`, content: `w${n}\n` } }] });

interface Compacted { sessions: SessionManager; sessionId: string; repo: string; agent: AutonomousAgent; close(): Promise<void>; saved(): any; endpoint: string }

/** A real agent that did some work and compacted once, with its session record and archive on disk. `withRecord: false` archives the way builds before CX-2 did. */
async function compacted(withRecord = true): Promise<Compacted> {
  const repo = makeRepo();
  const gw = await startGateway((n) => (n <= 6 ? write(n) : { kind: "text", content: "paused" }));
  const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
  const sessions = new SessionManager(path.join(home, `sessions-${Math.random().toString(36).slice(2)}`), () => agent.getWorkspacePathIdentity());
  const sessionId = sessions.generateSessionId();
  const save = () => sessions.saveSession({ id: sessionId, workspace: repo, model: "m", messages: agent.getMessages(), objective: agent.getObjective() ?? null, findings: agent.getFindings(), history: agent.getHistoryCompleteness() as any } as any);
  agent.setArchiveSink((id, messages, record) => sessions.appendArchivedHistory(sessionId, messages, id, withRecord ? record : undefined));
  agent.setProgressListener(save);
  await agent.runTurn("1. Write w1..w6");
  const result = await agent.compactNow(false);
  assert.equal(result.ok && result.durable, true, result.message);
  agent.setProgressListener(undefined);
  return {
    sessions, sessionId, repo, agent, endpoint: gw.url,
    saved: () => sessions.loadSession(sessionId)!,
    close: async () => { agent.shutdown(); await gw.close(); fs.rmSync(repo, { recursive: true, force: true }); },
  };
}

function resume(c: Compacted, saved: any): { restored: AutonomousAgent; notice: string | undefined } {
  const restored = quiet(new AutonomousAgent(cfg(c.endpoint, c.repo)));
  const notice = restored.restoreConversation(saved, (committed) => c.sessions.readArchivedHistory(c.sessionId, committed));
  return { restored, notice };
}

const archiveFile = (c: Compacted) => c.sessions.archivedHistoryPath(c.sessionId);

describe("through a real compaction and resume", () => {
  test("a compaction's record names its covered ids and what it inserted; an intact archive resumes without a notice", { timeout: 120_000 }, async () => {
    const c = await compacted();
    try {
      const read = c.sessions.readArchivedHistory(c.sessionId);
      const [id, group] = [...read.byCompaction!.entries()][0];
      assert.equal(isCompactionRecord(group.record), true);
      const record = group.record as ReturnType<typeof buildCompactionRecord>;
      assert.equal(record.coveredCount, group.messages.length);
      assert.equal(record.coveredIds.length, group.messages.length);
      assert.equal(record.inserted?.at, 1, "the summary block sits right after the system prompt");
      assert.match(id, /^c1-/);
      assert.equal(auditCompaction(id, record, group.messages).status, "ok");
      const { restored, notice } = resume(c, c.saved());
      try {
        assert.equal(notice, undefined);
        assert.equal(restored.getMessages().length, c.saved().messages.length, "an intact archive leaves the conversation as saved");
      } finally { restored.shutdown(); }
    } finally { await c.close(); }
  });

  test("an archive line changed after the fact: the compaction is reported against its record and its messages are not used", { timeout: 120_000 }, async () => {
    const c = await compacted();
    try {
      const lines = fs.readFileSync(archiveFile(c), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const target = lines.find((l) => typeof l.message.content === "string" && l.message.role === "tool");
      target.message.content = "TAMPERED";
      fs.writeFileSync(archiveFile(c), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      const { restored, notice } = resume(c, c.saved());
      try {
        assert.match(notice ?? "", /compaction c1-\S+ does not match its record \(archived message\(s\) \d+ differ from what the record covered\)/);
        assert.match(notice ?? "", /covered 10 message id\(s\): [0-9a-f]{16}/, "the notice lists the covered ids");
        assert.equal(((restored as any).archiveForReading as ChatMessage[]).some((m) => m.content === "TAMPERED"), false, "read_archive does not serve the altered lines");
        assert.equal(restored.getMessages().length, c.saved().messages.length, "the saved conversation is used as it is");
      } finally { restored.shutdown(); }
    } finally { await c.close(); }
  });

  test("the compaction's own output is gone from the saved conversation and the archive is verified: resume restores the full transcript", { timeout: 120_000 }, async () => {
    const c = await compacted();
    try {
      const saved = c.saved();
      const archivedCount = c.sessions.readArchivedHistory(c.sessionId).messages.length;
      saved.messages = saved.messages.filter((m: ChatMessage) => !(m.role === "system" && String(m.content).startsWith("[Structured Context Memory")));
      const { restored, notice } = resume(c, saved);
      try {
        assert.match(notice ?? "", /no longer holds what compaction c1-\S+ inserted; resumed from the full transcript restored from the verified archive \(1 compaction\(s\) undone, 10 original message\(s\) put back\)/);
        const messages = restored.getMessages();
        assert.equal(messages.length, saved.messages.length + archivedCount, "the originals are back");
        assert.equal(messages.some((m) => String(m.content).startsWith("[Structured Context Memory")), false);
        assert.equal(messages.filter((m) => m.role === "tool" && String(m.content).includes("w1.txt")).length >= 1, true, "an original tool result from the archive is in the conversation");
        assert.equal(restored.getHistoryCompleteness().compactions, 0, "the undone compaction is no longer counted");
      } finally { restored.shutdown(); }
    } finally { await c.close(); }
  });

  test("conservative: a damaged archive line means no undo, even when the inserted block is gone", { timeout: 120_000 }, async () => {
    const c = await compacted();
    try {
      const saved = c.saved();
      saved.messages = saved.messages.filter((m: ChatMessage) => !(m.role === "system" && String(m.content).startsWith("[Structured Context Memory")));
      fs.appendFileSync(archiveFile(c), "{torn line\n");
      const { restored, notice } = resume(c, saved);
      try {
        assert.doesNotMatch(notice ?? "", /full transcript/);
        assert.match(notice ?? "", /could not be read/);
        assert.equal(restored.getMessages().length, saved.messages.length);
      } finally { restored.shutdown(); }
    } finally { await c.close(); }
  });

  test("a compaction archived without a record (an earlier build) is unauditable and resumes exactly as before", { timeout: 120_000 }, async () => {
    const c = await compacted(false);
    try {
      const saved = c.saved();
      saved.messages = saved.messages.filter((m: ChatMessage) => !(m.role === "system" && String(m.content).startsWith("[Structured Context Memory")));
      const { restored, notice } = resume(c, saved);
      try {
        assert.equal(notice, undefined, "nothing to check against, so nothing is claimed or undone");
        assert.equal(restored.getMessages().length, saved.messages.length);
      } finally { restored.shutdown(); }
    } finally { await c.close(); }
  });
});
