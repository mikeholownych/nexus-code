/**
 * Continuation past the per-segment step limit, bounded stopping, acceptance requirements, verifier attempts and
 * steering at the agent layer. Every scenario runs the real agent loop against a deterministic local gateway.
 *
 * Evidence session: nexus-session-session_20261011_162349_6lvu.json — the objective ended at step 30 (STEP LIMIT
 * REACHED), the operator had to type "continue", the original request survived only as a truncatable compaction note,
 * and task_completed re-ran the same failing `make test` twice on unchanged inputs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";
import { createLedger, seedRequirements, applyRequirementUpdates, isNewObjective, failedCheckFrom, renderPinnedLedger, acceptDescoping, requirementDone, readObjective, invalidateVerified, queueSteering, amendObjective } from "../src/core/objective.js";
import { stableToolCallId, redactTaskStateForPersistence } from "../src/core/persistence_protection.js";
import { SessionManager } from "../src/session.js";
import { WorkspacePath } from "../src/core/workspace_path.js";

import { requirementRows as require_rows } from "../src/core/objective.js";
const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  ...o,
});
const write = (name: string, content = `${name}\n`): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content } }] });
const read = (name: string): Reply => ({ kind: "tools", calls: [{ name: "read_file", args: { path: name } }] });
const text = (content: string): Reply => ({ kind: "text", content });
/** Resolves once the agent's turn is running inference (extension start-up can delay it). */
async function inferring(agent: AutonomousAgent, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (agent.getTurnLifecycle()?.phase !== "inference") {
    if (Date.now() > deadline) throw new Error("the turn never reached inference");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const userMessages = (body: any) => (body.messages as any[]).filter((m) => m.role === "user").map((m) => String(m.content));
const systemText = (body: any) => (body.messages as any[]).filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");

describe("continuation beyond the per-segment step limit", () => {
  test("a progressing task runs past 30 steps without the operator typing continue", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => (n <= 34 ? write(`f${n}.txt`) : text("All files written.")));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      const turn = await agent.runTurn("Write files f1.txt through f34.txt, one per step.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
      assert.equal(turn.steps.used, 35);
      assert.equal(turn.steps.limitReached, false);
      assert.equal(turn.continuation?.segments, 2, "step 31 begins the second segment");
      assert.equal(gw.requests.length, 35);
      assert.ok(fs.existsSync(path.join(repo, "f34.txt")));
      // No "continue" was typed or injected: the only user message is the operator's own.
      const last = gw.requests[34] as any;
      assert.deepEqual(userMessages(last).map((m) => m.split("\n")[0]), ["Write files f1.txt through f34.txt, one per step."]);
      assert.match(systemText(last), /Continuation: segment 2 of this turn/);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("without a continuation budget the same task still ends at the segment limit (legacy single-segment turn)", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => (n <= 34 ? write(`f${n}.txt`) : text("done")));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Write files f1.txt through f34.txt, one per step.");
      assert.equal(turn.execution, "LIMIT_REACHED");
      assert.equal(turn.reason, "STEP_LIMIT_REACHED");
      assert.equal(gw.requests.length, 30);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a stuck task stops boundedly: recovery notes, then STAGNATION_DETECTED", { timeout: 60_000 }, async () => {
    const gw = await startGateway(() => read("base.txt"));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 50, maxRecoveries: 2 } })));
    try {
      const turn = await agent.runTurn("Inspect base.txt.");
      assert.equal(turn.execution, "LIMIT_REACHED");
      assert.equal(turn.reason, "STAGNATION_DETECTED");
      assert.match(turn.detail ?? "", /repeated read_file \d+ times with an unchanged result on an unchanged workspace after 2 recovery notes/);
      assert.ok(gw.requests.length <= 10, `bounded: ${gw.requests.length} requests`);
      const notes = userMessages(gw.requests[gw.requests.length - 1]).filter((m) => m.startsWith("[Nexus recovery"));
      assert.equal(notes.length, 2, "two bounded recovery notes before stopping");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no progress for the configured window ends the turn with STAGNATION_DETECTED", { timeout: 60_000 }, async () => {
    // Alternating reads of two unchanging files: never the same call three times in a row, never new information.
    const gw = await startGateway((n) => read(n % 2 ? "base.txt" : "other.txt"));
    const repo = makeRepo({ "other.txt": "other\n" });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 4, maxRecoveries: 10 } })));
    try {
      const turn = await agent.runTurn("Inspect the two files.");
      assert.equal(turn.reason, "STAGNATION_DETECTED", JSON.stringify(turn));
      assert.match(turn.detail ?? "", /4 consecutive steps without progress/);
      assert.ok(gw.requests.length <= 8, `bounded: ${gw.requests.length}`);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the total step budget ends a long task with STEP_BUDGET_EXHAUSTED and its segment count", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => write(`g${n}.txt`));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { maxSteps: 5, continuation: { ...DEFAULT_CONTINUATION, maxTotalSteps: 12 } })));
    try {
      const turn = await agent.runTurn("Keep writing files.");
      assert.equal(turn.execution, "LIMIT_REACHED");
      assert.equal(turn.reason, "STEP_BUDGET_EXHAUSTED");
      assert.equal(turn.steps.used, 12);
      assert.equal(turn.steps.max, 12);
      assert.equal(turn.continuation?.segments, 3);
      assert.equal(gw.requests.length, 12);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("cancellation still stops a continued turn between steps", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => ({ ...write(`c${n}.txt`), delayMs: 40 }));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { maxSteps: 3, continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      const pending = agent.runTurn("Keep writing files.");
      // Cancel once the turn is in its second segment (maxSteps 3), whatever the machine's speed.
      while (gw.requests.length <= 4) await new Promise((r) => setTimeout(r, 10));
      agent.requestCancel("test");
      const turn = await pending;
      assert.equal(turn.execution, "INTERRUPTED");
      assert.ok(gw.requests.length > 3, "it had continued past the first segment before the cancel");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

const OBJECTIVE = `Add input validation to the importer.

Requirements:
1. Reject rows with an empty name.
2. Reject negative quantities.
3. Report the line number of every rejected row.`;

describe("acceptance requirements stay authoritative over the plan", () => {
  test("seeding, explicit scope changes and evidence rules", () => {
    assert.deepEqual(seedRequirements(OBJECTIVE).map((r) => r.id), ["R1", "R2", "R3"]);
    assert.equal(seedRequirements("fix the typo in README").length, 1);
    const nested = "Do this:\n1. First\n   1. sub-step\n   2. sub-step\n2. Second";
    assert.deepEqual(seedRequirements(nested).map((r) => r.text), ["First", "Second"]);
    const ledger = createLedger(OBJECTIVE);
    let r = applyRequirementUpdates(ledger, [{ id: "R1", status: "implemented" }]);
    assert.equal(r.ok, false, "implemented needs evidence");
    r = applyRequirementUpdates(ledger, [{ id: "R2", status: "descoped" }]);
    assert.equal(r.ok, false, "descoping needs a reason");
    r = applyRequirementUpdates(ledger, [{ id: "R2", status: "descoped", note: "operator said negatives are allowed" }, { id: "R1", status: "implemented", evidence: ["src/importer.ts"] }]);
    assert.equal(r.ok, true, r.errors.join(";"));
    assert.equal(ledger.scopeChanges.length, 1);
    assert.equal(ledger.scopeChanges[0].reason, "operator said negatives are allowed");
    r = applyRequirementUpdates(ledger, [{ id: "R3", text: "Something smaller" }]);
    assert.equal(r.ok, false, "operator requirement text cannot be reworded");
    assert.equal(isNewObjective(ledger, "continue"), false, "a short follow-up amends an unresolved objective");
    assert.equal(isNewObjective(ledger, "1. a\n2. b"), false, "an unfinished structured objective is never replaced implicitly");
    assert.equal(isNewObjective(ledger, "x".repeat(5000)), false, "not by a long follow-up either");
    assert.equal(isNewObjective(createLedger("fix the typo"), "now the other typo"), true, "single requests do not chain");
    const closed = createLedger(OBJECTIVE);
    closed.outcome = { status: "completed", reason: "VERIFIED", remaining: [], at: "" };
    assert.equal(isNewObjective(closed, "thanks, now tidy up"), true, "a completed objective is replaced");
    assert.equal(failedCheckFrom("ok 1\nnot ok 2 - rejects empty\n# fail 1"), "not ok 2 - rejects empty");
  });

  test("a completed plan cannot end the task while requirements are open; nudges are bounded", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) =>
      n === 1
        ? { kind: "tools", calls: [{ name: "update_plan", args: { phases: [{ name: "Validate input", status: "completed" }] } }] }
        : n === 2
          ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Validation added." } }] }
          : text("All done."),
    );
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      const turn = await agent.runTurn(OBJECTIVE);
      assert.equal(turn.execution, "COMPLETED");
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.reason, "REQUIREMENTS_INCOMPLETE");
      assert.equal(turn.objective?.status, "incomplete");
      assert.equal(turn.objective?.remaining.length, 3);
      const pinned = systemText(gw.requests[0]);
      assert.match(pinned, /R1 \[open\] Reject rows with an empty name\./);
      assert.match(pinned, /the plan never replaces these/);
      // task_completed was refused with the open requirements listed.
      const third = gw.requests[2] as any;
      const refusal = third.messages.find((m: any) => m.role === "tool" && m.name === "task_completed");
      assert.match(refusal.content, /Not complete: the operator's acceptance requirements are not all done/);
      // Two bounded continuation nudges, then the honest stop.
      const nudges = userMessages(gw.requests[gw.requests.length - 1]).filter((m) => m.startsWith("[Nexus continuation"));
      assert.equal(nudges.length, DEFAULT_CONTINUATION.maxCompletionNudges);
      assert.equal(gw.requests.length, 5);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("requirements recorded with evidence let the task complete; blocked ones are reported, not hidden", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) =>
      n === 1
        ? {
            kind: "tools",
            calls: [{
              name: "update_requirements",
              args: {
                requirements: [
                  { id: "R1", status: "implemented", evidence: ["importer.ts: empty-name check"] },
                  { id: "R2", status: "implemented", evidence: ["importer.ts: quantity check"] },
                  { id: "R3", status: "blocked", note: "line numbers are not available from the parser" },
                ],
                next_action: "Ask the operator whether a parser change is in scope.",
              },
            }],
          }
        : n === 2
          ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Done except R3." } }] }
          : text("R3 is blocked: the parser does not expose line numbers."),
    );
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      const turn = await agent.runTurn(OBJECTIVE);
      assert.equal(turn.reason, "REQUIREMENTS_INCOMPLETE");
      assert.equal(turn.objective?.status, "blocked", JSON.stringify({ objective: turn.objective, ledger: agent.getObjective()?.requirements }));
      assert.deepEqual(turn.objective?.remaining, ["R3 [blocked] Report the line number of every rejected row. (line numbers are not available from the parser)"]);
      assert.equal(turn.objective?.nextAction, "Ask the operator whether a parser change is in scope.");
      const ledger = agent.getObjective()!;
      assert.equal(ledger.outcome?.status, "blocked");
      assert.equal(ledger.scopeChanges[0].to, "blocked");
      assert.equal(gw.requests.length, 3, "a blocked requirement is not nudged");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the objective stays pinned verbatim after compaction drops the original message", { timeout: 60_000 }, async () => {
    const big = "x".repeat(9000);
    const gw = await startGateway((n) => (n <= 8 ? { ...write(`big${n}.txt`, `${big}${n}\n`), delayMs: n === 1 ? 300 : 0 } : text("stopping here")));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { contextLimit: 40_000, continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } })));
    const logs = console.log;
    console.log = () => {};
    try {
      const pending = agent.runTurn(OBJECTIVE);
      // Steering becomes the latest user message, so compaction keeps it and summarises the original request.
      await inferring(agent);
      assert.equal(agent.queueSteering("s1", "Also keep the old CSV format working.").status, "queued");
      await pending;
      const later = gw.requests.slice(3) as any[];
      const verbatim = later.find((body) => systemText(body).includes("Operator objective (verbatim"));
      assert.ok(verbatim, "a later request pinned the objective verbatim");
      assert.ok(systemText(verbatim).includes(OBJECTIVE), "the full objective text, not a truncated note");
      assert.ok(!systemText(verbatim).includes(`Earlier task requests: ${OBJECTIVE.split("\n")[0]}`), "not repeated as a compaction note");
      assert.match(systemText(verbatim), /s1 \[applied at step \d+\] Also keep the old CSV format working\./);
      assert.ok(agent.getHistoryCompleteness().compactions > 0);
      assert.equal(agent.getHistoryCompleteness().complete, false);
      const archived = (agent as any).stateManager.readArchive(agent.getTaskId(), new Set(agent.getHistoryCompleteness().committedCompactions));
      assert.ok(archived.messages.length > 0, "replaced originals are archived durably beside the task state");
      assert.deepEqual(archived.missingCompactions, [], "every committed compaction has its originals");
    } finally {
      console.log = logs;
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("steering survives a crash mid-turn", () => {
  test("steering applied mid-turn is saved with the conversation, so a crash before the next checkpoint cannot lose it", { timeout: 60_000 }, async () => {
    const listDir: Reply = { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] };
    let agent: AutonomousAgent;
    let atNextRequest: any;
    const gw = await startGateway((n) => {
      // What a crash at this point would leave: the durable state as of the request after steering was applied.
      if (n === 2) atNextRequest = JSON.parse(JSON.stringify((agent as any).stateManager.loadTaskState((agent as any).currentTaskId)));
      return n === 1 ? { ...listDir, delayMs: 300 } : n === 2 ? listDir : text("stopping here");
    });
    const repo = makeRepo();
    agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } })));
    try {
      const pending = agent.runTurn(OBJECTIVE);
      await inferring(agent);
      assert.equal(agent.queueSteering("s1", "STEER-CRASH: keep the old CSV format working.").status, "queued");
      await pending;
      assert.ok(atNextRequest, "the durable state was read at the request after steering");
      assert.ok(atNextRequest.messages.some((m: any) => String(m.content).includes("STEER-CRASH")), "the steering message is in the saved conversation");
      const record = atNextRequest.objective?.steering?.find((s: any) => s.id === "s1");
      assert.equal(record?.status, "applied", `the saved ledger records the steering as applied: ${JSON.stringify(atNextRequest.objective?.steering)}`);
      // After a resume, once compaction removes the message, the pinned ledger still carries it.
      assert.match(renderPinnedLedger(atNextRequest.objective, true), /s1 \[applied at step \d+\] STEER-CRASH: keep the old CSV format working\./);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the objective survives detailed follow-ups and stays complete in context", () => {
  test("long and numbered follow-ups after an incomplete turn amend the objective; nothing asked earlier is lost", { timeout: 60_000 }, async () => {
    const gw = await startGateway(() => text("stopping"));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } })));
    try {
      await agent.runTurn(OBJECTIVE);
      const correction = `Correction to the importer task — please also handle these:\n1. Trim whitespace in names before the empty check.\n2. Log rejected rows to rejects.csv.\n${"Context paragraph explaining the CSV format in detail. ".repeat(20)}`;
      assert.ok(correction.length > 400);
      assert.equal(agent.objectiveDecision(correction).kind, "amend");
      await agent.runTurn(correction);
      const ledger = agent.getObjective()!;
      assert.equal(ledger.objective, OBJECTIVE, "the original objective is kept");
      assert.deepEqual(ledger.requirements.map((r) => r.id), ["R1", "R2", "R3", "R4", "R5"]);
      assert.equal(ledger.requirements[3].text, "Trim whitespace in names before the empty check.");
      assert.ok(ledger.requirements.slice(0, 3).every((r) => r.status === "open"), "earlier requirements are untouched");
      assert.equal(ledger.amendments.length, 1);
      const pinned = systemText(gw.requests.at(-1));
      assert.match(pinned, /R2 \[open\] Reject negative quantities\./);
      assert.match(pinned, /R5 \[open\] Log rejected rows to rejects\.csv\./);
      // Replacement is explicit.
      agent.clearObjective();
      await agent.runTurn("Unrelated: rename the CLI flag.");
      assert.equal(agent.getObjective()!.objective, "Unrelated: rename the CLI flag.");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("operator steering and follow-ups are pinned verbatim — the oldest, the longest and multi-line ones included", () => {
    const ledger = createLedger("Build the importer.");
    const multiline = "STEER-CODE: name the helper like this:\n\n    def parse_row(line):\n        return line.split(\"\\t\")\n\nand nothing else.";
    const long = `STEER-LONG: use the vendor's date format everywhere. ${"Keep timestamps in UTC; ".repeat(60)}STEER-LONG-END`;
    queueSteering(ledger, "s-first", "STEER-FIRST: never touch the legacy/ folder.", "2026-10-13T00:00:00.000Z");
    for (let i = 2; i <= 13; i++) queueSteering(ledger, `s${i}`, `Steering ${i}.`, `2026-10-13T00:00:${String(i).padStart(2, "0")}.000Z`);
    queueSteering(ledger, "s-code", multiline, "2026-10-13T00:01:00.000Z");
    queueSteering(ledger, "s-long", long, "2026-10-13T00:02:00.000Z");
    amendObjective(ledger, "AMEND-FIRST: also support TSV.", "2026-10-12T23:00:00.000Z");
    for (let i = 2; i <= 10; i++) amendObjective(ledger, `Follow-up ${i}.`, `2026-10-12T23:00:${String(i).padStart(2, "0")}.000Z`);
    const amendLong = `AMEND-LONG: also log skipped rows. ${"Each with its row number; ".repeat(40)}AMEND-LONG-END`;
    amendObjective(ledger, amendLong, "2026-10-12T23:30:00.000Z");
    const pinned = renderPinnedLedger(ledger, false);
    for (const text of ["STEER-FIRST: never touch the legacy/ folder.", multiline, long, "AMEND-FIRST: also support TSV.", amendLong]) {
      assert.ok(pinned.includes(text), `pinned verbatim: ${text.slice(0, 40)}`);
    }
    assert.ok(!/not shown for space/i.test(pinned), "everything fits; nothing is deferred");
  });

  test("operator steering beyond the pinned budget is named, the newest kept in full, and read_objective returns it verbatim", () => {
    const ledger = createLedger("Build the importer.");
    const big = (tag: string) => `${tag}-START ${"x".repeat(5000)} ${tag}-END`;
    amendObjective(ledger, big("AMD"), "2026-10-13T00:00:00.000Z");
    queueSteering(ledger, "s-old", big("OLD"), "2026-10-13T00:01:00.000Z");
    queueSteering(ledger, "s-mid", big("MID"), "2026-10-13T00:02:00.000Z");
    queueSteering(ledger, "s-new", big("NEW"), "2026-10-13T00:03:00.000Z");
    const pinned = renderPinnedLedger(ledger, false);
    assert.ok(pinned.includes(big("NEW")) && pinned.includes(big("MID")), "the newest operator messages are pinned in full");
    assert.ok(!pinned.includes("OLD-END") && !pinned.includes("AMD-END"), "older ones are not cut to fit");
    assert.match(pinned, /s-old .*not shown for space.*read_objective/i);
    assert.match(pinned, /A1 .*not shown for space.*read_objective/i);
    assert.equal(readObjective(ledger, { steering: "s-old" }).text.split("\n").slice(1).join("\n"), big("OLD"));
    assert.equal(readObjective(ledger, { amendment: "A1" }).text.split("\n").slice(1).join("\n"), big("AMD"));
    const unknown = readObjective(ledger, { steering: "nope" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /s-old, s-mid, s-new/);
    assert.equal(readObjective(ledger, { amendment: "A9" }).ok, false);
  });

  test("a long objective keeps every unresolved requirement's full wording in context, and read_objective returns the rest verbatim", { timeout: 60_000 }, async () => {
    const filler = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `   ${tag} detail line ${i}: keep the current behaviour for case ${i}.`).join("\n");
    const longObjective = [
      "Rework the import pipeline.",
      "",
      "1. Stream large files instead of loading them whole.",
      filler("R1", 450),
      "2. Validate every row before writing it.",
      filler("R2", 300),
      "   ACCEPTANCE-R2-FINAL: a row with a negative quantity must be rejected with code E_NEG and logged.",
      "3. Keep the public API unchanged.",
    ].join("\n");
    const ledger = createLedger(longObjective);
    assert.ok(ledger.requirements[1].detail!.endsWith("logged."), "a requirement keeps its complete body, nested lines included");
    const budget = 40_000;
    assert.ok(longObjective.length > budget, `objective ${longObjective.length} chars exceeds the ${budget}-char budget`);
    // All three unresolved: R1's body fills the budget, so R2 is named for retrieval rather than truncated silently.
    let pinned = renderPinnedLedger(ledger, true, budget);
    assert.match(pinned, /Not shown here for space \(unresolved; fetch with read_objective before working on them\): R2/);
    assert.ok(!pinned.includes("ACCEPTANCE-R2-FINAL") || pinned.includes("Full text of R2"));
    assert.match(readObjective(ledger, { requirement: "R2" }).text, /ACCEPTANCE-R2-FINAL: a row with a negative quantity must be rejected with code E_NEG and logged\./);
    const tail = readObjective(ledger, { offset: longObjective.length - 200, length: 200 }).text;
    assert.ok(tail.endsWith("3. Keep the public API unchanged."));
    // Once R1 is done, R2's complete wording is carried in context — the acceptance detail at its very end included.
    applyRequirementUpdates(ledger, [{ id: "R1", status: "implemented", evidence: ["stream.ts"] }]);
    pinned = renderPinnedLedger(ledger, true, budget);
    assert.ok(pinned.includes("ACCEPTANCE-R2-FINAL: a row with a negative quantity must be rejected with code E_NEG and logged."));
    assert.ok(!pinned.includes("R1 detail line 449"), "a resolved requirement's body is not repeated");

    // Through the agent: the original message is not in the conversation (compacted away), so the ledger carries it.
    const gw = await startGateway((n) => (n === 1 ? { kind: "tools", calls: [{ name: "read_objective", args: { requirement: "R2" } }] } : text("stopping")));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { contextLimit: 40_000, continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } })));
    try {
      agent.restoreSession([{ role: "system", content: "system prompt" }], false, createLedger(longObjective));
      await agent.runTurn("continue");
      assert.match(systemText(gw.requests[0]), /Not shown here for space .*: R2/);
      const tool = (gw.requests[1] as any).messages.find((m: any) => m.role === "tool" && m.name === "read_objective");
      assert.match(tool.content, /ACCEPTANCE-R2-FINAL/);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("verified means a recorded passing verifier run on the current workspace", () => {
  test("verified without a current pass is refused; after a passing run_tests it binds that run; a later change demotes it", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ Makefile: 'test:\n\t@echo "✔ importer works" && echo "ℹ tests 1"\n' });
    const script = (n: number): Reply =>
      n === 1
        ? { kind: "tools", calls: [{ name: "update_requirements", args: { requirements: [{ id: "R1", status: "verified", evidence: ["I checked it"] }] } }] }
        : n === 2
          ? { kind: "tools", calls: [{ name: "run_tests", args: {} }] }
          : n === 3
            ? { kind: "tools", calls: [{ name: "update_requirements", args: { requirements: [{ id: "R1", status: "verified", evidence: ["importer.ts"] }] } }] }
            : n === 4
              ? write("later-change.txt")
              : text("stopping");
    const gw = await startGateway(script);
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } })));
    try {
      await agent.runTurn(OBJECTIVE);
      const refusal = (gw.requests[1] as any).messages.filter((m: any) => m.role === "tool" && m.name === "update_requirements").at(-1);
      assert.match(refusal.content, /verified needs a passing verifier run on the current workspace/);
      const ledger = agent.getObjective()!;
      const pass = ledger.verification.find((a) => a.status === "PASSED");
      assert.ok(pass, "run_tests recorded a verifier attempt");
      const r1 = ledger.requirements[0];
      assert.equal(r1.status, "implemented", "the later write demoted it");
      assert.match(r1.note ?? "", /verification invalidated: write_file changed the workspace after the verifier run \(was verifier #\d+\)/);
      assert.ok(r1.evidence.some((e) => e.startsWith(`verifier #${pass!.n}: `)), "the bound receipt stays in the evidence trail");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("receipt rows distinguish model-reported implementation from bound verification", () => {
    const ledger = createLedger(OBJECTIVE);
    applyRequirementUpdates(ledger, [{ id: "R1", status: "implemented", evidence: ["a.ts"] }]);
    const pass = { n: 4, command: "make test", inputs: "abcdef1234567890", status: "PASSED" as const, at: "t" };
    applyRequirementUpdates(ledger, [{ id: "R2", status: "verified", evidence: ["b.ts"] }], undefined, undefined, pass);
    const rows = Object.fromEntries(require_rows(ledger));
    assert.match(rows.R1, /^IMPLEMENTED \(model-reported\)/);
    assert.match(rows.R2, /^VERIFIED \(verifier #4 make test passed on abcdef123456\)/);
    assert.deepEqual(invalidateVerified(ledger, "edit"), ["R2"]);
  });
});

describe("verifier attempts are remembered against their inputs", () => {
  test("an unchanged failing verifier is not rerun; a change reruns it; the gate stays closed until it passes", { timeout: 60_000 }, async () => {
    const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verifier-runs-")), "runs.log");
    const repo = makeRepo({ Makefile: `test:\n\techo run >> ${counter}\n\ttest -f fixed.txt || (echo "FAIL fixed.txt missing"; exit 1)\n\t@echo "ℹ tests 1"\n` });
    const gw = await startGateway((n) =>
      n === 1
        ? write("change.txt")
        : n === 2 || n === 3
          ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] }
          : n === 4
            ? write("fixed.txt")
            : n === 5
              ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "fixed" } }] }
              : text("done"),
    );
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      const runs = fs.readFileSync(counter, "utf8").trim().split("\n").length;
      // The run before the first edit (fail-before evidence), attempt 1, and the rerun after the change; attempt 2 on
      // unchanged inputs was not run.
      assert.equal(runs, 3, "attempt 2 on unchanged inputs was not run; the change reran it");
      const attempts = agent.getObjective()!.verification;
      assert.deepEqual(attempts.map((a) => a.status), ["FAILED", "SKIPPED_UNCHANGED_INPUTS", "PASSED"]);
      assert.equal(attempts[0].inputs, attempts[1].inputs);
      assert.notEqual(attempts[1].inputs, attempts[2].inputs);
      assert.match(attempts[0].failedCheck ?? "", /FAIL fixed\.txt missing/);
      const skipped = (gw.requests[3] as any).messages.filter((m: any) => m.role === "tool" && m.name === "task_completed").at(-1);
      assert.match(skipped.content, /already failed on these exact workspace inputs/);
      assert.match(skipped.content, /Failed check: FAIL fixed\.txt missing/);
      assert.equal(turn.outcome, "VERIFIED");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(path.dirname(counter), { recursive: true, force: true });
    }
  });

  test("a verifier that keeps failing ends with the failed check, remaining work and next action", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ Makefile: `test:\n\t@echo "not ok 1 - parser rejects empty file"; exit 1\n` });
    const gw = await startGateway((n) => (n === 1 ? write("change.txt") : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, maxRecoveries: 1 } })));
    try {
      const turn = await agent.runTurn("Make the build pass.");
      assert.equal(turn.execution, "LIMIT_REACHED");
      assert.equal(turn.reason, "STAGNATION_DETECTED");
      assert.ok(gw.requests.length <= 10, `bounded: ${gw.requests.length}`);
      const outcome = agent.getObjective()!.outcome!;
      assert.equal(outcome.status, "incomplete");
      assert.equal(outcome.failedCheck, "not ok 1 - parser rejects empty file");
      assert.match(outcome.nextAction ?? "", /Fix the failing check \(not ok 1 - parser rejects empty file\) and rerun make test|Review the repeated action/);
      assert.equal(turn.verification?.status, "FAILED", "the gate stayed closed");
      const runs = agent.getObjective()!.verification.filter((a) => a.status === "FAILED").length;
      assert.equal(runs, 1, "the expensive verifier ran once");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("a reused verifier failure never blocks a legitimate rerun", () => {
  const done = (summary = "done"): Reply => ({ kind: "tools", calls: [{ name: "task_completed", args: { summary } }] });
  const failingMake = (counter: string, needs: string) => ({
    Makefile: `test:\n\techo run >> ${counter}\n\ttest -e ${needs} || (echo "FAIL ${needs} missing"; exit 1)\n`,
  });
  const runs = (counter: string) => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").trim().split("\n").length : 0);

  test("an untracked file created outside Nexus changes the inputs, so the verifier reruns", { timeout: 60_000 }, async () => {
    const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runs-")), "runs");
    const repo = makeRepo(failingMake(counter, "fixed.txt"));
    const gw = await startGateway((n) => {
      if (n === 3) fs.writeFileSync(path.join(repo, "fixed.txt"), "operator\n"); // the operator, not a tool
      return n === 1 ? write("change.txt") : n <= 3 ? done() : text("ok");
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      await agent.runTurn("Make the build pass.");
      assert.deepEqual(agent.getObjective()!.verification.map((a) => a.status), ["FAILED", "PASSED"]);
      assert.equal(runs(counter), 3, "the run before the first edit, then both attempts");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a git-ignored dependency installed outside Nexus changes the external fingerprint, so the verifier reruns", { timeout: 60_000 }, async () => {
    const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runs-")), "runs");
    const repo = makeRepo({ ".gitignore": "node_modules/\n", ...failingMake(counter, "node_modules/dep") });
    const gw = await startGateway((n) => {
      if (n === 3) {
        fs.mkdirSync(path.join(repo, "node_modules/dep"), { recursive: true });
        fs.writeFileSync(path.join(repo, "node_modules/.package-lock.json"), "{}");
      }
      return n === 1 ? write("change.txt") : n <= 3 ? done() : text("ok");
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      await agent.runTurn("Make the build pass.");
      const attempts = agent.getObjective()!.verification;
      assert.equal(attempts[0].inputs, attempts[1].inputs, "git-ignored files are not part of the workspace identity");
      assert.deepEqual(attempts.map((a) => a.status), ["FAILED", "PASSED"]);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a mutating command between attempts (here: a file outside the workspace) reruns the verifier", { timeout: 60_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-outside-"));
    const counter = path.join(dir, "runs");
    const marker = path.join(dir, "installed");
    const repo = makeRepo(failingMake(counter, marker));
    const gw = await startGateway((n) =>
      n === 1 ? write("change.txt") : n === 2 ? done() : n === 3 ? { kind: "tools", calls: [{ name: "run_command", args: { command: `touch ${marker}` } }] } : n === 4 ? done() : text("ok"),
    );
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      await agent.runTurn("Make the build pass.");
      const attempts = agent.getObjective()!.verification;
      assert.equal(attempts[0].inputs, attempts[1].inputs, "the workspace itself did not change");
      assert.deepEqual(attempts.map((a) => a.status), ["FAILED", "PASSED"]);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a failure recorded by another process (a resumed session) is not reused", { timeout: 60_000 }, async () => {
    const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-runs-")), "runs");
    const repo = makeRepo(failingMake(counter, "never.txt"));
    const allDone: Reply = {
      kind: "tools",
      calls: [{ name: "update_requirements", args: { requirements: ["R1", "R2", "R3"].map((id) => ({ id, status: "implemented", evidence: ["importer.ts"] })) } }],
    };
    const gw = await startGateway((n) => (n === 1 ? allDone : n === 2 ? write("change.txt") : n === 3 ? done() : text("stopping")));
    const first = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } })));
    let ledger;
    let messages;
    try {
      await first.runTurn(OBJECTIVE);
      ledger = structuredClone(first.getObjective()!);
      messages = first.getMessages();
    } finally {
      first.shutdown();
    }
    const gw2 = await startGateway((n) => (n === 1 ? done() : text("stopping")));
    const second = quiet(new AutonomousAgent(cfg(gw2.url, repo, { continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 } })));
    try {
      second.restoreSession(messages!, true, ledger);
      await second.runTurn("continue");
      const attempts = second.getObjective()!.verification;
      assert.deepEqual(attempts.map((a) => a.status), ["FAILED", "FAILED"], "same objective, so both attempts are in its ledger");
      assert.equal(attempts[0].inputs, attempts[1].inputs, "the workspace did not change between the processes");
      assert.notEqual(attempts[0].epoch, attempts[1].epoch);
      // The first process's run before its edit and its attempt, then the resumed process's own attempt.
      assert.equal(runs(counter), 3, "the resumed process ran the verifier itself");
    } finally {
      second.shutdown();
      await gw.close();
      await gw2.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("only the operator can reduce the scope", () => {
  test("an operator requirement the agent descopes stays unresolved until the operator accepts it", { timeout: 60_000 }, async () => {
    const script = (n: number): Reply =>
      n === 1
        ? {
            kind: "tools",
            calls: [{
              name: "update_requirements",
              args: {
                requirements: [
                  { id: "R1", status: "implemented", evidence: ["importer.ts"] },
                  { id: "R2", status: "descoped", note: "negatives are probably fine" },
                  { id: "R3", status: "implemented", evidence: ["importer.ts"] },
                  { text: "Refactor the parser helper", status: "descoped", note: "not needed" },
                ],
              },
            }],
          }
        : n === 2
          ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] }
          : n === 3
            ? text("Stopping: R2 needs your decision.")
            : n === 4
              ? { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] }
              : text("done");
    const gw = await startGateway(script);
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      const first = await agent.runTurn(OBJECTIVE);
      assert.equal(first.reason, "REQUIREMENTS_INCOMPLETE");
      assert.equal(first.objective?.status, "blocked");
      assert.deepEqual(first.objective?.remaining, ["R2 [descoped, needs operator acceptance] Reject negative quantities. (negatives are probably fine)"]);
      const refusal = (gw.requests[2] as any).messages.filter((m: any) => m.role === "tool" && m.name === "task_completed").at(-1);
      assert.match(refusal.content, /Blocked:\n  R2 \[descoped\]/);
      const ledger = agent.getObjective()!;
      assert.equal(requirementDone(ledger.requirements.find((r) => r.id === "M1")!), true, "the agent's own sub-requirement may be descoped");
      // The operator's decision (what `/requirements accept R2` does), then a short follow-up turn.
      assert.deepEqual(acceptDescoping(ledger, ["R2", "R9"]), { accepted: ["R2"], refused: ["R9"] });
      const second = await agent.runTurn("go ahead");
      assert.notEqual(second.reason, "REQUIREMENTS_INCOMPLETE", JSON.stringify(second));
      assert.equal(second.objective?.status, "completed");
      assert.equal(ledger.scopeChanges.at(-1)?.reason, "accepted by the operator");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a later status change by the agent withdraws the operator's acceptance", () => {
    const ledger = createLedger(OBJECTIVE);
    applyRequirementUpdates(ledger, [{ id: "R2", status: "descoped", note: "x" }]);
    acceptDescoping(ledger, ["R2"]);
    assert.equal(requirementDone(ledger.requirements[1]), true);
    applyRequirementUpdates(ledger, [{ id: "R2", status: "open" }]);
    applyRequirementUpdates(ledger, [{ id: "R2", status: "descoped", note: "again" }]);
    assert.equal(requirementDone(ledger.requirements[1]), false);
  });
});

describe("steering during active work", () => {
  test("steering queued during inference is applied once at the next step and acknowledged", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => (n === 1 ? { ...read("base.txt"), delayMs: 300 } : n === 2 ? write("tabs.txt") : text("done")));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    const acks: any[] = [];
    agent.setObserver({ onSteering: (e) => acks.push(e) });
    try {
      const pending = agent.runTurn("Tidy the files.");
      await inferring(agent);
      assert.equal(agent.queueSteering("s1", "Use tabs, not spaces.").status, "queued");
      assert.equal(agent.queueSteering("s1", "Use tabs, not spaces.").status, "duplicate");
      await pending;
      assert.deepEqual(acks.map((a) => [a.id, a.status, a.step]), [["s1", "applied", 2]]);
      const second = userMessages(gw.requests[1]);
      assert.equal(second.filter((m) => m === "[Operator steering s1]: Use tabs, not spaces.").length, 1);
      const third = userMessages(gw.requests[2]);
      assert.equal(third.filter((m) => m.startsWith("[Operator steering s1]")).length, 1, "applied exactly once");
      assert.equal(agent.queueSteering("s2", "late").status, "no_active_turn");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("steering arriving as the model gives its final answer keeps the turn going", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => (n === 1 ? { ...text("Finished."), delayMs: 300 } : n === 2 ? write("readme.txt") : text("Done with the README too.")));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      const pending = agent.runTurn("Say when you are finished.");
      await inferring(agent);
      agent.queueSteering("s1", "Also add a README.");
      const turn = await pending;
      assert.equal(gw.requests.length, 3);
      assert.ok(fs.existsSync(path.join(repo, "readme.txt")));
      assert.equal(turn.execution, "COMPLETED");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("steering queued when the session was saved is applied once on the first step after resume", { timeout: 60_000 }, async () => {
    const gw = await startGateway(() => text("done"));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    try {
      const ledger = createLedger(OBJECTIVE);
      ledger.steering.push({ id: "s9", text: "Keep the CSV header.", receivedAt: "", status: "queued" });
      agent.restoreSession([{ role: "system", content: "s" }, { role: "user", content: OBJECTIVE }], false, ledger);
      await agent.runTurn("continue");
      const users = userMessages(gw.requests[0]);
      assert.equal(users.filter((m) => m === "[Operator steering s9]: Keep the CSV header.").length, 1);
      assert.equal(agent.getObjective()!.steering[0].status, "applied");
      assert.equal(agent.getObjective()!.amendments.at(-1)?.text, "continue", "a short follow-up amends the unresolved objective");
      assert.match(systemText(gw.requests[0]), /R1 \[open\]/, "the original requirements are still pinned");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("steering pending when the turn is cancelled is returned, not applied or lost", { timeout: 60_000 }, async () => {
    const gw = await startGateway(() => ({ ...read("base.txt"), delayMs: 400 }));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION } })));
    const acks: any[] = [];
    agent.setObserver({ onSteering: (e) => acks.push(e) });
    try {
      const pending = agent.runTurn("Look around.");
      await inferring(agent);
      agent.queueSteering("s1", "Stop and summarise instead.");
      agent.requestCancel("test");
      const turn = await pending;
      assert.equal(turn.execution, "INTERRUPTED");
      assert.deepEqual(acks.map((a) => [a.id, a.status, a.text]), [["s1", "cancelled", "Stop and summarise instead."]]);
      assert.equal(agent.getObjective()!.steering[0].status, "cancelled");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("durable state keeps tool-call relationships through redaction", () => {
  test("long provider ids become distinct stable ids instead of one redaction marker", () => {
    const ids = ["call_kq9ZtR2mXv8LbN4pQs7WyE1uJd", "call_Hx3VnB7cM0aZ5rT9yK2wP6eLqU", "fc_0f9e8d7c6b5a4938271605f4e3d2c1b0a9"];
    const state = {
      schemaVersion: 1, taskId: "t1", sessionId: "t1", id: "t1", title: "t", workspacePath: os.tmpdir(), workspace: os.tmpdir(),
      createdAt: "", updatedAt: "", status: "in_progress", activePlan: [], milestones: [], validationReceipts: [],
      messages: [
        { role: "assistant", content: "", tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } })) },
        ...ids.map((id) => ({ role: "tool", tool_call_id: id, name: "read_file", content: "ok" })),
      ],
    } as any;
    const saved = redactTaskStateForPersistence(state);
    const callIds = saved.messages[0].tool_calls.map((c: any) => c.id);
    const resultIds = saved.messages.slice(1).map((m: any) => m.tool_call_id);
    assert.equal(new Set(callIds).size, 3, `distinct: ${callIds}`);
    assert.deepEqual(resultIds, callIds, "each result still names its call");
    assert.ok(callIds.every((id: string) => !id.includes("REDACTED")));
    assert.equal(stableToolCallId(ids[0]), callIds[0], "stable across saves");
    assert.equal(stableToolCallId(callIds[0]), callIds[0], "idempotent");
    assert.equal(stableToolCallId("call_0"), "call_0", "short ids are untouched");
  });

  test("a saved session round-trips its objective, steering and history completeness", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sess-"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ws-"));
    try {
      const identity = WorkspacePath.fromSelectedWorkspace(ws);
      const manager = new SessionManager(dir, () => identity);
      const ledger = createLedger(OBJECTIVE);
      ledger.steering.push({ id: "s1", text: "keep CSV", receivedAt: "", status: "queued" });
      manager.saveSession({ id: "session_x", workspace: ws, messages: [{ role: "system", content: "s" }, { role: "user", content: OBJECTIVE }], objective: ledger, history: { complete: false, compactions: 1, archivedMessages: 2 } } as any, identity);
      manager.appendArchivedHistory("session_x", [{ role: "user", content: "old" }, { role: "assistant", content: "older" }]);
      const loaded = manager.loadSession("session_x")!;
      assert.equal(loaded.objective?.requirements.length, 3);
      assert.equal(loaded.objective?.steering[0].status, "queued");
      assert.equal(loaded.history?.compactions, 1);
      assert.equal(manager.readArchivedHistory("session_x").messages.length, 2);
      assert.match(renderPinnedLedger(loaded.objective!, true), /s1 \[queued\] keep CSV/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
