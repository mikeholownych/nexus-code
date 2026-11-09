/**
 * WP-1308 (carried from the PR #409 review): the bounded skill catalog is re-sized correctly on resume, on first
 * discovery and when it shrank to nothing.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { skillCatalogBudget, SKILL_CATALOG_HEADING, findCatalogSpan } from "../src/skills.js";
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

describe("catalog re-size (PR #409 review items)", () => {
  const system = (agent: AutonomousAgent) => agent.getMessages()[0].content as string;

  test("a session saved before PR #409 keeps no full catalog: it is recognised by its heading and cut to the window", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent, gw) => {
      const internals = agent as any;
      const built = system(agent);
      const full = internals.skillManager.getPromptSection(10_000_000) as string;
      assert.ok(full.length > 100_000, "the pre-#409 catalog was 100K+ characters");
      const span = findCatalogSpan(built)!;
      internals.messages[0] = { ...internals.messages[0], content: built.slice(0, span.start) + full + built.slice(span.end) };
      await agent.runTurn("Say done.");
      const sent = (gw.requests[0] as any).messages[0].content as string;
      const catalog = sent.slice(findCatalogSpan(sent)!.start, findCatalogSpan(sent)!.end);
      assert.ok(catalog.length <= skillCatalogBudget(65_536), `${catalog.length} chars sent`);
      assert.ok(sent.length < 60_000);
      assert.equal(sent.slice(0, span.start), built.slice(0, span.start), "nothing before the catalog changed");
    });
  });

  test("a recorded catalog is replaced only when it was found; a miss is not recorded", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent) => {
      const internals = agent as any;
      await agent.runTurn("Say done.");
      const before = system(agent);
      const recorded = { ...internals.skillCatalog };
      // messages[0] without any catalog and without the recorded text.
      internals.messages[0] = { ...internals.messages[0], content: "bare system prompt" };
      internals.contextLimit = () => 16_384;
      internals.resizeSkillCatalog();
      assert.equal(system(agent), "bare system prompt");
      assert.deepEqual(internals.skillCatalog, recorded, "nothing was replaced, so nothing is recorded");
      assert.ok(before.includes(SKILL_CATALOG_HEADING));
    });
  });

  test("first discovery re-sizes once, directly", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent) => {
      const internals = agent as any;
      const built = system(agent);
      internals.contextLimit = () => 400_000;
      internals.resizeSkillCatalog();
      assert.equal(system(agent), built, "no capabilities discovered yet, same window: untouched");
      internals.capabilities = {};
      internals.resizeSkillCatalog();
      assert.notEqual(system(agent), built, "the provider's window is known: re-sized");
      const once = system(agent);
      internals.resizeSkillCatalog();
      assert.equal(system(agent), once, "and only once");
    });
  });

  test("a catalog that shrank to nothing stays absent: notes and lookup cover it", { timeout: 60_000 }, async () => {
    await withAgent(done, async (agent) => {
      const internals = agent as any;
      internals.contextLimit = () => 2_000;
      internals.capabilities = {};
      internals.resizeSkillCatalog();
      assert.doesNotMatch(system(agent), /Specialized Agent Skills Available/);
      internals.contextLimit = () => 131_072;
      internals.resizeSkillCatalog();
      assert.doesNotMatch(system(agent), /Specialized Agent Skills Available/);
    });
  });
});
