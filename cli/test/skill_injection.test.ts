/**
 * WP-1308: relevance-based skill injection. The system prompt (with PR #409's bounded catalog) is byte-identical
 * across turns; a skill note naming the skills that fit an operator message is appended once, right after that
 * message, so every request is an append-only extension of the previous one. `activate_skill` doubles as a lookup.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent, ContextBudgetError } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { skillCatalogBudget, skillNoteBudget, SKILL_NOTE_PREFIX, SKILL_CATALOG_HEADING, findCatalogSpan } from "../src/skills.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

let home = "";
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, STATE: process.env.NEXUS_STATE_DIR };
const writeSkill = (root: string, name: string, description: string) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBODY-OF-${name}\n`);
};
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-skill-inject-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NEXUS_STATE_DIR = path.join(home, ".nexus");
  const root = path.join(home, ".agents", "skills");
  for (let i = 0; i < 300; i++) {
    writeSkill(root, `skill-${i}`, `Skill number ${i} for a specific engineering workflow. Use when the task involves area ${i}, its tooling, its tests, and the review checklist that goes with it.`);
  }
  writeSkill(root, "postgres-tuning", "Diagnose slow PostgreSQL queries, read EXPLAIN plans, add indexes and tune vacuum settings.");
  writeSkill(root, "pdf-forms", "Fill, merge and split PDF forms and extract tables from PDF documents.");
  for (let i = 0; i < 40; i++) writeSkill(root, `kafka-${i}`, `Kafka topic ${i}: partitions, consumer groups, offsets and rebalancing for stream pipeline number ${i}, with a long tail of detail to spend budget on ${"x".repeat(200)}.`);
});
after(() => {
  for (const [key, value] of [["HOME", saved.HOME], ["XDG_CONFIG_HOME", saved.XDG], ["NEXUS_STATE_DIR", saved.STATE]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 5, temperature: 0, workspace, shell: "bash",
  continuation: { ...DEFAULT_CONTINUATION }, approvalMode: "auto", fullAccess: true,
});
const text = (m: any): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const notes = (request: any) => request.messages.filter((m: any) => m.role === "user" && text(m).startsWith(SKILL_NOTE_PREFIX));

async function withAgent<T>(replies: (n: number) => Reply, fn: (agent: AutonomousAgent, gw: Awaited<ReturnType<typeof startGateway>>) => Promise<T>, contextLength = 65_536): Promise<T> {
  const repo = makeRepo();
  const gw = await startGateway(replies, { models: () => [{ id: "m", context_length: contextLength, max_model_len: contextLength, max_completion_tokens: 1_024 }] });
  const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
  try {
    return await fn(agent, gw);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
const done = (): Reply => ({ kind: "text", content: "done" });

describe("per-prompt skill note", () => {
  test("a prompt naming a skill's domain gets that skill's description immediately after that message", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent, gw) => {
      const prompt = "My postgres queries are slow; look at the explain plan and add an index.";
      await agent.runTurn(prompt);
      const msgs = (gw.requests[0] as any).messages;
      const at = msgs.findIndex((m: any) => m.role === "user" && text(m).startsWith(prompt));
      assert.ok(at > 0, "operator message is in the request");
      assert.ok(text(msgs[at + 1]).startsWith(SKILL_NOTE_PREFIX), "the note follows the operator message directly");
      assert.match(text(msgs[at + 1]), /\*\*postgres-tuning\*\*: Diagnose slow PostgreSQL queries/);
      assert.doesNotMatch(text(msgs[at + 1]), /BODY-OF/, "matching never loads a body");
      assert.ok(text(msgs[at + 1]).length <= skillNoteBudget(65_536));
      assert.equal(msgs[at + 1].role, "user", "a user-role harness note, accepted by every chat template");
    });
  });

  test("an unrelated prompt gets no note", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent, gw) => {
      await agent.runTurn("Say hello and tell me a joke about cats.");
      assert.equal(notes(gw.requests[0]).length, 0);
    });
  });

  test("across two operator messages the second request starts with the first request's messages unchanged", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent, gw) => {
      await agent.runTurn("My postgres queries are slow; look at the explain plan.");
      await agent.runTurn("Now fill in the PDF forms and extract the tables from the PDF documents.");
      const first = (gw.requests[0] as any).messages;
      const second = (gw.requests[gw.requests.length - 1] as any).messages;
      assert.deepEqual(second.slice(0, first.length), first, "append-only prefix");
      assert.equal(notes(gw.requests[gw.requests.length - 1]).length, 2, "the first note stays where it was written; the second is added after its message");
      assert.match(text(notes(gw.requests[gw.requests.length - 1])[1]), /\*\*pdf-forms\*\*/);
    });
  });

  test("the system prompt is byte-identical across turns with different prompts", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent, gw) => {
      await agent.runTurn("My postgres queries are slow; look at the explain plan.");
      await agent.runTurn("Fill in the PDF forms.");
      await agent.runTurn("Say hello.");
      const prompts = gw.requests.map((r: any) => r.messages[0].content);
      assert.ok(prompts.length >= 3);
      for (const p of prompts) assert.equal(p, prompts[0]);
    });
  });

  test("the note stays inside its budget when 40 skills match, and a 305-skill host starts without a capacity block", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent, gw) => {
      const result = await agent.runTurn("Explain kafka topic partitions, consumer groups, offsets and rebalancing for the stream pipeline.");
      assert.ok(gw.requests.length >= 1, "the turn reached the model");
      assert.notEqual((result as any).stopReason, "CONTEXT_FULL");
      const [note] = notes(gw.requests[0]);
      assert.ok(note, "kafka skills matched");
      assert.ok(text(note).length <= skillNoteBudget(65_536), `${text(note).length} chars`);
      assert.ok((text(note).match(/^- \*\*/gm) ?? []).length <= 5);
    });
  });

  test("a message too large for the window gets no note, so the turn is still refused and withdrawn whole", { timeout: 60_000 }, async () => {
    const agent = quiet(new AutonomousAgent({ endpoint: "http://localhost:1234/v1", model: "test-model", workspace: process.cwd(), maxSteps: 1, shell: "bash", contextLimit: 65_536, completionReserveTokens: 8_192, toolResponseReserveTokens: 4_096 }));
    let dispatched = false;
    (agent as any).client = { chatCompletionStream: async () => { dispatched = true; return { role: "assistant", content: "unexpected" }; } };
    try {
      const before = agent.getMessages().length;
      const blocked = await agent.runTurn(`Keep this postgres explain index requirement intact: ${"critical ".repeat(70_000)}`);
      assert.equal(blocked.reason, "CONTEXT_CAPACITY_EXCEEDED");
      assert.equal(dispatched, false, "the oversized message is not condensed behind a note");
      assert.equal(agent.getMessages().length, before, "the refused submission is not retained");
    } finally {
      agent.shutdown();
    }
  });

  test("a turn refused after its note was written withdraws the note with the message", { timeout: 60_000 }, async () => {
    const agent = quiet(new AutonomousAgent({ endpoint: "http://localhost:1234/v1", model: "test-model", workspace: process.cwd(), maxSteps: 1, shell: "bash", contextLimit: 65_536, completionReserveTokens: 8_192, toolResponseReserveTokens: 4_096 }));
    (agent as any).client = { chatCompletionStream: async () => ({ role: "assistant", content: "unexpected" }) };
    (agent as any).admitWithFindings = async () => { throw new ContextBudgetError(70_000, 8_192, 4_096, 65_536); };
    try {
      const before = agent.getMessages().length;
      const blocked = await agent.runTurn("My postgres queries are slow, explain the plan and add an index.");
      assert.equal(blocked.reason, "CONTEXT_CAPACITY_EXCEEDED");
      assert.equal(agent.getMessages().length, before, "neither the message nor its note is retained");
    } finally {
      agent.shutdown();
    }
  });
});
