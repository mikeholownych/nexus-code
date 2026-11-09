/**
 * D-04 (docs/v1.1.4/TUI-AUDIT.md): the turn verdict must follow from this turn's evidence.
 *
 * Each scenario drives a real turn against a local OpenAI-compatible gateway in review mode (the audit's
 * `package.json` with `scripts.test`), answering approvals the way the operator did, and checks the classification
 * the TUI and the REPL both render: outcome/reason plus `turnEvidence` (did the workspace change during this turn,
 * were changes carried in, how many actions were denied, which verifier runs happened and when).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { getGitInfo } from "../src/git.js";
import { summarizeTurn, type TurnResult } from "../src/core/turn.js";

type Reply = { kind: "tools"; calls: Array<{ name: string; args: any }> } | { kind: "text"; content: string };
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

function stream(r: Reply): string {
  let out = "";
  if (r.kind === "text") out += sse({ choices: [{ index: 0, delta: { content: r.content } }] });
  else {
    r.calls.forEach((c, i) => {
      out += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
    });
  }
  return out + sse({ choices: [{ index: 0, delta: {}, finish_reason: r.kind === "tools" ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n";
}

/** Scripted like the audit's fake model: the first request of each turn gets `first`, every later one plain text. */
async function gateway(firsts: Reply[]): Promise<{ url: string; close(): Promise<void> }> {
  let turn = -1;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const last = body.messages?.at(-1);
      // A new operator prompt starts a turn; tool results continue it.
      if (last?.role === "user" && !String(last.content).startsWith("[Nexus")) turn++;
      const reply = last?.role === "tool" ? { kind: "text" as const, content: "Done." } : firsts[turn] ?? { kind: "text" as const, content: "Done." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(stream(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function auditRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-d04-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# Demo\n\nA small repository.\n");
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"demo","scripts":{"test":"echo ok"}}');
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
  return repo;
}

const write = { kind: "tools" as const, calls: [{ name: "write_file", args: { path: "src/new.ts", content: "export const a = 1;\n" } }] };
const del = { kind: "tools" as const, calls: [{ name: "delete_file", args: { path: "base.txt" } }] };
const echo = { kind: "tools" as const, calls: [{ name: "run_command", args: { command: "for i in 1 2 3; do echo step $i; done" } }] };
const touch = { kind: "tools" as const, calls: [{ name: "run_command", args: { command: "echo made > made.txt" } }] };
const hello = { kind: "text" as const, content: "Hello." };

/** Runs one turn per prompt; `deny` names the tools the operator denies (everything else, verifier included, is approved). */
async function turns(firsts: Reply[], deny: string[] = []): Promise<{ results: TurnResult[]; repo: string }> {
  const gw = await gateway(firsts);
  const repo = auditRepo();
  const agent = new AutonomousAgent({ endpoint: gw.url, model: "m", maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", approvalMode: "review" } as any);
  const results: TurnResult[] = [];
  try {
    for (let i = 0; i < firsts.length; i++) {
      results.push(await agent.runTurn(`go ${i}`, async (tool) => !deny.includes(tool)));
    }
    return { results, repo };
  } finally {
    agent.shutdown();
    await gw.close();
  }
}

describe("D-04: the verdict follows this turn's evidence", () => {
  test("1. an approved verifier run before the change is reported as run, not as 'no verifier ran'", async () => {
    const { results: [r], repo } = await turns([write]);
    try {
      assert.equal(r.outcome, "UNVERIFIED", "the change itself was never checked");
      assert.equal(r.reason, "VERIFICATION_NOT_RUN");
      assert.equal(r.turnEvidence?.workspaceChanged, "yes");
      assert.deepEqual(r.turnEvidence?.verifierRuns, [{ command: "npm test", phase: "before_change", passed: true }]);
      assert.match(summarizeTurn(r).line, /npm test ran before the change only/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("2a. a denied delete changes nothing: NOT_REQUIRED with the denial counted", async () => {
    const { results: [r], repo } = await turns([del], ["delete_file"]);
    try {
      assert.equal(r.outcome, "NOT_REQUIRED");
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
      assert.equal(r.turnEvidence?.denied, 1);
      assert.ok(fs.existsSync(path.join(repo, "base.txt")));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("2b. a denied delete after an earlier change: still unverified, but this turn changed nothing", async () => {
    const { results: [, r], repo } = await turns([write, del], ["delete_file"]);
    try {
      assert.equal(r.outcome, "UNVERIFIED", "the earlier change is still unverified");
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
      assert.equal(r.turnEvidence?.carriedChanges, true);
      assert.equal(r.turnEvidence?.denied, 1);
      assert.match(summarizeTurn(r).line, /no files changed this turn/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("3. a read-only run_command turn changes nothing: NOT_REQUIRED, no pending obligation", async () => {
    const { results: [r], repo } = await turns([echo]);
    try {
      assert.equal(r.outcome, "NOT_REQUIRED", `got ${r.outcome}/${r.reason}`);
      assert.equal(r.unverifiedChangesPending, false);
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("3b. a command that does write a file stays UNVERIFIED (the command latch is only lifted on proof)", async () => {
    const { results: [r], repo } = await turns([touch]);
    try {
      assert.equal(r.outcome, "UNVERIFIED");
      assert.equal(r.unverifiedChangesPending, true);
      assert.equal(r.turnEvidence?.workspaceChanged, "yes");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("4. a turn with no change says so, and the header agrees (0 changed)", async () => {
    const { results: [r], repo } = await turns([hello]);
    try {
      assert.equal(r.outcome, "NOT_REQUIRED");
      assert.equal(r.turnEvidence?.workspaceChanged, "no");
      assert.equal(getGitInfo(repo).dirtyCount, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
