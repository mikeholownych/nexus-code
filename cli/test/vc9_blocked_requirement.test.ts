/**
 * VC-9 row 8: in a headless run (`nexus run`), a requirement the model marks blocked ends the turn BLOCKED / NEEDS_INPUT
 * with the blocker as a question, answered in free text (`--answer <id>=reply:<text>`). Other surfaces keep
 * COMPLETED / REQUIREMENTS_INCOMPLETE, and so does a requirement that is merely still open. Every scenario runs the real
 * agent loop against a deterministic local gateway.
 */
import "./helpers/leak_guard.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";
import { MAX_REPLY_CHARS, buildBlockedRequirementQuestion, needsInputId, parseOperatorAnswers, replyNote } from "../src/core/needs_input.js";
import { exitCodeForTurn, summarizeTurn } from "../src/core/turn.js";

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION }, ...o,
});
const text = (content: string): Reply => ({ kind: "text", content });
const update = (requirements: unknown[]): Reply => ({ kind: "tools", calls: [{ name: "update_requirements", args: { requirements } }] });
const completed: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Done except what is blocked." } }] };
const userMessages = (body: any) => (body.messages as any[]).filter((m) => m.role === "user").map((m) => String(m.content));

const OBJECTIVE = `Add input validation to the importer.

Requirements:
1. Reject rows with an empty name.
2. Reject negative quantities.
3. Report the line number of every rejected row.`;
const BLOCKER = "line numbers are not available from the parser";
const done = (id: string) => ({ id, status: "implemented", evidence: ["importer.ts"] });
/** The model implements R1 and R2, marks R3 blocked, and finishes. */
const blockedScript = (n: number): Reply =>
  n === 1 ? update([done("R1"), done("R2"), { id: "R3", status: "blocked", note: BLOCKER }]) : n === 2 ? completed : text("R3 is blocked: the parser does not expose line numbers.");

async function run(surface: HarnessConfig["surface"] | undefined, script: (n: number) => Reply, body: (agent: AutonomousAgent, gw: Awaited<ReturnType<typeof startGateway>>) => Promise<void>) {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, surface ? { surface } : {})));
  try {
    await body(agent, gw);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("VC-9 row 8: a blocked requirement in a headless run is a question", () => {
  test("`nexus run`: the turn ends BLOCKED / NEEDS_INPUT with the blocker, a reply option and an id bound to the requirement and its reason", { timeout: 60_000 }, async () => {
    await run("headless", blockedScript, async (agent) => {
      const turn = await agent.runTurn(OBJECTIVE);
      assert.equal(turn.execution, "BLOCKED");
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.reason, "NEEDS_INPUT");
      const q = turn.needsInput!;
      assert.equal(q.kind, "blocked_requirement");
      assert.deepEqual(q.subject, { requirement: "R3", text: "Report the line number of every rejected row.", blocker: BLOCKER });
      assert.match(q.prompt, /^Requirement R3 is blocked: line numbers are not available from the parser\. What should the run do about it\?$/);
      assert.deepEqual(q.options.map((o) => o.id), ["reply"], "there is nothing to approve or decline");
      assert.equal(q.id, needsInputId("blocked_requirement", "R3", BLOCKER));
      assert.equal(turn.furtherNeedsInput, undefined);
      assert.equal(turn.objective?.status, "blocked", "the objective state is still reported");
      assert.equal(exitCodeForTurn(turn), 1);
      assert.match(summarizeTurn(turn).line, new RegExp(`Resume with --answer ${q.id}=reply:<what to do>\\.`));
      assert.doesNotMatch(summarizeTurn(turn).line, /=approve/);
    });
  });

  test("the same blocked requirement on another surface keeps COMPLETED / REQUIREMENTS_INCOMPLETE (baseline: the contract change is headless only)", { timeout: 90_000 }, async () => {
    for (const surface of [undefined, "tui", "repl"] as const) {
      await run(surface, blockedScript, async (agent) => {
        const turn = await agent.runTurn(OBJECTIVE);
        assert.equal(turn.execution, "COMPLETED", String(surface));
        assert.equal(turn.reason, "REQUIREMENTS_INCOMPLETE", String(surface));
        assert.equal(turn.needsInput, undefined, String(surface));
      });
    }
  });

  test("requirements that are only still open, or descoped and awaiting acceptance, are not turned into a question", { timeout: 90_000 }, async () => {
    const openOnly = (n: number): Reply => (n === 1 ? update([done("R1"), done("R2")]) : text("I did two of three."));
    await run("headless", openOnly, async (agent) => {
      const turn = await agent.runTurn(OBJECTIVE);
      assert.equal(turn.reason, "REQUIREMENTS_INCOMPLETE", JSON.stringify(turn.objective));
      assert.equal(turn.needsInput, undefined);
    });
    const descoped = (n: number): Reply =>
      n === 1 ? update([done("R1"), done("R2"), { id: "R3", status: "descoped", note: "probably not needed" }]) : n === 2 ? completed : text("Stopping: R3 needs your decision.");
    await run("headless", descoped, async (agent) => {
      const turn = await agent.runTurn(OBJECTIVE);
      assert.equal(turn.reason, "REQUIREMENTS_INCOMPLETE");
      assert.equal(turn.needsInput, undefined, "descoping is accepted with /requirements accept, not answered as a blocker");
    });
  });

  test("two blocked requirements: the first is the question and the second waits behind it", { timeout: 60_000 }, async () => {
    const script = (n: number): Reply =>
      n === 1 ? update([done("R1"), { id: "R2", status: "blocked", note: "no sample data" }, { id: "R3", status: "blocked", note: BLOCKER }]) : n === 2 ? completed : text("Two requirements are blocked.");
    await run("headless", script, async (agent) => {
      const turn = await agent.runTurn(OBJECTIVE);
      assert.equal(turn.needsInput?.subject.requirement, "R2");
      assert.deepEqual(turn.furtherNeedsInput?.map((q) => [q.kind, q.subject.requirement]), [["blocked_requirement", "R3"]]);
      assert.match(summarizeTurn(turn).line, /1 more question\(s\) wait behind it/);
    });
  });

  test("resume with the operator's reply: the model is given the reply, reopens the requirement and the turn is no longer a question", { timeout: 90_000 }, async () => {
    const script = (n: number): Reply =>
      n <= 3
        ? blockedScript(n)
        : n === 4
          ? update([{ id: "R3", status: "in_progress" }])
          : n === 5
            ? update([{ id: "R3", status: "implemented", evidence: ["importer.ts: row index used as the line number"] }])
            : n === 6
              ? completed
              : text("R3 done using the row index.");
    await run("headless", script, async (agent, gw) => {
      const blocked = await agent.runTurn(OBJECTIVE);
      const id = blocked.needsInput!.id;
      const { replies } = parseOperatorAnswers([`${id}=reply:Use the row index as the line number; that is close enough.`]);
      const resumed = await agent.runTurn(`${replyNote(replies)}\n\ncontinue`);
      const sent = userMessages(gw.requests[3]).join("\n");
      assert.match(sent, new RegExp(`question ${id}: the operator replied: "Use the row index as the line number; that is close enough\\."`));
      assert.match(sent, /set that requirement back to in_progress with update_requirements/);
      assert.notEqual(resumed.reason, "NEEDS_INPUT", JSON.stringify(resumed.objective));
      assert.equal(resumed.needsInput, undefined);
      assert.equal(resumed.objective?.status, "completed");
      assert.equal(agent.getObjective()!.requirements.find((r) => r.id === "R3")!.status, "implemented");
    });
  });

  test("a requirement left blocked for the same reason asks the same question again; a new reason is a new question", { timeout: 90_000 }, async () => {
    const script = (n: number): Reply =>
      n <= 3 ? blockedScript(n) : n === 4 ? text("Still blocked for the same reason.") : n === 5 ? update([{ id: "R3", status: "blocked", note: "the reply needs a schema change" }]) : text("Blocked on the schema.");
    await run("headless", script, async (agent) => {
      const first = await agent.runTurn(OBJECTIVE);
      const second = await agent.runTurn("continue");
      assert.equal(second.reason, "NEEDS_INPUT");
      assert.equal(second.needsInput?.id, first.needsInput?.id, "same requirement, same reason: the same decision");
      const third = await agent.runTurn("continue");
      assert.equal(third.reason, "NEEDS_INPUT");
      assert.notEqual(third.needsInput?.id, first.needsInput?.id, "an answer to the old blocker cannot be taken for the new one");
      assert.equal(third.needsInput?.subject.blocker, "the reply needs a schema change");
    });
  });
});

describe("VC-9 row 8: the reply on the command line", () => {
  const id = "0123456789ab";

  test("replies and decisions parse side by side; a reply keeps its punctuation and line breaks", () => {
    const parsed = parseOperatorAnswers([`${id}=reply:Use the row index; a=b is fine.\nSecond line.`, "ba9876543210=approve", "aaaaaaaaaaaa=decline"]);
    assert.deepEqual([...parsed.replies], [[id, "Use the row index; a=b is fine.\nSecond line."]]);
    assert.deepEqual([...parsed.decisions], [["ba9876543210", "approve"], ["aaaaaaaaaaaa", "decline"]]);
    assert.match(replyNote(parsed.replies), /question 0123456789ab: the operator replied: "Use the row index; a=b is fine\.\\nSecond line\."/);
  });

  test("an empty reply, an oversized one and a malformed pair are refused with a message that names the form", () => {
    assert.throws(() => parseOperatorAnswers([`${id}=reply:   `]), /needs the reply text after 'reply:'/);
    assert.throws(() => parseOperatorAnswers([`${id}=reply:${"x".repeat(MAX_REPLY_CHARS + 1)}`]), new RegExp(`is ${MAX_REPLY_CHARS + 1} characters; the limit is ${MAX_REPLY_CHARS}`));
    assert.equal(parseOperatorAnswers([`${id}=reply:${"x".repeat(MAX_REPLY_CHARS)}`]).replies.get(id)!.length, MAX_REPLY_CHARS);
    for (const bad of ["nope", `${id}=maybe`, `short=reply:x`, `${id}=Reply:x`, `${id}`]) {
      assert.throws(() => parseOperatorAnswers([bad]), /--answer expects <question id>=approve\|decline, or <question id>=reply:<text>/, bad);
    }
  });

  test("the question is built from the requirement: a missing reason is said, long text is clipped, the id ignores the clipping", () => {
    const bare = buildBlockedRequirementQuestion({ id: "R1", text: "t" });
    assert.match(bare.prompt, /Requirement R1 is blocked: no reason was recorded\./);
    const long = "y".repeat(500);
    const q = buildBlockedRequirementQuestion({ id: "R1", text: "z".repeat(500), note: long });
    assert.equal(q.subject.text.length, 200);
    assert.equal(q.subject.blocker.length, 300);
    assert.equal(q.id, needsInputId("blocked_requirement", "R1", long), "bound to the whole reason, not the clipped one");
  });

  const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
  test("`nexus run --resume --answer <id>=reply:` with no text is refused before anything runs", { skip: fs.existsSync(CLI) ? false : "cli/dist is not built" }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc9b-home-"));
    try {
      const res = spawnSync(process.execPath, [CLI, "run", "--resume", "--answer", `${id}=reply:`, "do it"], { encoding: "utf8", cwd: home, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") }, timeout: 30_000 });
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /needs the reply text after 'reply:'/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
