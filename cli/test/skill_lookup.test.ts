/**
 * WP-1308: `activate_skill` doubles as the lookup pass: a name no skill has is searched, and the ranked matches
 * come back (descriptions only; nothing is activated).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
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

describe("activate_skill lookup", () => {
  const lookup = (name: string): Reply => ({ kind: "tools", calls: [{ name: "activate_skill", args: { name } }] });
  const toolResult = (gw: any): string => {
    const last = gw.requests[gw.requests.length - 1].messages.filter((m: any) => m.role === "tool").pop();
    return text(last);
  };

  test("a query that is no skill's name returns ranked matches and activates nothing", { timeout: 60_000 }, async () => {
    await withAgent((n) => (n === 1 ? lookup("slow postgres explain index") : done()), async (agent, gw) => {
      await agent.runTurn("Hello.");
      const out = toolResult(gw);
      assert.match(out, /\*\*postgres-tuning\*\*: Diagnose slow PostgreSQL queries/);
      assert.doesNotMatch(out, /BODY-OF/);
      assert.doesNotMatch(out, /Available skills:/);
      assert.ok(out.length < 3_000);
    });
  });

  test("an exact name still activates, and a query nothing matches says so without listing every skill", { timeout: 60_000 }, async () => {
    await withAgent((n) => (n === 1 ? lookup("pdf-forms") : done()), async (agent, gw) => {
      await agent.runTurn("Hello.");
      assert.match(toolResult(gw), /\[Activated Skill: pdf-forms\][\s\S]*BODY-OF-pdf-forms/);
    });
    await withAgent((n) => (n === 1 ? lookup("zzzz qqqq") : done()), async (agent, gw) => {
      await agent.runTurn("Hello.");
      const out = toolResult(gw);
      assert.match(out, /No installed skill matches/);
      assert.ok(out.length < 400, `${out.length} chars`);
    });
  });
});
