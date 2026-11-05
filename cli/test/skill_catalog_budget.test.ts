/**
 * The skill catalog in the system prompt is a share of the context window the provider actually reports, not of the
 * client default the prompt was first built with (citable report: 305 installed skills filled a 64K window on step 1).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { skillCatalogBudget } from "../src/skills.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

let home = "";
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, STATE: process.env.NEXUS_STATE_DIR };
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-skill-budget-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NEXUS_STATE_DIR = path.join(home, ".nexus");
  for (let i = 0; i < 300; i++) {
    const dir = path.join(home, ".agents", "skills", `skill-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: skill-${i}\ndescription: Skill number ${i} for a specific engineering workflow. Use when the task involves area ${i}, its tooling, its tests, and the review checklist that goes with it.\n---\nBody ${i}\n`,
    );
  }
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
  endpoint,
  model: "m",
  maxSteps: 5,
  temperature: 0,
  workspace,
  shell: "bash",
  continuation: { ...DEFAULT_CONTINUATION },
  approvalMode: "auto",
  fullAccess: true,
});
const HEADER = "### Specialized Agent Skills Available:";
const withoutCatalog = (system: string): string => {
  const start = system.indexOf(HEADER);
  return system.slice(0, start) + system.slice(system.indexOf("\n### ", start + 1));
};
const catalogOf = (request: any): string => {
  const system = request.messages[0].content as string;
  const start = system.indexOf("### Specialized Agent Skills Available:");
  assert.ok(start >= 0, "the catalog is advertised");
  return system.slice(start, system.indexOf("\n### ", start + 1));
};

async function firstRequestCatalog(contextLength: number): Promise<string> {
  const repo = makeRepo();
  const gw = await startGateway(() => ({ kind: "text", content: "done" }), {
    models: () => [{ id: "m", context_length: contextLength, max_model_len: contextLength, max_completion_tokens: 1_024 }],
  });
  const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
  try {
    await agent.runTurn("Say done.");
    return catalogOf(gw.requests[0]);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("skill catalog is sized to the reported context window", () => {
  test("a large advertised window gets a larger catalog than the 64K default would allow", { timeout: 60_000 }, async () => {
    const catalog = await firstRequestCatalog(131_072);
    assert.ok(catalog.length <= skillCatalogBudget(131_072), `catalog is ${catalog.length} chars`);
    assert.ok(catalog.length > skillCatalogBudget(65_536), "the prompt was re-sized after the provider reported its window");
    assert.match(catalog, /- \*\*skill-0\*\*: Skill number 0/, "descriptions fit at 128K");
  });

  test("a small advertised window shrinks the catalog below the 64K default", { timeout: 60_000 }, async () => {
    const catalog = await firstRequestCatalog(16_384);
    assert.ok(catalog.length <= skillCatalogBudget(16_384), `catalog is ${catalog.length} chars`);
    assert.match(catalog, /…and \d+ more/);
  });

  test("only the catalog is re-sized, once, and the system prompt is then stable across steps", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const write: Reply = { kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content: "a\n" } }] };
    const gw = await startGateway((n) => (n === 1 ? write : { kind: "text", content: "done" }), {
      models: () => [{ id: "m", context_length: 131_072, max_model_len: 131_072, max_completion_tokens: 1_024 }],
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const built = agent.getMessages()[0].content as string;
      await agent.runTurn("Write a.txt with the line a, then say done.");
      assert.ok(gw.requests.length >= 2, `requests: ${gw.requests.length}`);
      const prompts = gw.requests.map((r: any) => r.messages[0].content as string);
      assert.notEqual(prompts[0], built, "the catalog was re-sized for the advertised window");
      assert.equal(withoutCatalog(prompts[0]), withoutCatalog(built), "nothing but the catalog changed");
      for (const p of prompts.slice(1)) assert.equal(p, prompts[0], "messages[0] is byte-stable after the first re-size");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("after the provider's window is known the catalog only shrinks, so alternating windows cannot flip it", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway(() => ({ kind: "text", content: "done" }), {
      models: () => [{ id: "m", context_length: 131_072, max_model_len: 131_072, max_completion_tokens: 1_024 }],
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Say done.");
      const internals = agent as any;
      const system = () => agent.getMessages()[0].content as string;
      const large = system();
      internals.contextLimit = () => 32_768; // e.g. a coder client with a smaller window
      internals.resizeSkillCatalog();
      const small = system();
      assert.ok(small.length < large.length, "a smaller window shrinks the catalog");
      assert.ok(catalogOf({ messages: [{ content: small }] }).length <= skillCatalogBudget(32_768));
      internals.contextLimit = () => 131_072; // the planner client again
      internals.resizeSkillCatalog();
      assert.equal(system(), small, "a larger window later does not grow it back");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
