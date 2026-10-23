/**
 * A reply cut off at the output limit (finish_reason=length): nothing from it runs; once in a row the model is told
 * what was cut off and asked for the content in parts, and the turn goes on; a second cut-off reply in a row ends the
 * turn as INFERENCE_FAILED (output_truncated), as before. A cut-off plain-text answer is never accepted as final.
 * Every scenario runs the real agent loop against a deterministic local gateway.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { truncatedCalls } from "../src/client.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

let home = "";
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trunc-home-"));
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
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  continuation: { ...DEFAULT_CONTINUATION },
  approvalMode: "auto",
  fullAccess: true,
  ...o,
});
const MARKER = "CUT-OFF-REPLY-MARKER";
const bigWrite = (file: string): Reply => ({
  kind: "tools",
  truncated: true,
  calls: [{ name: "write_file", args: { path: file, content: `${MARKER}\n${"lorem ipsum ".repeat(200)}` } }],
});
const lastUser = (body: any): string => {
  const users = (body.messages as any[]).filter((m) => m.role === "user");
  return String(users[users.length - 1]?.content ?? "");
};

describe("truncatedCalls", () => {
  test("names each cut-off call and its path when the partial arguments hold it whole", () => {
    const calls = truncatedCalls([
      { function: { name: "write_file", arguments: '{"path":"docs/READ \\"ME\\".md","content":"# Title\\nlong' } },
      { function: { name: "write_file", arguments: '{"content":"no path yet' } },
      { function: { name: "edit_file", arguments: '{"path":"src/a.p' } },
    ]);
    assert.deepEqual(calls[0], { name: "write_file", path: 'docs/READ "ME".md', argumentChars: 54 });
    assert.equal(calls[1].path, undefined);
    assert.equal(calls[2].path, undefined, "a path still being written is not reported");
  });
});

describe("a reply cut off at the output limit", () => {
  test("is not run; the model is told and writes the content in parts; the turn completes", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => {
      if (n === 1) return bigWrite("README.md");
      if (n === 2) return { kind: "tools", calls: [{ name: "write_file", args: { path: "README.md", content: "part one\n" } }] };
      if (n === 3) return { kind: "tools", calls: [{ name: "edit_file", args: { path: "README.md", old_content: "part one\n", new_content: "part one\npart two\n" } }] };
      return { kind: "text", content: "README written in two parts." };
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Write the usage documentation to README.md.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
      assert.notEqual(turn.reason, "INFERENCE_FAILED");
      assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "part one\npart two\n");
      const notice = lastUser((gw.requests as any[])[1]);
      assert.match(notice, /cut off at the \d+-token output limit/);
      assert.match(notice, /a write_file call for `README\.md`/);
      assert.match(notice, /Nothing from that reply ran/);
      assert.match(notice, /in parts/);
      const history = JSON.stringify(agent.getMessages());
      assert.ok(!history.includes(MARKER), "the cut-off reply is not in the conversation");
      const t = agent.getObjective()!.execution!;
      assert.ok(t.interventions.some((i) => i.kind === "output_truncated" && i.detail.includes("write_file README.md")), JSON.stringify(t.interventions));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("twice in a row ends the turn as before; no call from either reply runs", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const cut: Reply = {
      kind: "tools",
      truncated: true,
      calls: [
        { name: "run_command", args: { command: "touch ran.txt" } },
        { name: "write_file", args: { path: "README.md", content: `${MARKER}\n${"x".repeat(400)}` } },
      ],
    };
    const gw = await startGateway(() => cut);
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Write README.md.");
      assert.equal(turn.execution, "FAILED");
      assert.equal(turn.reason, "INFERENCE_FAILED");
      assert.equal(turn.detail, "output_truncated/client");
      assert.equal(gw.requests.length, 2, "one retry, then the turn ends");
      assert.ok(!fs.existsSync(path.join(repo, "ran.txt")), "no tool from a cut-off reply runs");
      assert.ok(!fs.existsSync(path.join(repo, "README.md")));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a cut-off plain-text answer is never accepted as final", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n === 1 ? { kind: "text", content: `${MARKER} all requirements are`, truncated: true } : { kind: "text", content: "Short complete answer." }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const providerRecoveryStates: string[] = [];
    agent.setObserver({ onProviderRecovery: ({ record }) => providerRecoveryStates.push(record.state) });
    try {
      const turn = await agent.runTurn("Summarize the work.");
      assert.equal(turn.execution, "COMPLETED");
      assert.deepEqual(providerRecoveryStates, [], "a completed but truncated response is handled as an output-limit issue, not a provider outage");
      assert.match(lastUser((gw.requests as any[])[1]), /cut off at the .*output limit \(.*\) before it finished\. None of that reply was kept/);
      assert.ok(!JSON.stringify(agent.getMessages()).includes(MARKER));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }

    const always = await startGateway(() => ({ kind: "text", content: `${MARKER} partial`, truncated: true }));
    const agent2 = quiet(new AutonomousAgent(cfg(always.url, makeRepo())));
    const repeatedProviderRecoveryStates: string[] = [];
    agent2.setObserver({ onProviderRecovery: ({ record }) => repeatedProviderRecoveryStates.push(record.state) });
    try {
      const turn = await agent2.runTurn("Summarize the work.");
      assert.equal(turn.reason, "INFERENCE_FAILED");
      assert.equal(always.requests.length, 2);
      assert.deepEqual(repeatedProviderRecoveryStates, [], "repeated truncation remains a turn failure without being labeled provider recovery");
    } finally {
      agent2.shutdown();
      await always.close();
    }
  });

  test("with no step left under an operator step limit, the turn ends as before", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway(() => bigWrite("README.md"));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { maxSteps: 1, continuation: undefined })));
    try {
      const turn = await agent.runTurn("Write README.md.");
      assert.equal(turn.reason, "INFERENCE_FAILED");
      assert.equal(gw.requests.length, 1);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a delegated helper recovers the same way", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n, body) => {
      const sub = (body.messages as any[]).some((m) => typeof m.content === "string" && m.content.includes("[Subagent Objective]"));
      if (!sub) return n === 1 ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "write notes.md" } }] } : { kind: "text", content: "parent done" };
      const tools = (body.messages as any[]).filter((m) => m.role === "tool").length;
      if (!lastUser(body).includes("cut off") && tools === 0) return bigWrite("notes.md");
      return tools === 0
        ? { kind: "tools", calls: [{ name: "write_file", args: { path: "notes.md", content: "short notes\n" } }] }
        : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "wrote notes.md" } }] };
    });
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Delegate writing notes.md to a helper.");
      assert.equal(fs.readFileSync(path.join(repo, "notes.md"), "utf8"), "short notes\n");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
