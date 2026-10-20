/**
 * REQ-AGT-111 v1 subset (AGT-05): subagent loop calls measureAdmission and offers
 * the same tool set it accepts (getEffectiveTools). Full shared-step refactor remains post-v1.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, type HarnessConfig, type ToolDefinition } from "../src/types.js";
import { startGateway, makeRepo } from "./helpers/fixtures.js";

let home = "";
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agt111-home-"));
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};

const cfg = (endpoint: string, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 12,
  temperature: 0,
  workspace,
  shell: "bash",
  continuation: { ...DEFAULT_CONTINUATION },
  approvalMode: "auto",
  fullAccess: true,
  ...o,
});

/** limits_version makes parseAdvertisement set tokenize:true (aihost gateway shape). */
const gatewayEntry = () => ({
  id: "m",
  context_length: 40_000,
  max_model_len: 40_000,
  max_completion_tokens: 3_000,
  limits_version: "lv-agt111",
  serving: [{ worker_id: "w-agt111", pool: "lead" }],
});

const toolNames = (body: any): string[] =>
  (body?.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter(Boolean).sort();

const namesOf = (tools: ToolDefinition[]): string[] =>
  tools.map((t) => t.function.name).sort();

const isSubagentBody = (body: any): boolean =>
  JSON.stringify(body?.messages ?? []).includes("[Subagent Objective]");

const toolResults = (body: any): number =>
  (body?.messages ?? []).filter((m: any) => m.role === "tool").length;

describe("REQ-AGT-111 v1 subset: subagent measureAdmission and matched tool sets", () => {
  test("subagent chat uses live getEffectiveTools() and calls measureAdmission", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ "notes.txt": "hello from notes\n" });
    const snapshots: string[][] = [];
    let subagentMeasureCalls = 0;
    const original = AutonomousAgent.prototype.getEffectiveTools;
    const originalMeasure = (AutonomousAgent.prototype as any).measureAdmission;
    AutonomousAgent.prototype.getEffectiveTools = function (this: AutonomousAgent) {
      const tools = original.apply(this);
      if ((this as any).runningAsSubagent) snapshots.push(namesOf(tools));
      return tools;
    };
    (AutonomousAgent.prototype as any).measureAdmission = async function (this: AutonomousAgent, ...args: unknown[]) {
      if ((this as any).runningAsSubagent) subagentMeasureCalls++;
      return originalMeasure.apply(this, args);
    };

    const gw = await startGateway((_n, body) => {
      if (!body?.tools) return { kind: "text", content: "No findings." };
      if (isSubagentBody(body)) {
        return toolResults(body) === 0
          ? { kind: "tools", calls: [{ name: "read_file", args: { path: "notes.txt" } }] }
          : { kind: "text", content: "Subagent report: notes say hello." };
      }
      return toolResults(body) === 0
        ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "Read notes.txt and report." } }] }
        : { kind: "text", content: "Parent done." };
    }, {
      models: () => [gatewayEntry()],
      tokenize: () => ({
        status: 200,
        body: { prompt_tokens: 120, source: "exact", worker_id: "w-agt111", context_length: 40_000, limits_version: "lv-agt111" },
      }),
    });

    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const log = console.log;
    console.log = () => {};
    try {
      const turn = await agent.runTurn("Use a subagent to read notes.txt.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify({ reason: turn.reason, detail: turn.detail }));
      assert.ok(snapshots.length >= 1, "getEffectiveTools must run while runningAsSubagent");

      const subChats = (gw.requests as any[]).filter((b) => b.tools && isSubagentBody(b));
      assert.ok(subChats.length >= 1, "expected at least one subagent chat request with tools");
      for (const body of subChats) {
        assert.ok(
          snapshots.some((snap) => JSON.stringify(snap) === JSON.stringify(toolNames(body))),
          `subagent chat tools must equal a live getEffectiveTools() snapshot; chat=${JSON.stringify(toolNames(body))} snapshots=${JSON.stringify(snapshots)}`,
        );
      }

      assert.ok(
        subagentMeasureCalls >= subChats.length,
        `measureAdmission must run for each subagent inference step; measure=${subagentMeasureCalls} chats=${subChats.length}`,
      );
    } finally {
      console.log = log;
      AutonomousAgent.prototype.getEffectiveTools = original;
      (AutonomousAgent.prototype as any).measureAdmission = originalMeasure;
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
