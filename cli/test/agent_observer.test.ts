import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent, AgentObserver } from "../src/agent.js";
import { startGateway, makeRepo } from "./helpers/fixtures.js";

describe("AgentObserver", () => {
  test("receives tool start/end and streamed assistant text in order", async () => {
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] }
      : { kind: "text", content: "There is one file." });
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const seen: string[] = [];
    let text = "";
    const observer: AgentObserver = {
      onToolStart: (e) => seen.push(`start:${e.tool}:${e.args.path}:${Boolean(e.callId)}`),
      onToolEnd: (e) => seen.push(`end:${e.tool}:${e.success}`),
      onAssistantDelta: (delta) => { if (!seen.includes("text")) seen.push("text"); text += delta; },
    };
    agent.setObserver(observer);
    try {
      const turn = await agent.runTurn("what is here?");
      assert.equal(turn.outcome, "NOT_REQUIRED");
      assert.deepEqual(seen, ["start:list_dir:.:true", "end:list_dir:true", "text"]);
      assert.equal(text, "There is one file.");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a denied tool reports onToolEnd with success=false", async () => {
    const gw = await startGateway((n) => n === 1
      ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] }
      : { kind: "text", content: "ok" });
    const repo = makeRepo();
    const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash" } as any);
    const ends: Array<{ tool: string; success: boolean }> = [];
    agent.setObserver({ onToolEnd: (e) => ends.push({ tool: e.tool, success: e.success }) });
    try {
      await agent.runTurn("make x", async () => false);
      assert.deepEqual(ends, [{ tool: "write_file", success: false }]);
      assert.equal(fs.existsSync(`${repo}/x.txt`), false);
      assert.equal(agent.getCompletionSummary(), undefined);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
