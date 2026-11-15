/**
 * CX-5: after every compaction, every gating requirement of the pinned objective ledger is present in the request the
 * model is sent, or the turn blocks with a named reason. The ledger is not part of the conversation: requestMessages
 * rebuilds it for every request, so compaction cannot rewrite it; these tests hold that, rung by rung, and hold the guard
 * that blocks when it ever fails to be so.
 */
import "./helpers/leak_guard.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { AutonomousAgent, ContextBudgetError } from "../src/agent.js";
import { createLedger, gatingRequirements, missingGatingRequirements, PINNED_LEDGER_PREFIX, renderPinnedLedger } from "../src/core/objective.js";
import { DEFAULT_CONTINUATION, type HarnessConfig } from "../src/types.js";
import { makeRepo, startGateway, type Reply } from "./helpers/fixtures.js";

let home = "";
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(`${os.tmpdir()}/nexus-cx5-home-`);
  process.env.HOME = home;
});
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 }, ...o,
});
const write = (n: number): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: `w${n}.txt`, content: `${n}\n`.repeat(400), overwrite: true } }] });
const OBJECTIVE = "1. Add the maxLength option\n2. Keep every file under 10 kilobytes\n3. Write w1..w6\n4. Document the option";

/** An agent that has run a turn of `writes` tool steps under OBJECTIVE, so it has a durable ledger and a real history. */
async function withAgent(fn: (agent: AutonomousAgent, gw: Awaited<ReturnType<typeof startGateway>>) => Promise<void>, extra: Partial<HarnessConfig> = {}, objective = OBJECTIVE): Promise<void> {
  const root = makeRepo();
  const gw = await startGateway((n) => (n <= 6 ? write(n) : { kind: "text", content: "paused" }));
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root, extra)));
  try {
    await agent.runTurn(objective);
    await fn(agent, gw);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const sentBlock = (agent: AutonomousAgent, messages = agent.getMessages()): string =>
  (agent as any).requestMessages(messages).map((m: any) => String(m.content)).filter((c: string) => c.startsWith(PINNED_LEDGER_PREFIX)).join("\n");

test("missingGatingRequirements names a gating requirement absent from the block, by id or by wording", () => {
  const ledger = { requirements: [{ id: "R1", text: "Add a flag", status: "open" }, { id: "R2", text: "Document it", status: "open" }] } as any;
  const block = `${PINNED_LEDGER_PREFIX}\n- R1 [open] Add a flag\n- R2 [open] Document it`;
  assert.deepEqual(missingGatingRequirements(ledger, block), []);
  assert.deepEqual(missingGatingRequirements(ledger, block.replace("- R2 [open] Document it", "")), ["R2"]);
  assert.deepEqual(missingGatingRequirements(ledger, block.replace("Document it", "Docu")), ["R2"]);
  assert.deepEqual(missingGatingRequirements(ledger, ""), ["R1", "R2"]);
});

test("every rung of the admitContext ladder keeps every gating requirement in the request", async () => {
  await withAgent(async (agent) => {
    const a = agent as any;
    const original = a.messages;
    const gating = gatingRequirements(agent.getObjective()!);
    assert.equal(gating.length, 4);
    const ladder: Array<[number, number]> = [];
    for (const recent of [2, 1, 0]) for (const detail of [6000, 3000, 1200, 400, 0]) ladder.push([recent, detail]);
    const tags = new WeakMap<object, string>();
    const candidate = a.compactionCandidate.bind(a);
    const scaled = a.scaledBudget.bind(a);
    for (const [recent, detail] of ladder) {
      const target = `${recent}/${detail}`;
      // Only the target rung's candidate fits; every rung before it is refused, so the ladder is walked to it.
      a.compactionCandidate = (...args: any[]) => {
        const out = candidate(...args);
        if (args[3] === undefined) tags.set(out.messages, `${args[1]}/${args[2]}`);
        return out;
      };
      a.scaledBudget = (messages: any, limit: number, tools?: any) => {
        const b = scaled(messages, limit, tools);
        return { ...b, totalActiveTokens: tags.get(messages) === target ? 1 : 1e9 };
      };
      try {
        a.messages = original;
        a.admitContext(0, `rung-${target}`);
        assert.equal(tags.get(a.messages), target, `rung ${target} was the one admitted`);
        const sent = sentBlock(agent, a.messages);
        assert.deepEqual(missingGatingRequirements(agent.getObjective()!, sent), [], `rung ${target}: no gating requirement missing`);
        for (const r of gating) assert.ok(sent.includes(`- ${r.id} [`) && sent.includes(r.text), `rung ${target}: ${r.id} present with its wording`);
      } finally {
        a.compactionCandidate = candidate;
        a.scaledBudget = scaled;
        a.messages = original;
        a.pendingCompaction = undefined;
      }
    }
    // The stronger second-pass ladder (recent turns 1, 0 against budgets 3000..0) builds from the same candidates.
    for (const [recent, detail] of [[1, 3000], [1, 1200], [1, 400], [1, 0], [0, 3000], [0, 1200], [0, 400], [0, 0]]) {
      const c = candidate(original, recent, detail);
      assert.deepEqual(missingGatingRequirements(agent.getObjective()!, sentBlock(agent, c.messages)), [], `second pass ${recent}/${detail}`);
    }
  });
});

test("/compact --llm leaves every gating requirement in the next request; a request that would lose one is not committed", async () => {
  await withAgent(async (agent) => {
    const a = agent as any;
    const before = agent.getMessages().length;
    const summarised = await agent.compactNow(true);
    assert.equal(summarised.ok, true, summarised.message);
    assert.ok(agent.getMessages().length < before);
    assert.deepEqual(missingGatingRequirements(agent.getObjective()!, sentBlock(agent)), []);

    // A request builder that dropped one requirement: the summary is not committed and the reason names it.
    const kept = a.messages;
    const real = a.requestMessages.bind(a);
    a.requestMessages = (messages: any) => real(messages).map((m: any) => (typeof m.content === "string" && m.content.startsWith(PINNED_LEDGER_PREFIX) ? { ...m, content: m.content.replace(/^- R3 .*$/m, "") } : m));
    try {
      const refused = await agent.compactNow(true);
      assert.equal(refused.ok, false);
      assert.match(refused.message, /R3/);
      assert.match(refused.message, /not compacted/i);
      assert.equal(a.messages, kept, "conversation unchanged");
    } finally {
      a.requestMessages = real;
    }
  });
});

test("admission refuses a request that would lose a gating requirement: BLOCKED, CONTEXT_CAPACITY_EXCEEDED, the requirement named, nothing sent", async () => {
  const root = makeRepo();
  const gw = await startGateway(() => ({ kind: "text", content: "done" }));
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root)));
  try {
    const a = agent as any;
    const real = a.requestMessages.bind(a);
    a.requestMessages = (messages: any) => real(messages).map((m: any) => (typeof m.content === "string" && m.content.startsWith(PINNED_LEDGER_PREFIX) ? { ...m, content: m.content.replace(/^- R2 .*$/m, "") } : m));
    const result = await agent.runTurn(OBJECTIVE);
    assert.equal(result.execution, "BLOCKED");
    assert.equal(result.reason, "CONTEXT_CAPACITY_EXCEEDED");
    assert.deepEqual(result.capacity?.missingRequirements, ["R2"]);
    assert.equal(gw.requests.length, 0, "no request was sent");
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a ledger larger than the context budget is never truncated: the turn blocks and no request is sent", async () => {
  const big = Array.from({ length: 4 }, (_, i) => `${i + 1}. Requirement ${i + 1} ${String.fromCharCode(97 + i).repeat(6000)}`).join("\n");
  const root = makeRepo();
  const gw = await startGateway(() => ({ kind: "text", content: "done" }));
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root, { contextLimit: 8000 })));
  try {
    const result = await agent.runTurn(big);
    assert.equal(result.execution, "BLOCKED");
    assert.equal(result.reason, "CONTEXT_CAPACITY_EXCEEDED");
    assert.equal(gw.requests.length, 0, "nothing truncated was sent");
    // The ledger itself is whole: every requirement row carries its complete wording, however large the objective.
    const ledger = createLedger(big);
    assert.deepEqual(missingGatingRequirements(ledger, renderPinnedLedger(ledger, true)), []);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("at the last rung (recent turns 0, detail 0) an over-limit ledger still blocks instead of being cut", async () => {
  await withAgent(async (agent) => {
    const a = agent as any;
    const original = a.messages;
    a.config.contextLimit = 3000;
    try {
      assert.throws(() => a.admitContext(0, "zero-rung"), ContextBudgetError);
      assert.equal(a.messages, original, "nothing was committed");
    } finally {
      a.messages = original;
    }
    // Whole requirements, not cut ones: the block that would have been sent still lists each with its complete wording.
    assert.deepEqual(missingGatingRequirements(agent.getObjective()!, sentBlock(agent, original)), []);
  });
});
