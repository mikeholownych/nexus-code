import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ValidationReceipt } from "../src/core/candidate.js";
import type { TurnResult } from "../src/core/turn.js";
import { EvidenceLedger, MAX_DETAIL, receiptSections, receiptText, redactedJson } from "../src/evidence.js";

function clock(...times: number[]): () => number {
  return () => times.shift() ?? 0;
}

const verifiedTurn: TurnResult = {
  execution: "COMPLETED",
  outcome: "VERIFIED",
  acceptance: "NOT_REQUESTED",
  modelStop: "TASK_COMPLETED_TOOL",
  finalOutputComplete: true,
  verification: { status: "PASSED", command: "npm test", source: "discovered", exitSuccess: true, outputSha256: "abc123", candidateId: "cand-1", at: "2026-10-04T10:00:00.000Z" },
  interruption: null,
  inferenceFailure: null,
  steps: { used: 4, max: 30, limitReached: false },
  unverifiedChangesPending: false,
  finishedAt: "2026-10-04T10:00:01.000Z",
};

describe("evidence ledger", () => {
  test("quoted and escape-split secrets in arguments are redacted", () => {
    const content = 'API_KEY="abcdef1234567890"\nkey: sk-abcdefgh\x1b[0mijklmnopqrstuvwxyz123456';
    const ledger = new EvidenceLedger();
    const args = ledger.get(ledger.start("t1", "write_file", ".env", { path: ".env", content }))!.args;
    const id = ledger.start("t1", "run_command", "x", {});
    ledger.end(id, true, JSON.stringify('API_KEY="abcdef1234567890" done'));
    assert.doesNotMatch(ledger.get(id)!.output, /abcdef1234567890/);
    for (const text of [args, redactedJson({ path: ".env", content })]) {
      assert.doesNotMatch(text, /abcdef1234567890/);
      assert.doesNotMatch(text, /ijklmnopqrstuvwxyz123456/);
      assert.match(text, /"path": "\.env"/);
    }
  });

  test("each call gets a new id and a running record that the end fills in", () => {
    const ledger = new EvidenceLedger(200, clock(1000, 1250, 2000));
    const first = ledger.start("t1", "read_file", "a.ts", { path: "a.ts" });
    assert.equal(first, "e1");
    assert.deepEqual(ledger.get(first), {
      evidence: "e1",
      turnId: "t1",
      tool: "read_file",
      subject: "a.ts",
      args: '{\n  "path": "a.ts"\n}',
      status: "running",
      output: "",
      startedAt: 1000,
      durationMs: null,
    });
    ledger.end(first, true, "const a = 1;");
    assert.equal(ledger.get(first)?.status, "succeeded");
    assert.equal(ledger.get(first)?.output, "const a = 1;");
    assert.equal(ledger.get(first)?.durationMs, 250);
    assert.equal(ledger.start("t2", "read_file", "a.ts", { path: "a.ts" }), "e2");
  });

  test("a failed call keeps its output and appends the error", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.start("t1", "run_command", "make", { command: "make" });
    ledger.end(id, false, "partial output", "exit code 2");
    assert.equal(ledger.get(id)?.status, "failed");
    assert.equal(ledger.get(id)?.output, "partial output\nexit code 2");
  });

  test("secrets and terminal escapes are removed and long output is capped", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.start("t1", "write_file", "env.ts", { path: "env.ts", content: "token = sk-abcdefghijklmnopqrstuvwxyz123456" });
    assert.equal(ledger.get(id)?.args.includes("sk-abcdefghij"), false);
    ledger.end(id, true, "\x1b[31mred\x1b[0m " + "x".repeat(MAX_DETAIL + 6000));
    const output = ledger.get(id)?.output ?? "";
    assert.ok(output.startsWith("red x"));
    assert.ok(output.endsWith("…[truncated 6004 chars]"), output.slice(-40));
  });

  test("only the latest records are kept", () => {
    const ledger = new EvidenceLedger(2);
    const ids = ["a", "b", "c"].map((name) => ledger.start("t1", "read_file", name, { path: name }));
    assert.equal(ledger.get(ids[0]), undefined);
    assert.equal(ledger.get(ids[1])?.subject, "b");
    assert.equal(ledger.get(ids[2])?.subject, "c");
    ledger.end(ids[0], true, "late");
    assert.equal(ledger.get(ids[0]), undefined);
  });
});

describe("receipt projection", () => {
  test("before any turn every section says why it is empty", () => {
    const sections = receiptSections(null, null);
    assert.deepEqual(sections.map((s) => [s.title, s.rows.length]), [["Last turn", 0], ["Verifier", 0], ["Validation receipt", 0]]);
    assert.equal(sections[0].note, "No turn has finished in this session yet.");
    assert.equal(sections[1].note, "Nothing to report until a turn finishes.");
    assert.match(sections[2].note ?? "", /^No validation receipt is active\./);
  });

  test("a verified turn with a receipt lists every field, redacted", () => {
    const receipt: ValidationReceipt = {
      receiptId: "rcpt-1",
      candidateId: "cand-1",
      verifierCommand: "API_KEY=supersecretvalue npm test",
      exitCode: 0,
      stdoutHash: "def456",
      timestamp: "2026-10-04T10:00:02.000Z",
      status: "PASSED",
      materialDependencies: [],
    };
    const sections = receiptSections({ heading: "TURN VERIFIED", turn: verifiedTurn }, receipt);
    assert.deepEqual(sections[0].rows, [
      ["result", "TURN VERIFIED"],
      ["execution", "COMPLETED"],
      ["outcome", "VERIFIED"],
      ["steps", "4 of 30"],
      ["model stop", "TASK_COMPLETED_TOOL"],
      ["finished", "2026-10-04T10:00:01.000Z"],
    ]);
    assert.deepEqual(sections[1].rows, [
      ["status", "PASSED"],
      ["command", "npm test"],
      ["source", "discovered"],
      ["exit", "success"],
      ["output sha256", "abc123"],
      ["candidate", "cand-1"],
      ["at", "2026-10-04T10:00:00.000Z"],
    ]);
    const command = sections[2].rows.find(([label]) => label === "command")?.[1] ?? "";
    assert.equal(command.includes("supersecretvalue"), false);
    const text = receiptText(sections);
    assert.match(text, /^Last turn\n  result        TURN VERIFIED$/m);
    assert.match(text, /^Validation receipt\n  status        PASSED$/m);
  });
});
